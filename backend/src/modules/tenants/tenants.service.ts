import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import * as crypto from 'crypto';
import {
  Tenant,
  TenantStatus,
  TenantPhoneNumber,
  PhoneNumberAllocationStatus,
  PhoneNumberProvider,
  CommunicationIntegration,
  TenantIntegration,
} from '../../database/entities';
import { ChannelType } from '../../database/entities/sender.entity';
import { IntegrationStatus, ProviderType } from '../../database/entities/communication-integration.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { ProviderRegistry } from '../communication/providers/provider-registry.service';

export interface CreateTenantDto {
  externalId?: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface AllocatePhoneNumberDto {
  tenantId: string;
  phoneNumber: string;
  provider: PhoneNumberProvider;
  providerId?: string;
  friendlyName?: string;
  channel?: ChannelType;
  isDefault?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AvailablePhoneNumber {
  phoneNumber: string;
  friendlyName: string | null;
  provider: PhoneNumberProvider;
  providerId: string;
  capabilities?: string[];
  allocated: boolean;
  allocatedTo?: {
    tenantId: string;
    tenantName: string;
  };
}

export interface ConnectTenantIntegrationDto {
  provider: ProviderType;
  // For Twilio
  accountSid?: string;
  authToken?: string;
  // For OpenPhone
  apiKey?: string;
  // Optional phone number details
  phoneNumber?: string;
  phoneNumberSid?: string;
  friendlyName?: string;
}

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    @InjectRepository(Tenant)
    private tenantRepo: Repository<Tenant>,
    @InjectRepository(TenantPhoneNumber)
    private tenantPhoneRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(CommunicationIntegration)
    private integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(TenantIntegration)
    private tenantIntegrationRepo: Repository<TenantIntegration>,
    private encryptionService: EncryptionService,
    private providerRegistry: ProviderRegistry,
  ) {}

