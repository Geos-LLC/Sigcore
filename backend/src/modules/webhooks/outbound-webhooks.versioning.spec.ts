/**
 * Payload-versioning contract tests for OutboundWebhooksService.
 *
 * Two contracts coexist:
 *
 *   v1 — pre-2026-06 shape. `message.metadata` is SPREAD flat into
 *        `data`. Every consumer wired before 2026-06-05 (Service Flow,
 *        LeadBridge, Callio, HireFunnel's pre-existing inbound
 *        verifier) reads from this shape. The byte-pin tests below
 *        lock it; if a v1 payload field moves or disappears, the SF/LB
 *        verifier in production will break and these tests will fail
 *        first.
 *
 *   v2 — 2026-06-onwards default. `message.metadata` is NESTED under
 *        `data.metadata`. No flat spread. Default for every new
 *        subscription via `createSubscription`. Upgrade path from v1
 *        is a PATCH on the subscription row.
 *
 * Additive in BOTH versions:
 *   - `deliveredAt` / `failedAt` / `sentAt` aliases, populated only
 *     for the matching event type (MESSAGE_DELIVERED, MESSAGE_FAILED,
 *     MESSAGE_SENT). Safe to add to v1 because nothing reads those
 *     keys today — they're new.
 */

import { OutboundWebhooksService } from './outbound-webhooks.service';
import {
  WebhookEventType,
  WebhookSubscriptionStatus,
} from '../../database/entities/webhook-subscription.entity';

const WS = 'workspace-1';
const TENANT = 'tenant-A';

type SubOver = Partial<{
  id: string;
  workspaceId: string;
  status: WebhookSubscriptionStatus;
  events: WebhookEventType[];
  failureCount: number;
  tenantId: string | null;
  communicationBusinessId: string | null;
  communicationProfileId: string | null;
  payloadVersion: 'v1' | 'v2';
  secret: string;
  webhookUrl: string;
}>;

function sub(over: SubOver = {}): any {
  return {
    id: 'sub-' + Math.random().toString(36).slice(2, 8),
    workspaceId: WS,
    status: WebhookSubscriptionStatus.ACTIVE,
    events: [
      WebhookEventType.MESSAGE_INBOUND,
      WebhookEventType.MESSAGE_DELIVERED,
      WebhookEventType.MESSAGE_FAILED,
      WebhookEventType.MESSAGE_SENT,
    ],
    failureCount: 0,
    tenantId: TENANT,
    communicationBusinessId: null,
    communicationProfileId: null,
    payloadVersion: 'v1' as const,
    secret: 'secret-32-bytes-of-randomness-abc',
    webhookUrl: 'https://example.test/hook',
    ...over,
  };
}

function buildService(subs: any[]) {
  const subscriptionRepo: any = {
    find: jest.fn().mockResolvedValue(subs),
    findOne: jest.fn(),
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (data: any) => ({ id: 'new-sub-id', ...data })),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn(),
  };
  const service = new OutboundWebhooksService(subscriptionRepo);
  (service as any).sendWebhook = jest.fn().mockResolvedValue(undefined);
  return { service, subscriptionRepo };
}

// Captures the payload that sendWebhook would have shipped, mapped by sub id.
function dispatched(service: any): Record<string, any> {
  const calls = (service as any).sendWebhook.mock.calls as Array<[any, any]>;
  const out: Record<string, any> = {};
  for (const [s, payload] of calls) {
    out[s.id] = payload;
  }
  return out;
}

function makeMessage(over: Partial<any> = {}): any {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    direction: 'out',
    channel: 'sms',
    body: 'Hello',
    fromNumber: '+19183091938',
    toNumber: '+13862408898',
    status: 'delivered',
    providerMessageId: 'SMfakefakefakefakefakefakefakefake',
    createdAt: new Date('2026-06-05T19:00:00.000Z'),
    metadata: {
      candidateId: 'cand-9',
      workspaceId: 'hf-workspace-x',
      automationExecutionId: 'exec-7',
      source: 'hiringflow:hf-workspace-x',
    },
    ...over,
  };
}

