/**
 * Twilio Voice SDK identity encoder/decoder.
 *
 * The wire format `ws_<workspaceId>_user_<userId>` is an implementation
 * detail — callers MUST go through `VoiceIdentity.encode` / `.decode` so
 * the format can evolve (v2 shape, encrypted identities, per-device
 * suffixes) without hunting down string concatenations across the codebase.
 *
 * Cross-repo contract: Callio's inbound TwiML builder for Feature 2 will
 * consume identities in the same format, so any change here must land in
 * lockstep with a matching change on the Callio side. The tests in
 * `voice-identity.spec.ts` pin the format explicitly.
 */

export interface VoiceIdentityInput {
  /** REQUIRED. Sigcore workspace UUID. */
  workspaceId: string;
  /** Optional per-user scope. Absent = legacy workspace-only identity. */
  userId?: string;
  /**
   * Reserved for future multi-device support (desktop / mobile / native).
   * NOT encoded in v1 — the field exists so callers can pass the value
   * today without breaking when the format evolves.
   */
  clientType?: string;
  /** Reserved for future per-device identities. NOT encoded in v1. */
  deviceId?: string;
}

export interface DecodedVoiceIdentity {
  workspaceId: string;
  userId?: string;
  /** Populated when a future format version carries client-type. */
  clientType?: string;
  /** Populated when a future format version carries device-id. */
  deviceId?: string;
}

// Wire format is delimited by underscores. Both segments constrained to
// characters Twilio VoiceGrant identity accepts.
const V1_PER_USER_RE = /^ws_([A-Za-z0-9.~:-]+)_user_([A-Za-z0-9.~:-]+)$/;
const V1_LEGACY_RE = /^[A-Za-z0-9.~:-]{1,121}$/;

export const VoiceIdentity = {
  /**
   * Encode a user-scoped identity for Twilio VoiceGrant.
   *
   * v1 encodes only workspaceId + userId. Extra fields (clientType,
   * deviceId) are accepted so future call sites don't have to be
   * retrofitted when the format evolves.
   */
  encode(input: VoiceIdentityInput): string {
    if (!input.workspaceId) {
      throw new Error('VoiceIdentity.encode: workspaceId is required');
    }
    if (input.userId) {
      return `ws_${input.workspaceId}_user_${input.userId}`;
    }
    return input.workspaceId;
  },

  /**
   * Decode an identity emitted by `encode`. Returns `undefined` for
   * unparseable input so callers can distinguish "not our shape" from
   * "successfully parsed legacy shape".
   */
  decode(identity: string | null | undefined): DecodedVoiceIdentity | undefined {
    if (!identity) return undefined;

    const perUserMatch = identity.match(V1_PER_USER_RE);
    if (perUserMatch) {
      return { workspaceId: perUserMatch[1], userId: perUserMatch[2] };
    }

    // Legacy: bare identifier equals workspaceId. Reject anything that
    // starts with `ws_` here — that's a malformed per-user attempt, not a
    // legacy workspace UUID.
    if (V1_LEGACY_RE.test(identity) && !identity.startsWith('ws_')) {
      return { workspaceId: identity };
    }

    return undefined;
  },

  /**
   * Convenience: true if the identity was minted with per-user scope.
   * Useful for guards / metrics that need to gate on "is this a v1 per-user
   * identity" without unpacking the whole shape.
   */
  isPerUser(identity: string): boolean {
    return V1_PER_USER_RE.test(identity);
  },
};