  /**
   * Create a new tenant
   */
  private generateExternalId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const suffix = Math.random().toString(36).substring(2, 6);
    return `${slug}-${suffix}`;
  }

  async createTenant(workspaceId: string, dto: CreateTenantDto): Promise<Tenant> {
    const externalId = dto.externalId?.trim() || this.generateExternalId(dto.name);

    // Check if tenant with externalId already exists
    const existing = await this.tenantRepo.findOne({
      where: { workspaceId, externalId },
    });

    if (existing) {
      throw new ConflictException(`Tenant with externalId ${externalId} already exists`);
    }

    const tenant = this.tenantRepo.create({
      workspaceId,
      externalId,
      name: dto.name,
      status: TenantStatus.ACTIVE,
      webhookSecret: crypto.randomBytes(32).toString('hex'),
      metadata: dto.metadata,
    });

    await this.tenantRepo.save(tenant);
    this.logger.log(`Created tenant: ${tenant.id} (${tenant.name})`);

    // Register in business identity model (fire-and-forget, non-blocking)
    this.registerTenantIdentity(tenant).catch((e) =>
      this.logger.warn(`[BusinessIdentity] Auto-registration for tenant ${tenant.id}: ${e.message}`),
    );

    return tenant;
  }

  /**
   * Register a tenant in the business identity model.
   * Creates a business + product_workspace + links phone numbers as assets.
   */
  private async registerTenantIdentity(tenant: Tenant): Promise<void> {
    // Lazy import to avoid circular dependency
    const { BusinessIdentityService } = await import('../business-identity/business-identity.service');
    const biService = new BusinessIdentityService(
      this.tenantRepo.manager.getRepository('Business') as any,
      this.tenantRepo.manager.getRepository('ProductWorkspace') as any,
      this.tenantRepo.manager.getRepository('SharedCommunicationAsset') as any,
      this.tenantRepo.manager.getRepository('WorkspaceAssetLink') as any,
    );

    const { business } = await biService.createOrResolveBusiness({
      name: tenant.name,
      external_id: `sigcore-tenant-${tenant.id}`,
    });

    const { workspace } = await biService.registerWorkspace(business.id, {
      product_type: 'sigcore' as any,
      workspace_name: tenant.name,
      external_workspace_id: tenant.id,
    });

    // Update tenant
    tenant.businessIdentityId = business.id;
    tenant.productWorkspaceId = workspace.id;
    await this.tenantRepo.save(tenant);

    // Register phone numbers as assets
    const phoneNumbers = await this.tenantRepo.manager
      .getRepository('TenantPhoneNumber')
      .find({ where: { tenantId: tenant.id } }) as any[];

    for (const pn of phoneNumbers) {
      const { asset } = await biService.createOrResolveAsset({
        asset_type: 'phone' as any,
        value: pn.phoneNumber,
        provider: pn.provider,
        external_asset_id: pn.providerId,
      });
      await biService.linkAssetToWorkspace(asset.id, {
        workspace_id: workspace.id,
        role: 'sigcore_registered_number',
        purpose: 'general_inbox',
        is_primary: pn.isDefault,
      });
    }

    this.logger.log(`[BusinessIdentity] Registered tenant ${tenant.id} as business ${business.id}`);
  }

  /**
   * Get all tenants for a workspace
   */
  async getTenants(workspaceId: string): Promise<Tenant[]> {
    return this.tenantRepo.find({
      where: { workspaceId },
      relations: ['phoneNumbers'],
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get a tenant by ID
   */
  async getTenant(workspaceId: string, tenantId: string): Promise<Tenant> {
    const tenant = await this.tenantRepo.findOne({
      where: { workspaceId, id: tenantId },
      relations: ['phoneNumbers'],
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    return tenant;
  }

  async saveTenant(tenant: Tenant): Promise<Tenant> {
    return this.tenantRepo.save(tenant);
  }

  /**
   * Get a tenant by external ID
   */
  async getTenantByExternalId(workspaceId: string, externalId: string): Promise<Tenant | null> {
    return this.tenantRepo.findOne({
      where: { workspaceId, externalId },
      relations: ['phoneNumbers'],
    });
  }

  /**
   * Copy integrations from one tenant to another (used during re-provisioning).
   * Only copies integrations that don't already exist on the target tenant.
   */
  async copyTenantIntegrations(
    workspaceId: string,
    fromTenantId: string,
    toTenantId: string,
  ): Promise<{ copied: number }> {
    const sourceIntegrations = await this.tenantIntegrationRepo.find({
      where: { workspaceId, tenantId: fromTenantId, status: IntegrationStatus.ACTIVE },
    });

    let copied = 0;
    for (const src of sourceIntegrations) {
      const existing = await this.tenantIntegrationRepo.findOne({
        where: { workspaceId, tenantId: toTenantId, provider: src.provider },
      });
      if (!existing) {
        const newIntegration = this.tenantIntegrationRepo.create({
          workspaceId,
          tenantId: toTenantId,
          provider: src.provider,
          credentialsEncrypted: src.credentialsEncrypted,
          status: IntegrationStatus.ACTIVE,
        });
        await this.tenantIntegrationRepo.save(newIntegration);
        copied++;
        this.logger.log(`Copied ${src.provider} integration from tenant ${fromTenantId} to ${toTenantId}`);
      }
    }

    return { copied };
  }

  /**
   * Update a tenant
   */
  async updateTenant(
    workspaceId: string,
    tenantId: string,
    updates: Partial<Pick<Tenant, 'name' | 'status' | 'metadata' | 'webhookUrl' | 'webhookSecret'>>,
  ): Promise<Tenant> {
    const tenant = await this.getTenant(workspaceId, tenantId);
    Object.assign(tenant, updates);
    await this.tenantRepo.save(tenant);
    this.logger.log(`Updated tenant: ${tenant.id}`);
    return tenant;
  }

  /**
   * Configure webhook for a tenant (for receiving delivery status updates)
   */
  async configureWebhook(
    workspaceId: string,
    tenantId: string,
    webhookUrl?: string,
    webhookSecret?: string,
  ): Promise<Tenant> {
    const tenant = await this.getTenant(workspaceId, tenantId);
    tenant.webhookUrl = webhookUrl || undefined;
    tenant.webhookSecret = webhookSecret || undefined;
    await this.tenantRepo.save(tenant);
    this.logger.log(`Configured webhook for tenant: ${tenant.id}, URL: ${webhookUrl || '(cleared)'}`);
    return tenant;
  }

  /**
   * Delete a tenant
   */
  async deleteTenant(workspaceId: string, tenantId: string): Promise<void> {
    const tenant = await this.getTenant(workspaceId, tenantId);
    await this.tenantRepo.remove(tenant);
    this.logger.log(`Deleted tenant: ${tenantId}`);
  }

  /**
   * Get all available phone numbers from connected integrations
   */
  async getAvailablePhoneNumbers(workspaceId: string): Promise<AvailablePhoneNumber[]> {
    const result: AvailablePhoneNumber[] = [];

    // Get all active integrations
    const integrations = await this.integrationRepo.find({
      where: { workspaceId, status: IntegrationStatus.ACTIVE },
    });

    // Get already allocated phone numbers
    const allocatedNumbers = await this.tenantPhoneRepo.find({
      where: { workspaceId },
      relations: ['tenant'],
    });
    const allocatedMap = new Map(
      allocatedNumbers.map((an) => [
        this.normalizePhoneNumber(an.phoneNumber),
        { tenantId: an.tenantId, tenantName: an.tenant?.name || 'Unknown' },
      ]),
    );

    for (const integration of integrations) {
      try {
        const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
        const provider = this.providerRegistry.getProvider(integration.provider);

        if (provider && provider.getPhoneNumbersFromCredentials) {
          const phoneNumbers = await provider.getPhoneNumbersFromCredentials(credentials);

          for (const [id, pn] of phoneNumbers) {
            const pnObj = pn as Record<string, unknown>;
            const phoneNumber = ('number' in pnObj ? pnObj.number : pnObj.phoneNumber) as string;
            const friendlyName = ('name' in pnObj ? pnObj.name : pnObj.friendlyName) as string | null;
            const normalizedNumber = this.normalizePhoneNumber(phoneNumber);
            const allocation = allocatedMap.get(normalizedNumber);

            result.push({
              phoneNumber: normalizedNumber,
              friendlyName: friendlyName || null,
              provider: this.mapProviderType(integration.provider),
              providerId: id,
              capabilities: (pnObj.capabilities as string[]) || [],
              allocated: !!allocation,
              allocatedTo: allocation,
            });
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to get phone numbers from ${integration.provider}: ${error.message}`);
      }
    }

    return result;
  }

  /**
   * Allocate a phone number to a tenant
   */
  async allocatePhoneNumber(
    workspaceId: string,
    dto: AllocatePhoneNumberDto,
  ): Promise<TenantPhoneNumber> {
    // Verify tenant exists
    const tenant = await this.getTenant(workspaceId, dto.tenantId);

    // Normalize phone number
    const normalizedNumber = this.normalizePhoneNumber(dto.phoneNumber);

    // Check if phone number is already allocated
    const existing = await this.tenantPhoneRepo.findOne({
      where: { workspaceId, phoneNumber: normalizedNumber },
    });

    if (existing) {
      throw new ConflictException(
        `Phone number ${normalizedNumber} is already allocated to another tenant`,
      );
    }

    // If this is set as default, unset other defaults for this tenant
    if (dto.isDefault) {
      await this.tenantPhoneRepo.update(
        { tenantId: dto.tenantId, isDefault: true },
        { isDefault: false },
      );
    }

    const allocation = this.tenantPhoneRepo.create({
      workspaceId,
      tenantId: dto.tenantId,
      phoneNumber: normalizedNumber,
      friendlyName: dto.friendlyName,
      provider: dto.provider,
      providerId: dto.providerId,
      channel: dto.channel || ChannelType.SMS,
      status: PhoneNumberAllocationStatus.ACTIVE,
      isDefault: dto.isDefault || false,
      metadata: dto.metadata,
    });

    await this.tenantPhoneRepo.save(allocation);
    this.logger.log(`Allocated ${normalizedNumber} to tenant ${tenant.name}`);
    return allocation;
  }

  /**
   * Deallocate a phone number from a tenant
   */
  async deallocatePhoneNumber(workspaceId: string, allocationId: string): Promise<void> {
    const allocation = await this.tenantPhoneRepo.findOne({
      where: { workspaceId, id: allocationId },
    });

    if (!allocation) {
      throw new NotFoundException(`Phone number allocation ${allocationId} not found`);
    }

    await this.tenantPhoneRepo.remove(allocation);
    this.logger.log(`Deallocated phone number: ${allocation.phoneNumber}`);
  }

  /**
   * Get phone numbers allocated to a tenant
   */
  async getTenantPhoneNumbers(
    workspaceId: string,
    tenantId: string,
  ): Promise<TenantPhoneNumber[]> {
    // Verify tenant exists
    await this.getTenant(workspaceId, tenantId);

    return this.tenantPhoneRepo.find({
      where: { workspaceId, tenantId },
      order: { isDefault: 'DESC', createdAt: 'ASC' },
    });
  }

  /**
   * Get the default phone number for a tenant, or the first available
   */
  async getTenantDefaultPhoneNumber(
    workspaceId: string,
    tenantId: string,
  ): Promise<TenantPhoneNumber | null> {
    // First try to get the default
    let phoneNumber = await this.tenantPhoneRepo.findOne({
      where: { workspaceId, tenantId, isDefault: true, status: PhoneNumberAllocationStatus.ACTIVE },
    });

    // If no default, get the first active one
    if (!phoneNumber) {
      phoneNumber = await this.tenantPhoneRepo.findOne({
        where: { workspaceId, tenantId, status: PhoneNumberAllocationStatus.ACTIVE },
        order: { createdAt: 'ASC' },
      });
    }

    return phoneNumber;
  }

  /**
   * Find phone number allocation by phone number
   */
  async findAllocationByPhoneNumber(
    workspaceId: string,
    phoneNumber: string,
  ): Promise<TenantPhoneNumber | null> {
    const normalizedNumber = this.normalizePhoneNumber(phoneNumber);
    return this.tenantPhoneRepo.findOne({
      where: { workspaceId, phoneNumber: normalizedNumber },
      relations: ['tenant'],
    });
  }

  /**
   * Set a phone number as the default for a tenant
   */
  async setDefaultPhoneNumber(
    workspaceId: string,
    tenantId: string,
    allocationId: string,
  ): Promise<TenantPhoneNumber> {
    // Verify tenant exists
    await this.getTenant(workspaceId, tenantId);

    const allocation = await this.tenantPhoneRepo.findOne({
      where: { workspaceId, id: allocationId, tenantId },
    });

    if (!allocation) {
      throw new NotFoundException(`Phone number allocation ${allocationId} not found`);
    }

    // Unset other defaults
    await this.tenantPhoneRepo.update(
      { tenantId, isDefault: true },
      { isDefault: false },
    );

    // Set this one as default
    allocation.isDefault = true;
    await this.tenantPhoneRepo.save(allocation);

    this.logger.log(`Set ${allocation.phoneNumber} as default for tenant ${tenantId}`);
    return allocation;
  }

  /**
   * Normalize phone number to E.164 format
   */
  private normalizePhoneNumber(phone: string): string {
    if (!phone) return phone;

    let normalized = phone.replace(/[^\d+]/g, '');

    if (!normalized.startsWith('+')) {
      if (normalized.length === 10) {
        normalized = '+1' + normalized;
      } else if (normalized.length === 11 && normalized.startsWith('1')) {
        normalized = '+' + normalized;
      } else {
        normalized = '+' + normalized;
      }
    }

    return normalized;
  }

  /**
   * Map ProviderType to PhoneNumberProvider
   */
  private mapProviderType(providerType: ProviderType): PhoneNumberProvider {
    switch (providerType) {
      case ProviderType.TWILIO:
        return PhoneNumberProvider.TWILIO;
      case ProviderType.OPENPHONE:
        return PhoneNumberProvider.OPENPHONE;
      default:
        return PhoneNumberProvider.TWILIO;
    }
  }

  // ==================== TENANT INTEGRATIONS ====================

  /**
   * Connect a provider integration for a tenant (tenant provides their own credentials)
   */
  async connectTenantIntegration(
    workspaceId: string,
    tenantId: string,
    dto: ConnectTenantIntegrationDto,
  ): Promise<TenantIntegration> {
    // Verify tenant exists
    const tenant = await this.getTenant(workspaceId, tenantId);

    // Check if integration already exists for this provider
    const existing = await this.tenantIntegrationRepo.findOne({
      where: { workspaceId, tenantId, provider: dto.provider },
    });

    if (existing) {
      throw new ConflictException(
        `Tenant already has a ${dto.provider} integration. Delete it first to connect a new one.`,
      );
    }

    // Build credentials object based on provider
    let credentials: Record<string, string> = {};

    if (dto.provider === ProviderType.TWILIO) {
      if (!dto.accountSid || !dto.authToken) {
        throw new BadRequestException('Twilio integration requires accountSid and authToken');
      }
      credentials = {
        accountSid: dto.accountSid,
        authToken: dto.authToken,
      };

      // Validate Twilio credentials
      try {
        const provider = this.providerRegistry.getProvider(ProviderType.TWILIO);
        if (provider && provider.validateCredentials) {
          await provider.validateCredentials(JSON.stringify(credentials));
        }
      } catch (error) {
        throw new BadRequestException(`Invalid Twilio credentials: ${error.message}`);
      }
    } else if (dto.provider === ProviderType.OPENPHONE) {
      if (!dto.apiKey) {
        throw new BadRequestException('OpenPhone integration requires apiKey');
      }
      credentials = {
        apiKey: dto.apiKey,
      };

      // Validate OpenPhone credentials
      try {
        const provider = this.providerRegistry.getProvider(ProviderType.OPENPHONE);
        if (provider && provider.validateCredentials) {
          await provider.validateCredentials(JSON.stringify(credentials));
        }
      } catch (error) {
        throw new BadRequestException(`Invalid OpenPhone credentials: ${error.message}`);
      }
    } else {
      throw new BadRequestException(`Unsupported provider: ${dto.provider}`);
    }

    // Encrypt credentials
    const encryptedCredentials = this.encryptionService.encrypt(JSON.stringify(credentials));

    // Create integration
    const integration = this.tenantIntegrationRepo.create({
      workspaceId,
      tenantId,
      provider: dto.provider,
      credentialsEncrypted: encryptedCredentials,
      status: IntegrationStatus.ACTIVE,
      phoneNumber: dto.phoneNumber ? this.normalizePhoneNumber(dto.phoneNumber) : undefined,
      phoneNumberSid: dto.phoneNumberSid,
      friendlyName: dto.friendlyName,
    });

    await this.tenantIntegrationRepo.save(integration);
    this.logger.log(`Connected ${dto.provider} integration for tenant ${tenant.name}`);

    return integration;
  }

  /**
   * Get all integrations for a tenant
   */
  async getTenantIntegrations(
    workspaceId: string,
    tenantId: string,
  ): Promise<TenantIntegration[]> {
    // Verify tenant exists
    await this.getTenant(workspaceId, tenantId);

    return this.tenantIntegrationRepo.find({
      where: { workspaceId, tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get a specific tenant integration
   */
  async getTenantIntegration(
    workspaceId: string,
    tenantId: string,
    integrationId: string,
  ): Promise<TenantIntegration> {
    const integration = await this.tenantIntegrationRepo.findOne({
      where: { workspaceId, tenantId, id: integrationId },
    });

    if (!integration) {
      throw new NotFoundException(`Tenant integration ${integrationId} not found`);
    }

    return integration;
  }

  /**
   * Get tenant's active integration for a specific provider
   */
  async getTenantActiveIntegration(
    workspaceId: string,
    tenantId: string,
    provider?: ProviderType,
  ): Promise<TenantIntegration | null> {
    const where: any = {
      workspaceId,
      tenantId,
      status: IntegrationStatus.ACTIVE,
    };

    if (provider) {
      where.provider = provider;
    }

    return this.tenantIntegrationRepo.findOne({
      where,
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Get decrypted credentials for a tenant integration
   */
  async getTenantIntegrationCredentials(
    workspaceId: string,
    tenantId: string,
    integrationId: string,
  ): Promise<Record<string, string>> {
    const integration = await this.getTenantIntegration(workspaceId, tenantId, integrationId);
    return JSON.parse(this.encryptionService.decrypt(integration.credentialsEncrypted));
  }

  /**
   * Update tenant integration (e.g., phone number, status)
   */
  async updateTenantIntegration(
    workspaceId: string,
    tenantId: string,
    integrationId: string,
    updates: Partial<Pick<TenantIntegration, 'phoneNumber' | 'phoneNumberSid' | 'friendlyName' | 'status' | 'metadata'>>,
  ): Promise<TenantIntegration> {
    const integration = await this.getTenantIntegration(workspaceId, tenantId, integrationId);

    if (updates.phoneNumber) {
      updates.phoneNumber = this.normalizePhoneNumber(updates.phoneNumber);
    }

    Object.assign(integration, updates);
    await this.tenantIntegrationRepo.save(integration);
    this.logger.log(`Updated tenant integration ${integrationId}`);

    return integration;
  }

  /**
   * Delete a tenant integration
   */
  async deleteTenantIntegration(
    workspaceId: string,
    tenantId: string,
    integrationId: string,
  ): Promise<void> {
    const integration = await this.getTenantIntegration(workspaceId, tenantId, integrationId);
    await this.tenantIntegrationRepo.remove(integration);
    this.logger.log(`Deleted tenant integration ${integrationId}`);
  }

  // ==================== ORPHAN DETECTION ====================

  /**
   * Find orphaned tenants — tenants with no integrations and no phone numbers.
   */
  async findOrphanedTenants(workspaceId: string): Promise<Array<{
    id: string;
    externalId: string;
    name: string;
    status: string;
    createdAt: Date;
    hasIntegrations: boolean;
    hasPhoneNumbers: boolean;
  }>> {
    const tenants = await this.tenantRepo.find({
      where: { workspaceId },
      relations: ['phoneNumbers'],
      order: { createdAt: 'DESC' },
    });

    const orphans = [];
    for (const tenant of tenants) {
      const integrations = await this.tenantIntegrationRepo.find({
        where: { workspaceId, tenantId: tenant.id },
      });

      const hasIntegrations = integrations.length > 0;
      const hasPhoneNumbers = (tenant.phoneNumbers || []).length > 0;

      // A tenant is orphaned if it has no integrations AND no phone numbers
      if (!hasIntegrations && !hasPhoneNumbers) {
        orphans.push({
          id: tenant.id,
          externalId: tenant.externalId,
          name: tenant.name,
          status: tenant.status,
          createdAt: tenant.createdAt,
          hasIntegrations,
          hasPhoneNumbers,
        });
      }
    }

    this.logger.log(`Found ${orphans.length} orphaned tenants out of ${tenants.length} total`);
    return orphans;
  }

  /**
   * Delete orphaned tenants. If tenantIds provided, only delete those.
   */
  async deleteOrphanedTenants(
    workspaceId: string,
    tenantIds?: string[],
  ): Promise<{ deleted: number; skipped: number }> {
    const orphans = await this.findOrphanedTenants(workspaceId);
    const orphanIds = new Set(orphans.map(o => o.id));

    const toDelete = tenantIds
      ? tenantIds.filter(id => orphanIds.has(id))
      : Array.from(orphanIds);

    const skipped = tenantIds ? tenantIds.length - toDelete.length : 0;

    if (toDelete.length > 0) {
      await this.tenantRepo.delete({ workspaceId, id: In(toDelete) });
      this.logger.log(`Deleted ${toDelete.length} orphaned tenants`);
    }

    return { deleted: toDelete.length, skipped };
  }
}
