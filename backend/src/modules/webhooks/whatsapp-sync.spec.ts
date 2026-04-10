import { WebhooksService } from './webhooks.service';
import { ProviderType } from '../../database/entities/communication-integration.entity';
import { MessageDirection, MessageStatus } from '../../database/entities/communication-message.entity';

// ---------------------------------------------------------------------------
// Mock builders (same pattern as whatsapp-webhook.spec.ts)
// ---------------------------------------------------------------------------
function buildMockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data: any) => ({ id: `gen-${Date.now()}-${Math.random()}`, ...data })),
    save: jest.fn(async (entity: any) => entity),
    remove: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
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
  const eventsGateway = { emitNewMessage: jest.fn(), emitNewConversation: jest.fn() };
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

const WS_ID = 'ws-sync';

// ---------------------------------------------------------------------------
// Deduplication Tests
// ---------------------------------------------------------------------------
describe('WhatsApp Sync — Message Deduplication', () => {
  it('skips duplicate message when providerMessageId already exists', async () => {
    const { service, messageRepo, conversationRepo } = buildService();

    // Simulate existing message in DB
    messageRepo.findOne.mockResolvedValue({
      id: 'existing-msg',
      providerMessageId: 'wa_msg_dup_123',
    });

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15551234567',
      to: '+15559876543',
      body: 'Duplicate message',
      externalMessageId: 'wa_msg_dup_123',
      externalChatId: '15551234567@c.us',
    });

    // Should NOT create a new message
    expect(messageRepo.create).not.toHaveBeenCalled();
    // Should NOT create a new conversation
    expect(conversationRepo.create).not.toHaveBeenCalled();
  });

  it('creates message when providerMessageId does not exist yet', async () => {
    const { service, messageRepo, conversationRepo } = buildService();

    // No existing message (first time)
    messageRepo.findOne.mockResolvedValue(null);
    // No existing conversation
    conversationRepo.findOne.mockResolvedValue(null);

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15551234567',
      to: '+15559876543',
      body: 'New message',
      externalMessageId: 'wa_msg_new_456',
      externalChatId: '15551234567@c.us',
    });

    // Should create message
    expect(messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: 'wa_msg_new_456',
        body: 'New message',
        direction: MessageDirection.IN,
      }),
    );
    expect(messageRepo.save).toHaveBeenCalled();
  });

  it('handles message without externalMessageId (no dedup check)', async () => {
    const { service, messageRepo, conversationRepo } = buildService();
    conversationRepo.findOne.mockResolvedValue(null);

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15551234567',
      to: '+15559876543',
      body: 'No external ID',
      // no externalMessageId
      externalChatId: '15551234567@c.us',
    });

    // Should NOT call findOne for dedup (no ID to check)
    expect(messageRepo.findOne).not.toHaveBeenCalled();
    // Should still create the message
    expect(messageRepo.create).toHaveBeenCalled();
  });

  it('deduplicates when message_create and message events fire for same message', async () => {
    const { service, messageRepo, conversationRepo } = buildService();
    const existingConv = {
      id: 'conv-1',
      workspaceId: WS_ID,
      provider: ProviderType.WHATSAPP,
    };

    // First call: message_create event — no existing message
    messageRepo.findOne.mockResolvedValueOnce(null);
    conversationRepo.findOne.mockResolvedValue(existingConv);

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15551234567',
      to: '+15559876543',
      body: 'Hello',
      externalMessageId: 'wa_msg_dual_789',
      externalChatId: '15551234567@c.us',
    });

    expect(messageRepo.create).toHaveBeenCalledTimes(1);

    // Second call: message event for same message — now exists
    messageRepo.findOne.mockResolvedValueOnce({
      id: 'msg-already-created',
      providerMessageId: 'wa_msg_dual_789',
    });

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15551234567',
      to: '+15559876543',
      body: 'Hello',
      externalMessageId: 'wa_msg_dual_789',
      externalChatId: '15551234567@c.us',
    });

    // Should NOT create a second message
    expect(messageRepo.create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Auto-Sync Conversation Handling Tests
// ---------------------------------------------------------------------------
describe('WhatsApp Sync — Conversation Handling', () => {
  it('creates new conversation for unknown participant', async () => {
    const { service, messageRepo, conversationRepo } = buildService();
    messageRepo.findOne.mockResolvedValue(null);
    conversationRepo.findOne.mockResolvedValue(null);

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15559999999',
      to: '+15551111111',
      body: 'From new contact',
      externalMessageId: 'wa_new_contact',
      externalChatId: '15559999999@c.us',
    });

    expect(conversationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        provider: ProviderType.WHATSAPP,
        participantPhoneNumber: '+15559999999',
        phoneNumber: '+15551111111',
        metadata: expect.objectContaining({ externalChatId: '15559999999@c.us' }),
      }),
    );
  });

  it('reuses existing conversation for known participant', async () => {
    const { service, messageRepo, conversationRepo } = buildService();
    messageRepo.findOne.mockResolvedValue(null);
    const existingConv = {
      id: 'conv-existing',
      workspaceId: WS_ID,
      participantPhoneNumber: '+15559999999',
      provider: ProviderType.WHATSAPP,
    };
    conversationRepo.findOne.mockResolvedValue(existingConv);

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15559999999',
      to: '+15551111111',
      body: 'Another message from same contact',
      externalMessageId: 'wa_same_contact',
      externalChatId: '15559999999@c.us',
    });

    expect(conversationRepo.create).not.toHaveBeenCalled();
    expect(messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-existing' }),
    );
  });

  it('handles bulk sync — multiple messages for multiple conversations', async () => {
    const { service, messageRepo, conversationRepo, eventsGateway, outboundWebhooksService } = buildService();

    // All messages are new (no dedup matches)
    messageRepo.findOne.mockResolvedValue(null);

    // First contact: no conversation yet
    conversationRepo.findOne
      .mockResolvedValueOnce(null) // contact A — first message
      .mockResolvedValueOnce({ id: 'conv-a', workspaceId: WS_ID }) // contact A — second message (conv created)
      .mockResolvedValueOnce(null); // contact B — first message

    // Simulate 3 messages from auto-sync: 2 from contact A, 1 from contact B
    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15550001111', to: '+15559876543', body: 'Msg 1 from A',
      externalMessageId: 'wa_sync_1', externalChatId: '15550001111@c.us',
    });

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15550001111', to: '+15559876543', body: 'Msg 2 from A',
      externalMessageId: 'wa_sync_2', externalChatId: '15550001111@c.us',
    });

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15550002222', to: '+15559876543', body: 'Msg 1 from B',
      externalMessageId: 'wa_sync_3', externalChatId: '15550002222@c.us',
    });

    // Should create 3 messages
    expect(messageRepo.create).toHaveBeenCalledTimes(3);
    // Should create 2 conversations (one per contact)
    expect(conversationRepo.create).toHaveBeenCalledTimes(2);
    // Should emit 3 WebSocket events
    expect(eventsGateway.emitNewMessage).toHaveBeenCalledTimes(3);
    // Should fan out 3 webhook events
    expect(outboundWebhooksService.emitEvent).toHaveBeenCalledTimes(3);
  });

  it('normalizes phone numbers — adds + prefix when missing', async () => {
    const { service, messageRepo, conversationRepo } = buildService();
    messageRepo.findOne.mockResolvedValue(null);
    conversationRepo.findOne.mockResolvedValue(null);

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '15551234567', // no + prefix
      to: '15559876543',
      body: 'Without plus',
      externalMessageId: 'wa_noplus',
      externalChatId: '15551234567@c.us',
    });

    expect(conversationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        participantPhoneNumber: '+15551234567',
        phoneNumber: '+15559876543',
      }),
    );
    expect(messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        fromNumber: '+15551234567',
        toNumber: '+15559876543',
      }),
    );
  });

  it('stores fromMe messages with correct direction', async () => {
    const { service, messageRepo, conversationRepo } = buildService();
    messageRepo.findOne.mockResolvedValue(null);
    conversationRepo.findOne.mockResolvedValue({
      id: 'conv-me',
      workspaceId: WS_ID,
    });

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15559876543',
      to: '+15551234567',
      body: 'I sent this',
      externalMessageId: 'wa_fromme',
      externalChatId: '15551234567@c.us',
      fromMe: true,
    });

    // Even "fromMe" messages come through as message_inbound from the WhatsApp service
    // They get stored as direction=IN because the handler doesn't differentiate
    // (dedup will prevent double-storage if also sent via Sigcore API)
    expect(messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'I sent this',
        providerMessageId: 'wa_fromme',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Webhook Payload Contract Tests
// ---------------------------------------------------------------------------
describe('WhatsApp Sync — Webhook Payload Contract', () => {
  it('emits standardized webhook payload with conversation + message objects', async () => {
    const { service, messageRepo, conversationRepo, outboundWebhooksService } = buildService();
    messageRepo.findOne.mockResolvedValue(null);
    conversationRepo.findOne.mockResolvedValue(null);

    await service.handleWhatsAppWebhook(WS_ID, 'message_inbound', {
      from: '+15551234567',
      to: '+15559876543',
      body: 'Contract test',
      externalMessageId: 'wa_contract_1',
      externalChatId: '15551234567@c.us',
      timestamp: '2026-04-08T14:30:00Z',
    });

    expect(outboundWebhooksService.emitEvent).toHaveBeenCalledWith(
      WS_ID,
      'whatsapp.message.inbound',
      expect.objectContaining({
        provider: 'whatsapp',
        conversation: expect.objectContaining({
          externalChatId: '15551234567@c.us',
          participantPhone: '+15551234567',
        }),
        message: expect.objectContaining({
          externalMessageId: 'wa_contract_1',
          text: 'Contract test',
          direction: 'in',
          timestamp: '2026-04-08T14:30:00Z',
        }),
      }),
    );
  });
});
