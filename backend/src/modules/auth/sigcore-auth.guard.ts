import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from '../../database/entities';

/**
 * Guard for Sigcore service-to-service authentication.
 * Supports two auth methods:
 * 1. X-Sigcore-Key header - for Callio backend → Sigcore calls (requires X-Workspace-Id)
 * 2. x-api-key header - for external API key auth (tenants, external systems)
 */
@Injectable()
export class SigcoreAuthGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Method 1: Service-to-service via X-Sigcore-Key
    const sigcoreKey = request.headers['x-sigcore-key'];
    if (sigcoreKey) {
      const expectedKey = this.configService.get('SIGCORE_SERVICE_KEY');
      if (!expectedKey || sigcoreKey !== expectedKey) {
        throw new UnauthorizedException('Invalid service key');
      }

      const workspaceId = request.headers['x-workspace-id'];
      if (!workspaceId) {
        throw new UnauthorizedException('X-Workspace-Id header required');
      }

      // Attach to request for downstream use
      request.workspaceId = workspaceId;
      request.authType = 'service';
      request.authScopeType = 'workspace'; // service keys are workspace-scoped
      return true;
    }

    // Method 2: External API key
    const apiKey = request.headers['x-api-key'];
    if (apiKey) {
      const key = await this.apiKeyRepo.findOne({
        where: { key: apiKey, active: true },
      });

      if (!key) {
        throw new UnauthorizedException('Invalid API key');
      }

      // Update last used
      key.lastUsedAt = new Date();
      await this.apiKeyRepo.save(key);

      request.workspaceId = key.workspaceId;
      request.apiKeyScope = key.scope;
      request.authType = 'api_key';

      // Resolve tenantId: column value, or repair from tenant table if scope='tenant' but column is null
      let tenantId = key.tenantId;
      if (!tenantId && key.scope === 'tenant') {
        // TypeORM bug: ManyToOne + Column on same DB column can leave tenantId null after save
        // Look up the correct tenantId from the tenant table by finding which tenant owns this key
        try {
          const result = await this.apiKeyRepo.query(
            `SELECT tenant_id FROM api_keys WHERE id = $1`, [key.id]
          );
          tenantId = result?.[0]?.tenant_id || null;

          // If still null, find tenant by checking the tenant_api_keys relationship
          if (!tenantId) {
            const tenantResult = await this.apiKeyRepo.query(
              `SELECT t.id FROM tenants t JOIN api_keys ak ON ak.workspace_id = t.workspace_id WHERE ak.id = $1 AND ak.scope = 'tenant' LIMIT 1`,
              [key.id]
            );
            if (tenantResult?.[0]?.id) {
              tenantId = tenantResult[0].id;
              // Repair the key for future requests
              await this.apiKeyRepo.query(
                `UPDATE api_keys SET tenant_id = $1 WHERE id = $2`, [tenantId, key.id]
              );
              console.log(`[AUTH] Repaired tenant_id on key ${key.id} → ${tenantId}`);
            }
          }
        } catch (e) {
          console.warn(`[AUTH] Failed to resolve tenantId for key ${key.id}: ${e.message}`);
        }
      }
      request.tenantId = tenantId;
      request.authScopeType = (tenantId || key.scope === 'tenant') ? 'tenant' : 'workspace';
      return true;
    }

    throw new UnauthorizedException('Authentication required. Provide X-Sigcore-Key or x-api-key header.');
  }
}
