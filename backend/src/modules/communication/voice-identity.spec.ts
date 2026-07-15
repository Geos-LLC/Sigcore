import { VoiceIdentity } from './voice-identity';

// The identity format is a cross-repo contract (Callio's inbound TwiML
// builder must produce the same string this file mints). Callers MUST use
// the encoder/decoder — never concatenate the format themselves — so the
// format can evolve without a wide refactor. These tests pin the current
// v1 shape and lock in the invariants a future v2 would need to preserve.
describe('VoiceIdentity', () => {
  const ws = '6e378229-49dd-4b5f-bea3-50e10daf084f';
  const user = '3b07dd25-1234-5678-9abc-def012345678';

  describe('encode', () => {
    it('returns the workspaceId unchanged when only workspaceId is supplied (legacy)', () => {
      expect(VoiceIdentity.encode({ workspaceId: ws })).toBe(ws);
    });

    it('returns ws_<workspaceId>_user_<userId> for per-user scope', () => {
      expect(VoiceIdentity.encode({ workspaceId: ws, userId: user })).toBe(
        `ws_${ws}_user_${user}`,
      );
    });

    it('accepts future-reserved clientType / deviceId without breaking (v1 ignores them)', () => {
      // The point of the richer input shape: callers can start passing these
      // TODAY without waiting for v2. When v2 lands and starts encoding them,
      // no call site has to change.
      expect(
        VoiceIdentity.encode({
          workspaceId: ws,
          userId: user,
          clientType: 'browser',
          deviceId: 'tab-1',
        }),
      ).toBe(`ws_${ws}_user_${user}`);
    });

    it('throws on missing workspaceId — defensive against silent workspace-scope loss', () => {
      // If a future refactor ever computes the input with a missing
      // workspaceId, silently returning `undefined` (or empty string) would
      // let Twilio issue an unroutable token. Throw so the bug surfaces.
      expect(() =>
        VoiceIdentity.encode({ workspaceId: '' as unknown as string }),
      ).toThrow(/workspaceId is required/i);
    });

    it('per-user identity fits within Twilio VoiceGrant identity length limit', () => {
      // Twilio docs: identity max 121 chars. Two UUIDs + "ws__user_" = 82.
      const id = VoiceIdentity.encode({ workspaceId: ws, userId: user });
      expect(id.length).toBeLessThanOrEqual(121);
    });

    it('per-user identity uses only Twilio-allowed identity characters', () => {
      const id = VoiceIdentity.encode({ workspaceId: ws, userId: user });
      // Twilio identity charset: alphanumeric + `-_.~:` — no spaces, no !@#.
      expect(id).toMatch(/^[A-Za-z0-9_.~:-]+$/);
    });
  });

  describe('decode', () => {
    it('returns { workspaceId, userId } for per-user identity', () => {
      expect(VoiceIdentity.decode(`ws_${ws}_user_${user}`)).toEqual({
        workspaceId: ws,
        userId: user,
      });
    });

    it('returns { workspaceId } for bare workspace identity (legacy)', () => {
      expect(VoiceIdentity.decode(ws)).toEqual({ workspaceId: ws });
    });

    it('round-trips through encode', () => {
      expect(VoiceIdentity.decode(VoiceIdentity.encode({ workspaceId: ws, userId: user }))).toEqual({
        workspaceId: ws,
        userId: user,
      });
      expect(VoiceIdentity.decode(VoiceIdentity.encode({ workspaceId: ws }))).toEqual({
        workspaceId: ws,
      });
    });

    it('returns undefined for unparseable input', () => {
      expect(VoiceIdentity.decode('')).toBeUndefined();
      expect(VoiceIdentity.decode(null)).toBeUndefined();
      expect(VoiceIdentity.decode(undefined)).toBeUndefined();
      expect(VoiceIdentity.decode('ws_only_but_no_user_suffix_$$$')).toBeUndefined();
    });

    it('does not misparse a value that starts with "ws_" but has no _user_ segment', () => {
      expect(VoiceIdentity.decode('ws_someUnexpectedShape')).toBeUndefined();
    });
  });

  describe('isPerUser', () => {
    it('true only for v1 per-user identities', () => {
      expect(VoiceIdentity.isPerUser(`ws_${ws}_user_${user}`)).toBe(true);
      expect(VoiceIdentity.isPerUser(ws)).toBe(false);
      expect(VoiceIdentity.isPerUser('some-random-string')).toBe(false);
    });
  });
});
