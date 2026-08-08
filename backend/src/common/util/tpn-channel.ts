import type { TenantPhoneNumber } from '../../database/entities';

/**
 * Public channels a TenantPhoneNumber can be dialed/sent on. Purchase
 * accepts a third value 'both' — see PurchasePhoneNumberDto — but on the
 * runtime side a caller always asks about a single channel at a time
 * ("can I send SMS from this number?" / "can I dial voice from it?").
 */
export type TpnChannel = 'sms' | 'voice';

interface TpnChannelInput {
  channel: TenantPhoneNumber['channel'];
  metadata?: TenantPhoneNumber['metadata'] | null;
}

/**
 * True if `tpn` supports the requested channel.
 *
 * The TPN.channel enum column has only three real values — SMS, VOICE,
 * WHATSAPP — but PurchasePhoneNumberDto accepts 'both'. To avoid a
 * schema migration when Wave-2 PR4 shipped, `both` purchases were stored
 * as `channel = SMS` in the column with the full request intent
 * ('sms'+'voice') persisted into `metadata.activeChannels`. See the
 * comment in phone-number-provisioning.service.ts near the persistence
 * site for the original design decision.
 *
 * That worked for SMS callers (their guards check for SMS, TPN is SMS
 * → pass) but broke voice dial: the guard at calls.controller.ts's
 * DialCallDto handler rejected TPNs with `channel === 'sms'` even when
 * `metadata.activeChannels` explicitly included 'voice'. Users bought
 * a `both` number, saw `activeChannels: ['sms','voice']` in the
 * purchase response, then got 400 on the first outbound dial.
 *
 * Fix: consult metadata.activeChannels as the source of truth. Fall
 * back to the column for pre-Wave-2 rows that predate the metadata
 * field. Never widen behavior for a row that ONLY has the column set —
 * a legacy SMS-only row still can't be used for voice.
 */
export function tpnSupportsChannel(
  tpn: TpnChannelInput,
  requested: TpnChannel,
): boolean {
  const active = extractActiveChannels(tpn.metadata);
  if (active) {
    return active.includes(requested);
  }
  return String(tpn.channel) === requested;
}

/**
 * Read `metadata.activeChannels` defensively. Returns `null` when the
 * field is absent or malformed — callers fall back to the column.
 */
function extractActiveChannels(
  metadata: TpnChannelInput['metadata'],
): TpnChannel[] | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as { activeChannels?: unknown }).activeChannels;
  if (!Array.isArray(raw)) return null;
  const normalized: TpnChannel[] = [];
  for (const v of raw) {
    if (v === 'sms' || v === 'voice') normalized.push(v);
  }
  return normalized;
}
