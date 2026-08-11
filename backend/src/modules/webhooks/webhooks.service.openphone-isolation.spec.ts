import axios from 'axios';
import { WebhooksService } from './webhooks.service';

// Cross-workspace data leak — issue #50.
// Regression guard: OpenPhone webhook handlers MUST reject events whose
// phoneNumberId isn't owned by the workspace they'd be written under.
// Prod evidence: 472 foreign OpenPhone calls piled into a single Sigcore
// workspace's DB (`1bcbb4e0-df1b-481c-83ba-0730df47a720`) because
// resolvePhoneNumber's failure returned an empty phone rather than a
// discriminated 'foreign' result, and callers proceeded to persist.

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------
function buildMockQueryBuilder() {
  return {
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
    getMany: jest.fn().mockResolvedValue([]),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
  } as any;
}

function buildMockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((data: any) => ({ id: 'generated-id', ...data })),
    save: jest.fn(async (entity: any) => entity),
    update: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn().mockImplementation(() => buildMockQueryBuilder()),
    query: jest.fn(),
  };
}

function buildService(opts: {
  ownedPhones?: Array<{ id: string; number: string; name?: string }>;
  /** When true, integrationRepo.findOne returns null (simulates missing creds). */
  noIntegration?: boolean;
  /** When true, axios.get throws (simulates OpenPhone API outage). */
  apiOutage?: boolean;
} = {}) {
  const conversationRepo = buildMockRepo();
  const messageRepo = buildMockRepo();
  const callRepo = buildMockRepo();
  const integrationRepo = buildMockRepo();
  const workspaceRepo = buildMockRepo();
  const tenantPhoneNumberRepo = buildMockRepo();
  const tenantIntegrationRepo = buildMockRepo();
  const webhookSubscriptionRepo = buildMockRepo();

  const encryptionService = {
    decrypt: jest.fn().mockReturnValue(JSON.stringify({ apiKey: 'test-key' })),
    encrypt: jest.fn(),
  };
  const eventsGateway = {
    emitNewMessage: jest.fn(),
    emitNewConversation: jest.fn(),
    emitConversationUpdate: jest.fn(),
    emitNewCall: jest.fn(),
  };
  const openPhoneProvider = {};
  const idempotencyService = {
    isDuplicate: jest.fn().mockResolvedValue(false),
    markProcessed: jest.fn(),
  };
  const outboundWebhooksService = {
    emitEvent: jest.fn().mockResolvedValue(undefined),
    emitMessageEvent: jest.fn().mockResolvedValue(undefined),
  };
  const s3Service = {
    isConfigured: jest.fn().mockReturnValue(false),
    buildKey: jest.fn(),
    putObject: jest.fn(),
    headObject: jest.fn().mockResolvedValue(false),
    getObjectStream: jest.fn().mockResolvedValue(null),
  };

  // Integration lookup
  if (opts.noIntegration) {
    integrationRepo.findOne.mockResolvedValue(null);
  } else {
    integrationRepo.findOne.mockResolvedValue({
      id: 'int-1',
      workspaceId: 'ws-1',
      credentialsEncrypted: 'encrypted-blob',
    });
  }

  // OpenPhone API mock — resolvePhoneNumber calls
  //   require('axios').create({...}).get('/phone-numbers')
  const axiosGet = opts.apiOutage
    ? jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    : jest.fn().mockResolvedValue({
        data: {
          data: (opts.ownedPhones ?? []).map((p) => ({
            id: p.id,
            number: p.number,
            name: p.name ?? null,
          })),
        },
      });
  mockedAxios.create = jest.fn().mockReturnValue({ get: axiosGet }) as any;

  const service = new WebhooksService(
    conversationRepo as any,
    messageRepo as any,
    callRepo as any,
    integrationRepo as any,
    workspaceRepo as any,
    tenantPhoneNumberRepo as any,
    tenantIntegrationRepo as any,
    webhookSubscriptionRepo as any,
    encryptionService as any,
    eventsGateway as any,
    openPhoneProvider as any,
    idempotencyService as any,
    outboundWebhooksService as any,
    s3Service as any,
  );

  return {
    service,
    conversationRepo,
    messageRepo,
    callRepo,
    integrationRepo,
    axiosCreate: mockedAxios.create as jest.Mock,
    axiosGet,
  };
}

