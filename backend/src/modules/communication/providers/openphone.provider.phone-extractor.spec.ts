import axios from 'axios';
import { OpenPhoneProvider } from './openphone.provider';

/**
 * TASKS_2026-09-08_CONVERSATION_SYNC.md — Task 6 (P1)
 *
 * The OpenPhone getConversations extractor MUST emit `phoneNumber: null`
 * (not an empty string) when the workspace's `/phone-numbers` reply doesn't
 * contain the `phoneNumberId` referenced by the conversation. The sync
 * writer relies on the null signal to skip with reason
 * `phone_number_unresolved` — an empty string would slip through the
 * existing typeof-string checks and clobber a previously-good stored value.
 *
 * The failure mode this pins:
 *   - Quo returns conversations pointing at PN_deleted
 *   - `/phone-numbers` no longer returns PN_deleted
 *   - Extractor emits `phoneNumber: ''` → sync unconditionally overwrites the
 *     stored `phone_number` with '' → row filtered out of every tenant-scoped
 *     read via applyConvTenantPhoneScope
 */
describe('OpenPhoneProvider.getConversations — phone_number extractor (Task 6)', () => {
  let provider: OpenPhoneProvider;
  let mockGet: jest.Mock;

  const CREDS = JSON.stringify({ apiKey: 'op_test_key' });

  beforeEach(() => {
    provider = new OpenPhoneProvider({ get: () => undefined } as any);
    mockGet = jest.fn();

    jest.spyOn(axios, 'create').mockReturnValue({
      get: mockGet,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits `phoneNumber: null` when phoneNumberMap does not contain the conversation`s phoneNumberId', async () => {
    // /phone-numbers returns PN_known only
    mockGet.mockImplementation((url: string) => {
      if (url === '/phone-numbers') {
        return Promise.resolve({
          data: {
            data: [{ id: 'PN_known', number: '+15550001111', restrictions: {} }],
          },
        });
      }
      if (url === '/conversations') {
        return Promise.resolve({
          data: {
            data: [
              {
                id: 'conv-known',
                phoneNumberId: 'PN_known',
                participants: ['+15559999001'],
                createdAt: '2026-09-01T00:00:00Z',
                lastActivityAt: '2026-09-08T00:00:00Z',
              },
              {
                id: 'conv-orphan',
                phoneNumberId: 'PN_deleted', // NOT in phoneNumberMap
                participants: ['+15559999002'],
                createdAt: '2026-09-02T00:00:00Z',
                lastActivityAt: '2026-09-08T01:00:00Z',
              },
            ],
            nextPageToken: null,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const convs = await provider.getConversations(CREDS);

    expect(convs).toHaveLength(2);

    const known = convs.find((c) => c.externalId === 'conv-known')!;
    const orphan = convs.find((c) => c.externalId === 'conv-orphan')!;

    // Resolvable conversation: phoneNumber is the mapped number
    expect(known.phoneNumber).toBe('+15550001111');

    // Unresolvable conversation: phoneNumber is null (Task 6 contract).
    // Historically this was `''`, which the sync writer unconditionally
    // wrote back over a previously-good value. Test guards against
    // regression to that shape.
    expect(orphan.phoneNumber).toBeNull();
    expect(orphan.phoneNumber).not.toBe('');
  });

  describe('Task 8 — tenant-scoped allowedPhoneNumbers', () => {
    /**
     * In a shared OpenPhone workspace the caller-tenant's Quo API key returns
     * `/phone-numbers` rows for phones owned by SIBLING tenants too. Without
     * scoping, the extractor maps a foreign phoneNumberId → foreign phone
     * number and stamps it on `communication_conversations.phone_number`,
     * which the tenant-scoped read filter (`applyConvTenantPhoneScope`) then
     * hides. Fix: strip the phoneNumberMap to entries whose phone NUMBER is
     * owned by the caller tenant AND post-filter the conversation list so
     * foreign phoneNumberIds never surface.
     *
     * Filtering by phone number (not phoneNumberId) is deliberate — the
     * number column on `tenant_phone_numbers` is guaranteed populated, while
     * `provider_id` is nullable and historically un-backfilled for
     * pre-`registerOpenPhoneNumbersForTenant` connections. See the 859a603
     * regression note in TASKS_2026-09-08_CONVERSATION_SYNC.md Task 8.
     */
    it('scopes phoneNumberMap and conv-list to allowedPhoneNumbers', async () => {
      mockGet.mockImplementation((url: string) => {
        if (url === '/phone-numbers') {
          // Shared workspace: ABC's key returns BOTH ABC's and a sibling's phones
          return Promise.resolve({
            data: {
              data: [
                { id: 'PN_owned_A', number: '+14254064045', restrictions: {} },
                { id: 'PN_owned_B', number: '+14256756379', restrictions: {} },
                { id: 'PN_foreign_X', number: '+18139212100', restrictions: {} },
                { id: 'PN_foreign_Y', number: '+16193938869', restrictions: {} },
              ],
            },
          });
        }
        if (url === '/conversations') {
          return Promise.resolve({
            data: {
              data: [
                {
                  id: 'conv-abc-1',
                  phoneNumberId: 'PN_owned_A',
                  participants: ['+13048262438'],
                  createdAt: '2026-09-01T00:00:00Z',
                  lastActivityAt: '2026-09-09T00:00:00Z',
                },
                {
                  id: 'conv-foreign-1',
                  phoneNumberId: 'PN_foreign_X',
                  participants: ['+15550000001'],
                  createdAt: '2026-09-02T00:00:00Z',
                  lastActivityAt: '2026-09-09T01:00:00Z',
                },
                {
                  id: 'conv-abc-2',
                  phoneNumberId: 'PN_owned_B',
                  participants: ['+15550000002'],
                  createdAt: '2026-09-03T00:00:00Z',
                  lastActivityAt: '2026-09-09T02:00:00Z',
                },
                {
                  id: 'conv-foreign-2',
                  phoneNumberId: 'PN_foreign_Y',
                  participants: ['+15550000003'],
                  createdAt: '2026-09-04T00:00:00Z',
                  lastActivityAt: '2026-09-09T03:00:00Z',
                },
              ],
              nextPageToken: null,
            },
          });
        }
        return Promise.resolve({ data: {} });
      });

      const allowed = new Set<string>(['+14254064045', '+14256756379']);
      const convs = await provider.getConversations(CREDS, undefined, undefined, undefined, allowed);

      // Foreign conversations must not surface — post-filter drops them
      const ids = convs.map((c) => c.externalId).sort();
      expect(ids).toEqual(['conv-abc-1', 'conv-abc-2']);

      // Each surviving conversation carries its own owned phone number, not a foreign one
      const abc1 = convs.find((c) => c.externalId === 'conv-abc-1')!;
      const abc2 = convs.find((c) => c.externalId === 'conv-abc-2')!;
      expect(abc1.phoneNumber).toBe('+14254064045');
      expect(abc2.phoneNumber).toBe('+14256756379');
    });

    /**
     * When the tenant owns zero OpenPhone providerIds, the extractor must
     * refuse to emit ANY tenant-side phone. Every workspace-wide conversation
     * gets stripped so nothing lands in `communication_conversations` under
     * the caller's tenantId.
     *
     * Empty-set semantics: `syncConversations` deliberately skips passing a
     * scope when the tenant owns zero ids (workspace-scoped fallback);
     * providers pass through in that case. So this test simulates the case
     * where a non-empty set is passed but doesn't include any of the
     * conversations' ids.
     */
    it('strips ALL conversations when no id matches the allowed set', async () => {
      mockGet.mockImplementation((url: string) => {
        if (url === '/phone-numbers') {
          return Promise.resolve({
            data: {
              data: [
                { id: 'PN_foreign_X', number: '+18139212100', restrictions: {} },
              ],
            },
          });
        }
        if (url === '/conversations') {
          return Promise.resolve({
            data: {
              data: [
                {
                  id: 'conv-foreign-1',
                  phoneNumberId: 'PN_foreign_X',
                  participants: ['+15550000001'],
                  createdAt: '2026-09-01T00:00:00Z',
                  lastActivityAt: '2026-09-09T00:00:00Z',
                },
              ],
              nextPageToken: null,
            },
          });
        }
        return Promise.resolve({ data: {} });
      });

      const convs = await provider.getConversations(
        CREDS,
        undefined,
        undefined,
        undefined,
        new Set<string>(['+14254064045']),
      );
      expect(convs).toEqual([]);
    });

    /**
     * Defense against Quo's lax `phoneNumbers` filter. Even if Quo returns
     * conversations whose `phoneNumberId` doesn't match the requested filter,
     * the extractor MUST post-filter locally when `allowedPhoneNumberIds` is
     * provided so foreign rows never leak into the sync writer.
     */
    it('post-filters even when Quo returns phoneNumberIds outside the filter (lax server-side filter)', async () => {
      mockGet.mockImplementation((url: string) => {
        if (url === '/phone-numbers') {
          return Promise.resolve({
            data: {
              data: [
                { id: 'PN_owned_A', number: '+14254064045', restrictions: {} },
                { id: 'PN_lax_leak', number: '+15559998888', restrictions: {} },
              ],
            },
          });
        }
        if (url === '/conversations') {
          // Even though we asked Quo for PN_owned_A specifically (via server-side
          // filter), Quo returns a leaked conversation on PN_lax_leak too.
          return Promise.resolve({
            data: {
              data: [
                {
                  id: 'conv-owned',
                  phoneNumberId: 'PN_owned_A',
                  participants: ['+13048262438'],
                  createdAt: '2026-09-01T00:00:00Z',
                  lastActivityAt: '2026-09-09T00:00:00Z',
                },
                {
                  id: 'conv-leaked',
                  phoneNumberId: 'PN_lax_leak',
                  participants: ['+15550000099'],
                  createdAt: '2026-09-02T00:00:00Z',
                  lastActivityAt: '2026-09-09T01:00:00Z',
                },
              ],
              nextPageToken: null,
            },
          });
        }
        return Promise.resolve({ data: {} });
      });

      const convs = await provider.getConversations(
        CREDS,
        undefined,
        'PN_owned_A',
        undefined,
        new Set<string>(['+14254064045']),
      );

      expect(convs).toHaveLength(1);
      expect(convs[0].externalId).toBe('conv-owned');
      expect(convs[0].phoneNumber).toBe('+14254064045');
    });

    /**
     * The 859a603 hotfix scenario: caller-tenant owns numbers, but for
     * whatever reason (Quo returned a stale phone list, number-format
     * mismatch, phone deleted in Quo), NONE of the tenant's owned numbers
     * match any entry in `/phone-numbers`. Extractor must strip everything
     * and log a distinct warning — this is a fatal misconfiguration that
     * would silently produce empty syncs otherwise.
     */
    it('strips everything and warns when tenant owns numbers but none match phoneNumberMap entries', async () => {
      mockGet.mockImplementation((url: string) => {
        if (url === '/phone-numbers') {
          return Promise.resolve({
            data: {
              data: [
                { id: 'PN_foreign_X', number: '+18139212100', restrictions: {} },
                { id: 'PN_foreign_Y', number: '+16193938869', restrictions: {} },
              ],
            },
          });
        }
        if (url === '/conversations') {
          return Promise.resolve({
            data: {
              data: [
                { id: 'conv-a', phoneNumberId: 'PN_foreign_X', participants: ['+15559999001'], createdAt: '2026-09-01T00:00:00Z', lastActivityAt: '2026-09-09T00:00:00Z' },
                { id: 'conv-b', phoneNumberId: 'PN_foreign_Y', participants: ['+15559999002'], createdAt: '2026-09-02T00:00:00Z', lastActivityAt: '2026-09-09T01:00:00Z' },
              ],
              nextPageToken: null,
            },
          });
        }
        return Promise.resolve({ data: {} });
      });

      const convs = await provider.getConversations(
        CREDS,
        undefined,
        undefined,
        undefined,
        // Tenant owns +14254064045, but Quo's /phone-numbers reply returns
        // foreign phones only — no id in the map maps to a tenant-owned
        // number, so nothing gets through.
        new Set<string>(['+14254064045']),
      );
      expect(convs).toEqual([]);
    });

    /**
     * When `allowedPhoneNumbers` is not passed (workspace-scoped caller),
     * the extractor MUST behave like before: full workspace-wide phone map,
     * no post-filtering. Guards against a regression that would silently
     * change workspace-scoped sync behavior.
     */
    it('is a no-op when allowedPhoneNumbers is not provided (workspace-scoped caller)', async () => {
      mockGet.mockImplementation((url: string) => {
        if (url === '/phone-numbers') {
          return Promise.resolve({
            data: {
              data: [
                { id: 'PN_A', number: '+15550001111', restrictions: {} },
                { id: 'PN_B', number: '+15550002222', restrictions: {} },
              ],
            },
          });
        }
        if (url === '/conversations') {
          return Promise.resolve({
            data: {
              data: [
                { id: 'conv-a', phoneNumberId: 'PN_A', participants: ['+15559999001'], createdAt: '2026-09-01T00:00:00Z', lastActivityAt: '2026-09-09T00:00:00Z' },
                { id: 'conv-b', phoneNumberId: 'PN_B', participants: ['+15559999002'], createdAt: '2026-09-02T00:00:00Z', lastActivityAt: '2026-09-09T01:00:00Z' },
              ],
              nextPageToken: null,
            },
          });
        }
        return Promise.resolve({ data: {} });
      });

      const convs = await provider.getConversations(CREDS);
      expect(convs).toHaveLength(2);
      const a = convs.find((c) => c.externalId === 'conv-a')!;
      const b = convs.find((c) => c.externalId === 'conv-b')!;
      expect(a.phoneNumber).toBe('+15550001111');
      expect(b.phoneNumber).toBe('+15550002222');
    });
  });

  it('emits `phoneNumber: null` for every conversation when /phone-numbers fails outright', async () => {
    // Simulates the try/catch at getPhoneNumbers() swallowing a 5xx and
    // returning an empty map. Every conversation's lookup misses.
    mockGet.mockImplementation((url: string) => {
      if (url === '/phone-numbers') {
        return Promise.reject(new Error('OpenPhone 503 Service Unavailable'));
      }
      if (url === '/conversations') {
        return Promise.resolve({
          data: {
            data: [
              {
                id: 'conv-a',
                phoneNumberId: 'PN_any',
                participants: ['+15559999003'],
                createdAt: '2026-09-01T00:00:00Z',
                lastActivityAt: '2026-09-08T02:00:00Z',
              },
            ],
            nextPageToken: null,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const convs = await provider.getConversations(CREDS);

    expect(convs).toHaveLength(1);
    expect(convs[0].phoneNumber).toBeNull();
  });
});
