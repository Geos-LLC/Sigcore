import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TelegramPublisherService } from './telegram-publisher.service';
import { TelegramServiceClient } from './telegram-service.client';
import { TelegramSubscriber } from '../../../database/entities/telegram-subscriber.entity';
import { TelegramPlacement } from '../../../database/entities/telegram-placement.entity';
import { OutboundWebhooksService } from '../../webhooks/outbound-webhooks.service';
import { WebhookEventType } from '../../../database/entities/webhook-subscription.entity';

function makeRepo<T = any>() {
  return {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((x: any) => ({ ...x, id: undefined })),
    update: jest.fn(),
  } as any;
}

describe('TelegramPublisherService', () => {
  let svc: TelegramPublisherService;
  let subRepo: any;
  let plRepo: any;
  let client: any;
  let outbound: any;

  beforeEach(async () => {
    subRepo = makeRepo();
    plRepo = makeRepo();
    client = {
      provisionSubscriber: jest.fn(),
      getSubscriber: jest.fn(),
      verifyChat: jest.fn(),
      publish: jest.fn(),
      cancelMessage: jest.fn(),
      deleteSubscriber: jest.fn(),
      // Account-mode methods
      startAccountLink: jest.fn(),
      submitAccountCode: jest.fn(),
      submitAccountPassword: jest.fn(),
      resendAccountCode: jest.fn(),
      getAccount: jest.fn(),
      deleteAccount: jest.fn(),
    };
    outbound = { emitEvent: jest.fn().mockResolvedValue(undefined) };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramPublisherService,
        { provide: getRepositoryToken(TelegramSubscriber), useValue: subRepo },
        { provide: getRepositoryToken(TelegramPlacement), useValue: plRepo },
        { provide: TelegramServiceClient, useValue: client },
        { provide: OutboundWebhooksService, useValue: outbound },
      ],
    }).compile();

    svc = mod.get(TelegramPublisherService);
  });

  describe('subscribe', () => {
    it('creates a new row and calls µsvc when no subscriber exists', async () => {
      subRepo.findOne.mockResolvedValue(null);
      subRepo.save.mockResolvedValue({ id: 'sub-uuid' });
      subRepo.create.mockImplementation((x: any) => ({ ...x, id: 'sub-uuid' }));
      client.provisionSubscriber.mockResolvedValue({
        subscriberId: 'tp_sub_1',
        botUsername: 'hf_bot',
        status: 'ready',
        inviteHint: 'add me',
      });

      const result = await svc.subscribe('ws-1', 'tenant-1', 'My Bot');

      expect(client.provisionSubscriber).toHaveBeenCalledWith('ws-1', 'My Bot');
      // µsvc bakes everything into one create+save; no separate update.
      expect(subRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-1',
          tenantId: 'tenant-1',
          teleporterSubscriberId: 'tp_sub_1',
          botUsername: 'hf_bot',
          status: 'ready',
        }),
      );
      expect(subRepo.save).toHaveBeenCalled();
      expect(subRepo.update).not.toHaveBeenCalled();
      expect(result).toEqual({ botUsername: 'hf_bot', status: 'ready', inviteHint: 'add me' });
    });

    it('does NOT persist a row when µsvc throws (round-2 regression: no phantom provisioning rows)', async () => {
      subRepo.findOne.mockResolvedValue(null);
      client.provisionSubscriber.mockRejectedValue(
        Object.assign(new Error('teleporter_request_failed'), { status: 400 }),
      );

      await expect(svc.subscribe('ws-1', 'tenant-1', undefined)).rejects.toThrow(
        'teleporter_request_failed',
      );

      // Critical: neither create nor save should be called when upstream rejects.
      expect(subRepo.create).not.toHaveBeenCalled();
      expect(subRepo.save).not.toHaveBeenCalled();
    });

    it('calls µsvc BEFORE any DB write (order check)', async () => {
      subRepo.findOne.mockResolvedValue(null);
      const callOrder: string[] = [];
      client.provisionSubscriber.mockImplementation(async () => {
        callOrder.push('usvc');
        return { subscriberId: 'tp_1', botUsername: 'b', status: 'ready' };
      });
      subRepo.create.mockImplementation((x: any) => {
        callOrder.push('create');
        return { ...x, id: 'r' };
      });
      subRepo.save.mockImplementation(async () => {
        callOrder.push('save');
        return { id: 'r' };
      });

      await svc.subscribe('ws-1', 'tenant-1', undefined);
      expect(callOrder).toEqual(['usvc', 'create', 'save']);
    });

    it('returns existing active subscriber without re-calling µsvc', async () => {
      subRepo.findOne.mockResolvedValue({
        id: 'sub-uuid',
        workspaceId: 'ws-1',
        status: 'ready',
        botUsername: 'existing_bot',
        inviteHint: 'old hint',
      });

      const result = (await svc.subscribe('ws-1', 'tenant-1', undefined)) as any;

      expect(client.provisionSubscriber).not.toHaveBeenCalled();
      expect(result.botUsername).toBe('existing_bot');
      expect(result.status).toBe('ready');
    });
  });

  describe('publish — idempotency', () => {
    it('returns existing placement if (workspace, externalRef) already seen', async () => {
      plRepo.findOne.mockResolvedValue({
        id: 'pl-1',
        status: 'sent',
        scheduledAt: null,
      });

      const result = await svc.publish('ws-1', 'tenant-1', {
        chatRef: '@chan',
        text: 'hi',
        externalRef: 'hf-placement-1',
      } as any);

      expect(result).toEqual({ placementId: 'pl-1', status: 'sent', scheduledAt: undefined });
      expect(client.publish).not.toHaveBeenCalled();
      expect(plRepo.save).not.toHaveBeenCalled();
    });

    it('creates placement + calls µsvc + updates with teleporter id on first call', async () => {
      plRepo.findOne.mockResolvedValue(null);
      plRepo.create.mockReturnValue({ id: 'pl-new' });
      plRepo.save.mockResolvedValue({ id: 'pl-new' });
      client.publish.mockResolvedValue({
        messageId: 'tp_msg_1',
        status: 'queued',
      });

      const result = await svc.publish('ws-1', 'tenant-1', {
        chatRef: '@chan',
        text: 'hi',
        externalRef: 'hf-placement-1',
      } as any);

      expect(client.publish).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'ws-1', idempotencyKey: 'hf-placement-1' }),
      );
      expect(plRepo.update).toHaveBeenCalledWith(
        'pl-new',
        expect.objectContaining({ teleporterMessageId: 'tp_msg_1', status: 'queued' }),
      );
      expect(result).toEqual(
        expect.objectContaining({ placementId: 'pl-new', status: 'queued' }),
      );
    });

    it('marks placement failed and rethrows on µsvc error', async () => {
      plRepo.findOne.mockResolvedValue(null);
      plRepo.create.mockReturnValue({ id: 'pl-new' });
      plRepo.save.mockResolvedValue({ id: 'pl-new' });
      client.publish.mockRejectedValue(new Error('teleporter down'));

      await expect(
        svc.publish('ws-1', 'tenant-1', { chatRef: '@x', text: 't', externalRef: 'k' } as any),
      ).rejects.toThrow('teleporter down');

      expect(plRepo.update).toHaveBeenCalledWith(
        'pl-new',
        expect.objectContaining({ status: 'failed', errorCode: 'TELEPORTER_REQUEST_FAILED' }),
      );
    });
  });

  describe('cancel', () => {
    it('404s on unknown placement', async () => {
      plRepo.findOne.mockResolvedValue(null);
      await expect(svc.cancel('pl-x', 'ws-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409s when already sent', async () => {
      plRepo.findOne.mockResolvedValue({ id: 'pl-1', status: 'sent' });
      await expect(svc.cancel('pl-1', 'ws-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('forwards cancel to µsvc and updates status', async () => {
      plRepo.findOne.mockResolvedValue({
        id: 'pl-1',
        status: 'scheduled',
        teleporterMessageId: 'tp_msg_1',
      });
      await svc.cancel('pl-1', 'ws-1');
      expect(client.cancelMessage).toHaveBeenCalledWith('tp_msg_1');
      expect(plRepo.update).toHaveBeenCalledWith('pl-1', { status: 'cancelled' });
    });

    it('still cancels locally when µsvc forward fails', async () => {
      plRepo.findOne.mockResolvedValue({
        id: 'pl-1',
        status: 'scheduled',
        teleporterMessageId: 'tp_msg_1',
      });
      client.cancelMessage.mockRejectedValue(new Error('upstream down'));
      const result = await svc.cancel('pl-1', 'ws-1');
      expect(plRepo.update).toHaveBeenCalledWith('pl-1', { status: 'cancelled' });
      expect(result.status).toBe('cancelled');
    });
  });

  describe('handleProviderEvent', () => {
    it('updates placement to sent + emits TELEGRAM_PLACEMENT_SENT', async () => {
      plRepo.findOne.mockResolvedValue({
        id: 'pl-1',
        workspaceId: 'ws-1',
        tenantId: 'tenant-1',
        chatRef: '@chan',
        externalRef: 'ext-1',
        teleporterMessageId: 'tp_msg_1',
      });

      await svc.handleProviderEvent({
        workspaceId: 'ws-1',
        eventType: 'placement.sent',
        timestamp: '2026-06-19T00:00:00Z',
        data: { messageId: 'tp_msg_1', providerMessageId: 'tg_999' },
      });

      expect(plRepo.update).toHaveBeenCalledWith(
        'pl-1',
        expect.objectContaining({
          status: 'sent',
          providerMessageId: 'tg_999',
          sentAt: expect.any(Date),
        }),
      );
      expect(outbound.emitEvent).toHaveBeenCalledWith(
        'ws-1',
        WebhookEventType.TELEGRAM_PLACEMENT_SENT,
        expect.objectContaining({ placementId: 'pl-1', status: 'sent', providerMessageId: 'tg_999' }),
        { tenantId: 'tenant-1' },
      );
    });

    it('updates placement to failed + emits TELEGRAM_PLACEMENT_FAILED with error fields', async () => {
      plRepo.findOne.mockResolvedValue({
        id: 'pl-1',
        workspaceId: 'ws-1',
        tenantId: 'tenant-1',
        chatRef: '@chan',
        externalRef: 'ext-1',
        teleporterMessageId: 'tp_msg_1',
      });

      await svc.handleProviderEvent({
        workspaceId: 'ws-1',
        eventType: 'placement.failed',
        timestamp: '2026-06-19T00:00:00Z',
        data: {
          messageId: 'tp_msg_1',
          errorCode: 'CHAT_NOT_FOUND',
          errorMessage: 'no such chat',
        },
      });

      expect(plRepo.update).toHaveBeenCalledWith(
        'pl-1',
        expect.objectContaining({
          status: 'failed',
          errorCode: 'CHAT_NOT_FOUND',
          errorMessage: 'no such chat',
        }),
      );
      expect(outbound.emitEvent).toHaveBeenCalledWith(
        'ws-1',
        WebhookEventType.TELEGRAM_PLACEMENT_FAILED,
        expect.objectContaining({ status: 'failed', errorCode: 'CHAT_NOT_FOUND' }),
        { tenantId: 'tenant-1' },
      );
    });

    it('no-ops on unknown placement (no throw)', async () => {
      plRepo.findOne.mockResolvedValue(null);
      await svc.handleProviderEvent({
        workspaceId: 'ws-1',
        eventType: 'placement.sent',
        timestamp: '2026-06-19T00:00:00Z',
        data: { messageId: 'tp_unknown' },
      });
      expect(plRepo.update).not.toHaveBeenCalled();
      expect(outbound.emitEvent).not.toHaveBeenCalled();
    });

    it('falls back to externalRef lookup when messageId not found', async () => {
      plRepo.findOne
        .mockResolvedValueOnce(null) // by messageId
        .mockResolvedValueOnce({
          id: 'pl-fallback',
          workspaceId: 'ws-1',
          tenantId: null,
          chatRef: '@chan',
          externalRef: 'ext-1',
        });

      await svc.handleProviderEvent({
        workspaceId: 'ws-1',
        eventType: 'placement.sent',
        timestamp: '2026-06-19T00:00:00Z',
        data: { messageId: 'unknown', externalRef: 'ext-1', providerMessageId: 'tg_1' },
      });
      expect(plRepo.update).toHaveBeenCalledWith('pl-fallback', expect.any(Object));
      expect(outbound.emitEvent).toHaveBeenCalled();
    });
  });

  // ===== Account-mode tests =====

  describe('subscribe(mode=account)', () => {
    it('creates a new row in account mode without calling TelePorter', async () => {
      subRepo.findOne.mockResolvedValue(null);
      subRepo.create.mockImplementation((x: any) => ({ ...x, id: 'sub-acc-1', updatedAt: new Date('2026-07-01T00:00:00Z'), createdAt: new Date('2026-07-01T00:00:00Z') }));
      subRepo.save.mockImplementation(async (x: any) => x);

      const out = await svc.subscribe('ws-1', 'tenant-1', undefined, 'account');

      expect(client.provisionSubscriber).not.toHaveBeenCalled();
      expect(subRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'ws-1', mode: 'account', status: 'ready' }),
      );
      expect((out as any).subscription).toEqual(
        expect.objectContaining({ mode: 'account', linkStatus: null, status: 'ready' }),
      );
      expect((out as any).nextStep).toBe('start');
    });

    it('flips an existing bot-mode row to account mode in place + clears bot fields', async () => {
      const existing = { id: 'sub-existing', workspaceId: 'ws-1', mode: 'bot', status: 'ready', botUsername: 'old_bot', tgUserId: null, tgUsername: null, linkStatus: null, updatedAt: new Date(), createdAt: new Date() };
      subRepo.findOne
        .mockResolvedValueOnce(existing) // initial existing lookup
        .mockResolvedValueOnce({ ...existing, mode: 'account', botUsername: null }); // reload after update

      const out = await svc.subscribe('ws-1', 'tenant-1', undefined, 'account');

      expect(subRepo.update).toHaveBeenCalledWith(
        'sub-existing',
        expect.objectContaining({ mode: 'account', botUsername: undefined, status: 'ready' }),
      );
      expect((out as any).subscription.mode).toBe('account');
    });

    it('idempotent: returns existing account-mode row without DB mutation', async () => {
      subRepo.findOne.mockResolvedValue({ id: 'sub-1', mode: 'account', status: 'ready', linkStatus: 'linked', tgUsername: '@x', tgUserId: '1', updatedAt: new Date(), createdAt: new Date() });
      const out = await svc.subscribe('ws-1', 'tenant-1', undefined, 'account');
      expect(subRepo.update).not.toHaveBeenCalled();
      expect(subRepo.save).not.toHaveBeenCalled();
      expect((out as any).subscription.linkStatus).toBe('linked');
    });
  });

  describe('account flow — round-2 transactional pattern applies', () => {
    it('startAccountLink throws RISK_NOT_ACKNOWLEDGED before any side-effect', async () => {
      subRepo.findOne.mockResolvedValue({ id: 'r', mode: 'account', status: 'ready', updatedAt: new Date(), createdAt: new Date() });
      await expect(
        svc.startAccountLink('ws-1', 't-1', { phoneNumber: '+1', riskAcknowledged: false }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ error: 'RISK_NOT_ACKNOWLEDGED' }) });
      expect(client.startAccountLink).not.toHaveBeenCalled();
      expect(subRepo.update).not.toHaveBeenCalled();
    });

    it('startAccountLink: on µsvc throw, no link_status mutation happens', async () => {
      const existingRow = { id: 'r-1', mode: 'account', status: 'ready', linkStatus: null, updatedAt: new Date(), createdAt: new Date() };
      subRepo.findOne.mockResolvedValue(existingRow);
      client.startAccountLink.mockRejectedValue(Object.assign(new Error('upstream 400'), { status: 400 }));

      await expect(
        svc.startAccountLink('ws-1', 't-1', { phoneNumber: '+1', riskAcknowledged: true }),
      ).rejects.toThrow('upstream 400');

      expect(subRepo.update).not.toHaveBeenCalled();
    });

    it('startAccountLink success → updates link_status + linkAccountId + returns nextStep=code', async () => {
      const existingRow = { id: 'r-1', mode: 'account', status: 'ready', linkStatus: null, updatedAt: new Date('2026-07-01T00:00:00Z'), createdAt: new Date('2026-07-01T00:00:00Z') };
      subRepo.findOne
        .mockResolvedValueOnce(existingRow)  // ensureAccountModeRow lookup
        .mockResolvedValueOnce({ ...existingRow, linkStatus: 'code_requested', linkAccountId: 'acc_1' }); // reload after update
      client.startAccountLink.mockResolvedValue({ accountId: 'acc_1', status: 'code_requested' });

      const out = await svc.startAccountLink('ws-1', 't-1', { phoneNumber: '+1', riskAcknowledged: true });

      expect(client.startAccountLink).toHaveBeenCalledWith({
        workspaceId: 'ws-1', phoneNumber: '+1', password: undefined, riskAcknowledged: true,
      });
      expect(subRepo.update).toHaveBeenCalledWith('r-1', expect.objectContaining({ linkAccountId: 'acc_1', linkStatus: 'code_requested' }));
      expect((out as any).nextStep).toBe('code');
      expect((out as any).subscription.linkStatus).toBe('code_requested');
    });

    it('submitAccountCode: linked → nextStep=linked, tg fields populated', async () => {
      const row = { id: 'r-1', mode: 'account', status: 'ready', linkStatus: 'code_requested', updatedAt: new Date(), createdAt: new Date(), tgUserId: null, tgUsername: null };
      subRepo.findOne
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce({ ...row, linkStatus: 'linked', tgUserId: '999', tgUsername: '@user' });
      client.submitAccountCode.mockResolvedValue({ accountId: 'acc_1', status: 'linked', tgUserId: '999', tgUsername: '@user' });

      const out = await svc.submitAccountCode('ws-1', '12345');
      expect((out as any).nextStep).toBe('linked');
      expect((out as any).subscription.tgUsername).toBe('@user');
    });

    it('submitAccountCode: password_required → nextStep=password', async () => {
      const row = { id: 'r-1', mode: 'account', status: 'ready', linkStatus: 'code_requested', updatedAt: new Date(), createdAt: new Date() };
      subRepo.findOne.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, linkStatus: 'password_required' });
      client.submitAccountCode.mockResolvedValue({ accountId: 'acc_1', status: 'password_required' });
      const out = await svc.submitAccountCode('ws-1', '12345');
      expect((out as any).nextStep).toBe('password');
    });

    it('rejects account ops when subscription is not in account mode', async () => {
      subRepo.findOne.mockResolvedValue({ id: 'r-1', mode: 'bot', status: 'ready' });
      await expect(svc.submitAccountCode('ws-1', '12345')).rejects.toMatchObject({
        response: expect.objectContaining({ error: 'ACCOUNT_MODE_NOT_INITIALIZED' }),
      });
    });

    it('deleteAccount marks row retired + linkStatus=revoked even if upstream fails', async () => {
      subRepo.findOne.mockResolvedValue({ id: 'r-1', mode: 'account', status: 'ready' });
      client.deleteAccount.mockRejectedValue(new Error('upstream gone'));
      const out = await svc.deleteAccount('ws-1');
      expect(subRepo.update).toHaveBeenCalledWith('r-1', expect.objectContaining({ status: 'retired', linkStatus: 'revoked' }));
      expect(out).toEqual({ ok: true });
    });
  });

  describe('handleProviderEvent — account events', () => {
    it('account.linked updates row + emits TELEGRAM_ACCOUNT_LINKED', async () => {
      subRepo.findOne.mockResolvedValue({ id: 'sub-1', workspaceId: 'ws-1', tenantId: 'tenant-1', mode: 'account', linkAccountId: 'acc_1', tgUserId: null, tgUsername: null });

      await svc.handleProviderEvent({
        workspaceId: 'ws-1',
        eventType: 'account.linked' as any,
        timestamp: '2026-07-01T00:00:00Z',
        data: { accountId: 'acc_1', tgUserId: '999', tgUsername: '@x' },
      });

      expect(subRepo.update).toHaveBeenCalledWith(
        'sub-1',
        expect.objectContaining({ mode: 'account', linkStatus: 'linked', tgUserId: '999', tgUsername: '@x' }),
      );
      expect(outbound.emitEvent).toHaveBeenCalledWith(
        'ws-1',
        WebhookEventType.TELEGRAM_ACCOUNT_LINKED,
        expect.objectContaining({ subscriberWorkspaceId: 'ws-1', tgUsername: '@x', tgUserId: '999' }),
        { tenantId: 'tenant-1' },
      );
    });

    it('account.revoked sets linkStatus=revoked + emits TELEGRAM_ACCOUNT_REVOKED', async () => {
      subRepo.findOne.mockResolvedValue({ id: 'sub-1', workspaceId: 'ws-1', tenantId: 'tenant-1', mode: 'account' });

      await svc.handleProviderEvent({
        workspaceId: 'ws-1',
        eventType: 'account.revoked' as any,
        timestamp: '2026-07-01T00:00:00Z',
        data: { reason: 'SESSION_REVOKED' },
      });

      expect(subRepo.update).toHaveBeenCalledWith('sub-1', { linkStatus: 'revoked' });
      expect(outbound.emitEvent).toHaveBeenCalledWith(
        'ws-1',
        WebhookEventType.TELEGRAM_ACCOUNT_REVOKED,
        expect.objectContaining({ subscriberWorkspaceId: 'ws-1', reason: 'SESSION_REVOKED' }),
        { tenantId: 'tenant-1' },
      );
    });

    it('account.linked no-ops on unknown subscriber', async () => {
      subRepo.findOne.mockResolvedValue(null);
      await svc.handleProviderEvent({
        workspaceId: 'ws-unknown',
        eventType: 'account.linked' as any,
        timestamp: 'now',
        data: { accountId: 'acc_1' },
      });
      expect(subRepo.update).not.toHaveBeenCalled();
      expect(outbound.emitEvent).not.toHaveBeenCalled();
    });
  });
});
