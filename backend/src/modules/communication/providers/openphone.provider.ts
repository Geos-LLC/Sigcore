import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  CommunicationProvider,
  SendMessageInput,
  SendMessageResult,
  ConversationData,
  MessageData,
  CallData,
  InitiateCallInput,
  InitiateCallResult,
} from '../interfaces/communication-provider.interface';
import { MessageDirection, MessageStatus } from '../../../database/entities/communication-message.entity';
import { CallDirection, CallStatus } from '../../../database/entities/communication-call.entity';
import { ChannelType } from '../../../database/entities/sender.entity';

interface OpenPhoneCredentials {
  apiKey: string;
}

export interface WebhookRegistrationResult {
  messageWebhookId?: string;
  callWebhookId?: string;
  webhookKey?: string;
  success: boolean;
  error?: string;
}

interface PhoneNumberInfo {
  id: string;
  number: string;
  name?: string;
  capabilities?: { sms: boolean; voice: boolean; mms: boolean };
}

export interface OpenPhoneContact {
  id: string;
  externalId?: string;
  source?: string;
  sourceUrl?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  role?: string;
  emails?: Array<{ name?: string; value: string; id?: string }>;
  phoneNumbers?: Array<{ name?: string; value: string; id?: string }>;
  customFields?: Array<{ id: string; name: string; value: unknown }>;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  createdByUserId?: string;
}

