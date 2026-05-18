import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EncryptionService } from '../common/encryption.service';
import {
  TelegramAccount,
  TelegramAccountMode,
  TelegramAccountStatus,
} from './telegram-account.entity';

export interface RegisterBotAccountInput {
  tenantId: string;
  displayName?: string;
  botUsername?: string;
  botToken: string;
}

export interface RegisterMtprotoAccountInput {
  tenantId: string;
  displayName?: string;
  telegramUserId?: string;
  phone?: string;
  gramjsSession: string;
}

@Injectable()
export class AccountStoreService {
  private readonly logger = new Logger(AccountStoreService.name);

  constructor(
    @InjectRepository(TelegramAccount)
    private readonly repo: Repository<TelegramAccount>,
    private readonly enc: EncryptionService,
  ) {}

  async registerBot(input: RegisterBotAccountInput): Promise<TelegramAccount> {
    const acct = this.repo.create({
      tenantId: input.tenantId,
      mode: 'bot' as TelegramAccountMode,
      displayName: input.displayName,
      botUsername: input.botUsername,
      botTokenEncrypted: this.enc.encrypt(input.botToken),
      status: 'connected' as TelegramAccountStatus,
      lastConnectedAt: new Date(),
      reconnectAttempts: 0,
    });
    return this.repo.save(acct);
  }

  async registerMtproto(input: RegisterMtprotoAccountInput): Promise<TelegramAccount> {
    if ((process.env.TELEGRAM_MTPROTO_ENABLED || 'false').toLowerCase() !== 'true') {
      throw new Error('mtproto_disabled');
    }
    const acct = this.repo.create({
      tenantId: input.tenantId,
      mode: 'mtproto' as TelegramAccountMode,
      displayName: input.displayName,
      telegramUserId: input.telegramUserId,
      phone: input.phone,
      gramjsSessionEncrypted: this.enc.encrypt(input.gramjsSession),
      status: 'connected' as TelegramAccountStatus,
      lastConnectedAt: new Date(),
      reconnectAttempts: 0,
    });
    return this.repo.save(acct);
  }

  async getForTenant(tenantId: string, accountId: string): Promise<TelegramAccount> {
    const acct = await this.repo.findOne({ where: { id: accountId, tenantId } });
    if (!acct) {
      throw new NotFoundException({ error: 'telegram_account_not_found' });
    }
    return acct;
  }

  async listForTenant(tenantId: string): Promise<TelegramAccount[]> {
    return this.repo.find({ where: { tenantId } });
  }

  decryptBotToken(acct: TelegramAccount): string {
    if (!acct.botTokenEncrypted) {
      throw new Error('no bot token on account');
    }
    return this.enc.decrypt(acct.botTokenEncrypted);
  }

  async markStatus(
    accountId: string,
    status: TelegramAccountStatus,
    opts?: { lastPingAt?: Date; reconnectAttempts?: number },
  ): Promise<void> {
    const patch: Partial<TelegramAccount> = { status };
    if (opts?.lastPingAt) patch.lastPingAt = opts.lastPingAt;
    if (typeof opts?.reconnectAttempts === 'number') patch.reconnectAttempts = opts.reconnectAttempts;
    await this.repo.update({ id: accountId }, patch);
  }
}
