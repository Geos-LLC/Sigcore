import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client, LocalAuth, Message as WAMessage } from 'whatsapp-web.js';
import * as QRCode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';

export interface WhatsAppSession {
  workspaceId: string;
  client: Client;
  status: 'initializing' | 'qr_ready' | 'authenticated' | 'ready' | 'disconnected' | 'error';
  qrCode?: string;
  qrCodeDataUrl?: string;
  phoneNumber?: string;
  error?: string;
  lastActivity?: Date;
}

export interface WhatsAppSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

@Injectable()
export class WhatsAppService implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private sessions: Map<string, WhatsAppSession> = new Map();
  private readonly sessionsPath: string;
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    this.sessionsPath = path.join(process.cwd(), 'data', 'whatsapp-sessions');
    this.ensureSessionsDirectory();
  }

  private ensureSessionsDirectory() {
    if (!fs.existsSync(this.sessionsPath)) {
      fs.mkdirSync(this.sessionsPath, { recursive: true });
      this.logger.log(`Created WhatsApp sessions directory: ${this.sessionsPath}`);
    }
  }

  async onModuleDestroy() {
    // Clear all reconnect timers
    for (const [, timer] of this.reconnectTimers) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    for (const [workspaceId, session] of this.sessions) {
      try {
        await session.client.destroy();
        this.logger.log(`Destroyed WhatsApp client for workspace ${workspaceId}`);
      } catch (error) {
        this.logger.warn(`Error destroying client for workspace ${workspaceId}`, error);
      }
    }
    this.sessions.clear();
  }

  async initializeClient(workspaceId: string): Promise<WhatsAppSession> {
    const existingSession = this.sessions.get(workspaceId);
    if (existingSession && existingSession.status === 'ready') {
      return existingSession;
    }

    if (existingSession) {
      try {
        await existingSession.client.destroy();
      } catch (e) {
        // Ignore
      }
    }

    // Clear any pending reconnect timer
    const reconnectTimer = this.reconnectTimers.get(workspaceId);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      this.reconnectTimers.delete(workspaceId);
    }

    this.logger.log(`Initializing WhatsApp client for workspace ${workspaceId}`);

    const session: WhatsAppSession = {
      workspaceId,
      client: null as any,
      status: 'initializing',
    };

    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: workspaceId,
        dataPath: this.sessionsPath,
      }),
      puppeteer: {
        headless: true,
        executablePath: executablePath || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--single-process',
        ],
      },
    });

    session.client = client;
    this.sessions.set(workspaceId, session);

    this.setupEventHandlers(workspaceId, client, session);

    try {
      await client.initialize();
    } catch (error) {
      this.logger.error(`Failed to initialize WhatsApp client for workspace ${workspaceId}`, error);
      session.status = 'error';
      session.error = error instanceof Error ? error.message : 'Failed to initialize';
    }

    return session;
  }

  private setupEventHandlers(workspaceId: string, client: Client, session: WhatsAppSession) {
    client.on('qr', async (qr: string) => {
      this.logger.log(`QR code received for workspace ${workspaceId}`);
      session.status = 'qr_ready';
      session.qrCode = qr;

      try {
        session.qrCodeDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
      } catch (e) {
        this.logger.warn('Failed to generate QR code data URL', e);
      }
    });

    client.on('authenticated', () => {
      this.logger.log(`WhatsApp authenticated for workspace ${workspaceId}`);
      session.status = 'authenticated';
      session.qrCode = undefined;
      session.qrCodeDataUrl = undefined;
    });

    client.on('ready', async () => {
      this.logger.log(`WhatsApp ready for workspace ${workspaceId}`);
      session.status = 'ready';
      session.lastActivity = new Date();

      try {
        const info = client.info;
        session.phoneNumber = info?.wid?.user ? `+${info.wid.user}` : undefined;
        this.logger.log(`Connected WhatsApp number: ${session.phoneNumber}`);
      } catch (e) {
        this.logger.warn('Failed to get WhatsApp info', e);
      }

      // Notify Sigcore main API that WhatsApp is connected
      this.forwardToSigcore(workspaceId, 'status_change', {
        status: 'ready',
        phoneNumber: session.phoneNumber,
      });

      // Auto-sync: wait for WhatsApp to load chats, then forward them
      // WhatsApp multi-device needs 15-30s after 'ready' to populate the chat store
      this.scheduleAutoSync(workspaceId, session);
    });

    client.on('disconnected', (reason: string) => {
      this.logger.warn(`WhatsApp disconnected for workspace ${workspaceId}: ${reason}`);
      session.status = 'disconnected';
      session.error = reason;

      // Notify Sigcore
      this.forwardToSigcore(workspaceId, 'status_change', {
        status: 'disconnected',
        reason,
      });

      // Attempt reconnection with exponential backoff
      this.scheduleReconnect(workspaceId, 1);
    });

    client.on('auth_failure', (message: string) => {
      this.logger.error(`WhatsApp auth failure for workspace ${workspaceId}: ${message}`);
      session.status = 'error';
      session.error = message;
    });

    // Forward messages to Sigcore main API
    // Use message_create instead of message — fires for ALL messages including
    // history synced from WhatsApp servers on connect, not just new incoming
    const forwardMessage = async (message: WAMessage) => {
      session.lastActivity = new Date();

      // Filter: only individual chat messages (not groups, broadcasts, or status updates)
      if (!message.from || !(message.from.endsWith('@c.us') || message.from.endsWith('@lid'))) {
        return;
      }
      if (!message.body && !message.hasMedia) {
        return;
      }

      const isFromMe = message.fromMe || false;
      const chatId = isFromMe ? message.to : message.from;

      // Resolve real phone number from contact (LID IDs are NOT phone numbers)
      let contactPhone: string | null = null;
      let contactName: string | null = null;
      try {
        const contact = await session.client.getContactById(chatId);
        if (contact?.number) {
          contactPhone = contact.number.startsWith('+') ? contact.number : `+${contact.number}`;
        }
        contactName = contact?.name || contact?.pushname || null;
      } catch {
        // fallback
      }

      // For c.us chats, use the user ID as phone if contact.number not available
      if (!contactPhone && chatId?.endsWith('@c.us')) {
        const user = chatId.replace('@c.us', '');
        if (user && user !== '0') {
          contactPhone = user.startsWith('+') ? user : `+${user}`;
        }
      }

      if (!contactPhone) {
        this.logger.debug(`[MSG] Skipped: can't resolve phone for ${chatId}`);
        return;
      }

      this.forwardToSigcore(workspaceId, 'message_inbound', {
        externalMessageId: message.id._serialized,
        externalChatId: chatId,
        from: isFromMe ? (session.phoneNumber || '') : contactPhone,
        to: isFromMe ? contactPhone : (session.phoneNumber || ''),
        body: message.body || '',
        timestamp: message.timestamp ? new Date(message.timestamp * 1000).toISOString() : new Date().toISOString(),
        hasMedia: message.hasMedia,
        type: message.type,
        fromMe: isFromMe,
        contactName,
      });
    };

    // message_create fires for all messages (incoming + synced history + sent)
    client.on('message_create', (msg) => {
      this.logger.log(`[EVENT] message_create fired: from=${msg.from} type=${msg.type}`);
      forwardMessage(msg);
    });
    // message fires for incoming only (backup — dedup handled by Sigcore)
    client.on('message', (msg) => {
      this.logger.log(`[EVENT] message fired: from=${msg.from} type=${msg.type}`);
      forwardMessage(msg);
    });

    // Forward message acknowledgement (delivery/read receipts)
    client.on('message_ack', async (message: WAMessage, ack: number) => {
      // ack: 0=pending, 1=sent, 2=delivered, 3=read
      if (ack >= 2) {
        this.forwardToSigcore(workspaceId, 'message_ack', {
          externalMessageId: message.id._serialized,
          ack,
          status: ack === 2 ? 'delivered' : ack === 3 ? 'read' : 'sent',
        });
      }
    });
  }

  /**
   * Forward events to Sigcore main API via webhook
   */
  private async forwardToSigcore(
    workspaceId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const sigcoreUrl = process.env.SIGCORE_API_URL;
    const webhookKey = process.env.SIGCORE_WEBHOOK_KEY;

    if (!sigcoreUrl || !webhookKey) {
      this.logger.debug(`SIGCORE_API_URL or SIGCORE_WEBHOOK_KEY not set, skipping webhook for ${eventType}`);
      return;
    }

    try {
      await axios.post(
        `${sigcoreUrl}/webhooks/whatsapp/inbound`,
        { workspaceId, eventType, data, timestamp: new Date().toISOString() },
        {
          headers: { 'x-webhook-key': webhookKey, 'Content-Type': 'application/json' },
          timeout: 30000,
        },
      );
      this.logger.debug(`Forwarded ${eventType} to Sigcore for workspace ${workspaceId}`);
    } catch (error) {
      this.logger.warn(
        `Failed to forward ${eventType} to Sigcore: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /**
   * Reconnect with exponential backoff (max 5 attempts, delays: 5s, 10s, 20s, 40s, 80s)
   */
  private scheduleReconnect(workspaceId: string, attempt: number): void {
    if (attempt > 5) {
      this.logger.warn(`Max reconnection attempts reached for workspace ${workspaceId}`);
      return;
    }

    const delayMs = Math.min(5000 * Math.pow(2, attempt - 1), 80000);
    this.logger.log(`Scheduling reconnect for workspace ${workspaceId} in ${delayMs}ms (attempt ${attempt})`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(workspaceId);
      const session = this.sessions.get(workspaceId);

      // Only reconnect if still disconnected (user didn't manually reconnect or disconnect)
      if (session && session.status === 'disconnected') {
        this.logger.log(`Attempting reconnect for workspace ${workspaceId} (attempt ${attempt})`);
        try {
          await this.initializeClient(workspaceId);
        } catch (e) {
          this.logger.warn(`Reconnect attempt ${attempt} failed for workspace ${workspaceId}`);
          this.scheduleReconnect(workspaceId, attempt + 1);
        }
      }
    }, delayMs);

    this.reconnectTimers.set(workspaceId, timer);
  }

  getSession(workspaceId: string): WhatsAppSession | null {
    return this.sessions.get(workspaceId) || null;
  }

  isConnected(workspaceId: string): boolean {
    const session = this.sessions.get(workspaceId);
    return session?.status === 'ready';
  }

  getQRCode(workspaceId: string): string | null {
    const session = this.sessions.get(workspaceId);
    if (session?.status === 'qr_ready' && session.qrCodeDataUrl) {
      return session.qrCodeDataUrl;
    }
    return null;
  }

  async sendMessage(workspaceId: string, to: string, body: string): Promise<WhatsAppSendResult> {
    const session = this.sessions.get(workspaceId);

    if (!session || session.status !== 'ready') {
      return { success: false, error: 'WhatsApp not connected. Please scan the QR code first.' };
    }

    try {
      let phoneNumber = to.replace(/\D/g, '');
      this.logger.log(`Checking if ${phoneNumber} is registered on WhatsApp`);

      const numberId = await session.client.getNumberId(phoneNumber);
      if (!numberId) {
        this.logger.warn(`Number ${phoneNumber} is not registered on WhatsApp`);
        return { success: false, error: `The number ${to} is not registered on WhatsApp` };
      }

      const chatId = numberId._serialized;
      this.logger.log(`Sending WhatsApp message to ${chatId}`);

      const message = await session.client.sendMessage(chatId, body, { sendSeen: false });
      session.lastActivity = new Date();

      // Forward outbound message to Sigcore
      this.forwardToSigcore(workspaceId, 'message_outbound', {
        externalMessageId: message.id._serialized,
        externalChatId: chatId,
        from: session.phoneNumber || '',
        to: phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`,
        body,
        timestamp: new Date().toISOString(),
      });

      return { success: true, messageId: message.id._serialized };
    } catch (error) {
      this.logger.error(`Failed to send WhatsApp message for workspace ${workspaceId}`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to send message' };
    }
  }

  async disconnect(workspaceId: string): Promise<boolean> {
    // Cancel any pending reconnect
    const reconnectTimer = this.reconnectTimers.get(workspaceId);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      this.reconnectTimers.delete(workspaceId);
    }

    const session = this.sessions.get(workspaceId);
    if (!session) return true;

    try {
      await session.client.logout();
      await session.client.destroy();
      this.sessions.delete(workspaceId);

      const sessionPath = path.join(this.sessionsPath, `session-${workspaceId}`);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }

      this.logger.log(`Disconnected WhatsApp for workspace ${workspaceId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to disconnect WhatsApp for workspace ${workspaceId}`, error);
      return false;
    }
  }

  /**
   * Fetch all individual chats with recent messages (aggregated batch response).
   * Filters out group chats. Normalizes phone numbers.
   */
  async getChatsWithMessages(
    workspaceId: string,
    messageLimit: number = 50,
  ): Promise<{ chats: any[] }> {
    const session = this.sessions.get(workspaceId);
    if (!session || session.status !== 'ready') {
      return { chats: [] };
    }

    let allChats = await session.client.getChats();
    this.logger.log(`[getChatsWithMessages] Total chats from getChats(): ${allChats.length}`);

    // Debug: log server types
    const serverCounts: Record<string, number> = {};
    for (const chat of allChats) {
      const server = chat.id?.server || 'unknown';
      serverCounts[server] = (serverCounts[server] || 0) + 1;
    }
    this.logger.log(`[getChatsWithMessages] Chat server types: ${JSON.stringify(serverCounts)}`);

    // If getChats() returns empty (common after session restore), try forcing chat load
    if (allChats.length === 0) {
      this.logger.log(`[Backfill] getChats() returned 0, attempting store-based fetch...`);
      try {
        // Use WhatsApp Web internal store via Puppeteer to get chat list
        const pupPage = (session.client as any).pupPage;
        if (pupPage) {
          const chatIds: string[] = await pupPage.evaluate(() => {
            const store = (window as any).Store;
            if (!store?.Chat?._models) return [];
            return store.Chat._models
              .filter((c: any) => !c.isGroup && (c.id?.server === 'c.us' || c.id?.server === 'lid'))
              .map((c: any) => c.id?._serialized)
              .filter(Boolean);
          });
          this.logger.log(`[Backfill] Store returned ${chatIds.length} chat IDs`);
          if (chatIds.length > 0) {
            const chatPromises = chatIds.map(id =>
              session.client.getChatById(id).catch(() => null)
            );
            const chats = await Promise.all(chatPromises);
            allChats = chats.filter(Boolean) as any[];
          }
        }
      } catch (e) {
        this.logger.warn(`[Backfill] Store-based fetch failed: ${e instanceof Error ? e.message : 'unknown'}`);
      }
    }

    // Individual chats only — include c.us (traditional) and lid (multi-device linked IDs)
    const individualChats = allChats.filter(
      (chat) => !chat.isGroup && (chat.id.server === 'c.us' || chat.id.server === 'lid'),
    );

    this.logger.log(
      `[Backfill] ${individualChats.length} individual chats for workspace ${workspaceId}`,
    );

    const result: any[] = [];

    for (const chat of individualChats) {
      // Resolve real phone number + name via contact
      const info = await this.resolveContactInfo(session, chat);
      const phone = info.phone;

      // Skip contacts without a resolvable phone number
      if (!phone) continue;

      let messages: any[] = [];
      if (messageLimit > 0) {
        try {
          const fetched = await chat.fetchMessages({ limit: messageLimit });
          messages = fetched.map((msg) => ({
            id: msg.id._serialized,
            from: msg.fromMe ? (session.phoneNumber || '') : phone,
            to: msg.fromMe ? phone : (session.phoneNumber || ''),
            body: msg.body || '',
            timestamp: msg.timestamp
              ? new Date(msg.timestamp * 1000).toISOString()
              : new Date().toISOString(),
            fromMe: msg.fromMe || false,
            hasMedia: msg.hasMedia || false,
            type: msg.type || 'chat',
          }));
        } catch (e) {
          this.logger.warn(
            `[getChatsWithMessages] Failed to fetch messages for ${phone}: ${e instanceof Error ? e.message : 'unknown'}`,
          );
        }
      }

      result.push({
        id: chat.id._serialized,
        name: info.name || null,
        phone,
        avatarUrl: info.avatarUrl || null,
        lastMessageAt: chat.timestamp
          ? new Date(chat.timestamp * 1000).toISOString()
          : null,
        unreadCount: chat.unreadCount || 0,
        messages,
      });
    }

    this.logger.log(
      `[Backfill] Returning ${result.length} chats with messages for workspace ${workspaceId}`,
    );
    return { chats: result };
  }

  /**
   * Resolve the display name, avatar, and real phone number for a chat contact.
   * LID (Linked ID) chats don't expose the phone number directly —
   * we need to look it up via contact.number or contact.id.user.
   */
  private async resolveContactInfo(
    session: WhatsAppSession,
    chat: any,
  ): Promise<{ name: string | null; avatarUrl: string | null; phone: string | null }> {
    const chatId = chat.id._serialized;
    const chatName = chat.name || null;

    try {
      const contact = await session.client.getContactById(chatId);
      const name = contact?.name || contact?.pushname || chatName || null;

      // Resolve real phone number:
      // - contact.number is the actual phone number (available for saved contacts)
      // - For LID chats, chat.id.user is an opaque ID, NOT a phone number
      let phone: string | null = null;
      if (contact?.number) {
        phone = contact.number.startsWith('+') ? contact.number : `+${contact.number}`;
      } else if (chat.id.server === 'c.us' && chat.id.user && chat.id.user !== '0') {
        // Traditional c.us chats — user IS the phone number
        phone = chat.id.user.startsWith('+') ? chat.id.user : `+${chat.id.user}`;
      }
      // For LID chats without contact.number, phone stays null (we can't resolve it)

      let avatarUrl: string | null = null;
      try {
        avatarUrl = await contact?.getProfilePicUrl() || null;
      } catch {
        // Privacy settings may block profile pic
      }

      return { name, avatarUrl, phone };
    } catch {
      // Fallback: use chat.id.user only for c.us chats
      let phone: string | null = null;
      if (chat.id.server === 'c.us' && chat.id.user && chat.id.user !== '0') {
        phone = chat.id.user.startsWith('+') ? chat.id.user : `+${chat.id.user}`;
      }
      return { name: chatName || null, avatarUrl: null, phone };
    }
  }

  /**
   * Auto-sync chats after WhatsApp is ready.
   * Flow: 1) fetch chats, 2) resolve contact names, 3) send contacts_sync, 4) sync messages
   * Retries every 15s (up to 4 times) waiting for chats to populate.
   */
  private scheduleAutoSync(workspaceId: string, session: WhatsAppSession): void {
    let attempt = 0;
    const maxAttempts = 5;
    const delayMs = 20000; // 20s between attempts — gives WhatsApp Web time to load chats

    const trySync = async () => {
      attempt++;
      if (session.status !== 'ready') {
        this.logger.log(`[AutoSync] Session no longer ready, stopping (attempt ${attempt})`);
        return;
      }

      this.logger.log(`[AutoSync] Attempt ${attempt}/${maxAttempts} — fetching chats for workspace ${workspaceId}`);
      const allChats = await session.client.getChats();

      // Debug: log server types to diagnose filtering
      const serverCounts: Record<string, number> = {};
      for (const chat of allChats) {
        const server = chat.id?.server || 'unknown';
        serverCounts[server] = (serverCounts[server] || 0) + 1;
      }
      this.logger.log(`[AutoSync] Chat server types: ${JSON.stringify(serverCounts)}`);

      // Log first 5 chats for debugging
      for (const chat of allChats.slice(0, 5)) {
        this.logger.log(`[AutoSync] Sample chat: id=${chat.id._serialized} server=${chat.id.server} name=${chat.name} isGroup=${chat.isGroup}`);
      }

      const individualChats = allChats.filter((c) => !c.isGroup && (c.id.server === 'c.us' || c.id.server === 'lid'));
      this.logger.log(`[AutoSync] Found ${individualChats.length} individual chats (${allChats.length} total)`);

      if (individualChats.length === 0 && attempt < maxAttempts) {
        this.logger.log(`[AutoSync] No chats yet, retrying in ${delayMs / 1000}s...`);
        setTimeout(trySync, delayMs);
        return;
      }

      // Step 1: Resolve all contact names, avatars, and real phone numbers
      const contactInfo = new Map<string, { name: string | null; avatarUrl: string | null; phone: string | null }>();
      this.logger.log(`[AutoSync] Resolving contact info for ${individualChats.length} chats...`);
      for (const chat of individualChats) {
        const info = await this.resolveContactInfo(session, chat);
        contactInfo.set(chat.id._serialized, info);
        this.logger.log(`[AutoSync] Contact: ${info.phone || chat.id._serialized} → name=${info.name || 'none'} server=${chat.id.server}${info.avatarUrl ? ' (has avatar)' : ''}`);
      }

      // Step 2: Send contacts_sync batch event (names + avatars arrive before messages)
      const contacts = individualChats.map(chat => {
        const info = contactInfo.get(chat.id._serialized);
        return {
          phone: info?.phone || null,
          externalChatId: chat.id._serialized,
          name: info?.name || null,
          avatarUrl: info?.avatarUrl || null,
        };
      }).filter(c => c.phone && (c.name || c.avatarUrl)); // only contacts with a resolved phone + name/avatar

      if (contacts.length > 0) {
        this.logger.log(`[AutoSync] Sending contacts_sync with ${contacts.length} named contacts`);
        await this.forwardToSigcore(workspaceId, 'contacts_sync', {
          contacts,
          sessionPhone: session.phoneNumber || '',
        });
      }

      // Step 3: Forward each chat's recent messages with resolved phone + contact names
      // fetchMessages() crashes on LID chats (waitForChatLoading bug).
      // Fallback: use Puppeteer to read messages directly from WhatsApp Web's internal store.
      let totalMessages = 0;
      let skippedChats = 0;
      const pupPage = (session.client as any).pupPage;

      for (const chat of individualChats) {
        const chatInfo = contactInfo.get(chat.id._serialized);
        const contactPhone = chatInfo?.phone;

        if (!contactPhone) {
          skippedChats++;
          continue;
        }

        let rawMessages: any[] = [];

        // Try standard fetchMessages first
        try {
          const fetched = await chat.fetchMessages({ limit: 20 });
          rawMessages = fetched;
        } catch {
          // Fallback: read messages from WhatsApp Web store via Puppeteer.
          // First, force-load the chat to populate msgs._models in memory.
          if (pupPage) {
            try {
              const storeMessages = await pupPage.evaluate(async (chatId: string) => {
                const store = (window as any).Store;
                if (!store?.Chat) return [];
                const chat = store.Chat.get(chatId);
                if (!chat) return [];

                // Force-load message history if not already loaded
                if (!chat.msgs?._models?.length) {
                  try {
                    // loadEarlierMsgs triggers WhatsApp to fetch message history from server
                    await chat.loadEarlierMsgs?.();
                  } catch {
                    // Some chats don't support this — proceed with what we have
                  }
                }

                const msgs = chat.msgs?._models || [];
                return msgs.slice(-20).map((m: any) => ({
                  id: m.id?._serialized || '',
                  body: m.body || '',
                  fromMe: m.id?.fromMe || false,
                  timestamp: m.t || 0,
                  type: m.type || 'chat',
                  hasMedia: !!(m.mediaData || m.isMedia),
                })).filter((m: any) => m.body || m.hasMedia);
              }, chat.id._serialized);
              rawMessages = storeMessages;
              if (storeMessages.length > 0) {
                this.logger.log(`[AutoSync] Store fallback: got ${storeMessages.length} messages for ${contactPhone}`);
              }
            } catch (storeErr) {
              this.logger.debug(`[AutoSync] Store fallback also failed for ${contactPhone}`);
            }
          }
        }

        for (const msg of rawMessages) {
          const body = msg.body || '';
          if (!body && !msg.hasMedia) continue;
          const isFromMe = msg.fromMe || false;
          const msgId = msg.id?._serialized || msg.id || `wa_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          // msg.timestamp can be unix seconds (from store) or already a Date (from fetchMessages)
          const ts = msg.timestamp;
          let isoTimestamp: string;
          if (ts instanceof Date) {
            isoTimestamp = ts.toISOString();
          } else if (typeof ts === 'number' && ts > 1000000000) {
            // Unix seconds (>2001) — convert to ms
            isoTimestamp = new Date(ts > 9999999999 ? ts : ts * 1000).toISOString();
          } else {
            isoTimestamp = new Date().toISOString();
          }
          await this.forwardToSigcore(workspaceId, 'message_inbound', {
            externalMessageId: msgId,
            externalChatId: chat.id._serialized,
            from: isFromMe ? (session.phoneNumber || '') : contactPhone,
            to: isFromMe ? contactPhone : (session.phoneNumber || ''),
            body,
            timestamp: isoTimestamp,
            hasMedia: msg.hasMedia || false,
            type: msg.type || 'chat',
            fromMe: isFromMe,
            contactName: chatInfo?.name || null,
          });
          totalMessages++;
        }
      }
      this.logger.log(`[AutoSync] Done: ${individualChats.length} chats, ${contacts.length} with names, ${skippedChats} skipped (no phone), ${totalMessages} messages forwarded`);
    };

    // First attempt after 15s delay
    setTimeout(trySync, delayMs);
  }

  getConnectedSessions(): Array<{ workspaceId: string; phoneNumber?: string; status: string }> {
    const result: Array<{ workspaceId: string; phoneNumber?: string; status: string }> = [];
    for (const [workspaceId, session] of this.sessions) {
      result.push({ workspaceId, phoneNumber: session.phoneNumber, status: session.status });
    }
    return result;
  }
}
