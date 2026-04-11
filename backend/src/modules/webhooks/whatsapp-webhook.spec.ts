import { WebhooksService } from './webhooks.service';
import { ProviderType } from '../../database/entities/communication-integration.entity';
import { MessageDirection, MessageStatus } from '../../database/entities/communication-message.entity';

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------
function buildMockQueryBuilder() {
  const qb: any = {
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  return qb;
}

function buildMockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data: any) => ({ id: 'generated-id', ...data })),
    save: jest.fn(async (entity: any) => entity),
    update: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(buildMockQueryBuilder()),
    query: jest.fn(),
  };
}

function buildService() {
  const conversationRepo = buildMockRepo();
  const messageRepo = buildMockRepo();
  const callRepo = buildMockRepo();
  const integrationRepo = buildMockRepo();
  const workspaceRepo = buildMockRepo();
  const tenantPhoneNumberRepo = buildMockRepo();
  const encryptionService = { decrypt: jest.fn(), encrypt: jest.fn() };
  const eventsGateway = { emitNewMessage: jest.fn(), emitNewConversation: jest.fn(), emitConversationUpdate: jest.fn() };
  const openPhoneProvider = {};
  const idempotencyService = { isDuplicate: jest.fn().mockResolvedValue(false), markProcessed: jest.fn() };
  const outboundWebhooksService = { emitEvent: jest.fn(), emitMessageEvent: jest.fn() };

  const service = new WebhooksService(
    conversationRepo as any,
    messageRepo as any,
    callRepo as any,
    integrationRepo as any,
    workspaceRepo as any,
    tenantPhoneNumberRepo as any,
    encryptionService as any,
    eventsGateway as any,
    openPhoneProvider as any,
    idempotencyService as any,
    outboundWebhooksService as any,
  );

  return {
    service,
    conversationRepo,
    messageRepo,
    eventsGateway,
    outboundWebhooksService,
  };
}

