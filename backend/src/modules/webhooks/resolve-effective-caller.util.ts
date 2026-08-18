/**
 * 2026-08-17 — Forwarded-caller identity capture (Sigcore side).
 *
 * Motivation: when an intermediate PBX (e.g. Quo) bridges a customer's
 * call to a Sigcore-owned Twilio DID, Twilio's `From` field typically
 * carries the PBX's own number rather than the original customer's
 * number. `ForwardedFrom` MAY carry the original identity when the PBX
 * uses SIP-native REFER/302 forwarding — but that varies by provider
 * and configuration.
 *
 * This module is the SINGLE resolver for the normalized
 * `effectiveCallerNumber` value that downstream services (Callio agent,
 * LB lead lookup, session identity) key on. Raw `From` is preserved
 * verbatim for diagnostics; the normalized value is added as a signed
 * envelope header on the Sigcore → Callio forward.
 *
 * Resolution rules (V1 — intentionally conservative):
 *
 *   ForwardedFrom is valid E.164
 *     AND ForwardedFrom !== From
 *     AND ForwardedFrom !== To
 *     AND ForwardedFrom !== businessForwardingNumber (tenant's
 *         configured after-hours handoff number, if any)
 *   → effectiveCallerNumber = ForwardedFrom (customer's true identity
 *     surfaced by SIP-native forwarding)
 *
 *   otherwise
 *   → effectiveCallerNumber = From (either a direct call OR a bridge
 *     forward that stripped the original identity — we cannot
 *     distinguish these cases and must not fabricate)
 *
 * The resolver ALWAYS returns a `resolutionSource` string so telemetry
 * can distinguish direct-vs-forwarded-vs-degraded scenarios without
 * heuristics further down the pipeline.
 *
 * NOT provider-specific by design. We do not branch on user-agent or
 * on the specific PBX. If a provider populates additional headers
 * (e.g. `X-Original-From`), that lookup belongs in a caller that
 * extracts from HTTP headers and passes to `resolveEffectiveCaller`
 * as a separate `alternativeCandidates` list — deliberately NOT
 * baked in here so this helper stays a pure function of its inputs.
 */

export interface EffectiveCallerInput {
  /** Twilio's `From` — the calling party number Twilio observed. Required. */
  from: string;
  /** Twilio's `To` — the number Twilio received the call on. Required. */
  to: string;
  /**
   * Twilio's `ForwardedFrom`. Populated when the call reached Twilio via a
   * SIP-native forward (REFER/302); typically absent on bridge-style
   * forwards where the intermediate PBX dials Twilio as a new outbound
   * leg from its own DID.
   */
  forwardedFrom?: string | null;
  /**
   * The tenant's configured after-hours forwarding destination
   * (`tenants.metadata.callForwardingNumber`). Used to reject a
   * `ForwardedFrom` value that equals the business's own forwarding
   * number — that would indicate a self-referential loop rather than
   * a genuine customer identity surfacing through the forward.
   */
  businessForwardingNumber?: string | null;
}

export type CallerResolutionSource =
  /** Direct call OR a bridge-forward where ForwardedFrom is absent. */
  | 'from_direct'
  /** Genuine customer identity surfaced through SIP-native forwarding. */
  | 'forwarded_from'
  /** ForwardedFrom present but rejected (see `reason` on the result). */
  | 'from_fallback_invalid_forwarded_from';

export interface EffectiveCallerResult {
  /** The normalized number downstream services should key on. */
  effectiveCallerNumber: string;
  /** Which of the inputs supplied it. */
  resolutionSource: CallerResolutionSource;
  /**
   * On `from_fallback_invalid_forwarded_from`, an operator-readable
   * explanation of why ForwardedFrom was rejected. `null` on the two
   * happy paths. Kept short + machine-friendly.
   */
  reason:
    | null
    | 'not_e164'
    | 'equals_from'
    | 'equals_to'
    | 'equals_business_forwarding_number';
  /** Preserved raw values for downstream persistence + diagnostics. */
  rawFrom: string;
  rawForwardedFrom: string | null;
}

/**
 * E.164: leading `+`, first digit 1–9, then 6–14 more digits. Same
 * pattern used by Sigcore's DialCallDto validation
 * (`/^\+[1-9]\d{6,14}$/`). Kept local to this file rather than shared
 * so future callers can override the shape without a cross-service
 * dependency.
 */
const E164_RE = /^\+[1-9]\d{6,14}$/;

export function resolveEffectiveCaller(
  input: EffectiveCallerInput,
): EffectiveCallerResult {
  const rawFrom = input.from;
  const rawForwardedFrom =
    typeof input.forwardedFrom === 'string' && input.forwardedFrom.trim().length > 0
      ? input.forwardedFrom.trim()
      : null;

  if (!rawForwardedFrom) {
    return {
      effectiveCallerNumber: rawFrom,
      resolutionSource: 'from_direct',
      reason: null,
      rawFrom,
      rawForwardedFrom: null,
    };
  }

  if (!E164_RE.test(rawForwardedFrom)) {
    return {
      effectiveCallerNumber: rawFrom,
      resolutionSource: 'from_fallback_invalid_forwarded_from',
      reason: 'not_e164',
      rawFrom,
      rawForwardedFrom,
    };
  }
  if (rawForwardedFrom === input.from) {
    return {
      effectiveCallerNumber: rawFrom,
      resolutionSource: 'from_fallback_invalid_forwarded_from',
      reason: 'equals_from',
      rawFrom,
      rawForwardedFrom,
    };
  }
  if (rawForwardedFrom === input.to) {
    return {
      effectiveCallerNumber: rawFrom,
      resolutionSource: 'from_fallback_invalid_forwarded_from',
      reason: 'equals_to',
      rawFrom,
      rawForwardedFrom,
    };
  }
  const biz =
    typeof input.businessForwardingNumber === 'string' &&
    input.businessForwardingNumber.trim().length > 0
      ? input.businessForwardingNumber.trim()
      : null;
  if (biz && rawForwardedFrom === biz) {
    return {
      effectiveCallerNumber: rawFrom,
      resolutionSource: 'from_fallback_invalid_forwarded_from',
      reason: 'equals_business_forwarding_number',
      rawFrom,
      rawForwardedFrom,
    };
  }

  return {
    effectiveCallerNumber: rawForwardedFrom,
    resolutionSource: 'forwarded_from',
    reason: null,
    rawFrom,
    rawForwardedFrom,
  };
}