describe('emitMessageEvent — v1 byte-pin (existing SF/LB/Callio contract)', () => {
  it('spreads message.metadata flat into data — does NOT nest', async () => {
    const v1Sub = sub({ id: 'sf-existing', payloadVersion: 'v1' });
    const { service } = buildService([v1Sub]);

    await service.emitMessageEvent(
      WS,
      WebhookEventType.MESSAGE_DELIVERED,
      makeMessage(),
      undefined,
      { tenantId: TENANT },
    );

    const { 'sf-existing': payload } = dispatched(service);
    expect(payload.event).toBe(WebhookEventType.MESSAGE_DELIVERED);
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Spread metadata → flat keys at data root
    expect(payload.data.candidateId).toBe('cand-9');
    expect(payload.data.workspaceId).toBe('hf-workspace-x');
    expect(payload.data.automationExecutionId).toBe('exec-7');
    expect(payload.data.source).toBe('hiringflow:hf-workspace-x');

    // The v1 contract: data.metadata must NOT exist as a nested object.
    // If anything tries to "improve" v1 by also nesting, SF/LB consumers
    // that iterate data keys (logging, persistence) will see surprise
    // entries.
    expect(payload.data.metadata).toBeUndefined();
  });

  it('preserves the full v1 field set: messageId, conversationId, direction, channel, body, fromNumber, toNumber, status, providerMessageId, createdAt, tenantId', async () => {
    const v1Sub = sub({ payloadVersion: 'v1' });
    const { service } = buildService([v1Sub]);

    await service.emitMessageEvent(
      WS,
      WebhookEventType.MESSAGE_INBOUND,
      makeMessage({ direction: 'in', metadata: {} }),
      undefined,
      { tenantId: TENANT },
    );

    const payload = Object.values(dispatched(service))[0] as any;

    expect(payload.data.messageId).toBe('msg-1');
    expect(payload.data.conversationId).toBe('conv-1');
    expect(payload.data.direction).toBe('in');
    expect(payload.data.channel).toBe('sms');
    expect(payload.data.body).toBe('Hello');
    expect(payload.data.fromNumber).toBe('+19183091938');
    expect(payload.data.toNumber).toBe('+13862408898');
    expect(payload.data.status).toBe('delivered');
    expect(payload.data.providerMessageId).toBe(
      'SMfakefakefakefakefakefakefakefake',
    );
    expect(payload.data.createdAt).toBeDefined();
    expect(payload.data.tenantId).toBe(TENANT);
  });

  it('passes additionalData (e.g. errorCode/errorMessage) through unchanged', async () => {
    const v1Sub = sub({ payloadVersion: 'v1' });
    const { service } = buildService([v1Sub]);

    await service.emitMessageEvent(
      WS,
      WebhookEventType.MESSAGE_FAILED,
      makeMessage({ status: 'failed' }),
      { errorCode: '30007', errorMessage: 'Carrier rejected' },
      { tenantId: TENANT },
    );

    const payload = Object.values(dispatched(service))[0] as any;
    expect(payload.data.errorCode).toBe('30007');
    expect(payload.data.errorMessage).toBe('Carrier rejected');
  });
});

describe('emitMessageEvent — v2 nested-metadata contract', () => {
  it('nests message.metadata under data.metadata — does NOT spread', async () => {
    const v2Sub = sub({ id: 'hf-new', payloadVersion: 'v2' });
    const { service } = buildService([v2Sub]);

    await service.emitMessageEvent(
      WS,
      WebhookEventType.MESSAGE_DELIVERED,
      makeMessage(),
      undefined,
      { tenantId: TENANT },
    );

    const { 'hf-new': payload } = dispatched(service);
    expect(payload.data.metadata).toEqual({
      candidateId: 'cand-9',
      workspaceId: 'hf-workspace-x',
      automationExecutionId: 'exec-7',
      source: 'hiringflow:hf-workspace-x',
    });

    // v2 contract: spread keys MUST NOT appear at data root.
    expect(payload.data.candidateId).toBeUndefined();
    expect(payload.data.automationExecutionId).toBeUndefined();
    expect(payload.data.source).toBeUndefined();
  });

  it('emits an empty object for metadata when message.metadata is null/undefined', async () => {
    const v2Sub = sub({ payloadVersion: 'v2' });
    const { service } = buildService([v2Sub]);

    await service.emitMessageEvent(
      WS,
      WebhookEventType.MESSAGE_DELIVERED,
      makeMessage({ metadata: null }),
      undefined,
      { tenantId: TENANT },
    );

    const payload = Object.values(dispatched(service))[0] as any;
    expect(payload.data.metadata).toEqual({});
  });
});

