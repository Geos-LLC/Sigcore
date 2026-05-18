export type NormalizedMessageType = 'text' | 'image' | 'file' | 'voice' | 'video' | 'unknown';

export interface ProviderMetadata {
  provider: 'telegram';
  tenantId: string;
  accountId: string;
  telegramChatId: string;
  telegramUserId?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  phone?: string;
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface NormalizedInboundMessage {
  tenantId: string;
  provider: 'telegram';
  accountId: string;
  externalMessageId: string;
  externalConversationId: string;
  participantKey: string;
  direction: 'inbound';
  messageType: NormalizedMessageType;
  text?: string;
  timestamp: string;
  providerMetadata: ProviderMetadata;
  providerPayload: Record<string, unknown>;
}

export type DurableEventStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'dead';

export interface DurableInboundEvent {
  id: string;
  tenantId: string;
  accountId: string;
  provider: 'telegram';
  externalMessageId: string;
  externalConversationId: string;
  participantKey: string;
  payload: Record<string, unknown>;
  normalizedPayload: NormalizedInboundMessage;
  status: DurableEventStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
