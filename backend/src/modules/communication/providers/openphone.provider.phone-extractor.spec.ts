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