describe('emitMessageEvent — timestamp aliases (additive in v1 AND v2)', () => {
  it('adds deliveredAt for MESSAGE_DELIVERED in both v1 and v2', async () => {
    const v1Sub = sub({ id: 'v1-sub', payloadVersion: 'v1' });
    const v2Sub = sub({ id: 'v2-sub', payloadVersion: 'v2' });
    const { service } = buildService([v1Sub, v2Sub]);

    await service.emitMessageEvent(
      WS,
      WebhookEventType.MESSAGE_DELIVERED,
      makeMessage(),
      undefined,
      { tenantId: TENANT },
    );

    const out = dispatched(service);
    expect(out['v1-sub'].data.deliveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out['v2-sub'].data.deliveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out['v1-sub'].data.failedAt).toBeUndefined();
    expect(out['v1-sub'].data.sentAt).toBeUndefined();
  });

  it('adds failedAt for MESSAGE_FAILED in both v1 and v2', async () => {
    const v1Sub = sub({ id: 'v1', payloadVersion: 'v1' });
    const v2Sub = sub({ id: 'v2', payloadVersion: 'v2' });
    const { service } = buildService([v1Sub, v2Sub]);

    await service.emitMessageEvent(
      WS,
      WebhookEventType.MESSAGE_FAILED,
      makeMessage({ status: 'failed' }),
      { errorCode: '30007' },
      { tenantId: TENANT },
    );

    const out = dispatched(service);
    expect(out.v1.data.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.v2.data.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.v1.data.deliveredAt).toBeUndefined();
    expect(out.v1.data.sentAt).toBeUndefined();
  });

  it('adds sentAt for MESSAGE_SENT in both v1 and v2', async () => {
    const v1Sub = sub({ id: 'v1', payloadVersion: 'v1' });
    const v2Sub = sub({ id: 'v2', payloadVersion: 'v2' });
    const { service } = buildService([v1Sub, v2Sub]);

    await service.emitMessageEvent(
      WS,
      WebhookEventType.MESSAGE_SENT,
      makeMessage({ status: 'sent' }),
      undefined,
      { tenantId: TENANT },
    );

    const out = dispatched(service);
    expect(out.v1.data.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.v2.data.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.v1.data.deliveredAt).toBeUndefined();
    expect(out.v1.data.failedAt).toBeUndefined();
  });

  it('emits NO status aliases for non-status events (MESSAGE_INBOUND)', async () => {
    const v1Sub = sub({ id: 'v1', payloadVersion: 'v1' });
    const v2Sub = sub({ id: 'v2', payloadVersion: 'v2' });
    const { service } = buildService([v1Sub, v2Sub]);

    await service.emitMessageEvent(
      WS,
      WebhookEventType.MESSAGE_INBOUND,
      makeMessage({ direction: 'in' }),
      undefined,
      { tenantId: TENANT },
    );

    const out = dispatched(service);
    for (const id of ['v1', 'v2']) {
      expect(out[id].data.deliveredAt).toBeUndefined();
      expect(out[id].data.failedAt).toBeUndefined();
      expect(out[id].data.sentAt).toBeUndefined();
    }
  });
});

