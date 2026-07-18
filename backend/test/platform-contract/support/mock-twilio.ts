/**
 * Mock Twilio provider used by the Platform Contract test suite.
 *
 * `TwilioProvider` in production talks to api.twilio.com. In tests we
 * don't want to consume Twilio credits (or require credentials) so this
 * class returns synthetic-but-shape-correct data for every method the
 * provisioning path touches:
 *
 *   validateCredentials -> always true
 *   searchAvailableNumbers -> synthetic list keyed by area code
 *   purchasePhoneNumber -> synthetic PN SID + capabilities
 *   configureWebhooks -> no-op, always success
 *   createApiKey / createTwiMLApp -> synthetic success
 *
 * Not exhaustive — extend as new scenarios exercise additional methods.
 * The point is to keep the test suite hermetic: no network, no billing.
 */

let seq = 0;
function nextSid(prefix: string): string {
  seq += 1;
  return `${prefix}${seq.toString(16).padStart(32, '0')}`;
}

export class MockTwilioProvider {
  async validateCredentials(): Promise<boolean> { return true; }

  async searchAvailableNumbers(
    _credentials: unknown,
    country: string,
    areaCode?: string,
  ): Promise<Array<{ phoneNumber: string; locality?: string; region?: string; capabilities: string[] }>> {
    const code = areaCode ?? '206';
    return Array.from({ length: 3 }).map((_, i) => ({
      phoneNumber: `+1${code}${String(7000000 + i + seq).slice(0, 7)}`,
      locality: 'TestCity',
      region: country,
      capabilities: ['sms', 'voice', 'mms'],
    }));
  }

  async purchasePhoneNumber(
    _credentials: unknown,
    phoneNumber: string,
  ): Promise<{ phoneNumber: string; sid: string; friendlyName: string; capabilities: string[] }> {
    return {
      phoneNumber,
      sid: nextSid('PN'),
      friendlyName: phoneNumber,
      capabilities: ['sms', 'voice', 'mms'],
    };
  }

  async releasePhoneNumber(): Promise<{ success: boolean }> {
    return { success: true };
  }

  async configureWebhooks(): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }

  async createApiKey(): Promise<{ success: boolean; apiKey?: { sid: string; secret: string } }> {
    return {
      success: true,
      apiKey: { sid: nextSid('SK'), secret: nextSid('secret') },
    };
  }

  async createTwiMLApp(): Promise<{ success: boolean; twimlApp?: { sid: string } }> {
    return {
      success: true,
      twimlApp: { sid: nextSid('AP') },
    };
  }

  async getPhoneNumbersArray(): Promise<any[]> { return []; }

  async lookupPhoneNumber(): Promise<{ found: boolean; sid?: string }> {
    return { found: true, sid: nextSid('PN') };
  }
}