const WS_ID = 'ws-1';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('WebhooksService – WhatsApp webhook handler', () => {
  describe('handleWhatsAppWebhook dispatch', () => {
    it('handles message_inbound event', async () => {
      const { service, conversationRepo, messageRepo } = buildService();
      conversationRepo.findOne.mockResolvedValue(null); // no existing conversation

      await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
        from: '+15551234567',
        to: '+15559876543',
        body: 'Hello from WhatsApp',
        externalMessageId: 'wa_msg_123',
        externalChatId: '15551234567@c.us',
        timestamp: '2026-04-08T12:00:00Z',
      });

      // Should create conversation
      expect(conversationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WS_ID,
          provider: ProviderType.WHATSAPP,
          participantPhoneNumber: '+15551234567',
        }),
      );
      expect(conversationRepo.save).toHaveBeenCalled();

      // Should create message
      expect(messageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: MessageDirection.IN,
          body: 'Hello from WhatsApp',
          fromNumber: '+15551234567',
          providerMessageId: 'wa_msg_123',
          status: MessageStatus.DELIVERED,
        }),
      );
      expect(messageRepo.save).toHaveBeenCalled();
    });

    it('reuses existing conversation on inbound', async () => {
      const { service, conversationRepo, messageRepo } = buildService();
      const existingConv = {
        id: 'conv-existing',
        workspaceId: WS_ID,
        provider: ProviderType.WHATSAPP,
        participantPhoneNumber: '+15551234567',
      };
      conversationRepo.findOne.mockResolvedValue(existingConv);

      await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
        from: '+15551234567',
        to: '+15559876543',
        body: 'Second message',
        externalMessageId: 'wa_msg_456',
        externalChatId: '15551234567@c.us',
      });

      // Should NOT create new conversation
      expect(conversationRepo.create).not.toHaveBeenCalled();

      // Should create message linked to existing conversation
      expect(messageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-existing',
        }),
      );
    });

    it('emits WebSocket event on inbound message', async () => {
      const { service, conversationRepo, messageRepo, eventsGateway } = buildService();
      conversationRepo.findOne.mockResolvedValue(null);

      await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
        from: '+15551234567',
        to: '+15559876543',
        body: 'Test',
        externalMessageId: 'wa_msg_789',
        externalChatId: '15551234567@c.us',
      });

      expect(eventsGateway.emitNewMessage).toHaveBeenCalledWith(
        WS_ID,
        expect.objectContaining({
          message: expect.objectContaining({
            direction: 'in',
            body: 'Test',
            channel: 'whatsapp',
          }),
        }),
      );
    });

    it('fans out to tenant webhook subscribers on inbound', async () => {
      const { service, conversationRepo, outboundWebhooksService } = buildService();
      conversationRepo.findOne.mockResolvedValue(null);

      await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
        from: '+15551234567',
        to: '+15559876543',
        body: 'Webhook test',
        externalMessageId: 'wa_msg_fan',
        externalChatId: '15551234567@c.us',
      });

      expect(outboundWebhooksService.emitEvent).toHaveBeenCalledWith(
        WS_ID,
        'whatsapp.message.inbound',
        expect.objectContaining({
          provider: 'whatsapp',
          message: expect.objectContaining({ text: 'Webhook test', direction: 'in' }),
        }),
      );
    });

    it('skips inbound when from is missing', async () => {
      const { service, conversationRepo } = buildService();

      await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
        to: '+15559876543',
        body: 'No from',
      });

      expect(conversationRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('message_ack handling', () => {
    it('updates message status on delivery ack', async () => {
      const { service, messageRepo } = buildService();
      const existingMsg = {
        id: 'msg-1',
        providerMessageId: 'wa_msg_ack',
        status: MessageStatus.SENT,
      };
      messageRepo.findOne.mockResolvedValue(existingMsg);

      await service.handleWhatsAppWebhook(WS_ID, 'message_ack', {
        externalMessageId: 'wa_msg_ack',
        ack: 2,
        status: 'delivered',
      });

      expect(existingMsg.status).toBe(MessageStatus.DELIVERED);
      expect(messageRepo.save).toHaveBeenCalledWith(existingMsg);
    });

    it('skips ack when message not found', async () => {
      const { service, messageRepo } = buildService();
      messageRepo.findOne.mockResolvedValue(null);

      await service.handleWhatsAppWebhook(WS_ID, 'message_ack', {
        externalMessageId: 'wa_nonexistent',
        status: 'delivered',
      });

      expect(messageRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('status_change handling', () => {
    it('emits webhook event on status change', async () => {
      const { service, outboundWebhooksService } = buildService();

      await service.handleWhatsAppWebhook(WS_ID, 'status_change', {
        status: 'disconnected',
        reason: 'User logged out',
      });

      expect(outboundWebhooksService.emitEvent).toHaveBeenCalledWith(
        WS_ID,
        'whatsapp.status.change',
        expect.objectContaining({ provider: 'whatsapp', status: 'disconnected' }),
      );
    });
  });

  describe('unknown event type', () => {
    it('handles unknown event type without error', async () => {
      const { service } = buildService();

      await expect(
        service.handleWhatsAppWebhook(WS_ID, 'unknown_event', { foo: 'bar' }),
      ).resolves.not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// clearWhatsAppData on reconnect (status_change: ready)
// ---------------------------------------------------------------------------
describe('WebhooksService – clearWhatsAppData on reconnect', () => {
  it('deletes all WhatsApp conversations and messages on status_change=ready', async () => {
    const { service, conversationRepo, messageRepo, outboundWebhooksService } = buildService();

    // Simulate existing WhatsApp conversations
    const existingConvs = [
      { id: 'wa-conv-1' },
      { id: 'wa-conv-2' },
    ];
    conversationRepo.find.mockResolvedValue(existingConvs);

    const msgQb = buildMockQueryBuilder();
    const convQb = buildMockQueryBuilder();

    // First call = message delete QB, second call = conversation delete QB
    messageRepo.createQueryBuilder.mockReturnValueOnce(msgQb);
    conversationRepo.createQueryBuilder.mockReturnValueOnce(convQb);

    await service.handleWhatsAppWebhook(WS_ID, 'status_change', {
      status: 'ready',
    });

    // Should look up WhatsApp conversations for this workspace
    expect(conversationRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS_ID, provider: ProviderType.WHATSAPP },
        select: ['id'],
      }),
    );

    // Should delete messages for those conversations
    expect(msgQb.delete).toHaveBeenCalled();
    expect(msgQb.where).toHaveBeenCalledWith(
      'conversationId IN (:...ids)',
      { ids: ['wa-conv-1', 'wa-conv-2'] },
    );
    expect(msgQb.execute).toHaveBeenCalled();

    // Should delete conversations
    expect(convQb.delete).toHaveBeenCalled();
    expect(convQb.where).toHaveBeenCalledWith(
      'id IN (:...ids)',
      { ids: ['wa-conv-1', 'wa-conv-2'] },
    );
    expect(convQb.execute).toHaveBeenCalled();

    // Should still emit the status_change webhook event
    expect(outboundWebhooksService.emitEvent).toHaveBeenCalledWith(
      WS_ID,
      'whatsapp.status.change',
      expect.objectContaining({ provider: 'whatsapp', status: 'ready' }),
    );
  });

  it('skips delete when no existing WhatsApp conversations', async () => {
    const { service, conversationRepo, messageRepo } = buildService();

    conversationRepo.find.mockResolvedValue([]);

    await service.handleWhatsAppWebhook(WS_ID, 'status_change', {
      status: 'ready',
    });

    // Should NOT create query builders for delete
    expect(messageRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(conversationRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('does NOT clear data on non-ready status changes', async () => {
    const { service, conversationRepo } = buildService();

    await service.handleWhatsAppWebhook(WS_ID, 'status_change', {
      status: 'disconnected',
      reason: 'User logged out',
    });

    // Should NOT look for conversations to delete
    expect(conversationRepo.find).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group ID normalization — don't add + prefix to @g.us / @ identifiers
// ---------------------------------------------------------------------------
describe('WebhooksService – Group ID normalization', () => {
  it('does NOT add + prefix to @g.us group identifiers in from', async () => {
    const { service, conversationRepo, messageRepo } = buildService();
    messageRepo.findOne.mockResolvedValue(null);
    conversationRepo.findOne.mockResolvedValue(null);

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '120363123456789@g.us',
      to: '+15559876543',
      body: 'Group message',
      externalMessageId: 'wa_group_1',
      externalChatId: '120363123456789@g.us',
      isGroup: true,
    });

    // from contains @, so should NOT get + prefix
    expect(messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        fromNumber: '120363123456789@g.us',
      }),
    );
  });

  it('does NOT add + prefix to @c.us identifiers used as from', async () => {
    const { service, conversationRepo, messageRepo } = buildService();
    messageRepo.findOne.mockResolvedValue(null);
    conversationRepo.findOne.mockResolvedValue(null);

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '15551234567@c.us',
      to: '+15559876543',
      body: 'At-sign identifier',
      externalMessageId: 'wa_at_1',
      externalChatId: '15551234567@c.us',
    });

    expect(messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        fromNumber: '15551234567@c.us',
      }),
    );
  });

  it('adds + prefix to regular phone numbers without @', async () => {
    const { service, conversationRepo, messageRepo } = buildService();
    messageRepo.findOne.mockResolvedValue(null);
    conversationRepo.findOne.mockResolvedValue(null);

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '15551234567',
      to: '15559876543',
      body: 'Regular phone',
      externalMessageId: 'wa_reg_1',
      externalChatId: '15551234567@c.us',
    });

    expect(messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        fromNumber: '+15551234567',
        toNumber: '+15559876543',
      }),
    );
  });
});
