import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';
import axios from 'axios';

/**
 * Extract a compact, log-safe description of a Twilio SDK error without
 * ever leaking auth material. Twilio errors typically expose `status`,
 * `code`, and `message` — that's exactly the surface we want to record.
 */
function describeTwilioError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as {
    status?: number;
    code?: number | string;
    message?: string;
  };
  const parts: string[] = [];
  if (e.status !== undefined) parts.push(`status=${e.status}`);
  if (e.code !== undefined) parts.push(`code=${e.code}`);
  if (e.message) parts.push(`msg=${e.message.slice(0, 200)}`);
  return parts.length ? parts.join(' ') : 'unknown';
}
import {
  CommunicationProvider,
  SendMessageInput,
  SendMessageResult,
  ConversationData,
  MessageData,
  CallData,
  InitiateCallInput,
  InitiateCallResult,
} from '../interfaces/communication-provider.interface';
import { MessageDirection, MessageStatus } from '../../../database/entities/communication-message.entity';
import { CallDirection, CallStatus } from '../../../database/entities/communication-call.entity';
import { ChannelType } from '../../../database/entities/sender.entity';

interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  phoneNumber?: string; // The Twilio phone number to use (E.164 format)
  phoneNumberSid?: string; // The SID of the phone number
}

export interface TwilioWebhookRegistrationResult {
  success: boolean;
  smsWebhookUrl?: string;
  voiceWebhookUrl?: string;
  error?: string;
}

interface TwilioPhoneNumberInfo {
  sid: string;
  phoneNumber: string;
  friendlyName?: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
  // A2P 10DLC compliance info
  a2pCompliance?: {
    messagingServiceSid?: string;
    isRegistered: boolean;
    campaignStatus?: string; // 'PENDING', 'VERIFIED', 'FAILED', 'IN_PROGRESS', 'NOT_REGISTERED'
    brandStatus?: string;
  };
}

@Injectable()
export class TwilioProvider implements CommunicationProvider {
  readonly providerName = 'twilio';
  readonly supportedChannels = [ChannelType.SMS, ChannelType.WHATSAPP, ChannelType.VOICE];
  private readonly logger = new Logger(TwilioProvider.name);

  constructor(private configService: ConfigService) {}

  private createClient(credentials: TwilioCredentials): Twilio {
    return new Twilio(credentials.accountSid, credentials.authToken);
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    try {
      const credentials = JSON.parse(input.workspaceId) as TwilioCredentials;
      const client = this.createClient(credentials);

      const channel = input.channel || ChannelType.SMS;

      // Ensure phone number is in E.164 format
      let toNumber = input.to;
      let fromNumber = input.from || credentials.phoneNumber;

      // Handle WhatsApp channel - add whatsapp: prefix
      if (channel === ChannelType.WHATSAPP) {
        if (!toNumber.startsWith('whatsapp:')) {
          toNumber = toNumber.startsWith('+') ? `whatsapp:${toNumber}` : `whatsapp:+${toNumber}`;
        }
        if (fromNumber && !fromNumber.startsWith('whatsapp:')) {
          fromNumber = fromNumber.startsWith('+') ? `whatsapp:${fromNumber}` : `whatsapp:+${fromNumber}`;
        }
      } else {
        // Regular SMS - ensure E.164 format
        if (!toNumber.startsWith('+')) {
          toNumber = '+' + toNumber;
        }
        if (fromNumber && !fromNumber.startsWith('+')) {
          fromNumber = '+' + fromNumber;
        }
      }

      if (!fromNumber) {
        throw new Error('No Twilio phone number configured');
      }

      this.logger.log(`Sending ${channel} message via Twilio: from=${fromNumber}, to=${toNumber}`);

      // Build message parameters
      const messageParams: any = {
        body: input.body,
        from: fromNumber,
        to: toNumber,
      };

      // Add status callback URL for delivery notifications
      const baseUrl = this.configService.get('BASE_URL') || process.env.BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
      if (baseUrl) {
        messageParams.statusCallback = `${baseUrl}/api/webhooks/twilio/sms/status`;
        this.logger.log(`Using status callback URL: ${messageParams.statusCallback}`);
      }

      // WhatsApp template support
      if (channel === ChannelType.WHATSAPP && input.templateId) {
        messageParams.contentSid = input.templateId;
        if (input.templateParams) {
          messageParams.contentVariables = JSON.stringify(input.templateParams);
        }
      }

      const message = await client.messages.create(messageParams);

      return {
        providerMessageId: message.sid,
        status: this.mapMessageStatus(message.status),
        sentAt: new Date(),
      };
    } catch (error) {
      this.logger.error('Failed to send message via Twilio', error);
      throw error;
    }
  }

  supportsChannel(channel: ChannelType): boolean {
    return this.supportedChannels.includes(channel);
  }

