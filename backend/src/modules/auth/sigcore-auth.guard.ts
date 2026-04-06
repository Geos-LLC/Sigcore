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

      // Resolve tenantId: direct column first, then relation, then scope-based lookup
      let tenantId = key.tenantId;
      if (!tenantId && key.scope === 'tenant') {
        // TypeORM ManyToOne relation may not populate tenantId column on findOne
        // Reload with relation to get the actual tenant_id
        const reloaded = await this.apiKeyRepo.findOne({
          where: { id: key.id },
          select: ['id', 'tenantId', 'workspaceId', 'scope'],
          loadEagerRelations: false,
        });
        tenantId = reloaded?.tenantId || null;
        if (!tenantId) {
          console.warn(`[AUTH] Tenant-scoped key ${key.id} has null tenantId after reload`);
        }
      }
      request.tenantId = tenantId;
      request.authScopeType = (tenantId || key.scope === 'tenant') ? 'tenant' : 'workspace';
      return true;
    }

    throw new UnauthorizedException('Authentication required. Provide X-Sigcore-Key or x-api-key header.');
  }
}