const WS_ID = 'ws-1';
const OWNED_PN = 'PNAXBSP9M6'; // matches issue evidence: workspace-owned
const FOREIGN_PN = 'PNhPoQSKvP'; // matches issue evidence: from a different Quo tenant

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('WebhooksService — OpenPhone cross-workspace isolation (issue #50)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('handleMessageEvent', () => {
    it('REJECTS foreign phoneNumberId and never writes to the DB', async () => {
      const { service, conversationRepo, messageRepo } = buildService({
        ownedPhones: [{ id: OWNED_PN, number: '+18885551234', name: 'TollFree' }],
      });

      await (service as any).handleMessageEvent(WS_ID, {
        type: 'message.received',
        data: {
          object: {
            id: 'MSGforeign',
            phoneNumberId: FOREIGN_PN,
            direction: 'incoming',
            from: '+15559999999',
            to: '+18885551234',
            text: 'leaked payload',
            createdAt: '2026-08-10T00:00:00Z',
          },
        },
      });

      expect(conversationRepo.save).not.toHaveBeenCalled();
      expect(conversationRepo.create).not.toHaveBeenCalled();
      expect(messageRepo.save).not.toHaveBeenCalled();
      expect(messageRepo.create).not.toHaveBeenCalled();
    });

    it('ADMITS owned phoneNumberId (control case)', async () => {
      const { service, conversationRepo, messageRepo } = buildService({
        ownedPhones: [{ id: OWNED_PN, number: '+18885551234', name: 'TollFree' }],
      });

      await (service as any).handleMessageEvent(WS_ID, {
        type: 'message.received',
        data: {
          object: {
            id: 'MSGowned',
            phoneNumberId: OWNED_PN,
            direction: 'incoming',
            from: '+15551112222',
            to: '+18885551234',
            text: 'legit',
            createdAt: '2026-08-10T00:00:00Z',
          },
        },
      });

      expect(conversationRepo.save).toHaveBeenCalled();
      expect(messageRepo.save).toHaveBeenCalled();
    });

    it('does NOT reject when resolvePhoneNumber is unresolvable (API outage) — legitimate traffic still lands', async () => {
      const { service, conversationRepo, messageRepo } = buildService({ apiOutage: true });

      await (service as any).handleMessageEvent(WS_ID, {
        type: 'message.received',
        data: {
          object: {
            id: 'MSGoutage',
            phoneNumberId: OWNED_PN,
            direction: 'incoming',
            from: '+15551112222',
            to: '+18885551234',
            text: 'during outage',
            createdAt: '2026-08-10T00:00:00Z',
          },
        },
      });

      expect(conversationRepo.save).toHaveBeenCalled();
      expect(messageRepo.save).toHaveBeenCalled();
    });

    it('does NOT reject when workspace has no OpenPhone integration credentials', async () => {
      const { service, conversationRepo, messageRepo } = buildService({ noIntegration: true });

      await (service as any).handleMessageEvent(WS_ID, {
        type: 'message.received',
        data: {
          object: {
            id: 'MSGnocreds',
            phoneNumberId: OWNED_PN,
            direction: 'incoming',
            from: '+15551112222',
            to: '+18885551234',
            text: 'no creds',
            createdAt: '2026-08-10T00:00:00Z',
          },
        },
      });

      expect(conversationRepo.save).toHaveBeenCalled();
      expect(messageRepo.save).toHaveBeenCalled();
    });
  });

  describe('handleCallCompletedEvent', () => {
    it('REJECTS foreign phoneNumberId and never writes to the DB', async () => {
      const { service, conversationRepo, callRepo } = buildService({
        ownedPhones: [{ id: OWNED_PN, number: '+18885551234', name: 'TollFree' }],
      });

      await (service as any).handleCallCompletedEvent(WS_ID, {
        type: 'call.completed',
        data: {
          object: {
            id: 'AC1ba4d4cdf8',
            phoneNumberId: FOREIGN_PN,
            direction: 'outgoing',
            from: '+18005551234',
            to: ['+15559999999'],
            status: 'completed',
            duration: 42,
            createdAt: '2026-08-10T00:00:00Z',
          },
        },
      });

      expect(conversationRepo.save).not.toHaveBeenCalled();
      expect(conversationRepo.create).not.toHaveBeenCalled();
      expect(callRepo.save).not.toHaveBeenCalled();
      expect(callRepo.create).not.toHaveBeenCalled();
    });

    it('ADMITS owned phoneNumberId (control case)', async () => {
      const { service, conversationRepo, callRepo } = buildService({
        ownedPhones: [{ id: OWNED_PN, number: '+18885551234', name: 'TollFree' }],
      });

      await (service as any).handleCallCompletedEvent(WS_ID, {
        type: 'call.completed',
        data: {
          object: {
            id: 'ACowned',
            phoneNumberId: OWNED_PN,
            direction: 'outgoing',
            from: '+18885551234',
            to: ['+15551112222'],
            status: 'completed',
            duration: 30,
            createdAt: '2026-08-10T00:00:00Z',
          },
        },
      });

      expect(conversationRepo.save).toHaveBeenCalled();
      expect(callRepo.save).toHaveBeenCalled();
    });
  });

  describe('handleVoicemailEvent (delegates to handleCallCompletedEvent)', () => {
    it('REJECTS foreign phoneNumberId', async () => {
      const { service, conversationRepo, callRepo } = buildService({
        ownedPhones: [{ id: OWNED_PN, number: '+18885551234', name: 'TollFree' }],
      });

      await (service as any).handleVoicemailEvent(WS_ID, {
        type: 'voicemail.received',
        data: {
          object: {
            id: 'ACvmforeign',
            phoneNumberId: FOREIGN_PN,
            direction: 'incoming',
            from: '+15559999999',
            to: ['+18885551234'],
            status: 'no-answer',
            voicemailUrl: 'https://x/vm.mp3',
            createdAt: '2026-08-10T00:00:00Z',
          },
        },
      });

      expect(conversationRepo.save).not.toHaveBeenCalled();
      expect(callRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('resolvePhoneNumber cache', () => {
    it('caches foreign verdicts — a flood of foreign events triggers only ONE upstream call', async () => {
      const { service, axiosGet } = buildService({
        ownedPhones: [{ id: OWNED_PN, number: '+18885551234', name: 'TollFree' }],
      });

      const buildForeign = (i: number) => ({
        type: 'call.completed',
        data: {
          object: {
            id: `AC-foreign-${i}`,
            phoneNumberId: FOREIGN_PN,
            direction: 'outgoing',
            from: '+18005551234',
            to: ['+15559999999'],
            status: 'completed',
            duration: 1,
            createdAt: '2026-08-10T00:00:00Z',
          },
        },
      });

      await (service as any).handleCallCompletedEvent(WS_ID, buildForeign(1));
      await (service as any).handleCallCompletedEvent(WS_ID, buildForeign(2));
      await (service as any).handleCallCompletedEvent(WS_ID, buildForeign(3));

      // Without caching the foreign verdict, three events would trigger three
      // GET /phone-numbers requests. With caching, exactly one.
      expect(axiosGet).toHaveBeenCalledTimes(1);
    });
  });
});
