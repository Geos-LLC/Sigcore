import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  CommunicationIntegration,
  ProviderType,
  IntegrationStatus,
} from '../../database/entities/communication-integration.entity';
import { TenantIntegration } from '../../database/entities/tenant-integration.entity';
import {
  CommunicationConversation,
} from '../../database/entities/communication-conversation.entity';
import {
  CommunicationMessage,
  MessageDirection,
  MessageStatus,
} from '../../database/entities/communication-message.entity';
import {
  CommunicationCall,
} from '../../database/entities/communication-call.entity';
import { Sender, ChannelType } from '../../database/entities/sender.entity';
import { OpenPhoneProvider } from './providers/openphone.provider';
import { TwilioProvider } from './providers/twilio.provider';
import { WhatsAppWebProvider } from './providers/whatsapp-web.provider';
import { EncryptionService } from '../../common/services/encryption.service';
import { CommunicationProvider } from './interfaces/communication-provider.interface';

export interface SyncProgress {
  status: 'idle' | 'running' | 'completed' | 'error' | 'cancelled';
  phase: string;
  current: number;
  total: number;
  message: string;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  result?: SyncResult;
}

export interface SyncResult {
  // What OpenPhone returned
  conversationsFromProvider: number;
  // What was actually synced
  conversationsSynced: number;
  messagesSynced: number;
  callsSynced: number;
  contactsLinked: number;
  contactsCreated: number;
  errors: number;
  // Skipped/filtered
  conversationsSkipped: number;
}

export interface SyncOptions {
  limit?: number;
  since?: Date;
  until?: Date; // End date for custom date range
  syncMessages?: boolean;
  forceRefresh?: boolean; // If true, update existing messages and conversations
  conversationIds?: string[]; // If provided, only sync these specific conversations
  onlyUpdated?: boolean; // If true, only sync conversations that have been updated in OpenPhone
  phoneNumberId?: string; // If provided, only sync conversations from this phone line
  onlySavedContacts?: boolean; // If true, only sync conversations where the contact has a name (not just phone number)
  provider?: ProviderType; // If provided, sync from this provider (defaults to first active integration)
}

@Injectable()
export class CommunicationService {
  private readonly logger = new Logger(CommunicationService.name);
  private syncProgress: Map<string, SyncProgress> = new Map();
  private syncCancelled: Map<string, boolean> = new Map();

