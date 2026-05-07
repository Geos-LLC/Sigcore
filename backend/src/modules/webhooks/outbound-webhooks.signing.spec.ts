/**
 * Sigcore outbound webhook signing tests.
 *
 * Asserts the X-Callio-* headers + HMAC format match the receiver-side
 * verifier used by Service Flow's /lead-status endpoint and PR-2's
 * `/api/communications/webhooks/sigcore`. Single source of truth for the
 * shape lives in SF's `lib/webhook-signature.js` — this test file
 * re-implements the verifier locally so a contract drift in either repo
 * fails this suite immediately.
 *
 * Contract recap:
 *   X-Callio-Timestamp : integer-as-string, epoch seconds
 *   X-Callio-Signature : hex(HMAC-SHA256(secret, `${ts}.${rawBody}`))
 *   Replay window      : ±5 minutes
 */

import * as crypto from 'crypto';
import axios from 'axios';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import {
  WebhookEventType,
  WebhookSubscriptionStatus,
} from '../../database/entities/webhook-subscription.entity';

jest.mock('axios');
const mockedAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;

// SF-compatible verifier — must stay in lockstep with
// service-flow-backend/lib/webhook-signature.js. If anything below
// changes, that file changes too.
const REPLAY_TOLERANCE_S = 5 * 60;

