import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';

/**
 * Carrier lookup via Twilio Lookup v2 line_type_intelligence.
 *
 * Sigcore already carries master Twilio credentials for subaccount
 * provisioning (see TwilioSubaccountProvisionerService); we reuse the
 * same env-var pattern for consistency:
 *
 *   SIGCORE_TWILIO_MASTER_ACCOUNT_SID  (preferred)
 *   SIGCORE_TWILIO_MASTER_AUTH_TOKEN   (preferred)
 *   TWILIO_ACCOUNT_SID                 (fallback)
 *   TWILIO_AUTH_TOKEN                  (fallback)
 *
 * Consumers today: LeadBridge signup flow. AuthService.register calls
 * this at signup time to stamp User.signupPhoneCarrier / lineType /
 * integration so the post-connect wizard can offer Quo / OpenPhone
 * connect cards. The integration-slug mapping lives in LB (it's
 * LB-specific policy) — this service returns the raw Twilio data.
 */

export interface CarrierLookupResult {
  /** Carrier as returned by Twilio, e.g. "Quo Communications". Null on error/no data. */
  carrier: string | null;
  /** Twilio's classification: mobile / landline / voip / fixedVoip / nonFixedVoip. */
  lineType: LineType | null;
}

export type LineType = 'mobile' | 'landline' | 'voip' | 'fixedVoip' | 'nonFixedVoip';

const KNOWN_LINE_TYPES: readonly string[] = ['mobile', 'landline', 'voip', 'fixedVoip', 'nonFixedVoip'];

@Injectable()
export class CarrierLookupService {
  private readonly logger = new Logger(CarrierLookupService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Best-effort carrier lookup. Never throws — returns
   * { carrier: null, lineType: null } on ANY error (invalid E.164
   * input, missing creds, Twilio 5xx, network failure). Caller
   * (LB via the lookups controller) treats a null result as "unknown"
   * and skips the wizard offer / admin-email carrier lines.
   */
  async lookup(phoneE164: string): Promise<CarrierLookupResult> {
    const empty: CarrierLookupResult = { carrier: null, lineType: null };
    if (typeof phoneE164 !== 'string') return empty;
    const trimmed = phoneE164.trim();
    if (!/^\+\d{8,15}$/.test(trimmed)) return empty;

    const sid =
      this.configService.get<string>('SIGCORE_TWILIO_MASTER_ACCOUNT_SID') ??
      this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const token =
      this.configService.get<string>('SIGCORE_TWILIO_MASTER_AUTH_TOKEN') ??
      this.configService.get<string>('TWILIO_AUTH_TOKEN');
    if (!sid || !token) {
      this.logger.warn('[CarrierLookup] no master Twilio credentials — skipping lookup');
      return empty;
    }

    // 3s hard cap. Twilio's normal Lookup v2 p99 is ~400ms; anything
    // above 3s is either a Twilio-side outage or a network problem
    // and the LB caller wants a null-result fallback quickly (the
    // signup admin-email waits sequentially on this).
    let timer: NodeJS.Timeout | null = null;
    try {
      const client = new Twilio(sid, token);
      const lookupPromise = client.lookups.v2
        .phoneNumbers(trimmed)
        .fetch({ fields: 'line_type_intelligence' });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('CarrierLookup timeout after 3000ms')), 3000);
      });
      const result: any = await Promise.race([lookupPromise, timeoutPromise]);

      const lti = result?.lineTypeIntelligence;
      const carrier =
        typeof lti?.carrier_name === 'string' && lti.carrier_name.trim().length > 0
          ? lti.carrier_name.trim()
          : null;
      const typeRaw = typeof lti?.type === 'string' ? lti.type.trim() : null;
      const lineType =
        typeRaw && KNOWN_LINE_TYPES.includes(typeRaw) ? (typeRaw as LineType) : null;
      return { carrier, lineType };
    } catch (err: any) {
      this.logger.warn(`[CarrierLookup] failed for ${trimmed}: ${err?.message || err}`);
      return empty;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