describe('emitMessageEvent — mixed v1 + v2 in same workspace', () => {
  it('routes each subscription to its own payload shape concurrently', async () => {
    // Models the real production state during migration: SF/LB on v1
    // alongside HF on v2, all in the same workspace, single inbound
    // event fans out two differently-shaped payloads.
    const v1Sub = sub({ id: 'sf-legacy', payloadVersion: 'v1' });
    const v2Sub = sub({ id: 'hf-modern', payloadVersion: 'v2' });
    const { service } = buildService([v1Sub, v2Sub]);

    await service.emitMessageEvent(
      WS,
      WebhookEventType.MESSAGE_DELIVERED,
      makeMessage(),
      undefined,
      { tenantId: TENANT },
    );

    const out = dispatched(service);
    // v1 sub: flat candidateId, no metadata key
    expect(out['sf-legacy'].data.candidateId).toBe('cand-9');
    expect(out['sf-legacy'].data.metadata).toBeUndefined();
    // v2 sub: nested metadata, no flat candidateId
    expect(out['hf-modern'].data.metadata.candidateId).toBe('cand-9');
    expect(out['hf-modern'].data.candidateId).toBeUndefined();
    // Both saw the same event + timestamp envelope shape
    expect(out['sf-legacy'].event).toBe(out['hf-modern'].event);
  });

  it('defaults sub.payloadVersion absence to v1 behavior — defensive', async () => {
    // If a sub row in prod somehow has payloadVersion = undefined
    // (e.g. read from a column added by an in-progress migration with
    // a default not yet applied), the dispatcher must not crash and
    // must not silently emit the v2 shape. Treat unknown as v1.
    const ghostSub = sub({ id: 'ghost', payloadVersion: undefined as any });
    const { service } = buildService([ghostSub]);

    await service.emitMessageEvent(
      WS,
      WebhookEventType.MESSAGE_DELIVERED,
      makeMessage(),
      undefined,
      { tenantId: TENANT },
    );

    const { ghost: payload } = dispatched(service);
    expect(payload.data.candidateId).toBe('cand-9'); // flat = v1 shape
    expect(payload.data.metadata).toBeUndefined();
  });
});

describe('createSubscription — payloadVersion defaulting', () => {
  it('defaults new subscriptions to v2 when payloadVersion is omitted', async () => {
    const { service, subscriptionRepo } = buildService([]);
    subscriptionRepo.findOne.mockResolvedValueOnce(null); // no existing row

    await service.createSubscription(
      WS,
      {
        name: 'New consumer',
        webhookUrl: 'https://new.example.test/hook',
        secret: 'a-secret',
        events: [WebhookEventType.MESSAGE_DELIVERED],
      },
      TENANT,
    );

    const created = subscriptionRepo.create.mock.calls[0][0];
    expect(created.payloadVersion).toBe('v2');
  });

  it('honors an explicit payloadVersion: v1 (opt-out to legacy shape)', async () => {
    const { service, subscriptionRepo } = buildService([]);
    subscriptionRepo.findOne.mockResolvedValueOnce(null);

    await service.createSubscription(
      WS,
      {
        name: 'New consumer pinned to v1',
        webhookUrl: 'https://legacy-consumer.example.test/hook',
        secret: 'a-secret',
        events: [WebhookEventType.MESSAGE_INBOUND],
        payloadVersion: 'v1',
      },
      TENANT,
    );

    const created = subscriptionRepo.create.mock.calls[0][0];
    expect(created.payloadVersion).toBe('v1');
  });

  it('upsert: omitting payloadVersion does NOT change an existing v1 sub', async () => {
    const existing = {
      id: 'existing-sub-id',
      workspaceId: WS,
      webhookUrl: 'https://hf.example.test/hook',
      payloadVersion: 'v1',
    };
    const { service, subscriptionRepo } = buildService([]);
    subscriptionRepo.findOne
      .mockResolvedValueOnce(existing) // first call: find-by-url for upsert
      .mockResolvedValueOnce({ ...existing, name: 'updated' }); // refetch after update

    await service.createSubscription(
      WS,
      {
        name: 'updated',
        webhookUrl: 'https://hf.example.test/hook',
        events: [
          WebhookEventType.MESSAGE_INBOUND,
          WebhookEventType.MESSAGE_DELIVERED,
        ],
      },
      TENANT,
    );

    const updatePatch = subscriptionRepo.update.mock.calls[0][1];
    expect(updatePatch.payloadVersion).toBeUndefined();
  });

  it('upsert: explicit payloadVersion DOES update the existing row (documented migration path)', async () => {
    const existing = {
      id: 'existing-sub-id',
      workspaceId: WS,
      webhookUrl: 'https://hf.example.test/hook',
      payloadVersion: 'v1',
    };
    const { service, subscriptionRepo } = buildService([]);
    subscriptionRepo.findOne
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce({ ...existing, payloadVersion: 'v2' });

    await service.createSubscription(
      WS,
      {
        name: 'HF migrated to v2',
        webhookUrl: 'https://hf.example.test/hook',
        events: [WebhookEventType.MESSAGE_INBOUND],
        payloadVersion: 'v2',
      },
      TENANT,
    );

    const updatePatch = subscriptionRepo.update.mock.calls[0][1];
    expect(updatePatch.payloadVersion).toBe('v2');
  });
});
