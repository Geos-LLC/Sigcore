import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  CommunicationIntegration,
  ProviderType,
  IntegrationStatus,
} from '../../database/entities/communication-integration.entity';
import { TenantIntegration } from '../../database/entities/tenant-integration.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { ContactIdentity } from '../../database/entities/contact-identity.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { OpenPhoneProvider } from '../communication/providers/openphone.provider';
import { TwilioProvider } from '../communication/providers/twilio.provider';
import { TwilioVoiceService } from '../communication/twilio-voice.service';
import { SetupIntegrationDto, SetupTwilioIntegrationDto, UpdateTwilioPhoneNumberDto } from './dto';

export interface IntegrationInfo {
  id: string;
  provider: ProviderType;
  status: IntegrationStatus;
  externalWorkspaceId?: string;
  webhookUrl: string;
  hasWebhookSecret: boolean;
  webhooksRegistered: boolean;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface TwilioPhoneNumberInfo {
  sid: string;
  phoneNumber: string;
  friendlyName?: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
  // A2P 10DLC compliance status
  a2pCompliance?: {
    isRegistered: boolean;
    campaignStatus?: string;
    messagingServiceSid?: string;
  };
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    @InjectRepository(CommunicationIntegration)
    private integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(TenantIntegration)
    private tenantIntegrationRepo: Repository<TenantIntegration>,
    @InjectRepository(Workspace)
    private workspaceRepo: Repository<Workspace>,
    @InjectRepository(ContactIdentity)
    private contactIdentityRepo: Repository<ContactIdentity>,
    private encryptionService: EncryptionService,
    private openPhoneProvider: OpenPhoneProvider,
    private twilioProvider: TwilioProvider,
    private twilioVoiceService: TwilioVoiceService,
    private configService: ConfigService,
  ) {}

