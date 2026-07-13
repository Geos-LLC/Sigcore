import { deriveForwardBody } from './webhooks.controller';

/**
 * Regression coverage for the Task 6B.5C rawBody-fallback path.
 *
 * Prior to this fix Sigcore's callback forwarder posted an empty body to
 * Callio whenever express body-parser had already consumed the request
 * stream (which was the case for every real Twilio callback in staging).
 * Callio then saw RecordingStatus/RecordingSid/RecordingUrl all missing
 * and silently dropped the recording without persisting recording_url.
 * Verified end-to-end failure during Task 6B.5C canary, fixed by falling
 * back to a URLSearchParams reconstruction from the parsed payload.
 */
describe('deriveForwardBody (Task 6B.5C rawBody fallback)', () => {
  const twilioPayload = {
    RecordingSid: 'REabc123',
    RecordingUrl:
      'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings/REabc123',
    RecordingStatus: 'completed',
    RecordingDuration: '17',
    RecordingChannels: '2',
    CallSid: 'CAxyz789',
    AccountSid: 'ACxxx',
  };

  it('returns rawBody verbatim when it is populated', () => {
    const raw = Buffer.from('CallSid=CA123&RecordingStatus=completed', 'utf8');
    const out = deriveForwardBody(raw, { CallSid: 'other', RecordingStatus: 'in-progress' });
    // The parsed payload has different values, but rawBody wins — proving
    // the fallback never overrides truth on the wire when the stream did
    // survive.
    expect(out.equals(raw)).toBe(true);
  });

  it('reconstructs form-urlencoded body when rawBody is undefined', () => {
    const out = deriveForwardBody(undefined, twilioPayload);
    const decoded = out.toString('utf8');
    // URLSearchParams uses the canonical Twilio-callback content-type
    // (application/x-www-form-urlencoded), so Callio's body-parser will
    // decode the fields the same way it would decode Twilio's original.
    expect(decoded).toContain('RecordingSid=REabc123');
    expect(decoded).toContain('RecordingStatus=completed');
    expect(decoded).toContain('CallSid=CAxyz789');
    // The RecordingUrl value contains `/` and `:` which must be URL-encoded.
    expect(decoded).toContain(
      'RecordingUrl=' +
        encodeURIComponent(
          'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings/REabc123',
        ),
    );
  });

  it('reconstructs form-urlencoded body when rawBody is an empty Buffer', () => {
    // The exact scenario Sigcore staging hit: bodyParser consumed the
    // stream, so req.rawBody exists but has length 0.
    const out = deriveForwardBody(Buffer.alloc(0), twilioPayload);
    expect(out.length).toBeGreaterThan(0);
    const decoded = out.toString('utf8');
    expect(decoded).toContain('RecordingStatus=completed');
  });

  it('round-trips through URLSearchParams so downstream decode sees the same fields', () => {
    const out = deriveForwardBody(undefined, twilioPayload);
    const parsed = Object.fromEntries(new URLSearchParams(out.toString('utf8')));
    expect(parsed.RecordingSid).toBe(twilioPayload.RecordingSid);
    expect(parsed.RecordingUrl).toBe(twilioPayload.RecordingUrl);
    expect(parsed.RecordingStatus).toBe(twilioPayload.RecordingStatus);
    expect(parsed.RecordingDuration).toBe(twilioPayload.RecordingDuration);
    expect(parsed.RecordingChannels).toBe(twilioPayload.RecordingChannels);
    expect(parsed.CallSid).toBe(twilioPayload.CallSid);
    expect(parsed.AccountSid).toBe(twilioPayload.AccountSid);
  });

  it('safely handles a missing / null parsed payload alongside empty rawBody', () => {
    // Defensive: an inbound with no parseable body should not throw. The
    // result is a well-formed empty form body.
    const out = deriveForwardBody(undefined, undefined as unknown as Record<string, string>);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.toString('utf8')).toBe('');
  });
});