  /**
   * Get phone numbers from Twilio account with A2P compliance status.
   */
  async getPhoneNumbers(client: Twilio): Promise<Map<string, TwilioPhoneNumberInfo>> {
    const phoneNumberMap = new Map<string, TwilioPhoneNumberInfo>();
    try {
      const phoneNumbers = await client.incomingPhoneNumbers.list();

      // Fetch A2P campaign info from messaging services
      const a2pCampaigns = await this.getA2PCampaigns(client);

      for (const pn of phoneNumbers) {
        // Check if phone number has A2P registration via messaging service or bundle
        const a2pInfo = a2pCampaigns.get(pn.phoneNumber);
        const hasBundle = !!(pn as unknown as { bundleSid?: string }).bundleSid;

        phoneNumberMap.set(pn.sid, {
          sid: pn.sid,
          phoneNumber: pn.phoneNumber,
          friendlyName: pn.friendlyName,
          capabilities: {
            voice: pn.capabilities?.voice ?? false,
            sms: pn.capabilities?.sms ?? false,
            mms: pn.capabilities?.mms ?? false,
          },
          a2pCompliance: {
            messagingServiceSid: a2pInfo?.messagingServiceSid,
            isRegistered: !!(a2pInfo?.campaignStatus === 'VERIFIED' || hasBundle),
            campaignStatus: a2pInfo?.campaignStatus || (hasBundle ? 'VERIFIED' : 'NOT_REGISTERED'),
            brandStatus: a2pInfo?.brandStatus,
          },
        });
        this.logger.log(`Phone number: ${pn.sid} -> ${pn.friendlyName} (${pn.phoneNumber}) A2P: ${a2pInfo?.campaignStatus || 'NOT_REGISTERED'}`);
      }
      this.logger.log(`Fetched ${phoneNumberMap.size} phone numbers from Twilio`);
    } catch (error) {
      this.logger.warn('Failed to fetch phone numbers from Twilio', error);
    }
    return phoneNumberMap;
  }

  /**
   * Get A2P 10DLC campaign registration status for phone numbers.
   * Checks messaging services for US A2P campaign registrations.
   */
  private async getA2PCampaigns(client: Twilio): Promise<Map<string, {
    messagingServiceSid: string;
    campaignStatus: string;
    brandStatus?: string;
  }>> {
    const campaignMap = new Map<string, {
      messagingServiceSid: string;
      campaignStatus: string;
      brandStatus?: string;
    }>();

    try {
      // Get all messaging services
      const messagingServices = await client.messaging.v1.services.list({ limit: 100 });

      for (const service of messagingServices) {
        try {
          // Get A2P campaigns for this messaging service using usAppToPerson API
          const campaigns = await client.messaging.v1.services(service.sid).usAppToPerson.list();

          // Get phone numbers assigned to this messaging service
          const servicePhoneNumbers = await client.messaging.v1.services(service.sid).phoneNumbers.list();

          // Determine campaign status from the A2P registrations
          let campaignStatus = 'NOT_REGISTERED';
          if (campaigns.length > 0) {
            // Use the first campaign's status (most services have one campaign)
            const campaign = campaigns[0];
            campaignStatus = campaign.campaignStatus || 'PENDING';
          }

          // Map each phone number to its campaign status
          for (const spn of servicePhoneNumbers) {
            campaignMap.set(spn.phoneNumber, {
              messagingServiceSid: service.sid,
              campaignStatus,
            });
          }
        } catch (err) {
          // Some services may not have A2P campaigns configured
          this.logger.debug(`No A2P campaigns for messaging service ${service.sid}`);
        }
      }

      this.logger.log(`Found A2P registrations for ${campaignMap.size} phone numbers`);
    } catch (error) {
      this.logger.warn('Failed to fetch A2P campaign info', error);
    }

    return campaignMap;
  }

  /**
   * Get phone numbers using credentials string (for external use).
   */
  async getPhoneNumbersFromCredentials(credentialsString: string): Promise<Map<string, TwilioPhoneNumberInfo>> {
    const credentials = JSON.parse(credentialsString) as TwilioCredentials;
    const client = this.createClient(credentials);
    return this.getPhoneNumbers(client);
  }

  /**
   * Get phone numbers as an array for API responses.
   */
  async getPhoneNumbersArray(credentialsString: string): Promise<TwilioPhoneNumberInfo[]> {
    const phoneNumberMap = await this.getPhoneNumbersFromCredentials(credentialsString);
    return Array.from(phoneNumberMap.values());
  }

  async getConversations(workspaceId: string, limit?: number, phoneNumberId?: string, since?: Date): Promise<ConversationData[]> {
    try {
      const credentials = JSON.parse(workspaceId) as TwilioCredentials;
      const client = this.createClient(credentials);

      this.logger.log(`Fetching conversations from Twilio (building from messages)...`);

      // Twilio doesn't have native conversations like OpenPhone
      // We build conversations by grouping messages by participant phone number
      const conversationMap = new Map<string, ConversationData>();

      // Fetch recent messages
      const messages = await client.messages.list({
        limit: limit || 1000,
      });

      for (const msg of messages) {
        // Determine the participant (the other party in the conversation)
        const isIncoming = msg.direction === 'inbound';
        const participantNumber = isIncoming ? msg.from : msg.to;
        const ourNumber = isIncoming ? msg.to : msg.from;

        // Create a unique conversation key based on participant + our number
        const conversationKey = `${ourNumber}:${participantNumber}`;

        if (!conversationMap.has(conversationKey)) {
          conversationMap.set(conversationKey, {
            externalId: conversationKey,
            phoneNumber: ourNumber,
            participantPhoneNumber: participantNumber,
            participantPhoneNumbers: [participantNumber],
            createdAt: msg.dateCreated,
            lastMessageAt: msg.dateCreated,
            metadata: {
              phoneNumberSid: credentials.phoneNumberSid,
            },
          });
        } else {
          // Update last message time if this message is more recent
          const existing = conversationMap.get(conversationKey)!;
          if (msg.dateCreated > (existing.lastMessageAt || existing.createdAt)) {
            existing.lastMessageAt = msg.dateCreated;
          }
        }
      }

      // Convert to array and sort by last activity
      const conversations = Array.from(conversationMap.values());
      conversations.sort((a, b) => {
        const aTime = a.lastMessageAt?.getTime() || a.createdAt.getTime();
        const bTime = b.lastMessageAt?.getTime() || b.createdAt.getTime();
        return bTime - aTime;
      });

      this.logger.log(`Built ${conversations.length} conversations from Twilio messages`);

      return limit ? conversations.slice(0, limit) : conversations;
    } catch (error) {
      this.logger.error('Failed to fetch conversations from Twilio', error);
      throw error;
    }
  }

