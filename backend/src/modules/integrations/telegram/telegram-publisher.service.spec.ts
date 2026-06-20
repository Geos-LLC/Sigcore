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
      expect(subRepo.update).toHaveBeenCalledWith(
        'sub-uuid',
        expect.objectContaining({
          teleporterSubscriberId: 'tp_sub_1',
          botUsername: 'hf_bot',
          status: 'ready',
        }),
      );
      expect(result).toEqual({ botUsername: 'hf_bot', status: 'ready', inviteHint: 'add me' });
    });

    it('returns existing active subscriber without re-calling µsvc', async () => {
      subRepo.findOne.mockResolvedValue({
        id: 'sub-uuid',
        workspaceId: 'ws-1',
        status: 'ready',
        botUsername: 'existing_bot',
        inviteHint: 'old hint',
      });

      const result = await svc.subscribe('ws-1', 'tenant-1', undefined);

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
});