@Injectable()
export class OpenPhoneProvider implements CommunicationProvider {
  readonly providerName = 'openphone';
  readonly supportedChannels = [ChannelType.SMS, ChannelType.VOICE];
  private readonly logger = new Logger(OpenPhoneProvider.name);
  private readonly baseUrl: string;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get('OPENPHONE_API_BASE_URL') || 'https://api.openphone.com/v1';
  }

  supportsChannel(channel: ChannelType): boolean {
    return this.supportedChannels.includes(channel);
  }

  private createClient(apiKey: string): AxiosInstance {
    return axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    try {
      const credentials = JSON.parse(input.workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      // OpenPhone API requires phone number ID, not the number string
      // If fromId is provided, use it; otherwise fetch the ID from the phone number
      let fromId = input.fromId;
      if (!fromId) {
        // Fetch phone numbers and find the matching one
        const phoneNumberMap = await this.getPhoneNumbers(client);
        for (const [id, info] of phoneNumberMap) {
          if (info.number === input.from) {
            fromId = id;
            break;
          }
        }
        // If still no match, use the first available phone number
        if (!fromId) {
          const firstPhone = phoneNumberMap.values().next().value;
          if (firstPhone) {
            fromId = firstPhone.id;
            this.logger.log(`Using first available phone number ID: ${fromId}`);
          }
        }
      }

      if (!fromId) {
        throw new Error('No valid OpenPhone phone number ID available');
      }

      // Ensure phone number is in E.164 format (with + prefix)
      let toNumber = input.to;
      if (!toNumber.startsWith('+')) {
        toNumber = '+' + toNumber;
      }

      this.logger.log(`Sending message via OpenPhone: from=${fromId}, to=${toNumber}`);

      const response = await client.post('/messages', {
        from: fromId,
        to: [toNumber],
        content: input.body,
      });

      return {
        providerMessageId: response.data.data.id,
        status: MessageStatus.SENT,
        sentAt: new Date(),
      };
    } catch (error) {
      this.logger.error('Failed to send message via OpenPhone', error);
      throw error;
    }
  }

  async getPhoneNumbers(client: AxiosInstance): Promise<Map<string, PhoneNumberInfo>> {
    const phoneNumberMap = new Map<string, PhoneNumberInfo>();
    try {
      const response = await client.get('/phone-numbers');
      const phoneNumbers = response.data.data || [];
      this.logger.log(`Phone numbers API response sample: ${JSON.stringify(phoneNumbers[0] || {})}`);
      for (const pn of phoneNumbers) {
        // OpenPhone API returns: id, object, name, number, formattedNumber, users, restrictions, etc.
        const name = pn.name || pn.formattedNumber || pn.number;
        // Derive SMS/voice capability from the restrictions object returned by OpenPhone.
        // restrictions.messaging.US / .CA / .Intl = "unrestricted" | "restricted"
        const messaging = pn.restrictions?.messaging || {};
        const calling = pn.restrictions?.calling || {};
        const smsEnabled = messaging.US === 'unrestricted';
        const voiceEnabled = calling.US !== 'restricted'; // default true if absent
        phoneNumberMap.set(pn.id, {
          id: pn.id,
          number: pn.number || pn.phoneNumber,
          name: name,
          capabilities: { sms: smsEnabled, voice: voiceEnabled, mms: false },
        });
        this.logger.log(`Phone number: ${pn.id} -> ${name} (${pn.number}) sms=${smsEnabled} voice=${voiceEnabled}`);
      }
      this.logger.log(`Fetched ${phoneNumberMap.size} phone numbers with names`);
    } catch (error) {
      this.logger.warn('Failed to fetch phone numbers, continuing without names', error);
    }
    return phoneNumberMap;
  }

  /**
   * Get phone numbers using credentials string (for external use).
   */
  async getPhoneNumbersFromCredentials(credentialsString: string): Promise<Map<string, PhoneNumberInfo>> {
    const credentials = JSON.parse(credentialsString) as OpenPhoneCredentials;
    const client = this.createClient(credentials.apiKey);
    return this.getPhoneNumbers(client);
  }

  /**
   * Get the first available phone number ID from OpenPhone.
   * Used when sending messages without a specific from number.
   * Returns the phone number ID (e.g., "PNm5YIDoXV") which is required by OpenPhone API.
   */
  async getDefaultPhoneNumberId(workspaceId: string): Promise<{ id: string; number: string } | null> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);
      const phoneNumberMap = await this.getPhoneNumbers(client);
      const firstPhone = phoneNumberMap.values().next().value;
      if (firstPhone) {
        return { id: firstPhone.id, number: firstPhone.number };
      }
      return null;
    } catch (error) {
      this.logger.error('Failed to get default phone number', error);
      return null;
    }
  }

  async getConversations(workspaceId: string, limit?: number, phoneNumberId?: string, since?: Date): Promise<ConversationData[]> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      this.logger.log(`Fetching conversations from OpenPhone with pagination... (limit: ${limit || 'none'}, phoneNumberId: ${phoneNumberId || 'all'}, since: ${since?.toISOString() || 'none'})`);

      // First, fetch phone numbers to get their display names
      const phoneNumberMap = await this.getPhoneNumbers(client);

      // WORKAROUND: OpenPhone's /conversations endpoint has stale lastActivityAt values
      // If a date filter is provided, use the /messages endpoint instead to find active conversations
      if (since && phoneNumberId) {
        this.logger.log(`Using message-based approach to find conversations with activity since ${since.toISOString()}`);
        return this.getConversationsFromMessages(client, phoneNumberMap, phoneNumberId, since, limit);
      }

      // Fetch conversations with pagination
      const allConversations: Record<string, unknown>[] = [];
      let pageToken: string | null = null;
      let pageCount = 0;
      const maxPages = 200; // Increased limit: 200 pages × 100 = 20,000 conversations max

      // Always fetch full pages (100) since the API does not sort by lastActivityAt.
      // We need a full page to sort and find the truly most recent conversations.
      // When a limit is set, stop pagination after the first page (100 is enough to find recent ones).
      do {
        const params: Record<string, unknown> = { maxResults: 100 };
        if (pageToken) {
          params.pageToken = pageToken;
        }
        // Filter by phone number ID at API level if specified
        // OpenPhone API uses 'phoneNumbers' (plural, array) parameter
        if (phoneNumberId) {
          params.phoneNumbers = [phoneNumberId];
        }

        const response = await client.get('/conversations', { params });
        const conversations = response.data.data || [];
        allConversations.push(...conversations);

        pageToken = response.data.nextPageToken || null;
        pageCount++;

        // Log every 10 pages to reduce noise
        if (pageCount % 10 === 0 || !pageToken) {
          this.logger.log(`Page ${pageCount}: fetched ${conversations.length} conversations (total: ${allConversations.length})`);
        }

        // When a small limit is set (e.g. 3 for testing), stop after first page
        // since 100 conversations is enough to sort and find the most recent ones.
        if (limit && limit <= 100 && allConversations.length >= 100) {
          this.logger.log(`Small limit (${limit}) requested, stopping after first page of ${allConversations.length} conversations`);
          break;
        }
      } while (pageToken && pageCount < maxPages);

      if (pageCount >= maxPages && pageToken) {
        this.logger.warn(`Reached max pages limit (${maxPages}). Some conversations may not be synced. Total fetched: ${allConversations.length}`);
      }

      this.logger.log(`Fetched total of ${allConversations.length} conversations from OpenPhone`);

      // Sort conversations by lastActivityAt descending to ensure most recent are first
      allConversations.sort((a, b) => {
        const aTime = a.lastActivityAt ? new Date(a.lastActivityAt as string).getTime() : 0;
        const bTime = b.lastActivityAt ? new Date(b.lastActivityAt as string).getTime() : 0;
        return bTime - aTime; // Descending order (most recent first)
      });

      // Log sample of recent conversations for debugging
      const recentConvs = allConversations.slice(0, 5);
      for (const conv of recentConvs) {
        const participants = (conv.participants as string[]) || [];
        this.logger.log(`  Conversation: id=${conv.id} | lastActivity=${conv.lastActivityAt} | participants=${JSON.stringify(participants)} | name=${conv.name || '(none)'}`);
      }

      // Apply limit after sorting to return only the requested number
      const limitedConversations = limit ? allConversations.slice(0, limit) : allConversations;

      return limitedConversations.map((conv: Record<string, unknown>) => {
        const phoneNumberId = conv.phoneNumberId as string;
        const phoneInfo = phoneNumberMap.get(phoneNumberId);
        const participants = (conv.participants as string[]) || [];

        // Only use actual phone number, never fall back to phoneNumberId
        // If phone info is missing, the phone may have been deleted from OpenPhone
        if (!phoneInfo) {
          this.logger.warn(`Phone number ID ${phoneNumberId} not found in OpenPhone - may have been deleted`);
        }

        return {
          externalId: conv.id as string,
          phoneNumber: phoneInfo?.number || '',  // Empty string if phone not found, not the ID
          participantPhoneNumber: participants[0] || '',
          participantPhoneNumbers: participants,
          createdAt: new Date(conv.createdAt as string),
          lastMessageAt: conv.lastActivityAt ? new Date(conv.lastActivityAt as string) : undefined,
          metadata: {
            unreadCount: conv.unreadCount,
            isArchived: conv.isArchived,
            phoneNumberId: phoneNumberId,
            phoneNumberName: phoneInfo?.name,
            // Capture conversation name - this might be the contact name from OpenPhone
            conversationName: conv.name as string | undefined,
            // Store the last activity time from OpenPhone directly
            lastActivityAt: conv.lastActivityAt as string | undefined,
            // Store participant count for group conversation detection
            participantCount: participants.length,
          },
        };
      });
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
      this.logger.error(`Failed to fetch conversations from OpenPhone: ${axiosError.message}`);
      if (axiosError.response) {
        this.logger.error(`OpenPhone API error: ${axiosError.response.status} - ${JSON.stringify(axiosError.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Fetch conversations with recent activity by combining /conversations and /messages endpoints.
   * Uses /conversations to discover participants, then /messages to verify actual activity since the date.
   * This works around OpenPhone's stale lastActivityAt and the /messages requirement for participants.
   */
  private async getConversationsFromMessages(
    client: AxiosInstance,
    phoneNumberMap: Map<string, PhoneNumberInfo>,
    phoneNumberId: string,
    since: Date,
    limit?: number,
  ): Promise<ConversationData[]> {
    this.logger.log(`Finding conversations with activity since ${since.toISOString()} for phone ${phoneNumberId}`);

    // Step 1: Fetch conversations to get participant lists
    const response = await client.get('/conversations', {
      params: { phoneNumbers: [phoneNumberId], maxResults: 100 },
    });
    const rawConversations = response.data.data || [];
    this.logger.log(`Fetched ${rawConversations.length} conversations to check for recent activity`);

    const phoneInfo = phoneNumberMap.get(phoneNumberId);
    const conversations: ConversationData[] = [];

    // Step 2: For each conversation, check if it has messages since the date
    for (const conv of rawConversations) {
      const participants = (conv.participants as string[]) || [];
      if (!participants.length) continue;

      try {
        const msgResponse = await client.get('/messages', {
          params: {
            phoneNumberId,
            participants,
            createdAfter: since.toISOString(),
            limit: 1,
          },
        });
        const messages = msgResponse.data.data || [];

        if (messages.length > 0) {
          const latestMsg = messages[0];
          conversations.push({
            externalId: conv.id as string,
            phoneNumber: phoneInfo?.number || '',
            participantPhoneNumber: participants[0],
            participantPhoneNumbers: participants,
            createdAt: new Date(conv.createdAt as string),
            lastMessageAt: new Date(latestMsg.createdAt as string),
            metadata: {
              phoneNumberId,
              phoneNumberName: phoneInfo?.name,
              participantCount: participants.length,
              derivedFromMessages: true,
            },
          });
        }
      } catch (error: any) {
        this.logger.warn(`Failed to check messages for conversation ${conv.id}: ${error.message}`);
      }
    }

    // Sort by actual last message time
    conversations.sort((a, b) => {
      const aTime = a.lastMessageAt?.getTime() || 0;
      const bTime = b.lastMessageAt?.getTime() || 0;
      return bTime - aTime;
    });

    const limited = limit ? conversations.slice(0, limit) : conversations;
    this.logger.log(`Found ${conversations.length} conversations with activity since ${since.toISOString()}, returning ${limited.length}`);
    return limited;
  }

  async getMessages(workspaceId: string, conversationId: string, phoneNumberId?: string, participantPhoneNumber?: string): Promise<MessageData[]> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      this.logger.log(`Fetching messages for conversation: ${conversationId}, phoneNumberId: ${phoneNumberId}, participant: ${participantPhoneNumber}`);

      // OpenPhone API uses /messages endpoint with phoneNumberId and participants parameters
      // Not /conversations/{id}/messages
      if (!phoneNumberId || !participantPhoneNumber) {
        this.logger.warn(`Missing phoneNumberId or participantPhoneNumber for conversation ${conversationId}, skipping message fetch`);
        return [];
      }

      const params: Record<string, unknown> = {
        phoneNumberId: phoneNumberId,
        participants: [participantPhoneNumber],
        maxResults: 100,
      };

      const response = await client.get('/messages', { params });
      const messages = response.data.data || [];

      this.logger.log(`Fetched ${messages.length} messages for conversation ${conversationId}`);

      return messages.map((msg: Record<string, unknown>) => {
        // Extract media URLs if present (MMS messages)
        const media = msg.media as Array<{ url: string; type?: string }> | undefined;
        const mediaUrls = media?.map(m => m.url).filter(Boolean) || [];

        return {
          providerMessageId: msg.id as string,
          direction: msg.direction === 'incoming' ? MessageDirection.IN : MessageDirection.OUT,
          body: msg.content as string || msg.text as string || '',
          fromNumber: msg.from as string,
          toNumber: (msg.to as string[])?.[0] || msg.to as string || '',
          status: this.mapMessageStatus(msg.status as string),
          createdAt: new Date(msg.createdAt as string),
          metadata: {
            type: msg.type,
            object: msg.object,
            media: media, // Store full media array for type info
            mediaUrls: mediaUrls, // Store just URLs for easy access
          },
        };
      });
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
      this.logger.error(`Failed to fetch messages for conversation ${conversationId}: ${axiosError.message}`);
      if (axiosError.response) {
        this.logger.error(`OpenPhone API error: ${axiosError.response.status} - ${JSON.stringify(axiosError.response.data)}`);
      }
      throw error;
    }
  }

  async getCalls(workspaceId: string): Promise<CallData[]> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      const response = await client.get('/calls');
      const calls = response.data.data || [];

      return calls.map((call: Record<string, unknown>) => this.mapCallData(call));
    } catch (error) {
      this.logger.error('Failed to fetch calls from OpenPhone', error);
      throw error;
    }
  }

  async getCallsForConversation(workspaceId: string, conversationId: string): Promise<CallData[]> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      const response = await client.get('/calls', {
        params: { conversationId },
      });
      const calls = response.data.data || [];

      return calls.map((call: Record<string, unknown>) => this.mapCallData(call));
    } catch (error) {
      this.logger.error('Failed to fetch calls for conversation from OpenPhone', error);
      throw error;
    }
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const phoneNumber = input.to.replace(/[^0-9+]/g, '');

    // Deep link with action=call auto-initiates the call (works with desktop/mobile app)
    const deepLink = `openphone://dial?number=${encodeURIComponent(phoneNumber)}&action=call`;
    // Web fallback URL for users without the app
    const webFallback = `https://my.openphone.com/dialer?phoneNumber=${encodeURIComponent(phoneNumber)}`;

    return {
      success: true,
      deepLink,
      webFallback,
      message: 'Opening OpenPhone dialer',
    };
  }

  async validateCredentials(credentials: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(credentials) as OpenPhoneCredentials;
      const client = this.createClient(parsed.apiKey);

      await client.get('/phone-numbers');
      return true;
    } catch (error) {
      this.logger.error('Failed to validate OpenPhone credentials', error);
      return false;
    }
  }

  /**
   * Get a single contact from OpenPhone by its ID.
   */
  async getOpenPhoneContact(workspaceId: string, contactId: string): Promise<OpenPhoneContact | null> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      this.logger.log(`Fetching single contact from OpenPhone: ${contactId}`);

      const response = await client.get(`/contacts/${contactId}`);
      const raw = response.data.data;

      if (!raw) {
        this.logger.warn(`Contact ${contactId} not found in OpenPhone`);
        return null;
      }

      // Log raw response for debugging
      this.logger.log(`Raw contact data from OpenPhone: ${JSON.stringify(raw)}`);

      const defaultFields = raw.defaultFields as Record<string, unknown> || {};
      const customFields = raw.customFields as Array<{ id: string; name: string; value: unknown }> | undefined;

      // Log extracted fields
      this.logger.log(`defaultFields: ${JSON.stringify(defaultFields)}`);
      this.logger.log(`customFields: ${JSON.stringify(customFields)}`);

      // Look for notes in custom fields
      let notes: string | undefined;
      if (customFields) {
        const notesField = customFields.find(cf =>
          cf.name.toLowerCase() === 'notes' ||
          cf.name.toLowerCase() === 'note' ||
          cf.name.toLowerCase() === 'comments'
        );
        if (notesField && typeof notesField.value === 'string') {
          notes = notesField.value;
        }
      }

      const contact: OpenPhoneContact = {
        id: raw.id as string,
        externalId: raw.externalId as string | undefined,
        source: raw.source as string | undefined,
        sourceUrl: raw.sourceUrl as string | undefined,
        firstName: defaultFields.firstName as string | undefined,
        lastName: defaultFields.lastName as string | undefined,
        company: defaultFields.company as string | undefined,
        role: defaultFields.role as string | undefined,
        emails: defaultFields.emails as Array<{ name?: string; value: string; id?: string }> | undefined,
        phoneNumbers: defaultFields.phoneNumbers as Array<{ name?: string; value: string; id?: string }> | undefined,
        customFields: customFields,
        notes: notes,
        createdAt: raw.createdAt as string,
        updatedAt: raw.updatedAt as string,
        createdByUserId: raw.createdByUserId as string | undefined,
      };

      // Log what we extracted
      this.logger.log(`Extracted emails: ${JSON.stringify(contact.emails)}`);
      this.logger.log(`Extracted notes: ${contact.notes}`);

      return contact;
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
      if (axiosError.response?.status === 404) {
        this.logger.warn(`Contact ${contactId} not found in OpenPhone`);
        return null;
      }
      this.logger.error(`Failed to fetch contact ${contactId} from OpenPhone: ${axiosError.message}`);
      throw error;
    }
  }

  /**
   * Get the most recent conversations from OpenPhone.
   * Single API call: GET /conversations?maxResults=50&updatedAfter=3d
   * No per-conversation message fetching — uses lastActivityAt for sorting.
   */
  async getRecentConversations(credentialsString: string, days: number = 1, filterPhoneNumberId?: string): Promise<Array<{
    participantPhone: string;
    phoneNumberId: string;
    phoneNumber: string;
    phoneNumberName: string;
    lastMessageAt: Date;
    conversationName?: string;
  }>> {
    const credentials = JSON.parse(credentialsString) as OpenPhoneCredentials;
    const client = this.createClient(credentials.apiKey);

    const phoneNumberMap = await this.getPhoneNumbers(client);

    // Fetch conversations from the past N days
    const since = new Date();
    since.setDate(since.getDate() - days);

    let conversations: Array<Record<string, unknown>> = [];
    try {
      const response = await client.get('/conversations', {
        params: {
          maxResults: 50,
          updatedAfter: since.toISOString(),
        },
      });
      conversations = response.data.data || [];
      this.logger.log(`Fetched ${conversations.length} conversations (updatedAfter=${days}d)`);
    } catch (error: any) {
      this.logger.error(`Failed to fetch conversations: ${error.message}`);
      return [];
    }

    // Filter out deleted conversations and those without participants
    const results = conversations
      .filter(conv => {
        if (conv.deletedAt) return false;
        const participants = (conv.participants as string[]) || [];
        if (participants.length === 0) return false;
        // Filter by phoneNumberId if specified
        if (filterPhoneNumberId && conv.phoneNumberId !== filterPhoneNumberId) return false;
        return true;
      })
      .map(conv => {
        const participants = (conv.participants as string[]) || [];
        const phoneNumberId = conv.phoneNumberId as string;
        const phoneInfo = phoneNumberMap.get(phoneNumberId);

        return {
          participantPhone: participants[0],
          phoneNumberId,
          phoneNumber: phoneInfo?.number || '',
          phoneNumberName: phoneInfo?.name || '',
          lastMessageAt: conv.lastActivityAt
            ? new Date(conv.lastActivityAt as string)
            : new Date(conv.updatedAt as string),
          conversationName: conv.name as string | undefined,
        };
      })
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());

    this.logger.log(`Returning ${results.length} conversations sorted by lastActivityAt`);
    return results;
  }

  /**
   * Normalize a phone number to just its last 10 digits for matching.
   * This handles all format differences: +1(865)385-9897 vs +18653859897 vs 8653859897
   */
  private normalizePhoneDigits(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    // For US numbers: take last 10 digits (strip country code)
    return digits.length > 10 ? digits.slice(-10) : digits;
  }

  /**
   * Look up contact names for a list of phone numbers.
   * Fetches ALL contacts to ensure no names are missed.
   * Returns a map of phone number -> contact name.
   */
  async lookupContactNamesByPhone(credentialsString: string, phoneNumbers: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!phoneNumbers.length) return result;

    // Build a normalized lookup set: last-10-digits -> original phone number
    const normalizedLookup = new Map<string, string>();
    for (const pn of phoneNumbers) {
      normalizedLookup.set(this.normalizePhoneDigits(pn), pn);
    }

    try {
      const credentials = JSON.parse(credentialsString) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      // Helper to extract phone numbers from a contact (handles multiple formats)
      const extractPhones = (raw: Record<string, unknown>): string[] => {
        const phones: string[] = [];
        const defaultFields = raw.defaultFields as Record<string, unknown> || {};
        const contactPhones = defaultFields.phoneNumbers;

        if (Array.isArray(contactPhones)) {
          for (const cp of contactPhones) {
            if (typeof cp === 'string') {
              phones.push(cp);
            } else if (cp && typeof cp === 'object') {
              // Could be { value: string } or { number: string } or { phoneNumber: string }
              const val = (cp as any).value || (cp as any).number || (cp as any).phoneNumber;
              if (typeof val === 'string') phones.push(val);
            }
          }
        }

        // Also check top-level phoneNumber field (some contact types)
        if (typeof raw.phoneNumber === 'string') phones.push(raw.phoneNumber);
        if (typeof (raw as any).phone === 'string') phones.push((raw as any).phone);

        return phones;
      };

      // Helper to extract name from a contact
      const extractName = (raw: Record<string, unknown>): string => {
        const defaultFields = raw.defaultFields as Record<string, unknown> || {};
        const firstName = (defaultFields.firstName as string) || '';
        const lastName = (defaultFields.lastName as string) || '';
        const company = (defaultFields.company as string) || '';
        return [firstName, lastName].filter(Boolean).join(' ') || company || '';
      };

      let pageToken: string | null = null;
      let pageCount = 0;
      let totalContacts = 0;
      const maxPages = 100;
      const pageDelayMs = 300; // 300ms delay between pages to avoid 429 rate limits
      let loggedSample = false;

      do {
        // Add delay between pages (not before the first page)
        if (pageCount > 0) {
          await new Promise(resolve => setTimeout(resolve, pageDelayMs));
        }

        const params: Record<string, unknown> = { maxResults: 50 };
        if (pageToken) params.pageToken = pageToken;

        const response = await client.get('/contacts', { params });
        const rawContacts = response.data.data || [];
        totalContacts += rawContacts.length;

        // Log the structure of the first contact for debugging
        if (!loggedSample && rawContacts.length > 0) {
          const sample = rawContacts[0];
          const sampleFields = sample.defaultFields || {};
          this.logger.log(`Contact sample - keys: ${Object.keys(sample).join(', ')}`);
          this.logger.log(`Contact sample defaultFields keys: ${Object.keys(sampleFields).join(', ')}`);
          if (sampleFields.phoneNumbers) {
            this.logger.log(`Contact sample phoneNumbers: ${JSON.stringify(sampleFields.phoneNumbers).substring(0, 200)}`);
          }
          loggedSample = true;
        }

        for (const raw of rawContacts) {
          const name = extractName(raw);
          if (!name) continue;

          const phones = extractPhones(raw);
          for (const phone of phones) {
            const normalized = this.normalizePhoneDigits(phone);

            // Store by normalized (last 10 digits) AND by original formats
            if (normalizedLookup.has(normalized)) {
              const originalKey = normalizedLookup.get(normalized)!;
              result.set(originalKey, name);
            }

            // Also store by exact formats for direct lookups
            const cleaned = phone.replace(/[^+\d]/g, '');
            const withPlus = cleaned.startsWith('+') ? cleaned : '+' + cleaned;
            const withoutPlus = withPlus.substring(1);
            result.set(withPlus, name);
            result.set(withoutPlus, name);
            result.set(phone, name);
          }
        }

        pageToken = response.data.nextPageToken || null;
        pageCount++;

        // Check if we've found all the numbers we need
        const allFound = phoneNumbers.every(pn => result.has(pn));
        if (allFound) {
          this.logger.log(`Found all ${phoneNumbers.length} contact names after ${pageCount} pages (${totalContacts} contacts)`);
          break;
        }
      } while (pageToken && pageCount < maxPages);

      const foundCount = phoneNumbers.filter(pn => result.has(pn)).length;
      this.logger.log(`Contact lookup: found ${foundCount}/${phoneNumbers.length} names after ${pageCount} pages (${totalContacts} contacts)`);

      // Log which numbers were NOT found for debugging
      const notFound = phoneNumbers.filter(pn => !result.has(pn));
      if (notFound.length > 0) {
        this.logger.warn(`Contact names NOT found for: ${notFound.join(', ')}`);
        this.logger.warn(`Normalized forms not found: ${notFound.map(pn => this.normalizePhoneDigits(pn)).join(', ')}`);
      }
    } catch (error: unknown) {
      const axiosError = error as { message?: string };
      this.logger.warn(`Failed to lookup contacts by phone: ${axiosError.message}`);
    }

    return result;
  }

  async getOpenPhoneContacts(workspaceId: string, limit?: number): Promise<OpenPhoneContact[]> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      this.logger.log(`Fetching contacts from OpenPhone with pagination... (limit: ${limit || 'none'})`);

      const allContacts: OpenPhoneContact[] = [];
      let pageToken: string | null = null;
      let pageCount = 0;
      const maxPages = 100; // Safety limit

      do {
        // OpenPhone contacts API has a max of 50 results per page
        // If we have a limit, request only what we need
        let pageSize = 50;
        if (limit && limit > 0) {
          const remaining = limit - allContacts.length;
          pageSize = Math.min(50, remaining);
        }

        const params: Record<string, unknown> = { maxResults: pageSize };
        if (pageToken) {
          params.pageToken = pageToken;
        }

        const response = await client.get('/contacts', { params });
        const rawContacts = response.data.data || [];

        // Map raw contacts to extract fields from defaultFields
        const mappedContacts = rawContacts.map((raw: Record<string, unknown>) => {
          const defaultFields = raw.defaultFields as Record<string, unknown> || {};
          const customFields = raw.customFields as Array<{ id: string; name: string; value: unknown }> | undefined;

          // Look for notes in custom fields (OpenPhone doesn't have a native notes field in defaultFields)
          // Common custom field names for notes: "notes", "Notes", "note", "Note", "Comments", "comments"
          let notes: string | undefined;
          if (customFields) {
            const notesField = customFields.find(cf =>
              cf.name.toLowerCase() === 'notes' ||
              cf.name.toLowerCase() === 'note' ||
              cf.name.toLowerCase() === 'comments'
            );
            if (notesField && typeof notesField.value === 'string') {
              notes = notesField.value;
            }
          }

          return {
            id: raw.id as string,
            externalId: raw.externalId as string | undefined,
            source: raw.source as string | undefined,
            sourceUrl: raw.sourceUrl as string | undefined,
            firstName: defaultFields.firstName as string | undefined,
            lastName: defaultFields.lastName as string | undefined,
            company: defaultFields.company as string | undefined,
            role: defaultFields.role as string | undefined,
            emails: defaultFields.emails as Array<{ name?: string; value: string; id?: string }> | undefined,
            phoneNumbers: defaultFields.phoneNumbers as Array<{ name?: string; value: string; id?: string }> | undefined,
            customFields: customFields,
            notes: notes,
            createdAt: raw.createdAt as string,
            updatedAt: raw.updatedAt as string,
            createdByUserId: raw.createdByUserId as string | undefined,
          } as OpenPhoneContact;
        });

        allContacts.push(...mappedContacts);

        pageToken = response.data.nextPageToken || null;
        pageCount++;

        this.logger.log(`Page ${pageCount}: fetched ${rawContacts.length} contacts (total: ${allContacts.length})`);

        // Stop if we've reached the limit
        if (limit && limit > 0 && allContacts.length >= limit) {
          this.logger.log(`Reached limit of ${limit} contacts, stopping pagination`);
          break;
        }
      } while (pageToken && pageCount < maxPages);

      this.logger.log(`Fetched total of ${allContacts.length} contacts from OpenPhone`);

      // Log contacts with actual email data for debugging
      const contactsWithEmails = allContacts.filter(c =>
        c.emails?.some(e => e.value && e.value.trim() !== '')
      );
      const contactsWithNotes = allContacts.filter(c => c.notes && c.notes.trim() !== '');
      const contactsWithCustomFields = allContacts.filter(c => c.customFields && c.customFields.length > 0);

      this.logger.log(`Contacts with emails: ${contactsWithEmails.length}, with notes: ${contactsWithNotes.length}, with customFields: ${contactsWithCustomFields.length}`);

      // Log a sample contact with email if found
      if (contactsWithEmails.length > 0) {
        this.logger.log(`Sample contact WITH email: ${JSON.stringify(contactsWithEmails[0])}`);
      }
      if (contactsWithCustomFields.length > 0) {
        this.logger.log(`Sample contact WITH customFields: ${JSON.stringify(contactsWithCustomFields[0])}`);
      }

      return allContacts;
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
      this.logger.error(`Failed to fetch contacts from OpenPhone: ${axiosError.message}`);
      if (axiosError.response) {
        this.logger.error(`OpenPhone API error: ${axiosError.response.status} - ${JSON.stringify(axiosError.response.data)}`);
      }
      throw error;
    }
  }

  private mapMessageStatus(status: string): MessageStatus {
    const statusMap: Record<string, MessageStatus> = {
      'delivered': MessageStatus.DELIVERED,
      'sent': MessageStatus.SENT,
      'failed': MessageStatus.FAILED,
      'pending': MessageStatus.PENDING,
    };
    return statusMap[status] || MessageStatus.PENDING;
  }

  private mapCallStatus(
    status: string,
    voicemailUrl?: string,
    duration?: number,
    answeredAt?: string,
    direction?: string,
  ): CallStatus {
    if (voicemailUrl) {
      return CallStatus.VOICEMAIL;
    }

    // OpenPhone uses various status values - normalize them
    const normalizedStatus = status?.toLowerCase() || '';

    // Check for explicit missed/cancelled status
    if (normalizedStatus === 'missed' || normalizedStatus === 'no-answer' || normalizedStatus === 'unanswered') {
      return CallStatus.MISSED;
    }
    if (normalizedStatus === 'cancelled' || normalizedStatus === 'canceled') {
      return CallStatus.CANCELLED;
    }
    if (normalizedStatus === 'voicemail') {
      return CallStatus.VOICEMAIL;
    }

    // For incoming calls: if duration is 0 and no answeredAt, it was missed
    if (direction === 'incoming' && (duration === 0 || duration === undefined) && !answeredAt) {
      return CallStatus.MISSED;
    }

    // Default to completed for answered calls
    return CallStatus.COMPLETED;
  }

  private mapCallData(call: Record<string, unknown>, phoneNumber?: string): CallData {
    // Log raw call data for debugging
    this.logger.log(`Raw call data: ${JSON.stringify(call)}`);

    // OpenPhone API returns calls with:
    // - phoneNumberId: the OpenPhone number ID
    // - participants: array of external phone numbers in the call
    // - direction: 'incoming' or 'outgoing'
    // - from/to may not be present, derive from direction and participants
    // - media: array of recordings/voicemails with url, type, duration
    const participants = call.participants as string[] || [];
    const participantPhone = participants[0] || '';

    // Determine from/to based on direction
    let fromNumber: string;
    let toNumber: string;

    if (call.direction === 'incoming') {
      // Incoming call: from = participant, to = our phone number
      fromNumber = call.from as string || participantPhone || phoneNumber || 'unknown';
      toNumber = call.to as string || phoneNumber || participantPhone || 'unknown';
    } else {
      // Outgoing call: from = our phone number, to = participant
      fromNumber = call.from as string || phoneNumber || participantPhone || 'unknown';
      toNumber = call.to as string || participantPhone || phoneNumber || 'unknown';
    }

    // Ensure we never have empty strings (database constraint)
    if (!fromNumber) fromNumber = 'unknown';
    if (!toNumber) toNumber = 'unknown';

    // Extract recording/voicemail URLs from media array or direct fields
    let recordingUrl = call.recordingUrl as string | undefined;
    let voicemailUrl = call.voicemailUrl as string | undefined;

    // OpenPhone sometimes returns media as an array
    const media = call.media as Array<{ url: string; type: string; duration?: number }> | undefined;
    if (media && media.length > 0) {
      // First media item is usually the recording
      recordingUrl = recordingUrl || media[0]?.url;
      this.logger.log(`Found media array with ${media.length} items, first URL: ${media[0]?.url}`);
    }

    const duration = (call.duration as number) || 0;
    const answeredAt = call.answeredAt as string | undefined;
    const callStatus = this.mapCallStatus(
      call.status as string,
      voicemailUrl,
      duration,
      answeredAt,
      call.direction as string,
    );

    this.logger.log(`Mapped call: from=${fromNumber}, to=${toNumber}, direction=${call.direction}, status=${callStatus}, duration=${duration}, answeredAt=${answeredAt}`);

    return {
      providerCallId: call.id as string,
      direction: call.direction === 'incoming' ? CallDirection.IN : CallDirection.OUT,
      duration: duration,
      fromNumber: fromNumber,
      toNumber: toNumber,
      status: callStatus,
      recordingUrl: recordingUrl,
      voicemailUrl: voicemailUrl,
      startedAt: answeredAt ? new Date(answeredAt) : undefined,
      endedAt: call.completedAt ? new Date(call.completedAt as string) : undefined,
      createdAt: new Date(call.createdAt as string),
      metadata: {
        phoneNumberId: call.phoneNumberId,
        userId: call.userId,
        participants: participants,
        originalStatus: call.status, // Store original status for debugging
      },
    };
  }

  /**
   * Get messages directly for a participant phone number across all phone lines.
   * This avoids fetching all conversations and is much more efficient for single contact sync.
   */
  async getMessagesForParticipant(
    workspaceId: string,
    participantPhoneNumber: string,
    filterPhoneNumberId?: string,
  ): Promise<{ messages: MessageData[]; phoneNumberId: string | null; phoneNumber: string | null }> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      // Ensure phone number is in E.164 format (with + prefix)
      let participant = participantPhoneNumber;
      if (participant && !participant.startsWith('+')) {
        participant = '+' + participant;
      }

      this.logger.log(`Fetching messages directly for participant: ${participant}${filterPhoneNumberId ? ` (filtered to phone ${filterPhoneNumberId})` : ''}`);

      // Get all phone numbers for this workspace
      const phoneNumberMap = await this.getPhoneNumbers(client);

      const allMessages: MessageData[] = [];
      let foundPhoneNumberId: string | null = null;
      let foundPhoneNumber: string | null = null;

      // Query messages for each phone number (or just the filtered one)
      for (const [phoneNumberId, phoneInfo] of phoneNumberMap) {
        // Skip if filtering to a specific phone number
        if (filterPhoneNumberId && phoneNumberId !== filterPhoneNumberId) {
          continue;
        }
        try {
          const params: Record<string, unknown> = {
            phoneNumberId: phoneNumberId,
            participants: [participant],
            maxResults: 100,
          };

          this.logger.log(`Fetching messages from OpenPhone: phoneNumberId=${phoneNumberId}, participant=${participant}`);
          const response = await client.get('/messages', { params });
          const messages = response.data.data || [];

          this.logger.log(`OpenPhone returned ${messages.length} messages for ${participant} on phone ${phoneInfo.number}`);

          // Log the date range and direction breakdown of messages returned
          if (messages.length > 0) {
            const firstMsg = messages[0];
            const lastMsg = messages[messages.length - 1];
            this.logger.log(`Message date range: ${lastMsg.createdAt} to ${firstMsg.createdAt}`);

            // Count messages by direction
            const incomingCount = messages.filter((m: Record<string, unknown>) => m.direction === 'incoming').length;
            const outgoingCount = messages.filter((m: Record<string, unknown>) => m.direction === 'outgoing').length;
            this.logger.log(`Message breakdown: ${incomingCount} incoming, ${outgoingCount} outgoing`);

            // Log the 3 most recent messages for debugging
            const recentMsgs = messages.slice(0, 3);
            for (const msg of recentMsgs) {
              this.logger.log(`  Recent msg: ${msg.createdAt} | ${msg.direction} | from=${msg.from} | to=${JSON.stringify(msg.to)} | content="${(msg.content as string || '').substring(0, 50)}..."`);
            }
          }

          if (messages.length > 0) {
            this.logger.log(`Found ${messages.length} messages for participant ${participant} on phone ${phoneInfo.number}`);
            foundPhoneNumberId = phoneNumberId;
            foundPhoneNumber = phoneInfo.number;

            const mappedMessages = messages.map((msg: Record<string, unknown>) => {
              // Extract media URLs if present (MMS messages)
              const media = msg.media as Array<{ url: string; type?: string }> | undefined;
              const mediaUrls = media?.map(m => m.url).filter(Boolean) || [];

              return {
                providerMessageId: msg.id as string,
                direction: msg.direction === 'incoming' ? MessageDirection.IN : MessageDirection.OUT,
                body: msg.content as string || msg.text as string || '',
                fromNumber: msg.from as string,
                toNumber: (msg.to as string[])?.[0] || msg.to as string || '',
                status: this.mapMessageStatus(msg.status as string),
                createdAt: new Date(msg.createdAt as string),
                metadata: {
                  type: msg.type,
                  object: msg.object,
                  phoneNumberId: phoneNumberId,
                  media: media,
                  mediaUrls: mediaUrls,
                },
              };
            });

            allMessages.push(...mappedMessages);
          }
        } catch (error) {
          // Continue to next phone number on error
          this.logger.warn(`Failed to fetch messages for phone ${phoneNumberId}: ${error}`);
        }
      }

      this.logger.log(`Total messages found for ${participant}: ${allMessages.length}`);

      return {
        messages: allMessages,
        phoneNumberId: foundPhoneNumberId,
        phoneNumber: foundPhoneNumber,
      };
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
      this.logger.error(`Failed to fetch messages for participant ${participantPhoneNumber}: ${axiosError.message}`);
      throw error;
    }
  }

  /**
   * Get calls directly for a participant phone number across all phone lines.
   * OpenPhone calls API requires phoneNumberId along with participants.
   */
  async getCallsForParticipant(
    workspaceId: string,
    participantPhoneNumber: string,
    filterPhoneNumberId?: string,
  ): Promise<CallData[]> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      // Ensure phone number is in E.164 format (with + prefix)
      let participant = participantPhoneNumber;
      if (participant && !participant.startsWith('+')) {
        participant = '+' + participant;
      }

      this.logger.log(`Fetching calls directly for participant: ${participant}${filterPhoneNumberId ? ` (filtered to phone ${filterPhoneNumberId})` : ''}`);

      // Get all phone numbers for this workspace (required by OpenPhone calls API)
      const phoneNumberMap = await this.getPhoneNumbers(client);

      const allCalls: CallData[] = [];

      // Query calls for each phone number (or just the filtered one)
      for (const [phoneNumberId, phoneInfo] of phoneNumberMap) {
        // Skip if filtering to a specific phone number
        if (filterPhoneNumberId && phoneNumberId !== filterPhoneNumberId) {
          continue;
        }
        try {
          const params: Record<string, unknown> = {
            phoneNumberId: phoneNumberId,
            participants: [participant],
            maxResults: 100,
          };

          const response = await client.get('/calls', { params });
          const calls = response.data.data || [];

          if (calls.length > 0) {
            this.logger.log(`Found ${calls.length} calls for participant ${participant} on phone ${phoneInfo.number}`);

            // Count calls by direction
            const incomingCalls = calls.filter((c: Record<string, unknown>) => c.direction === 'incoming').length;
            const outgoingCalls = calls.filter((c: Record<string, unknown>) => c.direction === 'outgoing').length;
            this.logger.log(`Call breakdown: ${incomingCalls} incoming, ${outgoingCalls} outgoing`);

            // Log the 3 most recent calls for debugging
            const recentCalls = calls.slice(0, 3);
            for (const call of recentCalls) {
              this.logger.log(`  Recent call: ${call.createdAt} | ${call.direction} | status=${call.status} | duration=${call.duration}`);
            }

            const mappedCalls = calls.map((call: Record<string, unknown>) => this.mapCallData(call, phoneInfo.number));
            allCalls.push(...mappedCalls);
          }
        } catch (error) {
          // Continue to next phone number on error
          this.logger.warn(`Failed to fetch calls for phone ${phoneNumberId}: ${error}`);
        }
      }

      this.logger.log(`Total calls found for ${participant}: ${allCalls.length}`);

      return allCalls;
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
      this.logger.error(`Failed to fetch calls for participant ${participantPhoneNumber}: ${axiosError.message}`);
      throw error;
    }
  }

  /**
   * Get recordings for a specific call from OpenPhone.
   * Returns the recording URL or null if not available.
   */
  async getCallRecordings(
    workspaceId: string,
    providerCallId: string,
  ): Promise<{ recordingUrl: string | null; voicemailUrl: string | null }> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      this.logger.log(`Fetching recordings for call: ${providerCallId}`);

      const response = await client.get(`/call-recordings/${providerCallId}`);
      const recordings = response.data.data || [];

      this.logger.log(`Found ${recordings.length} recordings for call ${providerCallId}`);

      let recordingUrl: string | null = null;
      let voicemailUrl: string | null = null;

      for (const recording of recordings) {
        if (recording.url) {
          // Check if it's a voicemail based on context or just use first recording
          if (recording.type === 'voicemail') {
            voicemailUrl = recording.url;
          } else {
            recordingUrl = recordingUrl || recording.url;
          }
        }
      }

      return { recordingUrl, voicemailUrl };
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
      if (axiosError.response?.status === 404) {
        this.logger.log(`No recordings found for call ${providerCallId}`);
        return { recordingUrl: null, voicemailUrl: null };
      }
      this.logger.error(`Failed to fetch recordings for call ${providerCallId}: ${axiosError.message}`);
      return { recordingUrl: null, voicemailUrl: null };
    }
  }

  /**
   * Get transcript for a specific call from OpenPhone.
   * Returns the transcript text or null if not available.
   */
  async getCallTranscript(
    workspaceId: string,
    providerCallId: string,
  ): Promise<{ transcript: string; status: string } | null> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      this.logger.log(`Fetching transcript for call: ${providerCallId}`);

      const response = await client.get(`/call-transcripts/${providerCallId}`);
      const data = response.data.data;

      if (!data || data.status !== 'completed' || !data.dialogue) {
        this.logger.log(`No transcript available for call ${providerCallId}, status: ${data?.status}`);
        return { transcript: '', status: data?.status || 'absent' };
      }

      // Format dialogue into readable transcript
      const transcript = data.dialogue
        .map((segment: { content: string; identifier?: string; userId?: string }) => {
          const speaker = segment.userId ? 'Agent' : (segment.identifier || 'Unknown');
          return `${speaker}: ${segment.content}`;
        })
        .join('\n');

      this.logger.log(`Fetched transcript for call ${providerCallId}, ${data.dialogue.length} segments`);

      return { transcript, status: 'completed' };
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
      if (axiosError.response?.status === 404) {
        this.logger.log(`No transcript found for call ${providerCallId}`);
        return { transcript: '', status: 'absent' };
      }
      this.logger.error(`Failed to fetch transcript for call ${providerCallId}: ${axiosError.message}`);
      return null;
    }
  }

  /**
   * Download a recording or voicemail file from OpenPhone.
   * Returns the audio data as a Buffer.
   */
  async downloadRecording(
    workspaceId: string,
    recordingUrl: string,
  ): Promise<Buffer | null> {
    this.logger.log(`Downloading recording from: ${recordingUrl}`);

    // OpenPhone recording URLs from Google Cloud Storage are pre-signed
    // and should be accessed WITHOUT authentication headers
    try {
      const response = await axios.get(recordingUrl, {
        responseType: 'arraybuffer',
        // No auth headers - GCS URLs are pre-signed
      });

      this.logger.log(`Downloaded recording, size: ${response.data.length} bytes`);
      return Buffer.from(response.data);
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number }; message?: string };
      this.logger.warn(`Direct download failed (${axiosError.response?.status}), trying with API key...`);

      // If direct download fails, try with OpenPhone API key
      // (some URLs might require it)
      try {
        const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
        const response = await axios.get(recordingUrl, {
          responseType: 'arraybuffer',
          headers: {
            'Authorization': credentials.apiKey,
          },
        });

        this.logger.log(`Downloaded recording with auth, size: ${response.data.length} bytes`);
        return Buffer.from(response.data);
      } catch (authError: unknown) {
        const authAxiosError = authError as { response?: { status?: number }; message?: string };
        this.logger.error(`Failed to download recording: ${authAxiosError.message}`);
        return null;
      }
    }
  }

  /**
   * Register webhooks with OpenPhone for real-time event notifications.
   * Creates webhooks for messages and calls.
   */
  async registerWebhooks(
    workspaceId: string,
    webhookUrl: string,
  ): Promise<WebhookRegistrationResult> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      this.logger.log(`Registering webhooks with OpenPhone, URL: ${webhookUrl}`);

      let messageWebhookId: string | undefined;
      let callWebhookId: string | undefined;
      let webhookKey: string | undefined;

      // Register message webhook
      try {
        const messageResponse = await client.post('/webhooks/messages', {
          url: webhookUrl,
          events: ['message.received', 'message.delivered'],
          resourceIds: ['*'], // All phone numbers
          label: 'Callio Messages',
        });

        messageWebhookId = messageResponse.data.data?.id;
        webhookKey = messageResponse.data.data?.key; // Webhook secret for signature verification
        this.logger.log(`Message webhook registered: ${messageWebhookId}`);
      } catch (error: unknown) {
        const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
        this.logger.error(`Failed to register message webhook: ${axiosError.message}`);
        if (axiosError.response) {
          this.logger.error(`OpenPhone API error: ${axiosError.response.status} - ${JSON.stringify(axiosError.response.data)}`);
        }
      }

      // Register call webhook
      try {
        const callResponse = await client.post('/webhooks/calls', {
          url: webhookUrl,
          events: ['call.completed', 'call.ringing', 'call.recording.completed'],
          resourceIds: ['*'], // All phone numbers
          label: 'Callio Calls',
        });

        callWebhookId = callResponse.data.data?.id;
        // Use the webhook key from calls if we didn't get one from messages
        if (!webhookKey) {
          webhookKey = callResponse.data.data?.key;
        }
        this.logger.log(`Call webhook registered: ${callWebhookId}`);
      } catch (error: unknown) {
        const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
        this.logger.error(`Failed to register call webhook: ${axiosError.message}`);
        if (axiosError.response) {
          this.logger.error(`OpenPhone API error: ${axiosError.response.status} - ${JSON.stringify(axiosError.response.data)}`);
        }
      }

      if (!messageWebhookId && !callWebhookId) {
        return {
          success: false,
          error: 'Failed to register any webhooks with OpenPhone',
        };
      }

      return {
        success: true,
        messageWebhookId,
        callWebhookId,
        webhookKey,
      };
    } catch (error: unknown) {
      const axiosError = error as { message?: string };
      this.logger.error(`Failed to register webhooks: ${axiosError.message}`);
      return {
        success: false,
        error: axiosError.message,
      };
    }
  }

  /**
   * Delete existing webhooks from OpenPhone.
   * Used when updating or removing the integration.
   */
  async deleteWebhooks(
    workspaceId: string,
    webhookIds: { messageWebhookId?: string; callWebhookId?: string },
  ): Promise<void> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      if (webhookIds.messageWebhookId) {
        try {
          await client.delete(`/webhooks/${webhookIds.messageWebhookId}`);
          this.logger.log(`Deleted message webhook: ${webhookIds.messageWebhookId}`);
        } catch (error) {
          this.logger.warn(`Failed to delete message webhook: ${webhookIds.messageWebhookId}`);
        }
      }

      if (webhookIds.callWebhookId) {
        try {
          await client.delete(`/webhooks/${webhookIds.callWebhookId}`);
          this.logger.log(`Deleted call webhook: ${webhookIds.callWebhookId}`);
        } catch (error) {
          this.logger.warn(`Failed to delete call webhook: ${webhookIds.callWebhookId}`);
        }
      }
    } catch (error) {
      this.logger.error('Failed to delete webhooks', error);
    }
  }

  /**
   * List all webhooks registered with OpenPhone for this account.
   */
  async listWebhooks(workspaceId: string): Promise<Array<{ id: string; url: string; events: string[]; status: string }>> {
    try {
      const credentials = JSON.parse(workspaceId) as OpenPhoneCredentials;
      const client = this.createClient(credentials.apiKey);

      const response = await client.get('/webhooks');
      const webhooks = response.data.data || [];

      return webhooks.map((wh: Record<string, unknown>) => ({
        id: wh.id as string,
        url: wh.url as string,
        events: wh.events as string[],
        status: wh.status as string,
      }));
    } catch (error) {
      this.logger.error('Failed to list webhooks', error);
      return [];
    }
  }
}
