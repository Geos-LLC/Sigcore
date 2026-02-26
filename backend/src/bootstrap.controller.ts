import {
  Controller,
  Post,
  Headers,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { Workspace } from './database/entities/workspace.entity';
import { ApiKey } from './database/entities/api-key.entity';

/**
 * Bootstrap controller — creates the initial workspace + API key.
 * Protected by SIGCORE_BOOTSTRAP_SECRET env var.
 * Safe to call multiple times (idempotent workspace creation).
 *
 * POST /bootstrap
 * Header: x-bootstrap-secret: <SIGCORE_BOOTSTRAP_SECRET>
 */
@Controller()
export class BootstrapController {
  private readonly logger = new Logger(BootstrapController.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Workspace)
    private readonly workspaceRepo: Repository<Workspace>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
  ) {}

  @Post('bootstrap')
  async bootstrap(@Headers('x-bootstrap-secret') secret: string) {
    const expected = this.configService.get<string>('SIGCORE_BOOTSTRAP_SECRET');
    if (!expected || secret !== expected) {
      throw new UnauthorizedException('Invalid bootstrap secret');
    }

    // Find or create the primary workspace
    let workspace = await this.workspaceRepo.findOne({
      where: { name: 'Primary Workspace' },
    });

    if (!workspace) {
      workspace = this.workspaceRepo.create({
        name: 'Primary Workspace',
        webhookId: `ws_${randomBytes(16).toString('hex')}`,
      });
      await this.workspaceRepo.save(workspace);
      this.logger.log(`[bootstrap] Created workspace ${workspace.id}`);
    } else {
      this.logger.log(`[bootstrap] Using existing workspace ${workspace.id}`);
    }

    // Always create a fresh API key
    const key = `sc_${randomBytes(32).toString('hex')}`;
    const apiKey = this.apiKeyRepo.create({
      workspaceId: workspace.id,
      tenantId: null,
      scope: 'workspace',
      key,
      name: 'Bootstrap Admin Key',
      active: true,
    });
    await this.apiKeyRepo.save(apiKey);

    this.logger.log(`[bootstrap] Created API key ${apiKey.id} for workspace ${workspace.id}`);

    return {
      workspaceId: workspace.id,
      apiKey: key,
    };
  }
}
