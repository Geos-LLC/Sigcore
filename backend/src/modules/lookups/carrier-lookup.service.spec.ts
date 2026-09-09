import { CarrierLookupService } from './carrier-lookup.service';

// Twilio SDK is mocked to avoid live HTTPS calls and to control the
// exact response shape. Only the shape of `lineTypeIntelligence` on
// the SDK's fetch result matters to the service under test.
jest.mock('twilio', () => {
  return {
    Twilio: jest.fn().mockImplementation(() => {
      return {
        lookups: {
          v2: {
            phoneNumbers: (_number: string) => ({
              fetch: (globalThis as any).__twilioFetchMock,
            }),
          },
        },
      };
    }),
  };
});

/**
 * Sigcore CarrierLookupService — pure logic (no live Twilio call).
 * Exercises the guardrails and the response mapping. LB owns the
 * carrier→integration policy mapping, so this service just surfaces
 * the raw carrier + lineType or null.
 */
describe('Sigcore CarrierLookupService', () => {
  const cfg = (values: Record<string, string | undefined>) => ({
    get: (key: string) => values[key],
  }) as any;

  beforeEach(() => {
    (globalThis as any).__twilioFetchMock = jest.fn();
  });

  it('short-circuits on non-E.164 input (no call to Twilio)', async () => {
    const svc = new CarrierLookupService(cfg({
      SIGCORE_TWILIO_MASTER_ACCOUNT_SID: 'ACtest',
      SIGCORE_TWILIO_MASTER_AUTH_TOKEN: 'tok',
    }));
    expect(await svc.lookup('')).toEqual({ carrier: null, lineType: null });
    expect(await svc.lookup('12483462681')).toEqual({ carrier: null, lineType: null });
    expect(await svc.lookup('+abc')).toEqual({ carrier: null, lineType: null });
    expect(await svc.lookup('+1')).toEqual({ carrier: null, lineType: null });
    expect(await svc.lookup('+1234567890123456')).toEqual({ carrier: null, lineType: null }); // > 15 digits
    expect((globalThis as any).__twilioFetchMock).not.toHaveBeenCalled();
  });

  it('short-circuits when master creds are missing (both preferred + fallback)', async () => {
    const svc = new CarrierLookupService(cfg({}));
    expect(await svc.lookup('+12483462681')).toEqual({ carrier: null, lineType: null });
    expect((globalThis as any).__twilioFetchMock).not.toHaveBeenCalled();
  });

  it('falls back to TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN when SIGCORE_* not set', async () => {
    // Same pattern as TwilioSubaccountProvisionerService.readMasterCredentials.
    (globalThis as any).__twilioFetchMock.mockResolvedValueOnce({
      lineTypeIntelligence: { type: 'mobile', carrier_name: 'Verizon Wireless' },
    });
    const svc = new CarrierLookupService(cfg({
      TWILIO_ACCOUNT_SID: 'ACfallback',
      TWILIO_AUTH_TOKEN: 'tokFallback',
    }));
    const res = await svc.lookup('+12483462681');
    expect(res).toEqual({ carrier: 'Verizon Wireless', lineType: 'mobile' });
  });

  it('maps Twilio VoIP response through untouched (carrier + lineType)', async () => {
    (globalThis as any).__twilioFetchMock.mockResolvedValueOnce({
      lineTypeIntelligence: { type: 'nonFixedVoip', carrier_name: 'Quo Communications' },
    });
    const svc = new CarrierLookupService(cfg({
      SIGCORE_TWILIO_MASTER_ACCOUNT_SID: 'AC',
      SIGCORE_TWILIO_MASTER_AUTH_TOKEN: 'tok',
    }));
    const res = await svc.lookup('+12483462681');
    expect(res).toEqual({ carrier: 'Quo Communications', lineType: 'nonFixedVoip' });
  });

  it('returns null lineType when Twilio returns an unrecognized type string', async () => {
    // Defensive: don't leak arbitrary Twilio strings — LB narrows on
    // the response shape and unknown values would type-error.
    (globalThis as any).__twilioFetchMock.mockResolvedValueOnce({
      lineTypeIntelligence: { type: 'satellite', carrier_name: 'Iridium' },
    });
    const svc = new CarrierLookupService(cfg({
      SIGCORE_TWILIO_MASTER_ACCOUNT_SID: 'AC',
      SIGCORE_TWILIO_MASTER_AUTH_TOKEN: 'tok',
    }));
    const res = await svc.lookup('+12483462681');
    expect(res).toEqual({ carrier: 'Iridium', lineType: null });
  });

  it('returns null carrier when Twilio omits carrier_name (whitespace-only counts as missing)', async () => {
    (globalThis as any).__twilioFetchMock.mockResolvedValueOnce({
      lineTypeIntelligence: { type: 'mobile', carrier_name: '   ' },
    });
    const svc = new CarrierLookupService(cfg({
      SIGCORE_TWILIO_MASTER_ACCOUNT_SID: 'AC',
      SIGCORE_TWILIO_MASTER_AUTH_TOKEN: 'tok',
    }));
    const res = await svc.lookup('+12483462681');
    expect(res.carrier).toBeNull();
    expect(res.lineType).toBe('mobile');
  });

  it('swallows Twilio SDK exceptions and returns null result', async () => {
    (globalThis as any).__twilioFetchMock.mockRejectedValueOnce(new Error('Twilio 500'));
    const svc = new CarrierLookupService(cfg({
      SIGCORE_TWILIO_MASTER_ACCOUNT_SID: 'AC',
      SIGCORE_TWILIO_MASTER_AUTH_TOKEN: 'tok',
    }));
    await expect(svc.lookup('+12483462681')).resolves.toEqual({ carrier: null, lineType: null });
  });

  it('never throws — even when the SDK constructor itself explodes', async () => {
    // Cause the Twilio() ctor to blow up by making it throw on next
    // invocation. Verifies the outer try/catch in lookup() covers
    // it (belt + suspenders with the SDK's own rejection path).
    const twilioMock = jest.requireMock('twilio');
    twilioMock.Twilio.mockImplementationOnce(() => { throw new Error('bad creds'); });
    const svc = new CarrierLookupService(cfg({
      SIGCORE_TWILIO_MASTER_ACCOUNT_SID: 'AC',
      SIGCORE_TWILIO_MASTER_AUTH_TOKEN: 'tok',
    }));
    await expect(svc.lookup('+12483462681')).resolves.toEqual({ carrier: null, lineType: null });
  });
});
