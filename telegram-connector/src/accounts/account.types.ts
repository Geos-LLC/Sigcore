export type TelegramAccountMode = 'bot' | 'mtproto';
export type TelegramAccountStatus = 'connected' | 'disconnected' | 'expired' | 'error';

/**
 * On-disk record.  `botTokenEncrypted` / `gramjsSessionEncrypted` always
 * hold ciphertext from EncryptionService.  Raw values never enter this shape.
 */
export interface TelegramAccountRecord {
  id: string;
  tenantId: string;
  provider: 'telegram';
  mode: TelegramAccountMode;
  displayName: string;
  botUsername?: string;
  botTokenEncrypted?: string;
  gramjsSessionEncrypted?: string;
  telegramUserId?: string;
  phone?: string;
  status: TelegramAccountStatus;
  lastError?: string;
  lastConnectedAt?: string;
  lastPingAt?: string;
  reconnectAttempts: number;
  createdAt: string;
  updatedAt: string;
}

/** Caller-safe view — secret fields stripped. */
export interface TelegramAccountPublic {
  id: string;
  tenantId: string;
  provider: 'telegram';
  mode: TelegramAccountMode;
  displayName: string;
  botUsername?: string;
  telegramUserId?: string;
  phone?: string;
  status: TelegramAccountStatus;
  lastError?: string;
  lastConnectedAt?: string;
  lastPingAt?: string;
  reconnectAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export function toPublic(record: TelegramAccountRecord): TelegramAccountPublic {
  const { botTokenEncrypted, gramjsSessionEncrypted, ...rest } = record;
  return rest;
}