  async getMessages(
    workspaceId: string,
    conversationId: string,
    phoneNumberId?: string,
    participantPhoneNumber?: string,
  ): Promise<MessageData[]> {
    try {
      const credentials = JSON.parse(workspaceId) as TwilioCredentials;
      const client = this.createClient(credentials);

      if (!participantPhoneNumber) {
        this.logger.warn(`Missing participantPhoneNumber for conversation ${conversationId}`);
        return [];
      }

      this.logger.log(`Fetching messages for participant: ${participantPhoneNumber}`);

      // Ensure phone number is in E.164 format
      let participant = participantPhoneNumber;
      if (!participant.startsWith('+')) {
        participant = '+' + participant;
      }

      // Fetch messages to/from this participant
      const [sentMessages, receivedMessages] = await Promise.all([
        client.messages.list({ to: participant, limit: 100 }),
        client.messages.list({ from: participant, limit: 100 }),
      ]);

      const allMessages = [...sentMessages, ...receivedMessages];

      // Sort by date
      allMessages.sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime());

      this.logger.log(`Fetched ${allMessages.length} messages for ${participantPhoneNumber}`);

      return allMessages.map((msg) => ({
        providerMessageId: msg.sid,
        direction: msg.direction === 'inbound' ? MessageDirection.IN : MessageDirection.OUT,
        body: msg.body || '',
        fromNumber: msg.from,
        toNumber: msg.to,
        status: this.mapMessageStatus(msg.status),
        createdAt: msg.dateCreated,
        metadata: {
          numMedia: msg.numMedia,
          numSegments: msg.numSegments,
          errorCode: msg.errorCode,
          errorMessage: msg.errorMessage,
        },
      }));
    } catch (error) {
      this.logger.error(`Failed to fetch messages from Twilio`, error);
      throw error;
    }
  }

  async getCalls(workspaceId: string): Promise<CallData[]> {
    try {
      const credentials = JSON.parse(workspaceId) as TwilioCredentials;
      const client = this.createClient(credentials);

      this.logger.log('Fetching calls from Twilio...');

      const calls = await client.calls.list({ limit: 500 });

      this.logger.log(`Fetched ${calls.length} calls from Twilio`);

      return calls.map((call) => this.mapCallData(call));
    } catch (error) {
      this.logger.error('Failed to fetch calls from Twilio', error);
      throw error;
    }
  }

  async getCallsForConversation(workspaceId: string, conversationId: string): Promise<CallData[]> {
    try {
      const credentials = JSON.parse(workspaceId) as TwilioCredentials;
      const client = this.createClient(credentials);

      // Parse participant from conversationId (format: "ourNumber:participantNumber")
      const [, participantNumber] = conversationId.split(':');

      if (!participantNumber) {
        this.logger.warn(`Invalid conversationId format: ${conversationId}`);
        return [];
      }

      let participant = participantNumber;
      if (!participant.startsWith('+')) {
        participant = '+' + participant;
      }

      this.logger.log(`Fetching calls for participant: ${participant}`);

      // Fetch calls to/from this participant
      const [outboundCalls, inboundCalls] = await Promise.all([
        client.calls.list({ to: participant, limit: 100 }),
        client.calls.list({ from: participant, limit: 100 }),
      ]);

      const allCalls = [...outboundCalls, ...inboundCalls];
      allCalls.sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime());

      this.logger.log(`Fetched ${allCalls.length} calls for ${participant}`);

      return allCalls.map((call) => this.mapCallData(call));
    } catch (error) {
      this.logger.error('Failed to fetch calls for conversation from Twilio', error);
      throw error;
    }
  }

  /**
   * Get calls directly for a participant phone number.
   */
  async getCallsForParticipant(
    workspaceId: string,
    participantPhoneNumber: string,
  ): Promise<CallData[]> {
    try {
      const credentials = JSON.parse(workspaceId) as TwilioCredentials;
      const client = this.createClient(credentials);

      let participant = participantPhoneNumber;
      if (!participant.startsWith('+')) {
        participant = '+' + participant;
      }

      this.logger.log(`Fetching calls for participant: ${participant}`);

      const [outboundCalls, inboundCalls] = await Promise.all([
        client.calls.list({ to: participant, limit: 100 }),
        client.calls.list({ from: participant, limit: 100 }),
      ]);

      const allCalls = [...outboundCalls, ...inboundCalls];
      allCalls.sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime());

      return allCalls.map((call) => this.mapCallData(call));
    } catch (error) {
      this.logger.error(`Failed to fetch calls for participant ${participantPhoneNumber}`, error);
      throw error;
    }
  }

  /**
   * Get messages directly for a participant phone number.
   */
  async getMessagesForParticipant(
    workspaceId: string,
    participantPhoneNumber: string,
    filterPhoneNumberId?: string,
  ): Promise<{ messages: MessageData[]; phoneNumberId: string | null; phoneNumber: string | null }> {
    try {
      const credentials = JSON.parse(workspaceId) as TwilioCredentials;
      const client = this.createClient(credentials);

      let participant = participantPhoneNumber;
      if (!participant.startsWith('+')) {
        participant = '+' + participant;
      }

      this.logger.log(`Fetching messages for participant: ${participant}`);

      const [sentMessages, receivedMessages] = await Promise.all([
        client.messages.list({ to: participant, limit: 100 }),
        client.messages.list({ from: participant, limit: 100 }),
      ]);

      const allMessages = [...sentMessages, ...receivedMessages];
      allMessages.sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime());

      const messages = allMessages.map((msg) => ({
        providerMessageId: msg.sid,
        direction: msg.direction === 'inbound' ? MessageDirection.IN : MessageDirection.OUT,
        body: msg.body || '',
        fromNumber: msg.from,
        toNumber: msg.to,
        status: this.mapMessageStatus(msg.status),
        createdAt: msg.dateCreated,
        metadata: {
          numMedia: msg.numMedia,
          numSegments: msg.numSegments,
        },
      }));

      return {
        messages,
        phoneNumberId: credentials.phoneNumberSid || null,
        phoneNumber: credentials.phoneNumber || null,
      };
    } catch (error) {
      this.logger.error(`Failed to fetch messages for participant ${participantPhoneNumber}`, error);
      throw error;
    }
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    // For Twilio, we return a web URL to the Twilio console
    // In the future, this could initiate a click-to-call via the API
    const phoneNumber = input.to.replace(/[^0-9+]/g, '');

    return {
      success: true,
      deepLink: `tel:${phoneNumber}`,
      webFallback: `https://www.twilio.com/console/phone-numbers/incoming`,
      message: 'Opening phone dialer',
    };
  }

  async validateCredentials(credentials: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(credentials) as TwilioCredentials;
      const client = this.createClient(parsed);

      // Try to fetch account info to validate credentials
      const account = await client.api.accounts(parsed.accountSid).fetch();
      this.logger.log(`Validated Twilio credentials for account: ${account.friendlyName}`);
      return true;
    } catch (error) {
      this.logger.error('Failed to validate Twilio credentials', error);
      return false;
    }
  }

  /**
   * Wave-2 Task 6B.5A — Twilio subaccount creation under a master account.
   *
   * Called by TwilioSubaccountProvisioner when a Sigcore communication
   * identity's Twilio integration transitions out of `pending_credentials`
   * on first voice-number purchase. Uses the master account's credentials
   * (from env / SigcoreMasterTwilioCredentials) to create a subaccount
   * whose SID + auth token are then stored on the integration row.
   *
   * Idempotency: Twilio's `accounts.create` is NOT idempotent by
   * friendlyName — repeated calls create distinct subaccounts. Callers MUST
   * hold a lock (application-level or DB-level) so that this method is
   * only invoked once per (workspaceId) at a time. The provisioner service
   * enforces this via `SELECT … FOR UPDATE` on the integration row.
   *
   * Twilio caveat: subaccounts cannot be deleted. Cleanup uses
   * `.update({status: 'closed'})` — irreversible — via `closeSubaccount`.
   */
  async createSubaccount(
    masterCredentials: TwilioCredentials,
    friendlyName: string,
  ): Promise<{
    subaccountSid: string;
    subaccountAuthToken: string;
    friendlyName: string;
    status: string;
  }> {
    const client = this.createClient(masterCredentials);
    // Twilio's subaccount API returns the auth token ONLY on creation —
    // subsequent GETs never expose it. Store it immediately.
    const subaccount = await client.api.v2010.accounts.create({
      friendlyName,
    });
    if (!subaccount.authToken) {
      // Should be impossible per Twilio API docs, but guard defensively so
      // we never persist a partial credential blob.
      throw new Error(
        `Twilio subaccount create returned no authToken for friendlyName=${friendlyName}`,
      );
    }
    this.logger.log(
      `twilio_subaccount_created sid=${subaccount.sid} friendlyName=${subaccount.friendlyName} status=${subaccount.status}`,
    );
    return {
      subaccountSid: subaccount.sid,
      subaccountAuthToken: subaccount.authToken,
      friendlyName: subaccount.friendlyName ?? friendlyName,
      status: subaccount.status,
    };
  }

  /**
   * Fetch a subaccount's current record from the master account.
   * Used by preflight to verify status=active before marking `ready`.
   */
  async fetchSubaccount(
    masterCredentials: TwilioCredentials,
    subaccountSid: string,
  ): Promise<{ sid: string; friendlyName: string; status: string }> {
    const client = this.createClient(masterCredentials);
    const account = await client.api.v2010.accounts(subaccountSid).fetch();
    return {
      sid: account.sid,
      friendlyName: account.friendlyName ?? '',
      status: account.status,
    };
  }

  /**
   * Close a subaccount — Twilio's terminology; irreversibly retires the
   * subaccount and releases any resources still attached to it. Used by
   * administrative cleanup only. Twilio does not support deletion of
   * subaccounts; `closed` is the terminal state.
   */
  async closeSubaccount(
    masterCredentials: TwilioCredentials,
    subaccountSid: string,
  ): Promise<{ sid: string; status: string }> {
    const client = this.createClient(masterCredentials);
    const account = await client.api.v2010.accounts(subaccountSid).update({
      status: 'closed',
    });
    this.logger.warn(
      `twilio_subaccount_closed sid=${account.sid} status=${account.status} — IRREVERSIBLE, all numbers released`,
    );
    return { sid: account.sid, status: account.status };
  }

  /**
   * Wave-2 Task 6B.5A — subaccount preflight.
   *
   * Verifies that a set of subaccount credentials can service provider
   * operations end-to-end, without making a billable resource change:
   *
   *   1. Credentials decrypt to a well-formed pair (caller's responsibility;
   *      this method assumes the input JSON parses).
   *   2. Twilio authentication succeeds — `.api.accounts(sid).fetch()`.
   *   3. Subaccount is in `active` status (not `closed` / `suspended`).
   *   4. Phone-number search API is reachable — `.availablePhoneNumbers()`
   *      list with limit=1. This is a free read that proves API access to
   *      the resources voice provisioning actually needs.
   *
   * Never places a billable call. Returns a structured result so the
   * provisioner can transition to `ready` / `error` with the right
   * machine-readable reason code.
   */
  async preflightSubaccount(
    subaccountCredentials: TwilioCredentials,
  ): Promise<
    | { ok: true; accountStatus: string; friendlyName: string }
    | { ok: false; reason: string; detail: string }
  > {
    let client: Twilio;
    try {
      client = this.createClient(subaccountCredentials);
    } catch (err) {
      return {
        ok: false,
        reason: 'TWILIO_CREDENTIALS_NOT_CONFIGURED',
        detail: (err as Error).message,
      };
    }
    // Step 2 — auth
    let account: { status: string; friendlyName: string | null };
    try {
      account = await client.api
        .accounts(subaccountCredentials.accountSid)
        .fetch();
    } catch (err) {
      const detail = describeTwilioError(err);
      return {
        ok: false,
        reason: 'TWILIO_AUTH_FAILED',
        detail,
      };
    }
    // Step 3 — status
    if (account.status !== 'active') {
      return {
        ok: false,
        reason: 'TWILIO_SUBACCOUNT_INACTIVE',
        detail: `subaccount status=${account.status}`,
      };
    }
    // Step 4 — read-only search reachability (no billing)
    try {
      await client.availablePhoneNumbers('US').local.list({ limit: 1 });
    } catch (err) {
      const detail = describeTwilioError(err);
      return {
        ok: false,
        reason: 'TWILIO_PREFLIGHT_LIST_FAILED',
        detail,
      };
    }
    return {
      ok: true,
      accountStatus: account.status,
      friendlyName: account.friendlyName ?? '',
    };
  }

  /**
   * Configure webhooks on a Twilio phone number.
   */
  async configureWebhooks(
    credentialsString: string,
    phoneNumberSid: string,
    smsWebhookUrl: string,
    voiceWebhookUrl: string,
  ): Promise<TwilioWebhookRegistrationResult> {
    try {
      const credentials = JSON.parse(credentialsString) as TwilioCredentials;
      const client = this.createClient(credentials);

      this.logger.log(`Configuring webhooks for phone number ${phoneNumberSid}`);

      await client.incomingPhoneNumbers(phoneNumberSid).update({
        smsUrl: smsWebhookUrl,
        smsMethod: 'POST',
        voiceUrl: voiceWebhookUrl,
        voiceMethod: 'POST',
      });

      this.logger.log(`Webhooks configured successfully for ${phoneNumberSid}`);

      return {
        success: true,
        smsWebhookUrl,
        voiceWebhookUrl,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to configure webhooks: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Partial update of a Twilio phone number's webhook fields. Only the fields
   * present in `urls` are sent to Twilio; every unset field is preserved on the
   * Twilio side. Twilio's REST update semantics preserve unlisted attributes,
   * so this is safe to use for voice-only, sms-only, or partial updates
   * without clobbering unrelated legs.
   *
   * Introduced for the Wave-2 Task 4 webhook-config endpoint so operators can
   * supply any combination of {smsUrl, voiceUrl, voiceFallbackUrl,
   * statusCallbackUrl} and get exactly those fields applied. The prior
   * `configureWebhooks` (both legs at once) and `updateSmsWebhook` (sms only)
   * remain for existing callers who explicitly want that shape.
   */
  async updateNumberWebhooks(
    credentialsString: string,
    phoneNumberSid: string,
    urls: {
      smsUrl?: string;
      voiceUrl?: string;
      voiceFallbackUrl?: string;
      statusCallbackUrl?: string;
    },
  ): Promise<{ success: boolean; applied: string[]; error?: string }> {
    try {
      const credentials = JSON.parse(credentialsString) as TwilioCredentials;
      const client = this.createClient(credentials);
      const params: Record<string, unknown> = {};
      const applied: string[] = [];
      if (urls.smsUrl !== undefined) {
        params.smsUrl = urls.smsUrl;
        params.smsMethod = 'POST';
        applied.push('smsUrl');
      }
      if (urls.voiceUrl !== undefined) {
        params.voiceUrl = urls.voiceUrl;
        params.voiceMethod = 'POST';
        applied.push('voiceUrl');
      }
      if (urls.voiceFallbackUrl !== undefined) {
        params.voiceFallbackUrl = urls.voiceFallbackUrl;
        params.voiceFallbackMethod = 'POST';
        applied.push('voiceFallbackUrl');
      }
      if (urls.statusCallbackUrl !== undefined) {
        params.statusCallback = urls.statusCallbackUrl;
        params.statusCallbackMethod = 'POST';
        applied.push('statusCallbackUrl');
      }
      if (applied.length === 0) {
        return { success: true, applied: [] };
      }
      await client.incomingPhoneNumbers(phoneNumberSid).update(params);
      this.logger.log(
        `updateNumberWebhooks sid=${phoneNumberSid} applied=${applied.join(',')}`,
      );
      return { success: true, applied };
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `updateNumberWebhooks sid=${phoneNumberSid} failed: ${err.message}`,
      );
      return { success: false, applied: [], error: err.message };
    }
  }

  /**
   * Update only the SMS webhook URL on a Twilio number — leaves voice config untouched.
   * Idempotent: calling repeatedly with the same URL is safe.
   */
  async updateSmsWebhook(
    credentialsString: string,
    phoneNumberSid: string,
    smsUrl: string,
    smsMethod: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const credentials = JSON.parse(credentialsString) as TwilioCredentials;
      const client = this.createClient(credentials);
      await client.incomingPhoneNumbers(phoneNumberSid).update({
        smsUrl,
        smsMethod: smsMethod as 'POST' | 'GET',
      });
      return { success: true };
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  }

  /**
   * Look up a single phone number's Twilio SID by E.164 phone number string.
   * Used when creating a new tenant_phone_numbers record for a number that was not
   * provisioned through Sigcore (e.g. imported or pre-existing Twilio numbers).
   */
  async getPhoneNumberSid(credentialsString: string, phoneNumber: string): Promise<string | undefined> {
    try {
      const credentials = JSON.parse(credentialsString) as TwilioCredentials;
      const client = this.createClient(credentials);
      const numbers = await client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
      return numbers[0]?.sid;
    } catch (error) {
      const err = error as Error;
      this.logger.warn(`[getPhoneNumberSid] Failed to look up SID for ${phoneNumber}: ${err.message}`);
      return undefined;
    }
  }

  /**
   * Get recordings for a call.
   */
  async getCallRecordings(
    workspaceId: string,
    providerCallId: string,
  ): Promise<{ recordingUrl: string | null; voicemailUrl: string | null }> {
    try {
      const credentials = JSON.parse(workspaceId) as TwilioCredentials;
      const client = this.createClient(credentials);

      const recordings = await client.recordings.list({
        callSid: providerCallId,
        limit: 10,
      });

      if (recordings.length === 0) {
        return { recordingUrl: null, voicemailUrl: null };
      }

      // Get the most recent recording URL
      const recording = recordings[0];
      const recordingUrl = `https://api.twilio.com${recording.uri.replace('.json', '.mp3')}`;

      return {
        recordingUrl,
        voicemailUrl: recordingUrl, // Twilio doesn't distinguish voicemail from recording
      };
    } catch (error) {
      this.logger.error(`Failed to fetch recordings for call ${providerCallId}`, error);
      return { recordingUrl: null, voicemailUrl: null };
    }
  }

  /**
   * Get transcription for a recording.
   */
  async getCallTranscript(
    workspaceId: string,
    providerCallId: string,
  ): Promise<{ transcript: string; status: string } | null> {
    try {
      const credentials = JSON.parse(workspaceId) as TwilioCredentials;
      const client = this.createClient(credentials);

      // First get the recording
      const recordings = await client.recordings.list({
        callSid: providerCallId,
        limit: 1,
      });

      if (recordings.length === 0) {
        return { transcript: '', status: 'absent' };
      }

      // Get transcriptions for this recording
      const transcriptions = await client.transcriptions.list({
        limit: 10,
      });

      // Find transcription for this recording
      const recordingSid = recordings[0].sid;
      const transcription = transcriptions.find((t) => t.recordingSid === recordingSid);

      if (!transcription || transcription.status !== 'completed') {
        return { transcript: '', status: transcription?.status || 'absent' };
      }

      return {
        transcript: transcription.transcriptionText || '',
        status: 'completed',
      };
    } catch (error) {
      this.logger.error(`Failed to fetch transcript for call ${providerCallId}`, error);
      return null;
    }
  }

  private mapMessageStatus(status: string): MessageStatus {
    const statusMap: Record<string, MessageStatus> = {
      queued: MessageStatus.PENDING,
      sending: MessageStatus.PENDING,
      sent: MessageStatus.SENT,
      delivered: MessageStatus.DELIVERED,
      undelivered: MessageStatus.FAILED,
      failed: MessageStatus.FAILED,
      received: MessageStatus.DELIVERED,
      accepted: MessageStatus.SENT,
    };
    return statusMap[status] || MessageStatus.PENDING;
  }

  private mapCallStatus(status: string): CallStatus {
    const statusMap: Record<string, CallStatus> = {
      completed: CallStatus.COMPLETED,
      busy: CallStatus.MISSED,
      'no-answer': CallStatus.MISSED,
      canceled: CallStatus.CANCELLED,
      failed: CallStatus.MISSED,
    };
    return statusMap[status] || CallStatus.COMPLETED;
  }

  private mapCallData(call: {
    sid: string;
    direction: string;
    duration: string;
    from: string;
    to: string;
    status: string;
    startTime: Date;
    endTime: Date;
    dateCreated: Date;
  }): CallData {
    return {
      providerCallId: call.sid,
      direction: call.direction === 'inbound' ? CallDirection.IN : CallDirection.OUT,
      duration: parseInt(call.duration, 10) || 0,
      fromNumber: call.from,
      toNumber: call.to,
      status: this.mapCallStatus(call.status),
      startedAt: call.startTime,
      endedAt: call.endTime,
      createdAt: call.dateCreated,
      metadata: {
        status: call.status,
      },
    };
  }

  /**
   * Create API Key for Twilio Voice SDK
   */
  async createApiKey(
    credentials: string,
    friendlyName: string,
  ): Promise<{ success: boolean; apiKey?: { sid: string; secret: string }; error?: string }> {
    try {
      const creds = JSON.parse(credentials) as TwilioCredentials;
      const client = this.createClient(creds);

      this.logger.log(`Creating API Key: ${friendlyName}`);

      const apiKey = await client.newKeys.create({
        friendlyName,
      });

      return {
        success: true,
        apiKey: {
          sid: apiKey.sid,
          secret: apiKey.secret,
        },
      };
    } catch (error: any) {
      this.logger.error('Failed to create Twilio API Key', error);
      return {
        success: false,
        error: error.message || 'Failed to create API Key',
      };
    }
  }

  /**
   * Get TwiML App configuration from Twilio
   */
  async getTwiMLAppConfig(
    credentials: string,
    twimlAppSid: string,
  ): Promise<{ success: boolean; config?: { voiceUrl: string; friendlyName: string }; error?: string }> {
    try {
      const creds = JSON.parse(credentials) as TwilioCredentials;
      const client = this.createClient(creds);

      const app = await client.applications(twimlAppSid).fetch();

      return {
        success: true,
        config: {
          voiceUrl: app.voiceUrl || '',
          friendlyName: app.friendlyName || '',
        },
      };
    } catch (error: any) {
      this.logger.error('Failed to get TwiML App config', error);
      return {
        success: false,
        error: error.message || 'Failed to get TwiML App config',
      };
    }
  }

  /**
   * Create TwiML App for Twilio Voice SDK
   * Checks for existing app with same friendly name before creating
   */
  async createTwiMLApp(
    credentials: string,
    friendlyName: string,
    voiceUrl: string,
  ): Promise<{ success: boolean; twimlApp?: { sid: string }; error?: string }> {
    try {
      const creds = JSON.parse(credentials) as TwilioCredentials;
      const client = this.createClient(creds);

      // Check if TwiML App already exists
      this.logger.log(`Checking for existing TwiML App: ${friendlyName}`);
      const existingApps = await client.applications.list({
        friendlyName,
        limit: 1,
      });

      if (existingApps.length > 0) {
        const existing = existingApps[0];
        this.logger.log(`Found existing TwiML App: ${existing.sid}`);
        this.logger.log(`Current voice URL: ${existing.voiceUrl}`);
        this.logger.log(`Updating to new voice URL: ${voiceUrl}`);

        // Update the existing app's voice URL
        await client.applications(existing.sid).update({
          voiceUrl,
          voiceMethod: 'POST',
        });

        this.logger.log(`✅ TwiML App updated successfully`);

        return {
          success: true,
          twimlApp: {
            sid: existing.sid,
          },
        };
      }

      // Create new TwiML App if none exists
      this.logger.log(`Creating new TwiML App: ${friendlyName}`);
      const twimlApp = await client.applications.create({
        friendlyName,
        voiceUrl,
        voiceMethod: 'POST',
      });

      return {
        success: true,
        twimlApp: {
          sid: twimlApp.sid,
        },
      };
    } catch (error: any) {
      this.logger.error('Failed to create/update TwiML App', error);
      return {
        success: false,
        error: error.message || 'Failed to create/update TwiML App',
      };
    }
  }

  /**
   * Search for available phone numbers in Twilio
   */
  async searchAvailableNumbers(
    credentials: TwilioCredentials | string,
    country: string,
    areaCode?: string,
    options?: { locality?: string; region?: string },
  ): Promise<Array<{ phoneNumber: string; locality?: string; region?: string; capabilities?: string[] }>> {
    try {
      const creds = typeof credentials === 'string' ? JSON.parse(credentials) as TwilioCredentials : credentials;
      const client = this.createClient(creds);

      this.logger.log(`Searching for available numbers in ${country} areaCode=${areaCode || ''} locality=${options?.locality || ''} region=${options?.region || ''}`);

      const searchParams: any = {
        limit: 10,
      };

      if (areaCode) {
        searchParams.areaCode = areaCode;
      }

      if (options?.locality) {
        searchParams.inLocality = options.locality;
      }

      if (options?.region) {
        searchParams.inRegion = options.region;
      }

      const availableNumbers = await client.availablePhoneNumbers(country).local.list(searchParams);

      return availableNumbers.map((num) => ({
        phoneNumber: num.phoneNumber,
        locality: num.locality,
        region: num.region,
        capabilities: [
          num.capabilities.sms && 'sms',
          num.capabilities.voice && 'voice',
          num.capabilities.mms && 'mms',
        ].filter(Boolean) as string[],
      }));
    } catch (error: any) {
      this.logger.error(`Failed to search available numbers: ${error.message}`);
      throw error;
    }
  }

  /**
   * Purchase a phone number from Twilio
   */
  async purchasePhoneNumber(
    credentials: TwilioCredentials | string,
    phoneNumber: string,
  ): Promise<{ phoneNumber: string; sid: string; friendlyName: string; capabilities: string[] }> {
    try {
      const creds = typeof credentials === 'string' ? JSON.parse(credentials) as TwilioCredentials : credentials;
      const client = this.createClient(creds);

      this.logger.log(`Purchasing phone number: ${phoneNumber}`);

      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber,
      });

      return {
        phoneNumber: purchased.phoneNumber,
        sid: purchased.sid,
        friendlyName: purchased.friendlyName || phoneNumber,
        capabilities: [
          purchased.capabilities?.sms && 'sms',
          purchased.capabilities?.voice && 'voice',
          purchased.capabilities?.mms && 'mms',
        ].filter(Boolean) as string[],
      };
    } catch (error: any) {
      this.logger.error(`Failed to purchase phone number: ${error.message}`);
      throw error;
    }
  }

  /**
   * Release a phone number back to Twilio
   */
  async releasePhoneNumber(
    credentials: TwilioCredentials | string,
    phoneNumberSid: string,
  ): Promise<void> {
    try {
      const creds = typeof credentials === 'string' ? JSON.parse(credentials) as TwilioCredentials : credentials;
      const client = this.createClient(creds);

      this.logger.log(`Releasing phone number: ${phoneNumberSid}`);

      await client.incomingPhoneNumbers(phoneNumberSid).remove();

      this.logger.log(`Phone number released successfully`);
    } catch (error: any) {
      this.logger.error(`Failed to release phone number: ${error.message}`);
      throw error;
    }
  }

  /**
   * Look up the current Twilio SID for a phone number by E.164.
   *
   * Used by the release-number self-heal path: if the SID we stored at
   * provision time no longer matches Twilio's record (SIDs can rotate on
   * subaccount transfers, re-purchases, or manual moves in the Console),
   * the stored-SID release will 404. Callers use this to re-resolve the
   * current SID and retry.
   *
   * Returns null when Twilio's account genuinely does not hold the number
   * anymore — in that case the number is already gone and the local
   * allocation record can be safely deallocated without a Twilio call.
   */
  async findPhoneNumberSid(
    credentials: TwilioCredentials | string,
    phoneNumberE164: string,
  ): Promise<string | null> {
    try {
      const creds = typeof credentials === 'string' ? JSON.parse(credentials) as TwilioCredentials : credentials;
      const client = this.createClient(creds);

      const matches = await client.incomingPhoneNumbers.list({
        phoneNumber: phoneNumberE164,
        limit: 1,
      });

      if (matches.length === 0) {
        this.logger.log(`findPhoneNumberSid: ${phoneNumberE164} not in Twilio account`);
        return null;
      }

      const sid = matches[0].sid;
      this.logger.log(`findPhoneNumberSid: ${phoneNumberE164} → ${sid}`);
      return sid;
    } catch (error: any) {
      this.logger.error(`findPhoneNumberSid failed for ${phoneNumberE164}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Add a phone number to a Twilio Messaging Service sender pool.
   * Required for A2P 10DLC compliance.
   */
  async addNumberToMessagingService(
    credentials: TwilioCredentials | string,
    messagingServiceSid: string,
    phoneNumberSid: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const creds = typeof credentials === 'string' ? JSON.parse(credentials) as TwilioCredentials : credentials;
      const client = this.createClient(creds);

      this.logger.log(`Adding ${phoneNumberSid} to Messaging Service ${messagingServiceSid}`);

      await client.messaging.v1
        .services(messagingServiceSid)
        .phoneNumbers.create({ phoneNumberSid });

      this.logger.log(`Successfully added ${phoneNumberSid} to Messaging Service`);
      return { success: true };
    } catch (error: any) {
      this.logger.error(`Failed to add number to Messaging Service: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove a phone number from a Twilio Messaging Service sender pool.
   */
  async removeNumberFromMessagingService(
    credentials: TwilioCredentials | string,
    messagingServiceSid: string,
    phoneNumberSid: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const creds = typeof credentials === 'string' ? JSON.parse(credentials) as TwilioCredentials : credentials;
      const client = this.createClient(creds);

      this.logger.log(`Removing ${phoneNumberSid} from Messaging Service ${messagingServiceSid}`);

      await client.messaging.v1
        .services(messagingServiceSid)
        .phoneNumbers(phoneNumberSid)
        .remove();

      return { success: true };
    } catch (error: any) {
      this.logger.error(`Failed to remove number from Messaging Service: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Download recording file from Twilio.
   * Twilio recordings require Basic Auth with AccountSid:AuthToken.
   */
  async downloadRecording(
    workspaceId: string,
    recordingUrl: string,
  ): Promise<Buffer | null> {
    this.logger.log(`Downloading recording from Twilio: ${recordingUrl}`);

    try {
      const credentials = JSON.parse(workspaceId) as TwilioCredentials;

      // Twilio requires Basic Auth
      const response = await axios.get(recordingUrl, {
        responseType: 'arraybuffer',
        auth: {
          username: credentials.accountSid,
          password: credentials.authToken,
        },
      });

      this.logger.log(`Downloaded recording, size: ${response.data.length} bytes`);
      return Buffer.from(response.data);
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number }; message?: string };
      this.logger.error(
        `Failed to download recording: ${axiosError.message}`,
        axiosError.response?.status,
      );
      return null;
    }
  }
}