function verifySfShape({
  headers,
  rawBody,
  secret,
  nowSec = Math.floor(Date.now() / 1000),
}: {
  headers: Record<string, string>;
  rawBody: string;
  secret: string;
  nowSec?: number;
}): { valid: boolean; reason: string | null } {
  const sigHeader = headers['X-Callio-Signature'];
  const tsHeader = headers['X-Callio-Timestamp'];
  if (!sigHeader || !tsHeader) {
    return { valid: false, reason: 'missing_signature_or_timestamp' };
  }
  const tsNum = parseInt(tsHeader, 10);
  if (!Number.isFinite(tsNum)) return { valid: false, reason: 'invalid_timestamp' };
  if (Math.abs(nowSec - tsNum) > REPLAY_TOLERANCE_S) {
    return { valid: false, reason: 'stale_timestamp' };
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${tsHeader}.${rawBody}`)
    .digest('hex');
  const provided = String(sigHeader).replace(/^sha256=/i, '');
  if (expected.length !== provided.length) {
    return { valid: false, reason: 'length_mismatch' };
  }
  const match = crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(provided, 'hex'),
  );
  return { valid: match, reason: match ? null : 'signature_mismatch' };
}

function buildSubscription(over: Partial<any> = {}): any {
  return {
    id: 'sub-test',
    workspaceId: 'ws-1',
    name: 'Test',
    webhookUrl: 'https://example.test/hook',
    secret: 'sub-secret-32-bytes-of-randomness',
    events: [WebhookEventType.MESSAGE_INBOUND],
    status: WebhookSubscriptionStatus.ACTIVE,
    failureCount: 0,
    ...over,
  };
}

function buildService(subs: any[]) {
  const subscriptionRepo: any = {
    find: jest.fn().mockResolvedValue(subs),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    create: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  };
  return new OutboundWebhooksService(subscriptionRepo);
}

beforeEach(() => {
  mockedAxiosPost.mockReset();
  mockedAxiosPost.mockResolvedValue({ status: 200, data: {} } as any);
});

describe('OutboundWebhooksService — outbound signature contract', () => {
  const SECRET = 'sub-secret-32-bytes-of-randomness';

  test('sendWebhook sends epoch X-Callio-Timestamp + ts.body HMAC X-Callio-Signature', async () => {
    const sub = buildSubscription();
    const service = buildService([sub]);

    const before = Math.floor(Date.now() / 1000);
    await service.emitEvent('ws-1', WebhookEventType.MESSAGE_INBOUND, { ping: 'pong' });
    const after = Math.floor(Date.now() / 1000);

    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedAxiosPost.mock.calls[0] as any;
    expect(url).toBe(sub.webhookUrl);
    const headers = opts.headers as Record<string, string>;

    // Timestamp shape: epoch seconds, integer-as-string, near "now"
    expect(headers['X-Callio-Timestamp']).toMatch(/^\d{10}$/);
    const ts = parseInt(headers['X-Callio-Timestamp'], 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);

    // Signature header present
    expect(headers['X-Callio-Signature']).toMatch(/^[a-f0-9]{64}$/);

    // SF verifier accepts it
    const rawBody = JSON.stringify(body);
    const r = verifySfShape({ headers, rawBody, secret: SECRET });
    expect(r).toEqual({ valid: true, reason: null });
  });

  test('signature is hex(HMAC-SHA256(secret, `${ts}.${body}`)) — explicit reproduction', async () => {
    const sub = buildSubscription({
      events: [WebhookEventType.MESSAGE_INBOUND, WebhookEventType.MESSAGE_DELIVERED],
    });
    const service = buildService([sub]);
    await service.emitEvent('ws-1', WebhookEventType.MESSAGE_DELIVERED, { x: 1 });

    const [, body, opts] = mockedAxiosPost.mock.calls[0] as any;
    const ts = (opts.headers as any)['X-Callio-Timestamp'];
    const sig = (opts.headers as any)['X-Callio-Signature'];

    // Reproduce signature locally
    const expected = crypto
      .createHmac('sha256', SECRET)
      .update(`${ts}.${JSON.stringify(body)}`)
      .digest('hex');
    expect(sig).toBe(expected);
  });

  test('event payload body still carries ISO timestamp field — body shape unchanged', async () => {
    const sub = buildSubscription();
    const service = buildService([sub]);
    await service.emitEvent('ws-1', WebhookEventType.MESSAGE_INBOUND, {});
    const [, body] = mockedAxiosPost.mock.calls[0] as any;
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(body.event).toBe(WebhookEventType.MESSAGE_INBOUND);
    expect(body.data).toBeDefined();
  });

  test('SF verifier rejects when body is tampered after Sigcore signs', async () => {
    const sub = buildSubscription();
    const service = buildService([sub]);
    await service.emitEvent('ws-1', WebhookEventType.MESSAGE_INBOUND, { ok: true });
    const [, body, opts] = mockedAxiosPost.mock.calls[0] as any;

    const tampered = JSON.stringify({ ...body, data: { ok: false } });
    const r = verifySfShape({
      headers: opts.headers,
      rawBody: tampered,
      secret: SECRET,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('signature_mismatch');
  });

  test('SF verifier rejects when X-Callio-Timestamp is tampered (sig was bound to original ts)', async () => {
    const sub = buildSubscription();
    const service = buildService([sub]);
    await service.emitEvent('ws-1', WebhookEventType.MESSAGE_INBOUND, {});
    const [, body, opts] = mockedAxiosPost.mock.calls[0] as any;

    const headers = { ...opts.headers, 'X-Callio-Timestamp': '9999999999' };
    const r = verifySfShape({
      headers,
      rawBody: JSON.stringify(body),
      secret: SECRET,
      nowSec: 9999999999, // pretend "now" is the tampered ts so replay check passes
    });
    // The signature is still bound to the ORIGINAL ts → verifier sees mismatch
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('signature_mismatch');
  });

  test('replay window: a sig captured 6 min ago is rejected even if otherwise valid', async () => {
    const sub = buildSubscription();
    const service = buildService([sub]);
    await service.emitEvent('ws-1', WebhookEventType.MESSAGE_INBOUND, {});
    const [, body, opts] = mockedAxiosPost.mock.calls[0] as any;

    // Verify with "now" 6 minutes after the sig was made
    const tsCaptured = parseInt((opts.headers as any)['X-Callio-Timestamp'], 10);
    const r = verifySfShape({
      headers: opts.headers,
      rawBody: JSON.stringify(body),
      secret: SECRET,
      nowSec: tsCaptured + 6 * 60,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('stale_timestamp');
  });

  test('OLD body-only signature format would be REJECTED by SF — proves the contract changed', async () => {
    const sub = buildSubscription();
    const service = buildService([sub]);
    await service.emitEvent('ws-1', WebhookEventType.MESSAGE_INBOUND, {});
    const [, body, opts] = mockedAxiosPost.mock.calls[0] as any;

    // Compute what the OLD format would've been (HMAC over body only)
    const oldFormatSig = crypto
      .createHmac('sha256', SECRET)
      .update(JSON.stringify(body))
      .digest('hex');

    // Sub the new sig with the old-format sig
    const headers = { ...opts.headers, 'X-Callio-Signature': oldFormatSig };
    const r = verifySfShape({
      headers,
      rawBody: JSON.stringify(body),
      secret: SECRET,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('signature_mismatch');
  });

  test('subscriptions without secret get unsigned deliveries — no X-Callio-Signature header', async () => {
    const sub = buildSubscription({ secret: null });
    const service = buildService([sub]);
    await service.emitEvent('ws-1', WebhookEventType.MESSAGE_INBOUND, {});
    const [, , opts] = mockedAxiosPost.mock.calls[0] as any;
    expect((opts.headers as any)['X-Callio-Signature']).toBeUndefined();
    // Timestamp is still stamped (it's not gated on secret)
    expect((opts.headers as any)['X-Callio-Timestamp']).toMatch(/^\d{10}$/);
  });
});

describe('OutboundWebhooksService.testSubscription — same signature contract', () => {
  const SECRET = 'test-sub-secret-32-bytes-of-randomness';

  test('testSubscription delivers with epoch ts + ts.body HMAC', async () => {
    const sub = buildSubscription({
      id: 'sub-under-test',
      secret: SECRET,
    });
    // testSubscription uses findOne, not find
    const subscriptionRepo: any = {
      find: jest.fn(),
      findOne: jest.fn().mockResolvedValue(sub),
      update: jest.fn(),
    };
    const service = new OutboundWebhooksService(subscriptionRepo);

    const result = await service.testSubscription('ws-1', sub.id);
    expect(result.success).toBe(true);
    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);

    const [url, body, opts] = mockedAxiosPost.mock.calls[0] as any;
    expect(url).toBe(sub.webhookUrl);
    const headers = opts.headers as Record<string, string>;

    // Test marker preserved
    expect(headers['X-Callio-Test']).toBe('true');

    // Same contract as production sends
    expect(headers['X-Callio-Timestamp']).toMatch(/^\d{10}$/);
    expect(headers['X-Callio-Signature']).toMatch(/^[a-f0-9]{64}$/);

    const r = verifySfShape({
      headers,
      rawBody: JSON.stringify(body),
      secret: SECRET,
    });
    expect(r).toEqual({ valid: true, reason: null });
  });
});
