import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramOutboundIdempotency } from './outbound-idempotency.entity';

@Injectable()
export class OutboundIdempotencyService {
  private readonly logger = new Logger(OutboundIdempotencyService.name);

  constructor(
    @InjectRepository(TelegramOutboundIdempotency)
    private readonly repo: Repository<TelegramOutboundIdempotency>,
  ) {}

  async lookup(tenantId: string, accountId: string, idempotencyKey: string) {
    return this.repo.findOne({ where: { tenantId, accountId, idempotencyKey } });
  }

  async record(input: {
    tenantId: string;
    accountId: string;
    idempotencyKey: string;
    externalMessageId: string;
    status: 'sent' | 'queued' | 'failed';
  }): Promise<TelegramOutboundIdempotency> {
    try {
      const row = this.repo.create(input);
      return await this.repo.save(row);
    } catch (e: any) {
      // Race: another concurrent send under the same idempotencyKey just won.
      if (e.code === '23505') {
        const existing = await this.lookup(input.tenantId, input.accountId, input.idempotencyKey);
        if (existing) return existing;
      }
      throw e;
    }
  }
}
