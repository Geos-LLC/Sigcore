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
  const s3Service = {
    isConfigured: jest.fn().mockReturnValue(false),
    buildKey: jest.fn((ws: string, id: string, ext: string) => `whatsapp/${ws}/${id}${ext}`),
    putObject: jest.fn().mockResolvedValue({ uploaded: true, skipped: false }),
    headObject: jest.fn().mockResolvedValue(false),
    getObjectStream: jest.fn().mockResolvedValue(null),
  };
  const tenantIntegrationRepo = buildMockRepo();
  const webhookSubscriptionRepo = buildMockRepo();

  // Default: no tenant_integrations rows, no webhook subs (tenant resolution returns null)
  tenantIntegrationRepo.find.mockResolvedValue([]);
  webhookSubscriptionRepo.find.mockResolvedValue([]);

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
    eventsGateway,
    outboundWebhooksService,
    s3Service,
    tenantIntegrationRepo,
    webhookSubscriptionRepo,
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
          tenantId: null,
          message: expect.objectContaining({ text: 'Webhook test', direction: 'in' }),
        }),
        undefined, // resolvedTenantId
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

  describe('PR2: inbound media persists to S3 + metadata contract', () => {
    it('writes to S3 when configured and sets mediaS3Key + mediaStatus + mediaSource + mediaSizeBytes', async () => {
      const { service, conversationRepo, messageRepo, s3Service } = buildService();
      conversationRepo.findOne.mockResolvedValue(null);
      (s3Service.isConfigured as jest.Mock).mockReturnValue(true);

      const base64 = Buffer.from('hello-image').toString('base64');

      await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
        from: '+15551234567',
        to: '+15559876543',
        body: '📷 Photo',
        externalMessageId: 'wa_msg_media_1',
        externalChatId: '15551234567@c.us',
        hasMedia: true,
        type: 'image',
        mediaData: base64,
        mediaMimetype: 'image/jpeg',
        mediaFilename: 'photo.jpg',
        mediaSizeBytes: Buffer.byteLength(base64, 'base64'),
        mediaStatus: 'downloaded',
        mediaSource: 'realtime',
      });

      expect(s3Service.putObject).toHaveBeenCalledWith(
        expect.objectContaining({
          key: expect.stringMatching(/^whatsapp\/ws-1\/.+\.jpg$/),
          contentType: 'image/jpeg',
        }),
      );

      // The final save should persist metadata with S3 key + status + source
      const saveCalls = messageRepo.save.mock.calls.map((c: any[]) => c[0]);
      const finalSave = saveCalls[saveCalls.length - 1];
      expect(finalSave.metadata).toEqual(
        expect.objectContaining({
          mediaS3Key: expect.stringMatching(/^whatsapp\/ws-1\/.+\.jpg$/),
          mediaMimetype: 'image/jpeg',
          mediaStatus: 'downloaded',
          mediaSource: 'realtime',
          mediaSizeBytes: expect.any(Number),
        }),
      );
      // Must NOT set legacy mediaPath when S3 is active
      expect(finalSave.metadata.mediaPath).toBeUndefined();
    });

    it('persists mediaStatus for LID chats even without mediaData', async () => {
      const { service, conversationRepo, messageRepo, s3Service } = buildService();
      conversationRepo.findOne.mockResolvedValue(null);
      (s3Service.isConfigured as jest.Mock).mockReturnValue(true);

      await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
        from: '+15551234567',
        to: '+15559876543',
        body: '📷 Photo',
        externalMessageId: 'wa_lid_1',
        externalChatId: '15551234567@lid',
        hasMedia: true,
        type: 'image',
        mediaStatus: 'unsupported_store_message',
        mediaSource: 'sync',
      });

      // No S3 upload should happen (no data)
      expect(s3Service.putObject).not.toHaveBeenCalled();

      // Message metadata should carry the status so SF can render a placeholder
      const createCall = messageRepo.create.mock.calls[0][0];
      expect(createCall.metadata).toEqual(
        expect.objectContaining({
          mediaStatus: 'unsupported_store_message',
          mediaSource: 'sync',
          hasMedia: true,
        }),
      );
    });

    it('falls back to local disk when S3 is not configured (back-compat)', async () => {
      const { service, conversationRepo, s3Service } = buildService();
      conversationRepo.findOne.mockResolvedValue(null);
      (s3Service.isConfigured as jest.Mock).mockReturnValue(false);

      // Don't actually let fs write; stub via spy so we just confirm we didn't call S3
      await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
        from: '+15551234567',
        to: '+15559876543',
        body: '📷 Photo',
        externalMessageId: 'wa_nos3_1',
        externalChatId: '15551234567@c.us',
        hasMedia: true,
        type: 'image',
        mediaData: Buffer.from('x').toString('base64'),
        mediaMimetype: 'image/jpeg',
      });

      expect(s3Service.putObject).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// PR3: Reconnect no longer wipes WhatsApp data.
// Sync upserts by providerMessageId; media persisted in S3 survives redeploys.
// ---------------------------------------------------------------------------
describe('WebhooksService – status_change=ready (PR3: no wipe)', () => {
  it('does NOT delete conversations or messages on status_change=ready', async () => {
    const { service, conversationRepo, messageRepo, outboundWebhooksService } = buildService();

    // Simulate existing WhatsApp conversations
    conversationRepo.find.mockResolvedValue([
      { id: 'wa-conv-1' },
      { id: 'wa-conv-2' },
    ]);

    await service.handleWhatsAppWebhook(WS_ID, 'status_change', {
      status: 'ready',
    });

    // Must not run any delete query builders
    expect(messageRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(conversationRepo.createQueryBuilder).not.toHaveBeenCalled();

    // Should NOT even call .find looking for conversations to wipe
    expect(conversationRepo.find).not.toHaveBeenCalled();

    // Should still emit the status_change webhook event
    expect(outboundWebhooksService.emitEvent).toHaveBeenCalledWith(
      WS_ID,
      'whatsapp.status.change',
      expect.objectContaining({ provider: 'whatsapp', status: 'ready' }),
    );
  });

  it('does NOT clear data on non-ready status changes', async () => {
    const { service, conversationRepo } = buildService();

    await service.handleWhatsAppWebhook(WS_ID, 'status_change', {
      status: 'disconnected',
      reason: 'User logged out',
    });

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