  /**
   * Find or create a workspace record. Since the auth guard already validates
   * the service key, we trust the workspaceId and auto-create the reference
   * record when it doesn't exist (first time a workspace uses Sigcore).
   */
  private async ensureWorkspace(workspaceId: string): Promise<Workspace> {
    let workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
    });

    if (!workspace) {
      this.logger.log(`Auto-creating workspace record for ${workspaceId}`);
      workspace = this.workspaceRepo.create({
        id: workspaceId,
        name: `Workspace ${workspaceId.substring(0, 8)}`,
        webhookId: crypto.randomBytes(16).toString('hex'),
      });
      await this.workspaceRepo.save(workspace);
    }

    return workspace;
  }

  /**
   * Resolve the base URL for webhook registration.
   * Checks multiple sources: ConfigService, process.env, Railway auto-injected domain.
   */
  private getBaseUrl(): string {
    return (
      this.configService.get('BASE_URL') ||
      process.env.BASE_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
      'http://localhost:3002'
    );
  }

  /**
   * Get integration by provider type. If no provider specified, returns the first active integration.
   */
  async getIntegration(workspaceId: string, provider?: ProviderType): Promise<IntegrationInfo | null> {
    const whereClause: { workspaceId: string; provider?: ProviderType } = { workspaceId };
    if (provider) {
      whereClause.provider = provider;
    }

    const integration = await this.integrationRepo.findOne({
      where: whereClause,
    });

    if (!integration) {
      return null;
    }

    return this.mapIntegrationToInfo(integration);
  }

  /**
   * Get all integrations for a workspace.
   */
  async getIntegrations(workspaceId: string): Promise<IntegrationInfo[]> {
    const integrations = await this.integrationRepo.find({
      where: { workspaceId },
    });

    return Promise.all(integrations.map((i) => this.mapIntegrationToInfo(i)));
  }

  private async mapIntegrationToInfo(integration: CommunicationIntegration): Promise<IntegrationInfo> {
    const workspace = await this.workspaceRepo.findOne({
      where: { id: integration.workspaceId },
    });

    const baseUrl = this.getBaseUrl();
    const metadata = integration.metadata || {};

    // Determine webhook URL based on provider
    let webhookUrl: string;
    let webhooksRegistered: boolean;

    if (integration.provider === ProviderType.TWILIO) {
      webhookUrl = `${baseUrl}/api/webhooks/twilio/sms/${workspace?.webhookId}`;
      webhooksRegistered = !!(metadata.smsWebhookConfigured || metadata.voiceWebhookConfigured);
    } else {
      webhookUrl = `${baseUrl}/api/webhooks/openphone/${workspace?.webhookId}`;
      webhooksRegistered = !!(metadata.messageWebhookId || metadata.callWebhookId);
    }

    return {
      id: integration.id,
      provider: integration.provider,
      status: integration.status,
      externalWorkspaceId: integration.externalWorkspaceId,
      webhookUrl,
      hasWebhookSecret: !!integration.webhookSecretEncrypted,
      webhooksRegistered,
      createdAt: integration.createdAt,
      metadata: {
        phoneNumber: metadata.phoneNumber,
        phoneNumberSid: metadata.phoneNumberSid,
        friendlyName: metadata.friendlyName,
      },
    };
  }

  /**
   * Setup OpenPhone integration.
   */
  async setupIntegration(
    workspaceId: string,
    dto: SetupIntegrationDto,
  ): Promise<IntegrationInfo> {
    // Validate API key
    const credentials = JSON.stringify({ apiKey: dto.apiKey });
    const isValid = await this.openPhoneProvider.validateCredentials(credentials);

    if (!isValid) {
      throw new BadRequestException('Invalid OpenPhone API key');
    }

    const encryptedCredentials = this.encryptionService.encrypt(credentials);

    // Get or create workspace to construct webhook URL
    const workspace = await this.ensureWorkspace(workspaceId);

    const baseUrl = this.getBaseUrl();
    const webhookUrl = `${baseUrl}/api/webhooks/openphone/${workspace.webhookId}`;
    this.logger.log(`Webhook URL for workspace ${workspaceId}: ${webhookUrl} (BASE_URL config=${this.configService.get('BASE_URL')}, env=${process.env.BASE_URL}, railway=${process.env.RAILWAY_PUBLIC_DOMAIN})`);

    let integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: dto.provider },
    });

    // Delete old webhooks if updating an existing integration
    if (integration?.metadata) {
      const oldMetadata = integration.metadata as { messageWebhookId?: string; callWebhookId?: string };
      if (oldMetadata.messageWebhookId || oldMetadata.callWebhookId) {
        this.logger.log('Deleting old webhooks before re-registering...');
        await this.openPhoneProvider.deleteWebhooks(credentials, {
          messageWebhookId: oldMetadata.messageWebhookId,
          callWebhookId: oldMetadata.callWebhookId,
        });
      }
    }

    // Register webhooks with OpenPhone
    this.logger.log(`Registering webhooks for workspace ${workspaceId}...`);
    const webhookResult = await this.openPhoneProvider.registerWebhooks(credentials, webhookUrl);

    let encryptedWebhookSecret: string | null = null;
    if (webhookResult.webhookKey) {
      // Use the webhook key from OpenPhone for signature verification
      encryptedWebhookSecret = this.encryptionService.encrypt(webhookResult.webhookKey);
      this.logger.log('Stored webhook secret from OpenPhone');
    } else if (dto.webhookSecret) {
      // Fall back to manually provided webhook secret
      encryptedWebhookSecret = this.encryptionService.encrypt(dto.webhookSecret);
    }

    // Build metadata with webhook IDs
    const metadata = {
      messageWebhookId: webhookResult.messageWebhookId,
      callWebhookId: webhookResult.callWebhookId,
      webhooksRegisteredAt: new Date().toISOString(),
    };

    if (integration) {
      integration.credentialsEncrypted = encryptedCredentials;
      integration.webhookSecretEncrypted = encryptedWebhookSecret ?? undefined;
      integration.externalWorkspaceId = dto.externalWorkspaceId;
      integration.status = IntegrationStatus.ACTIVE;
      integration.metadata = metadata;
    } else {
      integration = this.integrationRepo.create({
        workspaceId,
        provider: dto.provider,
        credentialsEncrypted: encryptedCredentials,
        webhookSecretEncrypted: encryptedWebhookSecret ?? undefined,
        externalWorkspaceId: dto.externalWorkspaceId,
        status: IntegrationStatus.ACTIVE,
        metadata,
      });
    }

    await this.integrationRepo.save(integration);

    if (webhookResult.success) {
      this.logger.log(`Webhooks registered successfully for workspace ${workspaceId}`);
    } else {
      this.logger.warn(`Webhook registration failed: ${webhookResult.error}. Manual registration required.`);
    }

    return this.getIntegration(workspaceId, dto.provider) as Promise<IntegrationInfo>;
  }

  /**
   * Setup Twilio integration.
   */
  async setupTwilioIntegration(
    workspaceId: string,
    dto: SetupTwilioIntegrationDto,
  ): Promise<IntegrationInfo> {
    // Validate Twilio credentials
    const credentials = JSON.stringify({
      accountSid: dto.accountSid,
      authToken: dto.authToken,
      phoneNumber: dto.phoneNumber,
      phoneNumberSid: dto.phoneNumberSid,
    });

    const isValid = await this.twilioProvider.validateCredentials(credentials);

    if (!isValid) {
      throw new BadRequestException('Invalid Twilio credentials');
    }

    // Get or create workspace to construct webhook URL
    const workspace = await this.ensureWorkspace(workspaceId);

    const baseUrl = this.getBaseUrl();
    const smsWebhookUrl = `${baseUrl}/api/webhooks/twilio/sms/${workspace.webhookId}`;
    const voiceWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspace.webhookId}`;

    // Automatically create API Key for Voice SDK
    this.logger.log('Creating Twilio API Key for Voice SDK...');
    const apiKeyResult = await this.twilioProvider.createApiKey(
      credentials,
      `Callio Voice - ${workspace.name || workspaceId}`,
    );

    if (!apiKeyResult.success) {
      this.logger.warn(`Failed to create API Key: ${apiKeyResult.error}`);
    }

    // Automatically create TwiML App for Voice
    this.logger.log('Creating TwiML App for Voice SDK...');
    const twimlAppResult = await this.twilioProvider.createTwiMLApp(
      credentials,
      `Callio Voice - ${workspace.name || workspaceId}`,
      voiceWebhookUrl,
    );

    if (!twimlAppResult.success) {
      this.logger.warn(`Failed to create TwiML App: ${twimlAppResult.error}`);
    }

    let integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO },
    });

    // Configure webhooks on Twilio phone number if provided
    let webhooksConfigured = false;
    if (dto.phoneNumberSid) {
      const webhookResult = await this.twilioProvider.configureWebhooks(
        credentials,
        dto.phoneNumberSid,
        smsWebhookUrl,
        voiceWebhookUrl,
      );
      webhooksConfigured = webhookResult.success;
      if (!webhookResult.success) {
        this.logger.warn(`Failed to configure Twilio webhooks: ${webhookResult.error}`);
      }
    }

    // Build metadata with voice credentials
    const metadata: any = {
      phoneNumber: dto.phoneNumber,
      phoneNumberSid: dto.phoneNumberSid,
      friendlyName: dto.friendlyName,
      smsWebhookUrl,
      voiceWebhookUrl,
      smsWebhookConfigured: webhooksConfigured,
      voiceWebhookConfigured: webhooksConfigured,
      webhooksConfiguredAt: webhooksConfigured ? new Date().toISOString() : undefined,
    };

    // Add voice SDK credentials if created successfully
    if (apiKeyResult.success && apiKeyResult.apiKey) {
      metadata.voiceApiKeySid = apiKeyResult.apiKey.sid;
      // Store the secret encrypted in credentials
      this.logger.log('Voice API Key created successfully');
    }

    if (twimlAppResult.success && twimlAppResult.twimlApp) {
      metadata.voiceTwimlAppSid = twimlAppResult.twimlApp.sid;
      this.logger.log('TwiML App created successfully');
    }

    // Update credentials to include voice API credentials
    const updatedCredentials = JSON.parse(credentials);
    if (apiKeyResult.success && apiKeyResult.apiKey) {
      updatedCredentials.voiceApiKey = apiKeyResult.apiKey.sid;
      updatedCredentials.voiceApiSecret = apiKeyResult.apiKey.secret;
    }
    if (twimlAppResult.success && twimlAppResult.twimlApp) {
      updatedCredentials.voiceTwimlAppSid = twimlAppResult.twimlApp.sid;
    }

    const encryptedCredentials = this.encryptionService.encrypt(JSON.stringify(updatedCredentials));

    // Store auth token encrypted as webhook secret for signature verification
    const encryptedAuthToken = this.encryptionService.encrypt(dto.authToken);

    if (integration) {
      integration.credentialsEncrypted = encryptedCredentials;
      integration.webhookSecretEncrypted = encryptedAuthToken;
      integration.status = IntegrationStatus.ACTIVE;
      integration.metadata = metadata;
    } else {
      integration = this.integrationRepo.create({
        workspaceId,
        provider: ProviderType.TWILIO,
        credentialsEncrypted: encryptedCredentials,
        webhookSecretEncrypted: encryptedAuthToken,
        status: IntegrationStatus.ACTIVE,
        metadata,
      });
    }

    await this.integrationRepo.save(integration);

    this.logger.log(`Twilio integration saved for workspace ${workspaceId} with Voice SDK support`);

    return this.getIntegration(workspaceId, ProviderType.TWILIO) as Promise<IntegrationInfo>;
  }

  /**
   * Get phone numbers from Twilio account.
   */
  async getTwilioPhoneNumbers(workspaceId: string): Promise<TwilioPhoneNumberInfo[]> {
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO },
    });

    if (!integration) {
      throw new NotFoundException('Twilio integration not found');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    return this.twilioProvider.getPhoneNumbersArray(credentials);
  }

  /**
   * Get OpenPhone phone numbers for a workspace.
   */
  async getOpenPhoneNumbers(workspaceId: string): Promise<Array<{ id: string; number: string; name?: string; capabilities?: { sms: boolean; voice: boolean; mms: boolean } }>> {
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.OPENPHONE },
    });

    if (!integration) {
      throw new NotFoundException('OpenPhone integration not found');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const phoneNumberMap = await this.openPhoneProvider.getPhoneNumbersFromCredentials(credentials);

    return Array.from(phoneNumberMap.values()).map((pn) => ({
      id: pn.id,
      number: pn.number,
      name: pn.name,
      symbol: pn.symbol || null,
      capabilities: pn.capabilities,
    }));
  }

  async getOpenPhoneConversations(
    workspaceId: string,
    days: number = 1,
    phoneNumberId?: string,
    includeMessages: boolean = false,
    messageLimit: number = 50,
    tenantId?: string | null,
    skipContactLookup: boolean = false,
  ): Promise<any> {
    // Try tenant-scoped integration first, fall back to workspace-scoped
    let integration = null;
    if (tenantId) {
      integration = await this.tenantIntegrationRepo.findOne({
        where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
      });
    }
    if (!integration) {
      integration = await this.integrationRepo.findOne({
        where: { workspaceId, provider: ProviderType.OPENPHONE },
      });
    }

    if (!integration) {
      throw new NotFoundException('OpenPhone integration not found');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    const conversations = await this.openPhoneProvider.getRecentConversations(credentials, days, phoneNumberId);

    // Contact name lookup (skip when caller already has names or wants speed)
    let contactNames = new Map<string, string>();
    if (!skipContactLookup) {
      const numbersNeedingLookup = conversations
        .filter(c => c.participantPhone && !c.conversationName)
        .map(c => c.participantPhone);

      this.logger.log(`${conversations.length} conversations, ${numbersNeedingLookup.length} need contact name lookup`);

      if (numbersNeedingLookup.length > 0) {
        contactNames = await this.openPhoneProvider.lookupContactNamesByPhone(
          credentials,
          numbersNeedingLookup,
        );
      }
    } else {
      this.logger.log(`${conversations.length} conversations (contact lookup skipped)`);
    }

    // Enrich: use conversationName first, then contact lookup, then null
    const enriched: any[] = conversations.map(conv => {
      const contactName = conv.conversationName || contactNames.get(conv.participantPhone) || null;
      return { ...conv, contactName };
    });

    // If includeMessages requested, fetch messages + calls for each conversation in parallel batches
    if (includeMessages) {
      const BATCH_SIZE = 5;
      this.logger.log(`Fetching messages+calls for ${enriched.length} conversations (batch-of-${BATCH_SIZE}, limit ${messageLimit})`);

      for (let i = 0; i < enriched.length; i += BATCH_SIZE) {
        const batch = enriched.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (conv) => {
            if (!conv.participantPhone || !conv.phoneNumberId) return { messages: [], calls: [] };
            const [msgs, calls] = await Promise.all([
              this.openPhoneProvider.getMessages(
                credentials, 'live', conv.phoneNumberId, conv.participantPhone,
              ).catch(e => { this.logger.warn(`Messages error for ${conv.participantPhone}: ${e.message}`); return []; }),
              this.openPhoneProvider.getCallsForParticipant(
                credentials, conv.participantPhone, conv.phoneNumberId,
              ).catch(e => { this.logger.warn(`Calls error for ${conv.participantPhone}: ${e.message}`); return []; }),
            ]);

            // Enrich calls with recordings + transcripts (parallel, batch-of-3)
            for (let ci = 0; ci < calls.length; ci += 3) {
              const callBatch = calls.slice(ci, ci + 3);
              await Promise.allSettled(
                callBatch.map(async (call) => {
                  if (!call.providerCallId) return;
                  try {
                    const [recordings, transcriptResult] = await Promise.all([
                      this.openPhoneProvider.getCallRecordings(credentials, call.providerCallId)
                        .catch(() => ({ recordingUrl: null, voicemailUrl: null })),
                      this.openPhoneProvider.getCallTranscript(credentials, call.providerCallId)
                        .catch(() => null),
                    ]);
                    (call as any).recordingUrl = recordings.recordingUrl || call.recordingUrl;
                    (call as any).voicemailUrl = recordings.voicemailUrl || call.voicemailUrl;
                    (call as any).transcription = transcriptResult?.transcript || null;
                  } catch (e) { /* non-fatal */ }
                }),
              );
            }

            return { messages: msgs.slice(0, messageLimit), calls };
          }),
        );
        results.forEach((result, idx) => {
          const data = result.status === 'fulfilled' ? result.value : { messages: [], calls: [] };
          batch[idx].messages = data.messages;
          batch[idx].calls = data.calls;
        });
      }

      const totalMsgs = enriched.reduce((sum, c) => sum + (c.messages?.length || 0), 0);
      const totalCalls = enriched.reduce((sum, c) => sum + (c.calls?.length || 0), 0);
      this.logger.log(`Fetched ${totalMsgs} messages + ${totalCalls} calls across ${enriched.length} conversations`);
    }

    return enriched;
  }

  /**
   * Full sync: fetch ALL conversations from OpenPhone, parallel per phone number.
   * Uses the paginated getConversations() which fetches all pages sequentially per number,
   * but runs all phone numbers in parallel.
   */
  async getAllOpenPhoneConversations(
    workspaceId: string,
    includeMessages: boolean = false,
    messageLimit: number = 50,
    tenantId?: string | null,
  ): Promise<any[]> {
    // Resolve credentials
    let integration = null;
    if (tenantId) {
      integration = await this.tenantIntegrationRepo.findOne({
        where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
      });
    }
    if (!integration) {
      integration = await this.integrationRepo.findOne({
        where: { workspaceId, provider: ProviderType.OPENPHONE },
      });
    }
    if (!integration) {
      throw new NotFoundException('OpenPhone integration not found');
    }
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    // Get all phone numbers
    const phoneNumberMap = await this.openPhoneProvider.getPhoneNumbersFromCredentials(credentials);
    const phoneIds = Array.from(phoneNumberMap.keys());
    this.logger.log(`Full sync: fetching ALL conversations for ${phoneIds.length} phone numbers in parallel`);

    // Fetch conversations for all phone numbers in parallel
    const results = await Promise.allSettled(
      phoneIds.map(pnId =>
        this.openPhoneProvider.getConversations(credentials, undefined, pnId)
          .catch(e => { this.logger.warn(`Failed to fetch conversations for ${pnId}: ${e.message}`); return []; })
      ),
    );

    // Merge all conversations
    let allConvs: any[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        for (const conv of result.value) {
          const meta = conv.metadata as Record<string, unknown> || {};
          const phoneInfo = phoneNumberMap.get(meta.phoneNumberId as string);
          allConvs.push({
            participantPhone: conv.participantPhoneNumber,
            phoneNumberId: conv.metadata?.phoneNumberId,
            phoneNumber: conv.phoneNumber || phoneInfo?.number || '',
            phoneNumberName: phoneInfo?.name || '',
            lastMessageAt: conv.lastMessageAt,
            conversationName: conv.metadata?.conversationName,
            contactName: null, // Will be enriched below
            externalId: conv.externalId,
          });
        }
      }
    }

    // Deduplicate by participant+endpoint
    const seen = new Set<string>();
    allConvs = allConvs.filter(c => {
      const key = `${c.phoneNumber}:${c.participantPhone}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    this.logger.log(`Full sync: ${allConvs.length} unique conversations across ${phoneIds.length} phone numbers`);

    // Enrich with contact names (batch lookup from contacts)
    const numbersToLookup = allConvs
      .filter(c => c.participantPhone && !c.conversationName)
      .map(c => c.participantPhone);

    if (numbersToLookup.length > 0) {
      try {
        const contactNames = await this.openPhoneProvider.lookupContactNamesByPhone(credentials, numbersToLookup);
        for (const conv of allConvs) {
          const name = conv.conversationName || contactNames.get(conv.participantPhone) || null;
          conv.contactName = name;
        }
        this.logger.log(`Full sync: enriched ${contactNames.size} contact names`);
      } catch (e) {
        this.logger.warn(`Full sync: contact name lookup failed: ${e.message}`);
      }
    }

    // Sort by most recent first
    allConvs.sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });

    // Include messages + calls if requested (parallel batch-of-5)
    if (includeMessages) {
      const BATCH_SIZE = 5;
      this.logger.log(`Full sync: fetching messages+calls for ${allConvs.length} conversations (batch-of-${BATCH_SIZE})`);

      for (let i = 0; i < allConvs.length; i += BATCH_SIZE) {
        const batch = allConvs.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(async (conv) => {
            if (!conv.participantPhone || !conv.phoneNumberId) return { messages: [], calls: [] };
            const [msgs, calls] = await Promise.all([
              this.openPhoneProvider.getMessages(credentials, 'live', conv.phoneNumberId, conv.participantPhone)
                .catch(() => []),
              this.openPhoneProvider.getCallsForParticipant(credentials, conv.participantPhone, conv.phoneNumberId)
                .catch(() => []),
            ]);
            return { messages: msgs.slice(0, messageLimit), calls };
          }),
        );
        batchResults.forEach((result, idx) => {
          const data = result.status === 'fulfilled' ? result.value : { messages: [], calls: [] };
          batch[idx].messages = data.messages;
          batch[idx].calls = data.calls;
        });
      }

      const totalMsgs = allConvs.reduce((sum, c) => sum + (c.messages?.length || 0), 0);
      const totalCalls = allConvs.reduce((sum, c) => sum + (c.calls?.length || 0), 0);
      this.logger.log(`Full sync: ${totalMsgs} messages + ${totalCalls} calls`);
    }

    return allConvs;
  }

  /**
   * Get messages for a specific conversation from OpenPhone (live from API)
   */
  async getOpenPhoneMessages(workspaceId: string, phoneNumberId: string, participant: string, tenantId?: string | null): Promise<any[]> {
    // Try tenant-scoped integration first, fall back to workspace-scoped
    let integration = null;
    if (tenantId) {
      integration = await this.tenantIntegrationRepo.findOne({
        where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
      });
    }
    if (!integration) {
      integration = await this.integrationRepo.findOne({
        where: { workspaceId, provider: ProviderType.OPENPHONE },
      });
    }
    if (!integration) {
      throw new NotFoundException('OpenPhone integration not found');
    }
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const messages = await this.openPhoneProvider.getMessages(credentials, 'live', phoneNumberId, participant);
    return messages;
  }

  /**
   * Bulk lookup contact names by phone numbers using Sigcore's stored contact_identities.
   * Fast DB query — no OpenPhone API pagination needed.
   */
  async lookupContactNamesByPhone(
    workspaceId: string,
    phoneNumbers: string[],
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    if (!phoneNumbers.length) return result;

    // Normalize to last 10 digits for matching
    const normalize = (ph: string) => ph.replace(/\D/g, '').slice(-10);
    const normalizedMap = new Map<string, string>(); // normalized → original
    for (const ph of phoneNumbers) {
      normalizedMap.set(normalize(ph), ph);
    }

    // Query contact_identities by workspace + channel=sms + identity LIKE patterns
    try {
      const identities = await this.contactIdentityRepo
        .createQueryBuilder('ci')
        .where('ci.workspaceId = :workspaceId', { workspaceId })
        .andWhere('ci.display IS NOT NULL')
        .getMany();

      for (const ci of identities) {
        const normalized = normalize(ci.identity);
        const original = normalizedMap.get(normalized);
        if (original && ci.display) {
          result[original] = ci.display;
        }
      }
      this.logger.log(`Contact identity lookup: ${Object.keys(result).length} names from ${identities.length} identities for ${phoneNumbers.length} phones`);
    } catch (e) {
      this.logger.warn(`Contact identity lookup failed: ${e.message}`);
    }

    // Fallback: for phones not found in contact_identities, try OpenPhone live lookup
    const missing = phoneNumbers.filter(ph => !result[ph]);
    if (missing.length > 0) {
      try {
        const integration = await this.integrationRepo.findOne({
          where: { workspaceId, provider: ProviderType.OPENPHONE },
        });
        if (integration) {
          const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
          const liveNames = await this.openPhoneProvider.lookupContactNamesByPhone(credentials, missing);
          for (const [phone, name] of liveNames) {
            result[phone] = name;
          }
          this.logger.log(`OpenPhone live lookup: ${liveNames.size} additional names for ${missing.length} phones`);
        }
      } catch (e) {
        this.logger.warn(`OpenPhone live lookup failed: ${e.message}`);
      }
    }

    return result;
  }

  /**
   * Update Twilio phone number configuration.
   */
  async updateTwilioPhoneNumber(
    workspaceId: string,
    dto: UpdateTwilioPhoneNumberDto,
  ): Promise<IntegrationInfo> {
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO },
    });

    if (!integration) {
      throw new NotFoundException('Twilio integration not found');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const parsedCredentials = JSON.parse(credentials);

    // Update credentials with new phone number
    parsedCredentials.phoneNumber = dto.phoneNumber;
    parsedCredentials.phoneNumberSid = dto.phoneNumberSid;

    const newCredentials = JSON.stringify(parsedCredentials);
    integration.credentialsEncrypted = this.encryptionService.encrypt(newCredentials);

    // Update metadata
    const metadata = integration.metadata as Record<string, unknown> || {};
    metadata.phoneNumber = dto.phoneNumber;
    metadata.phoneNumberSid = dto.phoneNumberSid;

    // Configure webhooks on the new phone number
    const workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
    });

    if (workspace && dto.phoneNumberSid) {
      const baseUrl = this.getBaseUrl();
      const smsWebhookUrl = `${baseUrl}/api/webhooks/twilio/sms/${workspace.webhookId}`;
      const voiceWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspace.webhookId}`;

      const webhookResult = await this.twilioProvider.configureWebhooks(
        newCredentials,
        dto.phoneNumberSid,
        smsWebhookUrl,
        voiceWebhookUrl,
      );

      metadata.smsWebhookConfigured = webhookResult.success;
      metadata.voiceWebhookConfigured = webhookResult.success;
      if (webhookResult.success) {
        metadata.webhooksConfiguredAt = new Date().toISOString();
      }
    }

    integration.metadata = metadata;
    await this.integrationRepo.save(integration);

    return this.getIntegration(workspaceId, ProviderType.TWILIO) as Promise<IntegrationInfo>;
  }

  /**
   * Delete integration by provider.
   * Returns a result object instead of throwing on not-found,
   * so callers (like Callio) always get a JSON response.
   */
  async deleteIntegration(workspaceId: string, provider?: ProviderType): Promise<{ success: boolean; error?: string }> {
    const whereClause: { workspaceId: string; provider?: ProviderType } = { workspaceId };
    if (provider) {
      whereClause.provider = provider;
    }

    const integration = await this.integrationRepo.findOne({
      where: whereClause,
    });

    if (!integration) {
      this.logger.log(`No integration found for workspace ${workspaceId} (provider=${provider || 'any'}) — nothing to delete`);
      return { success: true }; // Idempotent: already deleted is still success
    }

    // Delete webhooks based on provider
    if (integration.provider === ProviderType.OPENPHONE && integration.metadata) {
      const metadata = integration.metadata as { messageWebhookId?: string; callWebhookId?: string };
      if (metadata.messageWebhookId || metadata.callWebhookId) {
        try {
          const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
          await this.openPhoneProvider.deleteWebhooks(credentials, {
            messageWebhookId: metadata.messageWebhookId,
            callWebhookId: metadata.callWebhookId,
          });
          this.logger.log(`Deleted OpenPhone webhooks for workspace ${workspaceId}`);
        } catch (error) {
          this.logger.warn(`Failed to delete OpenPhone webhooks for workspace ${workspaceId}`, error);
        }
      }
    }
    // Note: For Twilio, webhooks are configured on the phone number and will remain until the number is released

    await this.integrationRepo.remove(integration);
    this.logger.log(`Deleted ${integration.provider} integration for workspace ${workspaceId}`);
    return { success: true };
  }

  async getWebhookSecret(workspaceId: string, provider?: ProviderType): Promise<string | null> {
    const whereClause: { workspaceId: string; provider?: ProviderType } = { workspaceId };
    if (provider) {
      whereClause.provider = provider;
    }

    const integration = await this.integrationRepo.findOne({
      where: whereClause,
    });

    if (!integration?.webhookSecretEncrypted) {
      return null;
    }

    return this.encryptionService.decrypt(integration.webhookSecretEncrypted);
  }

  async getDecryptedCredentials(workspaceId: string, provider?: ProviderType): Promise<Record<string, unknown> | null> {
    const whereClause: { workspaceId: string; provider?: ProviderType } = { workspaceId };
    if (provider) {
      whereClause.provider = provider;
    }

    const integration = await this.integrationRepo.findOne({
      where: whereClause,
    });

    if (!integration) {
      return null;
    }

    const decrypted = this.encryptionService.decrypt(integration.credentialsEncrypted);
    return JSON.parse(decrypted);
  }

  // ==================== TWILIO VOICE ====================

  async generateTwilioVoiceToken(workspaceId: string): Promise<string> {
    this.logger.log(`========== GENERATE VOICE TOKEN START ==========`);
    this.logger.log(`Workspace ID: ${workspaceId}`);

    const workspace = await this.ensureWorkspace(workspaceId);
    this.logger.log(`Found workspace: ${workspace.name}`);

    // Get Twilio integration with voice credentials
    const integration = await this.integrationRepo.findOne({
      where: {
        workspaceId,
        provider: ProviderType.TWILIO,
        status: IntegrationStatus.ACTIVE,
      },
    });

    if (!integration) {
      this.logger.error(`Twilio integration not found for workspace ${workspaceId}`);
      throw new NotFoundException('Twilio integration not found');
    }

    this.logger.log(`Found Twilio integration: ${integration.id}, status: ${integration.status}`);

    // Decrypt and parse credentials
    const decrypted = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const credentials = JSON.parse(decrypted);

    this.logger.log(`Credentials decrypted. Checking voice credentials...`);
    this.logger.log(`- Has voiceApiKey: ${!!credentials.voiceApiKey}`);
    this.logger.log(`- Has voiceApiSecret: ${!!credentials.voiceApiSecret}`);
    this.logger.log(`- Has voiceTwimlAppSid: ${!!credentials.voiceTwimlAppSid}`);
    this.logger.log(`- Account SID: ${credentials.accountSid?.substring(0, 10)}...`);

    if (!credentials.voiceApiKey || !credentials.voiceApiSecret || !credentials.voiceTwimlAppSid) {
      this.logger.error('Voice credentials missing!');
      throw new BadRequestException('Twilio Voice credentials not configured. Please reconnect your Twilio account.');
    }

    // Use workspace ID as identity for the voice client
    const identity = workspace.id;

    this.logger.log(`Generating access token for identity: ${identity}`);
    const token = this.twilioVoiceService.generateAccessToken(
      identity,
      credentials.accountSid,
      credentials.voiceApiKey,
      credentials.voiceApiSecret,
      credentials.voiceTwimlAppSid,
    );

    this.logger.log(`Token generated successfully (length: ${token.length} chars)`);
    this.logger.log(`========== GENERATE VOICE TOKEN END ==========`);

    return token;
  }

  async generateOutgoingCallTwiML(
    workspaceId: string,
    to: string,
    from: string,
    callerId?: string,
  ): Promise<string> {
    return this.twilioVoiceService.generateOutgoingCallTwiML(to, from, callerId);
  }

  async getTwilioVoiceConfig(workspaceId: string): Promise<{
    twimlAppSid: string;
    currentWebhookUrl: string;
    expectedWebhookUrl: string;
    isConfigured: boolean;
  }> {
    this.logger.log(`========== GET VOICE CONFIG START ==========`);
    this.logger.log(`Workspace ID: ${workspaceId}`);

    const workspace = await this.ensureWorkspace(workspaceId);

    const integration = await this.integrationRepo.findOne({
      where: {
        workspaceId,
        provider: ProviderType.TWILIO,
        status: IntegrationStatus.ACTIVE,
      },
    });

    if (!integration) {
      throw new NotFoundException('Twilio integration not found');
    }

    const decrypted = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const credentials = JSON.parse(decrypted);

    const baseUrl = this.getBaseUrl();
    const expectedWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspace.webhookId}`;

    // Get current webhook URL from Twilio
    let currentWebhookUrl = '';
    let isConfigured = false;

    try {
      const result = await this.twilioProvider.getTwiMLAppConfig(
        JSON.stringify(credentials),
        credentials.voiceTwimlAppSid,
      );

      if (result.success && result.config) {
        currentWebhookUrl = result.config.voiceUrl;
        isConfigured = currentWebhookUrl === expectedWebhookUrl;
      }
    } catch (error) {
      this.logger.error('Failed to get TwiML App config from Twilio', error);
    }

    this.logger.log(`TwiML App SID: ${credentials.voiceTwimlAppSid}`);
    this.logger.log(`Current webhook URL: ${currentWebhookUrl}`);
    this.logger.log(`Expected webhook URL: ${expectedWebhookUrl}`);
    this.logger.log(`Is configured correctly: ${isConfigured}`);
    this.logger.log(`========== GET VOICE CONFIG END ==========`);

    return {
      twimlAppSid: credentials.voiceTwimlAppSid,
      currentWebhookUrl,
      expectedWebhookUrl,
      isConfigured,
    };
  }

  // ==================== TENANT-SCOPED OPENPHONE METHODS ====================

  /**
   * Connect (or update) an OpenPhone integration for a specific tenant.
   * Validates the API key, then upserts a TenantIntegration record.
   */
  async connectOpenPhoneForTenant(
    workspaceId: string,
    tenantId: string,
    apiKey: string,
  ): Promise<TenantIntegration> {
    const credentials = JSON.stringify({ apiKey });
    const isValid = await this.openPhoneProvider.validateCredentials(credentials);
    if (!isValid) {
      throw new BadRequestException('Invalid OpenPhone API key');
    }

    const encryptedCredentials = this.encryptionService.encrypt(credentials);

    let integration = await this.tenantIntegrationRepo.findOne({
      where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
    });

    if (integration) {
      integration.credentialsEncrypted = encryptedCredentials;
      integration.status = IntegrationStatus.ACTIVE;
    } else {
      integration = this.tenantIntegrationRepo.create({
        workspaceId,
        tenantId,
        provider: ProviderType.OPENPHONE,
        credentialsEncrypted: encryptedCredentials,
        status: IntegrationStatus.ACTIVE,
      });
    }

    await this.tenantIntegrationRepo.save(integration);
    this.logger.log(`Connected OpenPhone for tenant ${tenantId} in workspace ${workspaceId}`);
    return integration;
  }

  /**
   * Get OpenPhone phone numbers for a specific tenant.
   */
  async getOpenPhoneNumbersForTenant(
    workspaceId: string,
    tenantId: string,
  ): Promise<Array<{ id: string; number: string; name?: string; capabilities?: { sms: boolean; voice: boolean; mms: boolean } }>> {
    const integration = await this.tenantIntegrationRepo.findOne({
      where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
    });

    if (!integration) {
      throw new NotFoundException('OpenPhone integration not found for this tenant');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const phoneNumberMap = await this.openPhoneProvider.getPhoneNumbersFromCredentials(credentials);

    return Array.from(phoneNumberMap.values()).map((pn) => ({
      id: pn.id,
      number: pn.number,
      name: pn.name,
      symbol: pn.symbol || null,
      capabilities: pn.capabilities,
    }));
  }

  /**
   * Disconnect (delete) the OpenPhone integration for a specific tenant.
   */
  async disconnectOpenPhoneForTenant(
    workspaceId: string,
    tenantId: string,
  ): Promise<{ success: boolean }> {
    const integration = await this.tenantIntegrationRepo.findOne({
      where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
    });

    if (!integration) {
      this.logger.log(`No OpenPhone integration found for tenant ${tenantId} — nothing to delete`);
      return { success: true };
    }

    await this.tenantIntegrationRepo.remove(integration);
    this.logger.log(`Disconnected OpenPhone for tenant ${tenantId} in workspace ${workspaceId}`);
    return { success: true };
  }

  async refreshTwilioVoiceWebhook(workspaceId: string): Promise<{
    success: boolean;
    twimlAppSid: string;
    webhookUrl: string;
  }> {
    this.logger.log(`========== REFRESH VOICE WEBHOOK START ==========`);
    this.logger.log(`Workspace ID: ${workspaceId}`);

    const workspace = await this.ensureWorkspace(workspaceId);

    const integration = await this.integrationRepo.findOne({
      where: {
        workspaceId,
        provider: ProviderType.TWILIO,
        status: IntegrationStatus.ACTIVE,
      },
    });

    if (!integration) {
      throw new NotFoundException('Twilio integration not found');
    }

    const decrypted = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const credentials = JSON.parse(decrypted);

    const baseUrl = this.getBaseUrl();
    const voiceWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspace.webhookId}`;

    this.logger.log(`Updating TwiML App ${credentials.voiceTwimlAppSid} webhook to: ${voiceWebhookUrl}`);

    // Update the TwiML App webhook URL
    const result = await this.twilioProvider.createTwiMLApp(
      JSON.stringify(credentials),
      `Callio Voice - ${workspace.name || workspaceId}`,
      voiceWebhookUrl,
    );

    if (!result.success) {
      this.logger.error(`Failed to update TwiML App webhook: ${result.error}`);
      throw new BadRequestException(`Failed to update webhook: ${result.error}`);
    }

    this.logger.log(`✅ TwiML App webhook updated successfully`);
    this.logger.log(`========== REFRESH VOICE WEBHOOK END ==========`);

    return {
      success: true,
      twimlAppSid: credentials.voiceTwimlAppSid,
      webhookUrl: voiceWebhookUrl,
    };
  }
}