  // Normalize phone number to E.164-like format for comparison
  private normalizePhoneNumber(phone: string): string {
    if (!phone) return '';
    // Remove all non-digit characters except leading +
    const cleaned = phone.replace(/[^\d+]/g, '');
    // If it starts with +, keep it, otherwise add +1 for US numbers
    if (cleaned.startsWith('+')) {
      return cleaned;
    }
    // If it's 10 digits, assume US number
    if (cleaned.length === 10) {
      return `+1${cleaned}`;
    }
    // If it's 11 digits starting with 1, add +
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
      return `+${cleaned}`;
    }
    return cleaned;
  }

  constructor(
    @InjectRepository(CommunicationIntegration)
    private integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(TenantIntegration)
    private tenantIntegrationRepo: Repository<TenantIntegration>,
    @InjectRepository(CommunicationConversation)
    private conversationRepo: Repository<CommunicationConversation>,
    @InjectRepository(CommunicationMessage)
    private messageRepo: Repository<CommunicationMessage>,
    @InjectRepository(CommunicationCall)
    private callRepo: Repository<CommunicationCall>,
    @InjectRepository(Sender)
    private senderRepo: Repository<Sender>,
    private openPhoneProvider: OpenPhoneProvider,
    private twilioProvider: TwilioProvider,
    private whatsappWebProvider: WhatsAppWebProvider,
    private encryptionService: EncryptionService,
  ) {}

  private getProvider(providerType: ProviderType): CommunicationProvider {
    switch (providerType) {
      case ProviderType.OPENPHONE:
        return this.openPhoneProvider;
      case ProviderType.TWILIO:
        return this.twilioProvider;
      default:
        throw new BadRequestException(`Unsupported provider: ${providerType}`);
    }
  }

  async getIntegration(workspaceId: string, provider?: ProviderType): Promise<CommunicationIntegration> {
    const whereClause: { workspaceId: string; provider?: ProviderType } = { workspaceId };
    if (provider) {
      whereClause.provider = provider;
    }

    const integration = await this.integrationRepo.findOne({
      where: whereClause,
    });

    if (!integration) {
      throw new NotFoundException(`Communication integration not found${provider ? ` for provider ${provider}` : ''}`);
    }

    return integration;
  }

  async getConversations(
    workspaceId: string,
    options: { page?: number; limit?: number; search?: string; phoneNumberId?: string; startDate?: Date; endDate?: Date; provider?: 'openphone' | 'twilio' } = {},
  ): Promise<{
    conversations: {
      id: string;
      externalId: string;
      phoneNumber: string;
      phoneNumberName: string | null;
      participantPhoneNumber: string;
      participantPhoneNumbers: string[] | null;
      participantContacts: { phoneNumber: string; contactId: string | null; contactName: string | null }[] | null;
      contactId: string | null;
      contactName: string | null;
      lastMessage: string | null;
      lastMessageAt: Date | null;
      unreadCount: number;
    }[];
    meta: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const { page = 1, limit = 50, search, phoneNumberId, startDate, endDate, provider } = options;
    const skip = (page - 1) * limit;

    // Build query with last message time as a computed column for proper ordering
    // Use per-conversation message time to keep phone lines separate
    const queryBuilder = this.conversationRepo
      .createQueryBuilder('conv')
      .addSelect(
        `COALESCE(
          (SELECT MAX(msg.created_at) FROM communication_messages msg WHERE msg.conversation_id = conv.id),
          (conv.metadata->>'lastActivityAt')::timestamp,
          conv.updated_at
        )`,
        'last_activity',
      )
      .where('conv.workspaceId = :workspaceId', { workspaceId });

    // Log total conversations before filtering for debugging
    const allConvsBeforeFilter = await this.conversationRepo.count({ where: { workspaceId } });
    this.logger.log(`Total conversations in workspace before phone filter: ${allConvsBeforeFilter}`);

    // Log sample of raw conversations to see phone_number values
    if (allConvsBeforeFilter > 0) {
      const sampleConvs = await this.conversationRepo.find({ where: { workspaceId }, take: 5 });
      this.logger.log(`Sample raw conversations from DB:`);
      for (const conv of sampleConvs) {
        this.logger.log(`  DB conv: id=${conv.id.substring(0,8)}... | phoneNumber='${conv.phoneNumber}' | participant=${conv.participantPhoneNumber}`);
      }
    }

    // Filter out conversations with invalid phone numbers (e.g., OpenPhone IDs like "PNxxxxxx")
    // Valid phone numbers: start with +, are empty, or are null
    // Also include legacy data where phone_number might be the phoneNumberId (starts with PN)
    // We'll just exclude obvious non-phone patterns that would cause issues
    // The old filter was too restrictive - let's be more inclusive and fix invalid data separately
    queryBuilder.andWhere(
      "(conv.phone_number IS NULL OR conv.phone_number = '' OR conv.phone_number LIKE '+%' OR conv.phone_number LIKE 'PN%')",
    );

    // Add phone line filter if provided
    // This filters conversations to only show those from a specific phone line
    if (phoneNumberId) {
      this.logger.log(`Filtering conversations by phoneNumberId: ${phoneNumberId}`);

      // Debug: Check what phoneNumberIds exist in the database for this workspace
      const distinctPhoneNumberIds = await this.conversationRepo
        .createQueryBuilder('conv')
        .select("DISTINCT conv.metadata->>'phoneNumberId'", 'phoneNumberId')
        .where('conv.workspaceId = :workspaceId', { workspaceId })
        .getRawMany();
      this.logger.log(`Distinct phoneNumberIds in DB: ${JSON.stringify(distinctPhoneNumberIds.map(r => r.phoneNumberId))}`);

      // Match by phoneNumberId in metadata OR by phoneNumber field (for legacy data)
      queryBuilder.andWhere(
        "(conv.metadata->>'phoneNumberId' = :phoneNumberId OR conv.phone_number = :phoneNumberId)",
        { phoneNumberId },
      );
    }

    // Add search filter if provided
    if (search) {
      queryBuilder.andWhere(
        '(conv.participantPhoneNumber LIKE :search OR contact.firstName LIKE :search OR contact.lastName LIKE :search OR contact.phoneNumber LIKE :search)',
        { search: `%${search}%` },
      );
    }

    // Add date range filter if provided
    // Filter by lastMessageAt or metadata.lastActivityAt
    if (startDate) {
      queryBuilder.andWhere(
        `COALESCE(
          (SELECT MAX(msg.created_at) FROM communication_messages msg WHERE msg.conversation_id = conv.id),
          (conv.metadata->>'lastActivityAt')::timestamp,
          conv.updated_at
        ) >= :startDate`,
        { startDate },
      );
    }
    if (endDate) {
      queryBuilder.andWhere(
        `COALESCE(
          (SELECT MAX(msg.created_at) FROM communication_messages msg WHERE msg.conversation_id = conv.id),
          (conv.metadata->>'lastActivityAt')::timestamp,
          conv.updated_at
        ) <= :endDate`,
        { endDate },
      );
    }

    // Add provider filter if provided
    if (provider) {
      this.logger.log(`Filtering conversations by provider: ${provider}`);
      queryBuilder.andWhere('conv.provider = :provider', { provider });
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Get paginated results - sort by last activity time (most recent message or OpenPhone lastActivityAt)
    this.logger.log(`Conversations after phone filter: ${total}`);
    const conversations = await queryBuilder
      .orderBy('last_activity', 'DESC', 'NULLS LAST')
      .skip(skip)
      .take(limit)
      .getMany();

    // Debug: log conversations and unique phone numbers
    if (conversations.length > 0) {
      const uniquePhoneNumbers = [...new Set(conversations.map(c => c.phoneNumber))];
      this.logger.log(`Unique phone lines in conversations: ${uniquePhoneNumbers.join(', ')}`);
      this.logger.log(`Sample conversations (first 5):`);
      for (const conv of conversations.slice(0, 5)) {
        const metadata = conv.metadata as Record<string, unknown> || {};
        this.logger.log(`  id=${conv.id} | phoneNumber='${conv.phoneNumber}' | participant=${conv.participantPhoneNumber} | lastActivityAt=${metadata.lastActivityAt || 'none'}`);
      }
    }

    // Contact data now lives in Callio service - use empty maps for enrichment
    const contactMap = new Map<string, any>();
    const phoneToContactMap = new Map<string, any>();

    // Pre-fetch last messages for each conversation
    // Key by conversationId to keep messages on their correct phone line
    const conversationIds = conversations.map(c => c.id);
    const messageByConversationId = new Map<string, CommunicationMessage>();

    if (conversationIds.length > 0) {
      // Get the most recent message for each conversation
      const lastMessages = await this.messageRepo
        .createQueryBuilder('msg')
        .where('msg.conversationId IN (:...ids)', { ids: conversationIds })
        .orderBy('msg.createdAt', 'DESC')
        .getMany();

      this.logger.log(`Found ${lastMessages.length} messages for ${conversationIds.length} conversations`);

      // Group by conversationId and keep only the most recent
      for (const msg of lastMessages) {
        if (!messageByConversationId.has(msg.conversationId)) {
          messageByConversationId.set(msg.conversationId, msg);
        }
      }
    }

    const result = conversations.map(conv => {
      const lastMessage = messageByConversationId.get(conv.id);
      const metadata = conv.metadata as Record<string, unknown> || {};

      // Use message createdAt if available, otherwise fall back to OpenPhone's lastActivityAt from metadata
      let lastMessageAt: Date | null = null;
      if (lastMessage?.createdAt) {
        lastMessageAt = lastMessage.createdAt;
      } else if (metadata.lastActivityAt) {
        lastMessageAt = new Date(metadata.lastActivityAt as string);
      }

      // Build participant contacts for group conversations
      // Contact data now lives in Callio - set contactName to null
      let participantContacts: { phoneNumber: string; contactId: string | null; contactName: string | null }[] | null = null;
      if (conv.participantPhoneNumbers && conv.participantPhoneNumbers.length > 1) {
        participantContacts = conv.participantPhoneNumbers.map(phone => {
          return {
            phoneNumber: phone,
            contactId: null,
            contactName: null,
          };
        });
      }

      return {
        id: conv.id,
        externalId: conv.externalId,
        phoneNumber: conv.phoneNumber,
        phoneNumberName: metadata.phoneNumberName as string || null,
        participantPhoneNumber: conv.participantPhoneNumber,
        participantPhoneNumbers: conv.participantPhoneNumbers || null,
        participantContacts,
        contactId: conv.contactId || null,
        contactName: (metadata.contactName as string) || (metadata.conversationName as string) || null,
        lastMessage: lastMessage?.body || (metadata.lastMessagePreview as string) || null,
        lastMessageAt: lastMessageAt,
        unreadCount: metadata.unreadCount as number || 0,
      };
    });

    // Conversations are already sorted by last_activity from DB query

    return {
      conversations: result,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getMessagesForConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<CommunicationMessage[]> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId, workspaceId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    // Find ALL conversations with the same participant to merge complete message history
    // The same participant might have multiple conversation records in our DB
    const participantPhones: string[] = [];
    if (conversation.participantPhoneNumber) {
      participantPhones.push(conversation.participantPhoneNumber);
      participantPhones.push(this.normalizePhoneNumber(conversation.participantPhoneNumber));
    }
    if (conversation.participantPhoneNumbers && Array.isArray(conversation.participantPhoneNumbers)) {
      for (const phone of conversation.participantPhoneNumbers) {
        participantPhones.push(phone);
        participantPhones.push(this.normalizePhoneNumber(phone));
      }
    }

    // Find all conversations with this participant
    let conversationIds = [conversation.id];
    if (participantPhones.length > 0) {
      const relatedConversations = await this.conversationRepo
        .createQueryBuilder('conv')
        .where('conv.workspaceId = :workspaceId', { workspaceId })
        .andWhere('conv.participantPhoneNumber IN (:...phones)', { phones: participantPhones })
        .getMany();

      conversationIds = [...new Set(relatedConversations.map(c => c.id))];
      this.logger.log(`Found ${conversationIds.length} related conversations for participant`);
    }

    return this.messageRepo.find({
      where: { conversationId: In(conversationIds) },
      order: { createdAt: 'ASC' },
    });
  }

  async getMessagesForContact(
    workspaceId: string,
    contactId: string,
  ): Promise<CommunicationMessage[]> {
    // Contact data now lives in Callio service - find conversations by contactId reference
    const conversations = await this.conversationRepo
      .createQueryBuilder('conv')
      .where('conv.workspaceId = :workspaceId', { workspaceId })
      .andWhere('conv.contactId = :contactId', { contactId })
      .getMany();

    if (conversations.length === 0) {
      return [];
    }

    this.logger.log(`Found ${conversations.length} conversations for contact ${contactId}`);

    // Get messages from ALL conversations and merge them
    const conversationIds = conversations.map(c => c.id);
    return this.messageRepo.find({
      where: { conversationId: In(conversationIds) },
      order: { createdAt: 'ASC' },
    });
  }

  async sendMessage(
    workspaceId: string,
    contactId: string,
    body: string,
    fromNumber?: string,
  ): Promise<CommunicationMessage> {
    const integration = await this.getIntegration(workspaceId);

    // Contact data now lives in Callio service - find conversation by contactId
    const conversation = await this.conversationRepo.findOne({
      where: { workspaceId, contactId },
    });

    if (!conversation) {
      throw new NotFoundException('No conversation found for this contact');
    }

    if (!conversation.participantPhoneNumber) {
      throw new BadRequestException('Conversation has no participant phone number');
    }

    const provider = this.getProvider(integration.provider);
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    // Use provided fromNumber or existing conversation's phone number
    const senderNumber = fromNumber || conversation.phoneNumber || '';

    // The OpenPhone provider will resolve the phone number to an ID
    const result = await provider.sendMessage({
      from: senderNumber,
      to: conversation.participantPhoneNumber,
      body,
      workspaceId: credentials,
    });

    const message = this.messageRepo.create({
      conversationId: conversation.id,
      direction: MessageDirection.OUT,
      body,
      fromNumber: senderNumber || 'unknown',
      toNumber: conversation.participantPhoneNumber,
      providerMessageId: result.providerMessageId,
      status: result.status,
    });

    return this.messageRepo.save(message);
  }

  async sendMessageToConversation(
    workspaceId: string,
    conversationId: string,
    body: string,
    fromNumber?: string,
  ): Promise<CommunicationMessage> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId, workspaceId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (!conversation.participantPhoneNumber) {
      throw new BadRequestException('Conversation has no participant phone number');
    }

    const integration = await this.getIntegration(workspaceId);
    const provider = this.getProvider(integration.provider);
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    // Use provided fromNumber or existing conversation's phone number
    // The provider will resolve to a valid phone number ID if needed
    const senderNumber = fromNumber || conversation.phoneNumber || '';

    // The OpenPhone provider will resolve the phone number to an ID
    const result = await provider.sendMessage({
      from: senderNumber,
      to: conversation.participantPhoneNumber,
      body,
      workspaceId: credentials,
    });

    const message = this.messageRepo.create({
      conversationId: conversation.id,
      direction: MessageDirection.OUT,
      body,
      fromNumber: senderNumber || 'unknown',
      toNumber: conversation.participantPhoneNumber,
      providerMessageId: result.providerMessageId,
      status: result.status,
    });

    return this.messageRepo.save(message);
  }

  /**
   * Send a message directly to a phone number, creating a conversation if needed.
   * This is the new /v1/messages endpoint logic.
   */
  async sendMessageToPhoneNumber(
    workspaceId: string,
    fromNumber: string,
    toNumber: string,
    body: string,
    channel: string = 'sms',
    tenantId?: string,
  ): Promise<CommunicationMessage> {
    // Normalize phone numbers to E.164 format
    const normalizedFrom = this.normalizePhoneNumber(fromNumber);
    const normalizedTo = this.normalizePhoneNumber(toNumber);

    this.logger.log(`Sending ${channel} message: from=${normalizedFrom}, to=${normalizedTo}${tenantId ? ` (tenant=${tenantId})` : ''}`);

    // Handle WhatsApp Web channel separately
    if (channel === 'whatsapp') {
      return this.sendWhatsAppMessage(workspaceId, normalizedFrom, normalizedTo, body);
    }

    // When called with a tenant key, look up credentials from TenantIntegration table
    if (tenantId) {
      const tenantOpenPhoneIntegration = await this.tenantIntegrationRepo.findOne({
        where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE, status: IntegrationStatus.ACTIVE },
      });

      if (!tenantOpenPhoneIntegration) {
        throw new BadRequestException('No active integration found for this tenant. Please connect OpenPhone first.');
      }

      const credentials = this.encryptionService.decrypt(tenantOpenPhoneIntegration.credentialsEncrypted);
      const provider: CommunicationProvider = this.openPhoneProvider;

      // Find or create conversation for this phone pair
      let conversation = await this.conversationRepo.findOne({
        where: {
          workspaceId,
          phoneNumber: normalizedFrom,
          participantPhoneNumber: normalizedTo,
          provider: ProviderType.OPENPHONE,
        },
      });

      if (!conversation) {
        conversation = this.conversationRepo.create({
          workspaceId,
          contactId: null,
          externalId: `conv_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          provider: ProviderType.OPENPHONE,
          phoneNumber: normalizedFrom,
          participantPhoneNumber: normalizedTo,
          channel: channel as any,
        });
        await this.conversationRepo.save(conversation);
      }

      const result = await provider.sendMessage({
        from: normalizedFrom,
        to: normalizedTo,
        body,
        workspaceId: credentials,
        channel: channel as ChannelType,
      });

      const message = this.messageRepo.create({
        conversationId: conversation.id,
        direction: MessageDirection.OUT,
        body,
        fromNumber: normalizedFrom,
        toNumber: normalizedTo,
        providerMessageId: result.providerMessageId,
        status: result.status,
        channel: channel as any,
      });

      return this.messageRepo.save(message);
    }

    // Determine which provider to use based on the fromNumber
    // First check Twilio
    const twilioIntegration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO, status: IntegrationStatus.ACTIVE },
    });

    // Check OpenPhone
    const openPhoneIntegration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.OPENPHONE, status: IntegrationStatus.ACTIVE },
    });

    if (!twilioIntegration && !openPhoneIntegration) {
      throw new BadRequestException('No active integration found. Please set up Twilio or OpenPhone first.');
    }

    // Determine provider based on fromNumber lookup
    let integration: CommunicationIntegration | null = null;
    let provider: CommunicationProvider | null = null;

    // Try to match fromNumber with Twilio phone numbers (using normalized comparison)
    if (twilioIntegration) {
      try {
        const credentials = this.encryptionService.decrypt(twilioIntegration.credentialsEncrypted);
        const twilioNumbers = await this.twilioProvider.getPhoneNumbersFromCredentials(credentials);
        for (const pn of twilioNumbers.values()) {
          if (this.normalizePhoneNumber(pn.phoneNumber) === normalizedFrom) {
            integration = twilioIntegration;
            provider = this.twilioProvider;
            break;
          }
        }
      } catch (e) {
        this.logger.warn('Failed to check Twilio numbers', e);
      }
    }

    // Try OpenPhone if not matched (using normalized comparison)
    if (!integration && openPhoneIntegration) {
      try {
        const credentials = this.encryptionService.decrypt(openPhoneIntegration.credentialsEncrypted);
        const opNumbers = await this.openPhoneProvider.getPhoneNumbersFromCredentials(credentials);
        for (const pn of opNumbers.values()) {
          if (this.normalizePhoneNumber(pn.number) === normalizedFrom) {
            integration = openPhoneIntegration;
            provider = this.openPhoneProvider;
            break;
          }
        }
      } catch (e) {
        this.logger.warn('Failed to check OpenPhone numbers', e);
      }
    }

    // Fallback to first available integration if fromNumber not matched
    if (!integration) {
      if (twilioIntegration) {
        integration = twilioIntegration;
        provider = this.twilioProvider;
      } else if (openPhoneIntegration) {
        integration = openPhoneIntegration;
        provider = this.openPhoneProvider;
      }
    }

    if (!integration || !provider) {
      throw new BadRequestException('Could not determine provider for the given fromNumber');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    // Find or create conversation for this phone pair (use normalized numbers)
    let conversation = await this.conversationRepo.findOne({
      where: {
        workspaceId,
        phoneNumber: normalizedFrom,
        participantPhoneNumber: normalizedTo,
        provider: integration.provider,
      },
    });

    if (!conversation) {
      conversation = this.conversationRepo.create({
        workspaceId,
        contactId: null,
        externalId: `conv_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        provider: integration.provider,
        phoneNumber: normalizedFrom,
        participantPhoneNumber: normalizedTo,
        channel: channel as any,
      });
      await this.conversationRepo.save(conversation);
    }

    // Send the message via provider (use normalized numbers)
    const result = await provider.sendMessage({
      from: normalizedFrom,
      to: normalizedTo,
      body,
      workspaceId: credentials,
      channel: channel as ChannelType,
    });

    // Create and save the message
    const message = this.messageRepo.create({
      conversationId: conversation.id,
      direction: MessageDirection.OUT,
      body,
      fromNumber: normalizedFrom,
      toNumber: normalizedTo,
      providerMessageId: result.providerMessageId,
      status: result.status,
      channel: channel as any,
    });

    return this.messageRepo.save(message);
  }

  /**
   * Send a WhatsApp message via WhatsApp Web provider
   */
  private async sendWhatsAppMessage(
    workspaceId: string,
    fromNumber: string,
    toNumber: string,
    body: string,
  ): Promise<CommunicationMessage> {
    // Check if WhatsApp is connected for this workspace
    const connected = await this.whatsappWebProvider.isConnected(workspaceId);
    if (!connected) {
      throw new BadRequestException(
        'WhatsApp is not connected. Please connect WhatsApp in Settings first.',
      );
    }

    // Get the session to find the connected phone number
    const session = await this.whatsappWebProvider.getSession(workspaceId);
    const whatsappFromNumber = session?.phoneNumber || fromNumber;

    // Send the message via WhatsApp Web
    const result = await this.whatsappWebProvider.sendMessage(workspaceId, toNumber, body);

    if (!result.success) {
      throw new BadRequestException(result.error || 'Failed to send WhatsApp message');
    }

    // Find or create conversation for WhatsApp
    let conversation = await this.conversationRepo.findOne({
      where: {
        workspaceId,
        phoneNumber: whatsappFromNumber,
        participantPhoneNumber: toNumber,
        channel: ChannelType.WHATSAPP,
      },
    });

    if (!conversation) {
      conversation = this.conversationRepo.create({
        workspaceId,
        contactId: null,
        externalId: `whatsapp_conv_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        provider: ProviderType.TWILIO, // We use a placeholder provider for WhatsApp Web
        phoneNumber: whatsappFromNumber,
        participantPhoneNumber: toNumber,
        channel: ChannelType.WHATSAPP,
      });
      await this.conversationRepo.save(conversation);
    }

    // Create and save the message
    const message = this.messageRepo.create({
      conversationId: conversation.id,
      direction: MessageDirection.OUT,
      body,
      fromNumber: whatsappFromNumber,
      toNumber: toNumber,
      providerMessageId: result.messageId || `wa_${Date.now()}`,
      status: MessageStatus.SENT,
      channel: ChannelType.WHATSAPP,
    });

    return this.messageRepo.save(message);
  }

  /**
   * Send a message using senderId (new preferred API)
   * This is the modern approach that uses Sender entities instead of raw phone numbers
   */
  async sendMessageWithSender(
    workspaceId: string,
    senderId: string,
    body: string,
    options: {
      conversationId?: string;
      contactId?: string;
      templateId?: string;
      templateName?: string;
    },
  ): Promise<CommunicationMessage> {
    // Validate that either conversationId or contactId is provided
    if (!options.conversationId && !options.contactId) {
      throw new BadRequestException('Either conversationId or contactId must be provided');
    }

    // Look up the sender
    const sender = await this.senderRepo.findOne({
      where: { id: senderId, workspaceId },
    });

    if (!sender) {
      throw new NotFoundException(`Sender with ID ${senderId} not found`);
    }

    // Get the recipient phone number
    let toNumber: string;
    let conversation: CommunicationConversation | null = null;
    let contactId: string | null = null;

    if (options.conversationId) {
      conversation = await this.conversationRepo.findOne({
        where: { id: options.conversationId, workspaceId },
      });
      if (!conversation) {
        throw new NotFoundException('Conversation not found');
      }
      toNumber = conversation.participantPhoneNumber;
      contactId = conversation.contactId || null;
    } else if (options.contactId) {
      // Contact data now lives in Callio - find conversation by contactId reference
      conversation = await this.conversationRepo.findOne({
        where: { workspaceId, contactId: options.contactId },
      });
      if (!conversation) {
        throw new NotFoundException('No conversation found for this contact');
      }
      if (!conversation.participantPhoneNumber) {
        throw new BadRequestException('Conversation has no participant phone number');
      }
      toNumber = conversation.participantPhoneNumber;
      contactId = options.contactId;
    } else {
      throw new BadRequestException('Either conversationId or contactId must be provided');
    }

    const normalizedTo = this.normalizePhoneNumber(toNumber);
    const normalizedFrom = this.normalizePhoneNumber(sender.address);

    this.logger.log(`Sending ${sender.channel} message via sender ${senderId}: from=${normalizedFrom}, to=${normalizedTo}`);

    // Handle WhatsApp Web channel
    if (sender.channel === ChannelType.WHATSAPP && sender.provider === 'whatsapp-web') {
      return this.sendWhatsAppMessage(workspaceId, normalizedFrom, normalizedTo, body);
    }

    // Get the appropriate integration and provider
    const providerType = sender.provider === 'twilio' ? ProviderType.TWILIO :
                         sender.provider === 'openphone' ? ProviderType.OPENPHONE :
                         ProviderType.TWILIO;

    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: providerType, status: IntegrationStatus.ACTIVE },
    });

    if (!integration) {
      throw new BadRequestException(`No active ${sender.provider} integration found`);
    }

    const provider = this.getProvider(providerType);
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    // Find or create conversation
    if (!conversation) {
      conversation = await this.conversationRepo.findOne({
        where: {
          workspaceId,
          phoneNumber: normalizedFrom,
          participantPhoneNumber: normalizedTo,
          provider: providerType,
        },
      });

      if (!conversation) {
        conversation = this.conversationRepo.create({
          workspaceId,
          contactId: contactId || null,
          externalId: `conv_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          provider: providerType,
          phoneNumber: normalizedFrom,
          participantPhoneNumber: normalizedTo,
          channel: sender.channel,
          senderId: sender.id,
        });
        await this.conversationRepo.save(conversation);
      }
    }

    // Send the message via provider
    const result = await provider.sendMessage({
      from: normalizedFrom,
      to: normalizedTo,
      body,
      workspaceId: credentials,
      channel: sender.channel,
      templateId: options.templateId,
    });

    // Create and save the message
    const message = this.messageRepo.create({
      conversationId: conversation.id,
      direction: MessageDirection.OUT,
      body,
      fromNumber: normalizedFrom,
      toNumber: normalizedTo,
      providerMessageId: result.providerMessageId,
      status: result.status,
      channel: sender.channel,
      templateId: options.templateId,
      templateName: options.templateName,
    });

    return this.messageRepo.save(message);
  }

  async getCallsForContact(
    workspaceId: string,
    contactId: string,
  ): Promise<CommunicationCall[]> {
    // Contact data now lives in Callio service - find conversations by contactId reference
    this.logger.log(`Getting calls for contact ${contactId}`);

    const conversations = await this.conversationRepo
      .createQueryBuilder('conv')
      .where('conv.workspaceId = :workspaceId', { workspaceId })
      .andWhere('conv.contactId = :contactId', { contactId })
      .getMany();

    this.logger.log(`Found ${conversations.length} conversations for contact ${contactId}`);

    if (conversations.length === 0) {
      return [];
    }

    // Get calls from ALL conversations and merge them
    const conversationIds = conversations.map(c => c.id);
    const calls = await this.callRepo.find({
      where: { conversationId: In(conversationIds) },
      order: { createdAt: 'DESC' },
    });

    this.logger.log(`Found ${calls.length} calls for contact ${contactId}`);
    return calls;
  }

  async getCallsForConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<CommunicationCall[]> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId, workspaceId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    // Find ALL conversations with the same participant to merge complete call history
    const participantPhones: string[] = [];
    if (conversation.participantPhoneNumber) {
      participantPhones.push(conversation.participantPhoneNumber);
      participantPhones.push(this.normalizePhoneNumber(conversation.participantPhoneNumber));
    }
    if (conversation.participantPhoneNumbers && Array.isArray(conversation.participantPhoneNumbers)) {
      for (const phone of conversation.participantPhoneNumbers) {
        participantPhones.push(phone);
        participantPhones.push(this.normalizePhoneNumber(phone));
      }
    }

    // Find all conversations with this participant
    let conversationIds = [conversation.id];
    if (participantPhones.length > 0) {
      const relatedConversations = await this.conversationRepo
        .createQueryBuilder('conv')
        .where('conv.workspaceId = :workspaceId', { workspaceId })
        .andWhere('conv.participantPhoneNumber IN (:...phones)', { phones: participantPhones })
        .getMany();

      conversationIds = [...new Set(relatedConversations.map(c => c.id))];
    }

    return this.callRepo.find({
      where: { conversationId: In(conversationIds) },
      order: { createdAt: 'DESC' },
    });
  }

  async initiateCall(
    workspaceId: string,
    contactId: string,
    fromNumber?: string,
  ): Promise<{ deepLink: string; webFallback: string; message: string }> {
    const integration = await this.getIntegration(workspaceId);

    // Contact data now lives in Callio service - find conversation by contactId reference
    const conversation = await this.conversationRepo.findOne({
      where: { workspaceId, contactId },
    });

    if (!conversation) {
      throw new NotFoundException('No conversation found for this contact');
    }

    if (!conversation.participantPhoneNumber) {
      throw new BadRequestException('Conversation has no participant phone number');
    }

    const provider = this.getProvider(integration.provider);
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    const result = await provider.initiateCall({
      from: fromNumber || '',
      to: conversation.participantPhoneNumber,
      workspaceId: credentials,
    });

    return {
      deepLink: result.deepLink || '',
      webFallback: result.webFallback || '',
      message: result.message || 'Call initiated',
    };
  }

  getSyncStatus(workspaceId: string): SyncProgress {
    return this.syncProgress.get(workspaceId) || {
      status: 'idle',
      phase: '',
      current: 0,
      total: 0,
      message: 'No sync in progress',
    };
  }

  cancelSync(workspaceId: string): { cancelled: boolean } {
    const progress = this.syncProgress.get(workspaceId);
    if (progress && progress.status === 'running') {
      this.syncCancelled.set(workspaceId, true);
      this.logger.log(`Sync cancellation requested for workspace ${workspaceId}`);
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  private isSyncCancelled(workspaceId: string): boolean {
    return this.syncCancelled.get(workspaceId) || false;
  }

  private clearCancellation(workspaceId: string): void {
    this.syncCancelled.delete(workspaceId);
  }

  private updateProgress(workspaceId: string, update: Partial<SyncProgress>) {
    const current = this.syncProgress.get(workspaceId) || {
      status: 'idle' as const,
      phase: '',
      current: 0,
      total: 0,
      message: '',
    };
    this.syncProgress.set(workspaceId, { ...current, ...update });
  }

  async syncConversations(workspaceId: string, options: SyncOptions = {}): Promise<SyncResult> {
    const { limit, since, until, syncMessages = true, forceRefresh = false, phoneNumberId, onlySavedContacts = true, provider: providerType } = options;

    // Check if sync is already running
    const currentProgress = this.syncProgress.get(workspaceId);
    if (currentProgress && currentProgress.status === 'running') {
      this.logger.warn(`Sync already running for workspace ${workspaceId}, skipping new sync request`);
      throw new Error('Sync already in progress. Please wait for it to complete or cancel it first.');
    }

    // Clear any previous cancellation flag
    this.clearCancellation(workspaceId);

    this.logger.log(`Starting sync for workspace ${workspaceId} with options: limit=${limit}, since=${since}, until=${until}, syncMessages=${syncMessages}, forceRefresh=${forceRefresh}, phoneNumberId=${phoneNumberId}, onlySavedContacts=${onlySavedContacts}`);

    // Validate date filters
    const now = new Date();
    if (since && since > now) {
      const futureDate = since.toISOString();
      const currentDate = now.toISOString();
      this.logger.error(`[SYNC VALIDATION] 'since' date is in the future: ${futureDate} (current time: ${currentDate})`);
      throw new BadRequestException(
        `Invalid sync date: The 'since' date (${futureDate.split('T')[0]}) is in the future. Please select a past date.`
      );
    }
    if (until && until > now) {
      const futureDate = until.toISOString();
      const currentDate = now.toISOString();
      this.logger.error(`[SYNC VALIDATION] 'until' date is in the future: ${futureDate} (current time: ${currentDate})`);
      throw new BadRequestException(
        `Invalid sync date: The 'until' date (${futureDate.split('T')[0]}) is in the future. Please select a past date.`
      );
    }

    const result: SyncResult = {
      conversationsFromProvider: 0,
      conversationsSynced: 0,
      messagesSynced: 0,
      callsSynced: 0,
      contactsLinked: 0,
      contactsCreated: 0,
      errors: 0,
      conversationsSkipped: 0,
    };

    this.updateProgress(workspaceId, {
      status: 'running',
      phase: 'Initializing',
      current: 0,
      total: 0,
      message: 'Starting sync...',
      startedAt: new Date(),
    });

    const integration = await this.getIntegration(workspaceId, providerType);
    this.logger.log(`Found integration: ${integration.provider}`);

    const provider = this.getProvider(integration.provider);
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    try {
      // First, fetch conversations to know which contacts we need
      const providerName = integration.provider === ProviderType.TWILIO ? 'Twilio' : 'OpenPhone';
      this.updateProgress(workspaceId, {
        phase: 'Fetching conversations',
        message: `Fetching conversations from ${providerName}...`,
      });

      // Pass limit, phoneNumberId, and since filter to provider so it can filter at API level
      // For OpenPhone, passing 'since' enables message-based filtering to work around stale lastActivityAt
      let conversations = await provider.getConversations(credentials, limit, phoneNumberId, since);
      const conversationsFromProvider = conversations.length;
      result.conversationsFromProvider = conversationsFromProvider;
      this.logger.log(`Fetched ${conversationsFromProvider} conversations from ${providerName}${phoneNumberId ? ` (filtered by phoneNumberId: ${phoneNumberId})` : ''}${since ? ` since ${since.toISOString()}` : ''}`);

      // Apply date filter if specified (note: this may reduce count below limit)
      if (since || until) {
        this.logger.log(`Date filter - since: ${since?.toISOString()} (${since?.getTime()}) | until: ${until?.toISOString()} (${until?.getTime()})`);
        const beforeCount = conversations.length;

        // Log a few sample conversations to debug date filtering
        const sampleConvs = conversations.slice(0, 3);
        for (const sample of sampleConvs) {
          if (sample.lastMessageAt) {
            const sampleDate = new Date(sample.lastMessageAt);
            this.logger.log(`Sample conv ${sample.externalId}: lastMessageAt=${sample.lastMessageAt} (${sampleDate.getTime()}) | would exclude by until: ${until ? sampleDate > until : false}`);
          }
        }

        conversations = conversations.filter(c => {
          if (!c.lastMessageAt) return false;
          const activityDate = new Date(c.lastMessageAt);
          const sinceFail = since && activityDate < since;
          const untilFail = until && activityDate > until;
          if (sinceFail || untilFail) {
            this.logger.debug(`Excluding conversation ${c.externalId}: lastMessageAt=${c.lastMessageAt} | sinceFail=${sinceFail} | untilFail=${untilFail}`);
            result.conversationsSkipped++;
          }
          return !sinceFail && !untilFail;
        });
        this.logger.log(`Filtered from ${beforeCount} to ${conversations.length} conversations${since ? ` since ${since.toISOString()}` : ''}${until ? ` until ${until.toISOString()}` : ''}`);
      }

      // Apply phone number filter if specified
      if (phoneNumberId) {
        const beforePhoneFilter = conversations.length;
        conversations = conversations.filter(c => {
          const metadata = c.metadata as Record<string, unknown> | undefined;
          return metadata?.phoneNumberId === phoneNumberId;
        });
        result.conversationsSkipped += beforePhoneFilter - conversations.length;
        this.logger.log(`Filtered to ${conversations.length} conversations for phone number ${phoneNumberId}`);
      }

      // Build a map for fast lookups of contacts by phone for filtering
      // For OpenPhone: fetch from OpenPhone API
      // For Twilio: use contacts from local database
      const contactsForFiltering = new Map<string, { firstName?: string; lastName?: string }>();
      const openPhoneContactsByPhone = new Map<string, any>(); // Keep for later use in contact sync

      if (integration.provider === ProviderType.OPENPHONE) {
        // Fetch contacts from OpenPhone - needed for contact names and saved contacts filter
        this.updateProgress(workspaceId, {
          phase: 'Fetching OpenPhone contacts',
          message: 'Fetching contacts from OpenPhone...',
        });

        try {
          const openPhoneContacts = await this.openPhoneProvider.getOpenPhoneContacts(credentials);
          this.logger.log(`Fetched ${openPhoneContacts.length} contacts from OpenPhone`);

          // Index OpenPhone contacts by all their phone numbers
          for (const opContact of openPhoneContacts) {
            if (opContact.phoneNumbers) {
              for (const phoneEntry of opContact.phoneNumbers) {
                if (phoneEntry.value) {
                  contactsForFiltering.set(phoneEntry.value, opContact);
                  contactsForFiltering.set(this.normalizePhoneNumber(phoneEntry.value), opContact);
                  openPhoneContactsByPhone.set(phoneEntry.value, opContact);
                  openPhoneContactsByPhone.set(this.normalizePhoneNumber(phoneEntry.value), opContact);
                }
              }
            }
          }
          this.logger.log(`Indexed ${contactsForFiltering.size} phone number mappings from OpenPhone contacts`);
        } catch (contactsError) {
          this.logger.error(`Failed to fetch OpenPhone contacts: ${contactsError}`);
          // If we can't fetch contacts and onlySavedContacts is enabled, we can't properly filter
          if (onlySavedContacts) {
            this.logger.warn(`Cannot apply saved contacts filter without OpenPhone contacts data - disabling filter`);
          }
        }
      } else if (integration.provider === ProviderType.TWILIO) {
        // Contact data now lives in Callio service - skip local contact loading for Twilio
        this.logger.log(`Skipping local contact loading for Twilio sync (contacts live in Callio)`);
      }

      // Filter to only saved contacts (conversations where the participant has a saved contact with a name)
      if (onlySavedContacts && contactsForFiltering.size > 0) {
        const beforeSavedFilter = conversations.length;

        // Helper to check if a contact has a real name (not just phone number)
        const hasRealName = (contact: { firstName?: string; lastName?: string }): boolean => {
          const firstName = contact.firstName?.trim() || '';
          const lastName = contact.lastName?.trim() || '';
          const fullName = `${firstName} ${lastName}`.trim();

          if (!fullName) return false;

          // Check if name is just phone number digits
          const nameDigits = fullName.replace(/\D/g, '');
          if (nameDigits.length >= 7) {
            // Name looks like a phone number
            return false;
          }
          return true;
        };

        // Log sample of conversations to understand the data
        this.logger.log(`Sample conversations with contact lookup (first 10):`);
        conversations.slice(0, 10).forEach((c, i) => {
          const participantPhone = c.participantPhoneNumber;
          const normalizedPhone = this.normalizePhoneNumber(participantPhone || '');
          const contact = contactsForFiltering.get(participantPhone || '') || contactsForFiltering.get(normalizedPhone);
          const contactName = contact ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() : '(no contact)';
          const isSaved = contact && hasRealName(contact);
          this.logger.log(`  [${i}] participant=${participantPhone} | contact="${contactName}" | saved=${isSaved}`);
        });

        conversations = conversations.filter(c => {
          const participantPhone = c.participantPhoneNumber;
          if (!participantPhone) return false;

          // Look up contact by participant phone number
          const normalizedPhone = this.normalizePhoneNumber(participantPhone);
          const contact = contactsForFiltering.get(participantPhone) || contactsForFiltering.get(normalizedPhone);

          // Include only if there's a contact with a real name
          return contact && hasRealName(contact);
        });
        result.conversationsSkipped += beforeSavedFilter - conversations.length;
        this.logger.log(`Filtered to ${conversations.length} conversations with saved contacts (excluded ${beforeSavedFilter - conversations.length} unsaved)`);
      } else if (onlySavedContacts && contactsForFiltering.size === 0) {
        this.logger.warn(`onlySavedContacts enabled but no contacts found - syncing all conversations`);
      }

      // Apply limit again in case filtering changed things
      if (limit && limit > 0 && conversations.length > limit) {
        result.conversationsSkipped += conversations.length - limit;
        conversations = conversations.slice(0, limit);
        this.logger.log(`Limited to ${conversations.length} conversations`);
      }

      // Collect participant phone numbers from conversations we're syncing
      const participantPhones = new Set<string>();
      for (const conv of conversations) {
        if (conv.participantPhoneNumber) {
          participantPhones.add(conv.participantPhoneNumber);
          participantPhones.add(this.normalizePhoneNumber(conv.participantPhoneNumber));
        }
      }
      this.logger.log(`Found ${participantPhones.size / 2} unique participant phone numbers`)

      // Look up contact names from OpenPhone for all participant phone numbers
      let contactNameMap = new Map<string, string>();
      if (participantPhones.size > 0) {
        try {
          this.updateProgress(workspaceId, {
            phase: 'Looking up contacts',
            message: 'Fetching contact names from OpenPhone...',
          });
          contactNameMap = await (provider as any).lookupContactNamesByPhone(
            credentials,
            Array.from(participantPhones),
          );
          this.logger.log(`Contact name lookup: found ${contactNameMap.size} name mappings`);
        } catch (err: any) {
          this.logger.warn(`Contact name lookup failed: ${err.message}`);
        }
      }

      const total = conversations.length;
      this.updateProgress(workspaceId, {
        phase: 'Syncing conversations',
        total,
        message: `Found ${total} conversations to sync`,
      });

      for (let i = 0; i < conversations.length; i++) {
        // Check for cancellation
        if (this.isSyncCancelled(workspaceId)) {
          this.logger.log(`Sync cancelled for workspace ${workspaceId} at conversation ${i + 1} of ${total}`);
          this.updateProgress(workspaceId, {
            status: 'cancelled',
            phase: 'Cancelled',
            message: `Sync cancelled. Synced ${result.conversationsSynced} conversations, ${result.messagesSynced} messages before cancellation.`,
            completedAt: new Date(),
          });
          this.clearCancellation(workspaceId);
          return result;
        }

        const convData = conversations[i];

        this.updateProgress(workspaceId, {
          current: i + 1,
          message: `Syncing conversation ${i + 1} of ${total}`,
        });

        try {
          let conversation = await this.conversationRepo.findOne({
            where: { workspaceId, externalId: convData.externalId },
          });

          if (!conversation) {
            conversation = this.conversationRepo.create({
              workspaceId,
              externalId: convData.externalId,
              provider: integration.provider,
              phoneNumber: convData.phoneNumber,
              participantPhoneNumber: convData.participantPhoneNumber,
              participantPhoneNumbers: convData.participantPhoneNumbers,
              metadata: convData.metadata,
            });
          } else {
            conversation.metadata = convData.metadata;
            conversation.phoneNumber = convData.phoneNumber;
            conversation.participantPhoneNumbers = convData.participantPhoneNumbers;
          }

          // Enrich metadata with contact name from OpenPhone contacts
          if (convData.participantPhoneNumber && contactNameMap.size > 0) {
            const name = contactNameMap.get(convData.participantPhoneNumber)
              || contactNameMap.get('+' + convData.participantPhoneNumber)
              || contactNameMap.get(convData.participantPhoneNumber.replace(/^\+/, ''));
            if (name) {
              const meta = conversation.metadata as Record<string, unknown> || {};
              meta.contactName = name;
              conversation.metadata = meta;
            }
          }

          const savedConv = await this.conversationRepo.save(conversation);
          this.logger.log(`Saved conversation: id=${savedConv.id}, externalId=${savedConv.externalId}, phoneNumber='${savedConv.phoneNumber}', participant=${savedConv.participantPhoneNumber}`);
          result.conversationsSynced++;

          // Sync messages if enabled
          if (syncMessages) {
            try {
              // Pass phoneNumberId and participantPhoneNumber for OpenPhone API
              // phoneNumberId comes from the fresh OpenPhone API response (convData), not stored metadata
              const phoneNumberId = (convData.metadata as Record<string, unknown>)?.phoneNumberId as string | undefined;

              if (!phoneNumberId) {
                this.logger.warn(`No phoneNumberId in OpenPhone response for conversation ${convData.externalId}, skipping message sync`);
              } else {
                this.logger.log(`Syncing messages for conversation ${convData.externalId} with phoneNumberId ${phoneNumberId}...`);
              }

              const messages = await provider.getMessages(
                credentials,
                convData.externalId,
                phoneNumberId,
                convData.participantPhoneNumber,
              );
              this.logger.log(`Got ${messages.length} messages for conversation ${convData.externalId}`);

              for (const msgData of messages) {
                // SECURITY: Include workspace context to prevent cross-workspace data leaks
                const existingMessage = await this.messageRepo
                  .createQueryBuilder('msg')
                  .innerJoin('msg.conversation', 'conv')
                  .where('msg.providerMessageId = :providerId', { providerId: msgData.providerMessageId })
                  .andWhere('conv.workspaceId = :workspaceId', { workspaceId })
                  .getOne();

                if (!existingMessage) {
                  const message = this.messageRepo.create({
                    conversationId: conversation.id,
                    direction: msgData.direction,
                    body: msgData.body,
                    fromNumber: msgData.fromNumber,
                    toNumber: msgData.toNumber,
                    providerMessageId: msgData.providerMessageId,
                    status: msgData.status,
                    metadata: msgData.metadata,
                    createdAt: msgData.createdAt, // Use the original timestamp from OpenPhone
                  });
                  await this.messageRepo.save(message);
                  result.messagesSynced++;
                } else if (forceRefresh) {
                  // Update existing message with latest data from OpenPhone
                  existingMessage.body = msgData.body;
                  existingMessage.status = msgData.status;
                  if (msgData.metadata) {
                    existingMessage.metadata = msgData.metadata;
                  }
                  await this.messageRepo.save(existingMessage);
                  result.messagesSynced++;
                }
              }
            } catch (msgError: unknown) {
              const err = msgError as { message?: string; response?: { status?: number; data?: unknown } };
              this.logger.error(`Failed to fetch messages for conversation ${convData.externalId}: ${err.message}`);
              if (err.response) {
                this.logger.error(`API response: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
              }
              result.errors++;
            }
          }

          // Sync calls for this conversation
          if (syncMessages && convData.participantPhoneNumber) {
            try {
              const callsPhoneNumberId = (convData.metadata as Record<string, unknown>)?.phoneNumberId as string | undefined;
              if (callsPhoneNumberId) {
                this.logger.log(`Syncing calls for conversation ${convData.externalId} with phoneNumberId ${callsPhoneNumberId}...`);
              }

              const calls = await this.openPhoneProvider.getCallsForParticipant(
                credentials,
                convData.participantPhoneNumber,
                callsPhoneNumberId,
              );
              this.logger.log(`Got ${calls.length} calls for conversation ${convData.externalId}`);

              for (const callData of calls) {
                // SECURITY: Include workspace context to prevent cross-workspace data leaks
                const existingCall = await this.callRepo
                  .createQueryBuilder('call')
                  .innerJoin('call.conversation', 'conv')
                  .where('call.providerCallId = :providerId', { providerId: callData.providerCallId })
                  .andWhere('conv.workspaceId = :workspaceId', { workspaceId })
                  .getOne();

                if (!existingCall) {
                  const call = this.callRepo.create({
                    conversationId: conversation.id,
                    direction: callData.direction,
                    duration: callData.duration,
                    fromNumber: callData.fromNumber,
                    toNumber: callData.toNumber,
                    providerCallId: callData.providerCallId,
                    status: callData.status,
                    recordingUrl: callData.recordingUrl,
                    voicemailUrl: callData.voicemailUrl,
                    metadata: callData.metadata,
                    createdAt: callData.createdAt,
                  });
                  await this.callRepo.save(call);
                  result.callsSynced++;
                } else if (forceRefresh) {
                  // Update existing call with latest data
                  existingCall.duration = callData.duration;
                  existingCall.status = callData.status;
                  existingCall.recordingUrl = callData.recordingUrl || existingCall.recordingUrl;
                  existingCall.voicemailUrl = callData.voicemailUrl || existingCall.voicemailUrl;
                  if (callData.metadata) {
                    existingCall.metadata = callData.metadata;
                  }
                  await this.callRepo.save(existingCall);
                  result.callsSynced++;
                }
              }
            } catch (callError: unknown) {
              const err = callError as { message?: string; response?: { status?: number; data?: unknown } };
              this.logger.error(`Failed to fetch calls for conversation ${convData.externalId}: ${err.message}`);
              if (err.response) {
                this.logger.error(`API response: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
              }
              result.errors++;
            }
          }
        } catch (convError: unknown) {
          const err = convError as { message?: string };
          this.logger.error(`Failed to sync conversation ${convData.externalId}: ${err.message}`);
          result.errors++;
        }
      }

      this.updateProgress(workspaceId, {
        status: 'completed',
        phase: 'Complete',
        current: total,
        message: `Synced ${result.conversationsSynced} conversations, ${result.messagesSynced} messages, ${result.callsSynced} calls`,
        completedAt: new Date(),
        result,
      });

      this.logger.log(`Sync completed for workspace ${workspaceId}: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      this.updateProgress(workspaceId, {
        status: 'error',
        phase: 'Error',
        message: 'Sync failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        completedAt: new Date(),
      });
      this.logger.error(`Failed to sync conversations for workspace ${workspaceId}`, error);
      throw error;
    }
  }

  /**
   * Quick sync - only refresh conversations that have been updated in OpenPhone
   * Compares lastActivityAt from OpenPhone with stored metadata to detect changes
   */
  async quickSyncConversations(
    workspaceId: string,
    conversationIds?: string[],
  ): Promise<{ updated: number; unchanged: number; messagesUpdated: number; callsSynced: number; errors: number }> {
    this.logger.log(`Starting quick sync for workspace ${workspaceId}, conversationIds: ${conversationIds?.length || 'all visible'}`);

    const result = { updated: 0, unchanged: 0, messagesUpdated: 0, callsSynced: 0, errors: 0 };

    this.updateProgress(workspaceId, {
      status: 'running',
      phase: 'Quick sync',
      current: 0,
      total: 0,
      message: 'Checking for updates...',
      startedAt: new Date(),
    });

    try {
      const integration = await this.getIntegration(workspaceId);
      const provider = this.getProvider(integration.provider);
      const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

      // Get conversations to check - either specific ones or recent from DB
      let dbConversations: CommunicationConversation[];
      if (conversationIds && conversationIds.length > 0) {
        dbConversations = await this.conversationRepo.find({
          where: { workspaceId, id: In(conversationIds) },
        });
      } else {
        // Get most recent 50 conversations from DB
        dbConversations = await this.conversationRepo.find({
          where: { workspaceId },
          order: { updatedAt: 'DESC' },
          take: 50,
        });
      }

      this.logger.log(`Checking ${dbConversations.length} conversations for updates`);

      // Build a map of externalId -> dbConversation for quick lookup
      const dbConvMap = new Map<string, CommunicationConversation>();
      for (const conv of dbConversations) {
        dbConvMap.set(conv.externalId, conv);
      }

      // Fetch fresh conversation data from OpenPhone (limit to 100 most recent)
      this.updateProgress(workspaceId, {
        message: 'Fetching latest from OpenPhone...',
      });

      const openPhoneConversations = await provider.getConversations(credentials, 100);

      // Filter to only conversations we care about
      const relevantConversations = openPhoneConversations.filter(c => dbConvMap.has(c.externalId));

      const total = relevantConversations.length;
      this.updateProgress(workspaceId, {
        total,
        message: `Checking ${total} conversations...`,
      });

      for (let i = 0; i < relevantConversations.length; i++) {
        const opConv = relevantConversations[i];
        const dbConv = dbConvMap.get(opConv.externalId);

        if (!dbConv) continue;

        this.updateProgress(workspaceId, {
          current: i + 1,
          message: `Checking conversation ${i + 1} of ${total}...`,
        });

        try {
          // Compare lastActivityAt to detect updates
          const dbLastActivity = (dbConv.metadata as Record<string, unknown>)?.lastActivityAt as string | undefined;
          const opLastActivity = (opConv.metadata as Record<string, unknown>)?.lastActivityAt as string | undefined;

          const dbTime = dbLastActivity ? new Date(dbLastActivity).getTime() : 0;
          const opTime = opLastActivity ? new Date(opLastActivity).getTime() : 0;

          if (opTime > dbTime) {
            // Conversation has been updated - sync it
            this.logger.log(`Conversation ${opConv.externalId} has been updated (${dbLastActivity} -> ${opLastActivity})`);

            // Update conversation metadata
            dbConv.metadata = opConv.metadata;
            dbConv.phoneNumber = opConv.phoneNumber;
            await this.conversationRepo.save(dbConv);

            // Sync messages for this conversation
            // phoneNumberId comes from fresh OpenPhone API response (opConv.metadata)
            const phoneNumberId = (opConv.metadata as Record<string, unknown>)?.phoneNumberId as string | undefined;

            if (phoneNumberId && opConv.participantPhoneNumber) {
              try {
                const messages = await provider.getMessages(
                  credentials,
                  opConv.externalId,
                  phoneNumberId,
                  opConv.participantPhoneNumber,
                );

                for (const msgData of messages) {
                  // SECURITY: Include workspace context to prevent cross-workspace data leaks
                  const existingMessage = await this.messageRepo
                    .createQueryBuilder('msg')
                    .innerJoin('msg.conversation', 'conv')
                    .where('msg.providerMessageId = :providerId', { providerId: msgData.providerMessageId })
                    .andWhere('conv.workspaceId = :workspaceId', { workspaceId })
                    .getOne();

                  if (!existingMessage) {
                    const message = this.messageRepo.create({
                      conversationId: dbConv.id,
                      direction: msgData.direction,
                      body: msgData.body,
                      fromNumber: msgData.fromNumber,
                      toNumber: msgData.toNumber,
                      providerMessageId: msgData.providerMessageId,
                      status: msgData.status,
                      metadata: msgData.metadata,
                      createdAt: msgData.createdAt,
                    });
                    await this.messageRepo.save(message);
                    result.messagesUpdated++;
                  }
                }
              } catch (msgError) {
                this.logger.warn(`Failed to sync messages for ${opConv.externalId}: ${msgError}`);
              }
            }

            // Sync calls for this conversation using participant phone number
            if (opConv.participantPhoneNumber) {
              try {
                const calls = await this.openPhoneProvider.getCallsForParticipant(
                  credentials,
                  opConv.participantPhoneNumber,
                );

                for (const callData of calls) {
                  // SECURITY: Include workspace context to prevent cross-workspace data leaks
                  const existingCall = await this.callRepo
                    .createQueryBuilder('call')
                    .innerJoin('call.conversation', 'conv')
                    .where('call.providerCallId = :providerId', { providerId: callData.providerCallId })
                    .andWhere('conv.workspaceId = :workspaceId', { workspaceId })
                    .getOne();

                  if (!existingCall) {
                    const call = this.callRepo.create({
                      conversationId: dbConv.id,
                      direction: callData.direction,
                      duration: callData.duration,
                      fromNumber: callData.fromNumber,
                      toNumber: callData.toNumber,
                      providerCallId: callData.providerCallId,
                      status: callData.status,
                      recordingUrl: callData.recordingUrl,
                      voicemailUrl: callData.voicemailUrl,
                      metadata: callData.metadata,
                      createdAt: callData.createdAt,
                    });
                    await this.callRepo.save(call);
                    result.callsSynced++;
                  }
                }
              } catch (callError) {
                this.logger.warn(`Failed to sync calls for ${opConv.externalId}: ${callError}`);
              }
            }

            result.updated++;
          } else {
            result.unchanged++;
          }
        } catch (convError) {
          this.logger.error(`Error checking conversation ${opConv.externalId}: ${convError}`);
          result.errors++;
        }
      }

      this.updateProgress(workspaceId, {
        status: 'completed',
        phase: 'Complete',
        current: total,
        message: `Updated ${result.updated} conversations, ${result.unchanged} unchanged, ${result.messagesUpdated} new messages, ${result.callsSynced} new calls`,
        completedAt: new Date(),
      });

      this.logger.log(`Quick sync completed: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      this.updateProgress(workspaceId, {
        status: 'error',
        phase: 'Error',
        message: 'Quick sync failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        completedAt: new Date(),
      });
      throw error;
    }
  }

  /**
   * Sync a single conversation - fetches latest messages and calls from OpenPhone.
   * Used by the sync button on the conversation detail view.
   */
  async syncSingleConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<{ messagesSynced: number; callsSynced: number; errors: number }> {
    this.logger.log(`Syncing single conversation ${conversationId} for workspace ${workspaceId}`);

    const result = { messagesSynced: 0, callsSynced: 0, errors: 0 };

    // Get the conversation
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId, workspaceId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (!conversation.participantPhoneNumber) {
      throw new BadRequestException('Conversation has no participant phone number');
    }

    // Get integration and credentials
    const integration = await this.getIntegration(workspaceId);
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    // Extract phoneNumberId from conversation metadata to filter sync to this phone line only
    const phoneNumberId = (conversation.metadata as Record<string, unknown>)?.phoneNumberId as string | undefined;
    if (phoneNumberId) {
      this.logger.log(`Syncing for phone line: ${phoneNumberId}`);
    } else {
      this.logger.warn(`No phoneNumberId in conversation metadata, will fetch from all phone lines`);
    }

    // Sync messages using participant phone number (filtered to this phone line)
    try {
      this.logger.log(`Fetching messages for phone: ${conversation.participantPhoneNumber}`);
      const messageResult = await this.openPhoneProvider.getMessagesForParticipant(
        credentials,
        conversation.participantPhoneNumber,
        phoneNumberId,
      );

      this.logger.log(`Fetched ${messageResult.messages.length} messages`);

      for (const msgData of messageResult.messages) {
        // SECURITY: Include workspace context to prevent cross-workspace data leaks
        const existingMessage = await this.messageRepo
          .createQueryBuilder('msg')
          .innerJoin('msg.conversation', 'conv')
          .where('msg.providerMessageId = :providerId', { providerId: msgData.providerMessageId })
          .andWhere('conv.workspaceId = :workspaceId', { workspaceId })
          .getOne();

        if (!existingMessage) {
          const message = this.messageRepo.create({
            conversationId: conversation.id,
            direction: msgData.direction,
            body: msgData.body,
            fromNumber: msgData.fromNumber,
            toNumber: msgData.toNumber,
            providerMessageId: msgData.providerMessageId,
            status: msgData.status,
            metadata: msgData.metadata,
            createdAt: msgData.createdAt,
          });
          await this.messageRepo.save(message);
          result.messagesSynced++;
        } else {
          // Update existing message with correct timestamp and data from OpenPhone
          let updated = false;
          if (existingMessage.createdAt.getTime() !== msgData.createdAt.getTime()) {
            existingMessage.createdAt = msgData.createdAt;
            updated = true;
          }
          if (existingMessage.body !== msgData.body) {
            existingMessage.body = msgData.body;
            updated = true;
          }
          if (existingMessage.status !== msgData.status) {
            existingMessage.status = msgData.status;
            updated = true;
          }
          if (updated) {
            await this.messageRepo.save(existingMessage);
            result.messagesSynced++;
            this.logger.log(`Updated existing message ${existingMessage.id} with corrected data`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Failed to sync messages for conversation ${conversationId}:`, error);
      result.errors++;
    }

    // Sync calls using participant phone number (filtered to this phone line)
    try {
      this.logger.log(`Fetching calls for phone: ${conversation.participantPhoneNumber}`);
      const calls = await this.openPhoneProvider.getCallsForParticipant(
        credentials,
        conversation.participantPhoneNumber,
        phoneNumberId,
      );

      this.logger.log(`Fetched ${calls.length} calls`);

      for (const callData of calls) {
        // SECURITY: Include workspace context to prevent cross-workspace data leaks
        const existingCall = await this.callRepo
          .createQueryBuilder('call')
          .innerJoin('call.conversation', 'conv')
          .where('call.providerCallId = :providerId', { providerId: callData.providerCallId })
          .andWhere('conv.workspaceId = :workspaceId', { workspaceId })
          .getOne();

        if (!existingCall) {
          const call = this.callRepo.create({
            conversationId: conversation.id,
            direction: callData.direction,
            duration: callData.duration,
            fromNumber: callData.fromNumber,
            toNumber: callData.toNumber,
            providerCallId: callData.providerCallId,
            status: callData.status,
            recordingUrl: callData.recordingUrl,
            voicemailUrl: callData.voicemailUrl,
            metadata: callData.metadata,
            createdAt: callData.createdAt,
          });
          await this.callRepo.save(call);
          result.callsSynced++;
        } else {
          // Update existing call with correct timestamp and data from OpenPhone
          let updated = false;
          if (existingCall.createdAt.getTime() !== callData.createdAt.getTime()) {
            existingCall.createdAt = callData.createdAt;
            updated = true;
          }
          if (existingCall.duration !== callData.duration) {
            existingCall.duration = callData.duration;
            updated = true;
          }
          if (existingCall.status !== callData.status) {
            existingCall.status = callData.status;
            updated = true;
          }
          if (callData.recordingUrl && existingCall.recordingUrl !== callData.recordingUrl) {
            existingCall.recordingUrl = callData.recordingUrl;
            updated = true;
          }
          if (callData.voicemailUrl && existingCall.voicemailUrl !== callData.voicemailUrl) {
            existingCall.voicemailUrl = callData.voicemailUrl;
            updated = true;
          }
          if (updated) {
            await this.callRepo.save(existingCall);
            result.callsSynced++;
            this.logger.log(`Updated existing call ${existingCall.id} with corrected data`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Failed to sync calls for conversation ${conversationId}:`, error);
      result.errors++;
    }

    this.logger.log(`Single conversation sync completed for ${conversationId}: ${JSON.stringify(result)}`);
    return result;
  }

  /**
   * Unlink a contact from a conversation.
   * This clears the contactId so the system can re-link to the correct contact.
   */
  async unlinkContactFromConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<void> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId, workspaceId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (!conversation.contactId) {
      this.logger.log(`Conversation ${conversationId} has no contact linked`);
      return;
    }

    this.logger.log(`Unlinking contact ${conversation.contactId} from conversation ${conversationId}`);
    conversation.contactId = null;
    await this.conversationRepo.save(conversation);
  }

  async syncContactsFromConversations(
    workspaceId: string,
    options: { limit?: number } = {},
  ): Promise<{ created: number; updated: number }> {
    // Contact data now lives in Callio service - this method is a no-op
    this.logger.log(`syncContactsFromConversations called for workspace ${workspaceId} - contacts now live in Callio, skipping`);
    return { created: 0, updated: 0 };
  }

  async syncContactsFromOpenPhone(
    workspaceId: string,
    options: { limit?: number } = {},
  ): Promise<{ created: number; updated: number; errors: number }> {
    // Contact data now lives in Callio service - this method is a no-op
    this.logger.log(`syncContactsFromOpenPhone called for workspace ${workspaceId} - contacts now live in Callio, skipping`);
    return { created: 0, updated: 0, errors: 0 };
  }

  async syncContactCommunications(
    workspaceId: string,
    contactId: string,
  ): Promise<{ messagesSynced: number; callsSynced: number; errors: number; contactUpdated: boolean }> {
    this.logger.log(`Syncing communications for contact ${contactId} in workspace ${workspaceId}`);

    const result = { messagesSynced: 0, callsSynced: 0, errors: 0, contactUpdated: false };

    // Contact data now lives in Callio - find conversation by contactId to get phone number
    const conversation = await this.conversationRepo.findOne({
      where: { workspaceId, contactId },
    });

    if (!conversation) {
      throw new NotFoundException('No conversation found for this contact');
    }

    if (!conversation.participantPhoneNumber) {
      throw new BadRequestException('Conversation has no participant phone number');
    }

    // Get integration
    const integration = await this.getIntegration(workspaceId);
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    // Sync messages directly using the participant phone number
    try {
      this.logger.log(`Fetching messages directly for phone: ${conversation.participantPhoneNumber}`);
      const messageResult = await this.openPhoneProvider.getMessagesForParticipant(
        credentials,
        conversation.participantPhoneNumber,
      );

      this.logger.log(`Fetched ${messageResult.messages.length} messages for contact ${contactId}`);

      for (const msgData of messageResult.messages) {
        // SECURITY: Include workspace context to prevent cross-workspace data leaks
        const existingMessage = await this.messageRepo
          .createQueryBuilder('msg')
          .innerJoin('msg.conversation', 'conv')
          .where('msg.providerMessageId = :providerId', { providerId: msgData.providerMessageId })
          .andWhere('conv.workspaceId = :workspaceId', { workspaceId })
          .getOne();

        if (!existingMessage) {
          const message = this.messageRepo.create({
            conversationId: conversation.id,
            direction: msgData.direction,
            body: msgData.body,
            fromNumber: msgData.fromNumber,
            toNumber: msgData.toNumber,
            providerMessageId: msgData.providerMessageId,
            status: msgData.status,
            metadata: msgData.metadata,
          });
          await this.messageRepo.save(message);
          result.messagesSynced++;
        }
      }
    } catch (error) {
      this.logger.error(`Failed to sync messages for contact ${contactId}:`, error);
      result.errors++;
    }

    // Sync calls directly using the participant phone number
    try {
      this.logger.log(`Fetching calls directly for phone: ${conversation.participantPhoneNumber}`);
      const calls = await this.openPhoneProvider.getCallsForParticipant(
        credentials,
        conversation.participantPhoneNumber,
      );

      this.logger.log(`Fetched ${calls.length} calls for contact ${contactId}`);

      for (const callData of calls) {
        // SECURITY: Include workspace context to prevent cross-workspace data leaks
        const existingCall = await this.callRepo
          .createQueryBuilder('call')
          .innerJoin('call.conversation', 'conv')
          .where('call.providerCallId = :providerId', { providerId: callData.providerCallId })
          .andWhere('conv.workspaceId = :workspaceId', { workspaceId })
          .getOne();

        if (!existingCall) {
          const call = this.callRepo.create({
            conversationId: conversation.id,
            direction: callData.direction,
            duration: callData.duration,
            fromNumber: callData.fromNumber,
            toNumber: callData.toNumber,
            providerCallId: callData.providerCallId,
            status: callData.status,
            recordingUrl: callData.recordingUrl,
            voicemailUrl: callData.voicemailUrl,
            metadata: callData.metadata,
          });
          await this.callRepo.save(call);
          result.callsSynced++;
        }
      }
    } catch (error) {
      this.logger.error(`Failed to sync calls for contact ${contactId}:`, error);
      result.errors++;
    }

    this.logger.log(`Contact sync completed for ${contactId}: ${JSON.stringify(result)}`);
    return result;
  }

  async setupIntegration(
    workspaceId: string,
    provider: ProviderType,
    credentials: Record<string, string>,
    externalWorkspaceId?: string,
  ): Promise<CommunicationIntegration> {
    const providerInstance = this.getProvider(provider);
    const credentialsString = JSON.stringify(credentials);

    const isValid = await providerInstance.validateCredentials(credentialsString);
    if (!isValid) {
      throw new BadRequestException('Invalid credentials');
    }

    const encryptedCredentials = this.encryptionService.encrypt(credentialsString);

    let integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider },
    });

    if (integration) {
      integration.credentialsEncrypted = encryptedCredentials;
      integration.externalWorkspaceId = externalWorkspaceId || integration.externalWorkspaceId;
    } else {
      integration = this.integrationRepo.create({
        workspaceId,
        provider,
        credentialsEncrypted: encryptedCredentials,
        externalWorkspaceId,
      });
    }

    return this.integrationRepo.save(integration);
  }

  /**
   * Get phone numbers from all configured providers for this workspace.
   * Includes capabilities (sms, voice, mms) and A2P compliance status.
   */
  async getPhoneNumbers(workspaceId: string): Promise<{
    id: string;
    phoneNumber: string;
    friendlyName: string | null;
    provider: string;
    capabilities: { sms: boolean; voice: boolean; mms: boolean };
    a2pCompliance?: {
      isRegistered: boolean;
      campaignStatus?: string;
      messagingServiceSid?: string;
    };
  }[]> {
    const results: {
      id: string;
      phoneNumber: string;
      friendlyName: string | null;
      provider: string;
      capabilities: { sms: boolean; voice: boolean; mms: boolean };
      a2pCompliance?: {
        isRegistered: boolean;
        campaignStatus?: string;
        messagingServiceSid?: string;
      };
    }[] = [];

    // Try to get OpenPhone phone numbers
    try {
      const openPhoneIntegration = await this.integrationRepo.findOne({
        where: { workspaceId, provider: ProviderType.OPENPHONE },
      });

      if (openPhoneIntegration) {
        const credentials = this.encryptionService.decrypt(openPhoneIntegration.credentialsEncrypted);
        const phoneNumberMap = await this.openPhoneProvider.getPhoneNumbersFromCredentials(credentials);

        for (const pn of phoneNumberMap.values()) {
          results.push({
            id: pn.id,
            phoneNumber: pn.number,
            friendlyName: pn.name || null,
            provider: 'openphone',
            // OpenPhone numbers support SMS and voice by default
            capabilities: { sms: true, voice: true, mms: false },
            // OpenPhone handles A2P compliance internally
            a2pCompliance: { isRegistered: true, campaignStatus: 'VERIFIED' },
          });
        }
      }
    } catch (error) {
      this.logger.warn('Failed to fetch OpenPhone phone numbers', error);
    }

    // Try to get Twilio phone numbers
    try {
      const twilioIntegration = await this.integrationRepo.findOne({
        where: { workspaceId, provider: ProviderType.TWILIO },
      });

      if (twilioIntegration) {
        const credentials = this.encryptionService.decrypt(twilioIntegration.credentialsEncrypted);
        const phoneNumberMap = await this.twilioProvider.getPhoneNumbersFromCredentials(credentials);

        for (const pn of phoneNumberMap.values()) {
          results.push({
            id: pn.sid,
            phoneNumber: pn.phoneNumber,
            friendlyName: pn.friendlyName || null,
            provider: 'twilio',
            // Use actual capabilities from Twilio API
            capabilities: {
              sms: pn.capabilities?.sms ?? false,
              voice: pn.capabilities?.voice ?? false,
              mms: pn.capabilities?.mms ?? false,
            },
            // Include A2P 10DLC compliance status
            a2pCompliance: pn.a2pCompliance ? {
              isRegistered: pn.a2pCompliance.isRegistered,
              campaignStatus: pn.a2pCompliance.campaignStatus,
              messagingServiceSid: pn.a2pCompliance.messagingServiceSid,
            } : undefined,
          });
        }
      }
    } catch (error) {
      this.logger.warn('Failed to fetch Twilio phone numbers', error);
    }

    return results;
  }

  async deleteAllData(workspaceId: string, provider?: ProviderType): Promise<{ contactsDeleted: number; conversationsDeleted: number; messagesDeleted: number; callsDeleted: number }> {
    this.logger.log(`Deleting ${provider ? provider : 'all'} data for workspace ${workspaceId}`);

    // Cancel any running sync first to prevent race conditions
    const progress = this.syncProgress.get(workspaceId);
    if (progress && progress.status === 'running') {
      this.logger.log(`Cancelling running sync before deleting data for workspace ${workspaceId}`);
      this.cancelSync(workspaceId);

      // Wait for sync to stop (check every 100ms, max 5 seconds)
      const maxWait = 5000;
      const checkInterval = 100;
      let waited = 0;

      while (waited < maxWait) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        waited += checkInterval;

        const currentProgress = this.syncProgress.get(workspaceId);
        if (!currentProgress || currentProgress.status !== 'running') {
          this.logger.log(`Sync stopped after ${waited}ms, proceeding with deletion`);
          break;
        }
      }

      if (waited >= maxWait) {
        this.logger.warn(`Sync did not stop after ${maxWait}ms, proceeding with deletion anyway`);
      }
    }

    // Delete in order: messages -> calls -> conversations -> contacts (due to foreign keys)
    // If provider is specified, only delete data from that provider
    const messagesResult = await this.messageRepo
      .createQueryBuilder()
      .delete()
      .where(
        provider
          ? 'conversationId IN (SELECT id FROM communication_conversations WHERE workspace_id = :workspaceId AND provider = :provider)'
          : 'conversationId IN (SELECT id FROM communication_conversations WHERE workspace_id = :workspaceId)',
        provider ? { workspaceId, provider } : { workspaceId }
      )
      .execute();

    const callsResult = await this.callRepo
      .createQueryBuilder()
      .delete()
      .where(
        provider
          ? 'conversationId IN (SELECT id FROM communication_conversations WHERE workspace_id = :workspaceId AND provider = :provider)'
          : 'conversationId IN (SELECT id FROM communication_conversations WHERE workspace_id = :workspaceId)',
        provider ? { workspaceId, provider } : { workspaceId }
      )
      .execute();

    const conversationsResult = await this.conversationRepo
      .createQueryBuilder()
      .delete()
      .where(
        provider
          ? 'workspaceId = :workspaceId AND provider = :provider'
          : 'workspaceId = :workspaceId',
        provider ? { workspaceId, provider } : { workspaceId }
      )
      .execute();

    // Contact data now lives in Callio service - skip contact deletion

    const result = {
      contactsDeleted: 0,
      conversationsDeleted: conversationsResult.affected || 0,
      messagesDeleted: messagesResult.affected || 0,
      callsDeleted: callsResult.affected || 0,
    };

    this.logger.log(`Deleted data for workspace ${workspaceId}: ${JSON.stringify(result)}`);
    return result;
  }

  /**
   * Get transcript for a specific call.
   * Fetches from OpenPhone if not already cached.
   */
  async getCallTranscript(
    workspaceId: string,
    callId: string,
  ): Promise<{ transcript: string; status: string }> {
    const call = await this.callRepo.findOne({
      where: { id: callId },
      relations: ['conversation'],
    });

    if (!call) {
      throw new NotFoundException('Call not found');
    }

    // Verify workspace access
    if (call.conversation.workspaceId !== workspaceId) {
      throw new NotFoundException('Call not found');
    }

    // Return cached transcript if available
    if (call.transcript && call.transcriptStatus === 'completed') {
      return { transcript: call.transcript, status: 'completed' };
    }

    if (!call.providerCallId) {
      return { transcript: '', status: 'absent' };
    }

    // Fetch from OpenPhone
    const integration = await this.getIntegration(workspaceId);
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    const result = await this.openPhoneProvider.getCallTranscript(credentials, call.providerCallId);

    if (result) {
      // Cache the transcript
      call.transcript = result.transcript;
      call.transcriptStatus = result.status;
      await this.callRepo.save(call);

      return result;
    }

    return { transcript: '', status: 'error' };
  }

  /**
   * Download and cache a recording or voicemail locally.
   * Returns the local path for serving the file.
   */
  async downloadCallRecording(
    workspaceId: string,
    callId: string,
    type: 'recording' | 'voicemail',
  ): Promise<{ localPath: string; url: string }> {
    const call = await this.callRepo.findOne({
      where: { id: callId },
      relations: ['conversation'],
    });

    if (!call) {
      throw new NotFoundException('Call not found');
    }

    // Verify workspace access
    if (call.conversation.workspaceId !== workspaceId) {
      throw new NotFoundException('Call not found');
    }

    // Check if already downloaded
    const localPathField = type === 'recording' ? 'localRecordingPath' : 'localVoicemailPath';
    if (call[localPathField]) {
      return {
        localPath: call[localPathField],
        url: `/api/calls/${callId}/${type}/stream`,
      };
    }

    // Get the remote URL
    const remoteUrl = type === 'recording' ? call.recordingUrl : call.voicemailUrl;
    if (!remoteUrl) {
      throw new NotFoundException(`No ${type} URL available for this call`);
    }

    // Download from OpenPhone
    const integration = await this.getIntegration(workspaceId);
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    const audioData = await this.openPhoneProvider.downloadRecording(credentials, remoteUrl);

    if (!audioData) {
      throw new BadRequestException(`Failed to download ${type}`);
    }

    // Save to local storage
    const fs = await import('fs/promises');
    const path = await import('path');

    const uploadsDir = path.join(process.cwd(), 'uploads', 'recordings', workspaceId);
    await fs.mkdir(uploadsDir, { recursive: true });

    // Extract extension from URL or default to mp3
    const urlPath = new URL(remoteUrl).pathname;
    const ext = path.extname(urlPath) || '.mp3';
    const filename = `${callId}_${type}${ext}`;
    const localPath = path.join(uploadsDir, filename);

    await fs.writeFile(localPath, audioData);
    this.logger.log(`Saved ${audioData.length} bytes to ${localPath}`);

    // Update database
    call[localPathField] = localPath;
    await this.callRepo.save(call);

    this.logger.log(`Downloaded ${type} for call ${callId} to ${localPath}`);

    return {
      localPath,
      url: `/api/calls/${callId}/${type}/stream`,
    };
  }

  /**
   * Get a call by ID with workspace verification.
   */
  async getCall(workspaceId: string, callId: string): Promise<CommunicationCall> {
    const call = await this.callRepo.findOne({
      where: { id: callId },
      relations: ['conversation'],
    });

    if (!call || call.conversation.workspaceId !== workspaceId) {
      throw new NotFoundException('Call not found');
    }

    return call;
  }

  /**
   * Fetch and cache recording URLs for a call from OpenPhone.
   * This fetches from the dedicated /call-recordings endpoint.
   */
  async fetchCallRecordings(
    workspaceId: string,
    callId: string,
  ): Promise<{ recordingUrl: string | null; voicemailUrl: string | null }> {
    const call = await this.callRepo.findOne({
      where: { id: callId },
      relations: ['conversation'],
    });

    if (!call) {
      throw new NotFoundException('Call not found');
    }

    if (call.conversation.workspaceId !== workspaceId) {
      throw new NotFoundException('Call not found');
    }

    // Return cached URLs if available
    if (call.recordingUrl || call.voicemailUrl) {
      return { recordingUrl: call.recordingUrl, voicemailUrl: call.voicemailUrl };
    }

    if (!call.providerCallId) {
      return { recordingUrl: null, voicemailUrl: null };
    }

    // Fetch from OpenPhone
    const integration = await this.getIntegration(workspaceId);
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    const result = await this.openPhoneProvider.getCallRecordings(credentials, call.providerCallId);

    // Cache the URLs
    if (result.recordingUrl || result.voicemailUrl) {
      call.recordingUrl = result.recordingUrl || call.recordingUrl;
      call.voicemailUrl = result.voicemailUrl || call.voicemailUrl;
      await this.callRepo.save(call);
    }

    return result;
  }

  /**
   * Get recording/voicemail buffer directly from OpenPhone.
   * Downloads the file and returns the buffer (doesn't cache locally).
   */
  async getRecordingBuffer(
    workspaceId: string,
    callId: string,
    type: 'recording' | 'voicemail',
  ): Promise<Buffer> {
    // Get the call to determine provider
    const call = await this.callRepo.findOne({
      where: { id: callId },
      relations: ['conversation'],
    });

    if (!call) {
      throw new NotFoundException('Call not found');
    }

    if (call.conversation.workspaceId !== workspaceId) {
      throw new NotFoundException('Call not found');
    }

    // First get/fetch the recording URLs
    const { recordingUrl, voicemailUrl } = await this.fetchCallRecordings(workspaceId, callId);

    const remoteUrl = type === 'recording' ? recordingUrl : voicemailUrl;
    if (!remoteUrl) {
      throw new NotFoundException(`No ${type} URL available for this call`);
    }

    const provider = call.conversation.provider;
    this.logger.log(`Downloading ${type} from provider: ${provider}, URL: ${remoteUrl}`);

    // Get integration for the correct provider
    const integration = await this.integrationRepo.findOne({
      where: {
        workspaceId,
        provider,
        status: IntegrationStatus.ACTIVE,
      },
    });

    if (!integration) {
      throw new NotFoundException(`${provider} integration not found`);
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    // Use the correct provider to download the recording
    let audioData: Buffer | null = null;

    if (provider === ProviderType.TWILIO) {
      audioData = await this.twilioProvider.downloadRecording(credentials, remoteUrl);
    } else if (provider === ProviderType.OPENPHONE) {
      audioData = await this.openPhoneProvider.downloadRecording(credentials, remoteUrl);
    } else {
      throw new BadRequestException(`Unsupported provider: ${provider}`);
    }

    if (!audioData) {
      throw new BadRequestException(`Failed to download ${type}`);
    }

    this.logger.log(`Downloaded ${type} for call ${callId}: ${audioData.length} bytes`);

    return audioData;
  }

  /**
   * Get analytics data for the workspace.
   * Returns counts for contacts, conversations, messages, and calls with direction breakdowns.
   * Supports filtering by time period and phone number.
   */
  async getAnalytics(
    workspaceId: string,
    options?: {
      period?: 'week' | 'month' | 'year' | 'custom';
      startDate?: Date;
      endDate?: Date;
      phoneNumber?: string;
    },
  ): Promise<{
    contacts: number;
    conversations: number;
    messages: {
      total: number;
      incoming: number;
      outgoing: number;
    };
    calls: {
      total: number;
      incoming: number;
      outgoing: number;
      missed: number;
      completed: number;
      voicemail: number;
    };
  }> {
    this.logger.log(`Fetching analytics for workspace ${workspaceId} with options: ${JSON.stringify(options)}`);

    // Calculate date range based on period
    let startDate: Date | undefined;
    let endDate: Date | undefined = options?.endDate;

    if (options?.period) {
      const now = new Date();
      endDate = endDate || now;

      switch (options.period) {
        case 'week':
          startDate = new Date(now);
          startDate.setDate(now.getDate() - 7);
          break;
        case 'month':
          startDate = new Date(now);
          startDate.setMonth(now.getMonth() - 1);
          break;
        case 'year':
          startDate = new Date(now);
          startDate.setFullYear(now.getFullYear() - 1);
          break;
        case 'custom':
          startDate = options.startDate;
          break;
      }
    } else if (options?.startDate) {
      startDate = options.startDate;
    }

    const phoneNumber = options?.phoneNumber;

    // Contact data now lives in Callio service
    const contactsCount = 0;

    // Get conversation count with optional phone number filter
    let conversationQuery = this.conversationRepo
      .createQueryBuilder('conv')
      .where('conv.workspaceId = :workspaceId', { workspaceId });

    if (phoneNumber) {
      conversationQuery = conversationQuery.andWhere('conv.phoneNumber = :phoneNumber', { phoneNumber });
    }

    const conversationsCount = await conversationQuery.getCount();

    // Get message counts by direction with time and phone number filters
    let messageQuery = this.messageRepo
      .createQueryBuilder('msg')
      .innerJoin('msg.conversation', 'conv')
      .where('conv.workspaceId = :workspaceId', { workspaceId });

    if (startDate) {
      messageQuery = messageQuery.andWhere('msg.createdAt >= :startDate', { startDate });
    }
    if (endDate) {
      messageQuery = messageQuery.andWhere('msg.createdAt <= :endDate', { endDate });
    }
    if (phoneNumber) {
      messageQuery = messageQuery.andWhere('conv.phoneNumber = :phoneNumber', { phoneNumber });
    }

    const messageStats = await messageQuery
      .select('msg.direction', 'direction')
      .addSelect('COUNT(*)', 'count')
      .groupBy('msg.direction')
      .getRawMany();

    const messagesTotal = messageStats.reduce((sum, stat) => sum + parseInt(stat.count, 10), 0);
    const messagesIncoming = parseInt(messageStats.find(s => s.direction === 'in')?.count || '0', 10);
    const messagesOutgoing = parseInt(messageStats.find(s => s.direction === 'out')?.count || '0', 10);

    // Get call counts by direction and status with time and phone number filters
    let callDirectionQuery = this.callRepo
      .createQueryBuilder('call')
      .innerJoin('call.conversation', 'conv')
      .where('conv.workspaceId = :workspaceId', { workspaceId });

    if (startDate) {
      callDirectionQuery = callDirectionQuery.andWhere('call.createdAt >= :startDate', { startDate });
    }
    if (endDate) {
      callDirectionQuery = callDirectionQuery.andWhere('call.createdAt <= :endDate', { endDate });
    }
    if (phoneNumber) {
      callDirectionQuery = callDirectionQuery.andWhere('conv.phoneNumber = :phoneNumber', { phoneNumber });
    }

    const callDirectionStats = await callDirectionQuery
      .select('call.direction', 'direction')
      .addSelect('COUNT(*)', 'count')
      .groupBy('call.direction')
      .getRawMany();

    let callStatusQuery = this.callRepo
      .createQueryBuilder('call')
      .innerJoin('call.conversation', 'conv')
      .where('conv.workspaceId = :workspaceId', { workspaceId });

    if (startDate) {
      callStatusQuery = callStatusQuery.andWhere('call.createdAt >= :startDate', { startDate });
    }
    if (endDate) {
      callStatusQuery = callStatusQuery.andWhere('call.createdAt <= :endDate', { endDate });
    }
    if (phoneNumber) {
      callStatusQuery = callStatusQuery.andWhere('conv.phoneNumber = :phoneNumber', { phoneNumber });
    }

    const callStatusStats = await callStatusQuery
      .select('call.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('call.status')
      .getRawMany();

    const callsTotal = callDirectionStats.reduce((sum, stat) => sum + parseInt(stat.count, 10), 0);
    const callsIncoming = parseInt(callDirectionStats.find(s => s.direction === 'in')?.count || '0', 10);
    const callsOutgoing = parseInt(callDirectionStats.find(s => s.direction === 'out')?.count || '0', 10);
    const callsMissed = parseInt(callStatusStats.find(s => s.status === 'missed')?.count || '0', 10);
    const callsCompleted = parseInt(callStatusStats.find(s => s.status === 'completed')?.count || '0', 10);
    const callsVoicemail = parseInt(callStatusStats.find(s => s.status === 'voicemail')?.count || '0', 10);

    return {
      contacts: contactsCount,
      conversations: conversationsCount,
      messages: {
        total: messagesTotal,
        incoming: messagesIncoming,
        outgoing: messagesOutgoing,
      },
      calls: {
        total: callsTotal,
        incoming: callsIncoming,
        outgoing: callsOutgoing,
        missed: callsMissed,
        completed: callsCompleted,
        voicemail: callsVoicemail,
      },
    };
  }
}
