import { Injectable, Logger } from '@nestjs/common';
import { AccountStoreService } from '../accounts/account-store.service';
import { TransportFactory } from '../transport/transport.factory';
import { OutboundIdempotencyService } from './outbound-idempotency.service';

export interface OutboundSendInput {
  tenantId: string;
  accountId: string;
  telegramChatId: string;
  text: string;
  conversationId?: string;
  idempotencyKey?: string;
}

export interface OutboundSendResult {
  ok: boolean;
  provider: 'telegram';
  externalMessageId?: string;
  status: 'sent' | 'queued' | 'failed';
  error?: string;
  idempotentReplay?: boolean;
}

@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);

  constructor(
    private readonly accounts: AccountStoreService,
    private readonly transports: TransportFactory,
    private readonly idem: OutboundIdempotencyService,
  ) {}

  async send(input: OutboundSendInput): Promise<OutboundSendResult> {
    // Validate tenant/account access — getForTenant throws if cross-tenant.
    const account = await this.accounts.getForTenant(input.tenantId, input.accountId);

    // DB-backed idempotency replaces the previous in-memory/disk cache.
    if (input.idempotencyKey) {
      const prior = await this.idem.lookup(input.tenantId, input.accountId, input.idempotencyKey);
      if (prior) {
        return {
          ok: prior.status !== 'failed',
          provider: 'telegram',
          externalMessageId: prior.externalMessageId,
          status: prior.status,
          idempotentReplay: true,
        };
      }
    }

    const transport = this.transports.forAccount(account);
    const result = await transport.sendMessage({
      account,
      telegramChatId: input.telegramChatId,
      text: input.text,
    });

    if (input.idempotencyKey && result.ok && result.externalMessageId) {
      try {
        await this.idem.record({
          tenantId: input.tenantId,
          accountId: input.accountId,
          idempotencyKey: input.idempotencyKey,
          externalMessageId: result.externalMessageId,
          status: result.status,
        });
      } catch (e) {
        this.logger.warn(`Failed to record idempotency row: ${(e as Error).message}`);
      }
    }

    return {
      ok: result.ok,
      provider: 'telegram',
      externalMessageId: result.externalMessageId,
      status: result.status,
      error: result.error,
    };
  }
}
