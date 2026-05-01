import { OutboundWebhooksService } from './outbound-webhooks.service';
import {
  WebhookEventType,
  WebhookSubscriptionStatus,
} from '../../database/entities/webhook-subscription.entity';

const WS = 'workspace-1';
const TENANT = 'tenant-A';
const OTHER_TENANT = 'tenant-B';
const BUSINESS = 'biz-1';
const PROFILE = 'prof-1';
const OTHER_PROFILE = 'prof-2';

function sub(over: Partial<any>): any {
  return {
    id: 'sub-' + Math.random().toString(36).slice(2, 8),
    workspaceId: WS,
    status: WebhookSubscriptionStatus.ACTIVE,
    events: [WebhookEventType.MESSAGE_INBOUND],
    failureCount: 0,
    tenantId: null,
    communicationBusinessId: null,
    communicationProfileId: null,
    ...over,
  };
}

function buildService(subs: any[]) {
  const subscriptionRepo: any = {
    find: jest.fn().mockResolvedValue(subs),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const service = new OutboundWebhooksService(subscriptionRepo);
  // Stub the network call so no actual axios fires.
  (service as any).sendWebhook = jest.fn().mockResolvedValue(undefined);
  return { service, subscriptionRepo };
}

describe('OutboundWebhooksService.emitEvent — additive scope fan-out', () => {
  it('fires profile-, business-, tenant-, and workspace-scoped subs all together when scope matches', async () => {
    const wsScoped = sub({});
    const tenantScoped = sub({ tenantId: TENANT });
    const businessScoped = sub({ communicationBusinessId: BUSINESS });
    const profileScoped = sub({ communicationProfileId: PROFILE });
    const otherTenant = sub({ tenantId: OTHER_TENANT });
    const otherProfile = sub({ communicationProfileId: OTHER_PROFILE });

    const { service } = buildService([
      wsScoped,
      tenantScoped,
      businessScoped,
      profileScoped,
      otherTenant,
      otherProfile,
    ]);

    await service.emitEvent(WS, WebhookEventType.MESSAGE_INBOUND, { test: true }, {
      tenantId: TENANT,
      businessId: BUSINESS,
      profileId: PROFILE,
    });

    const sent = (service as any).sendWebhook;
    expect(sent).toHaveBeenCalledTimes(4);
    const calledSubs = sent.mock.calls.map((c: any[]) => c[0]);
    expect(calledSubs).toContain(wsScoped);
    expect(calledSubs).toContain(tenantScoped);
    expect(calledSubs).toContain(businessScoped);
    expect(calledSubs).toContain(profileScoped);
    expect(calledSubs).not.toContain(otherTenant);
    expect(calledSubs).not.toContain(otherProfile);
  });

  it('preserves Issue #114: tenant-scoped sub does NOT fire when event has no tenant scope', async () => {
    const wsScoped = sub({});
    const tenantScoped = sub({ tenantId: TENANT });

    const { service } = buildService([wsScoped, tenantScoped]);
    await service.emitEvent(WS, WebhookEventType.MESSAGE_INBOUND, {}, {});

    const sent = (service as any).sendWebhook;
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0]).toBe(wsScoped);
  });

  it('back-compat: 4th arg as a plain string still acts as tenantId', async () => {
    const tenantScoped = sub({ tenantId: TENANT });
    const otherTenant = sub({ tenantId: OTHER_TENANT });

    const { service } = buildService([tenantScoped, otherTenant]);
    await service.emitEvent(WS, WebhookEventType.MESSAGE_INBOUND, {}, TENANT);

    const sent = (service as any).sendWebhook;
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0]).toBe(tenantScoped);
  });

  it('skips subs whose narrowest scope does not match (mixed scope levels)', async () => {
    const profileScoped = sub({ communicationProfileId: PROFILE });
    const otherProfile = sub({ communicationProfileId: OTHER_PROFILE });
    const tenantScoped = sub({ tenantId: TENANT });

    const { service } = buildService([profileScoped, otherProfile, tenantScoped]);
    await service.emitEvent(WS, WebhookEventType.MESSAGE_INBOUND, {}, {
      tenantId: TENANT,
      businessId: BUSINESS,
      profileId: PROFILE,
    });

    const sent = (service as any).sendWebhook;
    const calledSubs = sent.mock.calls.map((c: any[]) => c[0]);
    expect(calledSubs).toContain(profileScoped);
    expect(calledSubs).toContain(tenantScoped);
    expect(calledSubs).not.toContain(otherProfile);
  });

  it('only fires subs that listen for this specific event type', async () => {
    const wantsInbound = sub({ events: [WebhookEventType.MESSAGE_INBOUND] });
    const wantsCallStarted = sub({ events: [WebhookEventType.CALL_STARTED] });

    const { service } = buildService([wantsInbound, wantsCallStarted]);
    await service.emitEvent(WS, WebhookEventType.MESSAGE_INBOUND, {});

    const sent = (service as any).sendWebhook;
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0]).toBe(wantsInbound);
  });
});
