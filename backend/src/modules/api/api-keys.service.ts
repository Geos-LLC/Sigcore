import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from '../../database/entities/api-key.entity';
import { randomBytes } from 'crypto';

@Injectable()
export class ApiKeysService {
  constructor(
    @InjectRepository(ApiKey)
    private apiKeyRepository: Repository<ApiKey>,
  ) {}

  async getApiKeys(workspaceId: string): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      where: { workspaceId, scope: 'workspace' },
      order: { createdAt: 'DESC' },
    });
  }

  async createApiKey(workspaceId: string, name: string): Promise<{ apiKey: ApiKey; key: string }> {
    // Generate a secure random API key
    const key = `sc_${randomBytes(32).toString('hex')}`;

    const apiKey = this.apiKeyRepository.create({
      workspaceId,
      name,
      key,
      scope: 'workspace',
      active: true,
    });

    await this.apiKeyRepository.save(apiKey);

    // Return the full key only on creation (it won't be shown again)
    return { apiKey, key };
  }

  async deleteApiKey(workspaceId: string, keyId: string): Promise<void> {
    const apiKey = await this.apiKeyRepository.findOne({
      where: { id: keyId, workspaceId },
    });

    if (!apiKey) {
      throw new NotFoundException('API key not found');
    }

    await this.apiKeyRepository.remove(apiKey);
  }

  async toggleApiKey(workspaceId: string, keyId: string): Promise<ApiKey> {
    const apiKey = await this.apiKeyRepository.findOne({
      where: { id: keyId, workspaceId },
    });

    if (!apiKey) {
      throw new NotFoundException('API key not found');
    }

    apiKey.active = !apiKey.active;
    return this.apiKeyRepository.save(apiKey);
  }

  // ==================== Tenant API Keys ====================

  async createTenantApiKey(
    workspaceId: string,
    tenantId: string,
    name: string,
  ): Promise<{ apiKey: ApiKey; key: string }> {
    const key = `sc_tenant_${randomBytes(32).toString('hex')}`;

    const apiKey = this.apiKeyRepository.create({
      workspaceId,
      tenantId,
      name,
      key,
      scope: 'tenant',
      active: true,
    });

    const saved = await this.apiKeyRepository.save(apiKey);

    // Ensure tenant_id is persisted (TypeORM ManyToOne can nullify the column)
    if (tenantId && !saved.tenantId) {
      await this.apiKeyRepository
        .createQueryBuilder()
        .update()
        .set({ tenantId })
        .where('id = :id', { id: saved.id })
        .execute();
      saved.tenantId = tenantId;
    }

    return { apiKey: saved, key };
  }

  async getTenantApiKeys(workspaceId: string, tenantId: string): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      where: { workspaceId, tenantId, scope: 'tenant' },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Look up the canonical active tenant API key (PR10 idempotent provisioning).
   * Returns null when no active tenant key exists. Caller decides whether to
   * mint a new one (forceNewKey path) or hand back a summary.
   */
  async getActiveTenantApiKey(
    workspaceId: string,
    tenantId: string,
  ): Promise<ApiKey | null> {
    const candidates = await this.apiKeyRepository.find({
      where: { workspaceId, tenantId, scope: 'tenant', active: true },
      order: { createdAt: 'DESC' },
    });
    return candidates.length > 0 ? candidates[0] : null;
  }

  async deleteTenantApiKey(
    workspaceId: string,
    tenantId: string,
    keyId: string,
  ): Promise<void> {
    const apiKey = await this.apiKeyRepository.findOne({
      where: { id: keyId, workspaceId, tenantId, scope: 'tenant' },
    });

    if (!apiKey) {
      throw new NotFoundException('Tenant API key not found');
    }

    await this.apiKeyRepository.remove(apiKey);
  }

  async validateTenantApiKey(key: string): Promise<ApiKey | null> {
    return this.apiKeyRepository.findOne({
      where: { key, active: true, scope: 'tenant' },
      relations: ['tenant'],
    });
  }
}
