import { MessageDirection, MessageStatus } from '../../../database/entities/communication-message.entity';
import { CallDirection, CallStatus } from '../../../database/entities/communication-call.entity';
import { ChannelType } from '../../../database/entities/sender.entity';

export interface SendMessageInput {
  from: string;
  fromId?: string; // OpenPhone requires phone number ID (e.g., "PNm5YIDoXV")
  to: string;
  body: string;
  workspaceId: string;
  channel?: ChannelType; // Channel type (sms, whatsapp, telegram, voice)
  templateId?: string; // WhatsApp template ID
  templateParams?: Record<string, string>; // WhatsApp template parameters
}

export interface SendMessageResult {
  providerMessageId: string;
  status: MessageStatus;
  sentAt: Date;
}

export interface ConversationData {
  externalId: string;
  /**
   * Tenant-side phone number for this conversation. `null` when the provider
   * extractor could not resolve which of the workspace's phones hosts the
   * conversation (e.g. Quo `/phone-numbers` lookup missed the id: deleted,
   * paginated out, or a transient 5xx swallowed by the try/catch). The sync
   * writer MUST treat null as "unresolved" and skip rather than overwriting
   * a previously-good `phone_number`. See TASKS_2026-09-08_CONVERSATION_SYNC.md
   * Task 6.
   */
  phoneNumber: string | null;
  participantPhoneNumber: string;
  participantPhoneNumbers?: string[];
  createdAt: Date;
  lastMessageAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface MessageData {
  providerMessageId: string;
  direction: MessageDirection;
  body: string;
  fromNumber: string;
  toNumber: string;
  status: MessageStatus;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface CallData {
  providerCallId: string;
  direction: CallDirection;
  duration: number;
  fromNumber: string;
  toNumber: string;
  status: CallStatus;
  recordingUrl?: string;
  voicemailUrl?: string;
  startedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface InitiateCallInput {
  from: string;
  to: string;
  workspaceId: string;
}

export interface InitiateCallResult {
  success: boolean;
  deepLink?: string;
  webFallback?: string;
  message?: string;
}

export interface CommunicationProvider {
  readonly providerName: string;
  readonly supportedChannels: ChannelType[]; // Channels this provider supports

  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;

  /**
   * `allowedPhoneNumbers` — when set, providers that key conversations by a
   * workspace-scoped phone-line id (OpenPhone `phoneNumberId`) MUST both
   *  (a) scope any internal id→phone map to entries whose PHONE NUMBER is in
   *      this set, so the extractor can never emit a foreign tenant's phone
   *      number as the tenant-side phone, and
   *  (b) post-filter the returned conversation list so conversations on phones
   *      outside this set never reach the sync writer, even if the provider's
   *      own filter is lax (Quo returns identical top-N conversations for
   *      different `phoneNumberId` values on shared workspaces).
   *
   * The set holds E.164-normalized phone numbers (e.g. `+14254064045`). This is
   * a more reliable signal than a phoneNumberId set because
   * `tenant_phone_numbers.phone_number` is guaranteed populated whereas
   * `tenant_phone_numbers.provider_id` is nullable and historically
   * un-backfilled for pre-`registerOpenPhoneNumbersForTenant` connections.
   *
   * See TASKS_2026-09-08_CONVERSATION_SYNC.md Task 8.
   */
  getConversations(
    workspaceId: string,
    limit?: number,
    phoneNumberId?: string,
    since?: Date,
    allowedPhoneNumbers?: Set<string>,
  ): Promise<ConversationData[]>;

  getMessages(
    workspaceId: string,
    conversationId: string,
    phoneNumberId?: string,
    participantPhoneNumber?: string,
  ): Promise<MessageData[]>;

  getCalls(workspaceId: string): Promise<CallData[]>;

  getCallsForConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<CallData[]>;

  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;

  validateCredentials(credentials: string): Promise<boolean>;

  // Optional methods for channel-specific operations
  supportsChannel?(channel: ChannelType): boolean;

  // Get phone numbers from credentials - returns Map<id, { number/phoneNumber, name/friendlyName, ... }>
  getPhoneNumbersFromCredentials?(credentials: string): Promise<Map<string, unknown>>;
}
