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

interface StoreMessage {
  id: { _serialized: string };
  body?: string;
  type?: string;
  timestamp?: number;
  fromMe?: boolean;
  hasMedia?: boolean;
}

@Injectable()
export class WhatsAppService implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private sessions: Map<string, WhatsAppSession> = new Map();
  private readonly sessionsPath: string;
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  // LID→phone map built from getContacts() — reused across sync + real-time
  private contactPhoneMap: Map<string, { phone: string; name: string | null }> = new Map();
  // Flag to suppress reaction/call events during auto-sync
  private syncing = false;

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
    for (const [, timer] of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const [workspaceId, session] of this.sessions) {
      try { await session.client.destroy(); } catch {}
    }
    this.sessions.clear();
  }

  // =========================================================================
  // Session lifecycle
  // =========================================================================

  async initializeClient(workspaceId: string): Promise<WhatsAppSession> {
    const existing = this.sessions.get(workspaceId);
    if (existing?.status === 'ready') return existing;
    if (existing) { try { await existing.client.destroy(); } catch {} }

    const timer = this.reconnectTimers.get(workspaceId);
    if (timer) { clearTimeout(timer); this.reconnectTimers.delete(workspaceId); }

    this.logger.log(`Initializing WhatsApp client for workspace ${workspaceId}`);
    const session: WhatsAppSession = { workspaceId, client: null as any, status: 'initializing' };

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: workspaceId, dataPath: this.sessionsPath }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
               '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
               '--disable-gpu', '--single-process'],
      },
    });

    session.client = client;
    this.sessions.set(workspaceId, session);
    this.setupEventHandlers(workspaceId, client, session);

    try {
      await client.initialize();
    } catch (error) {
      this.logger.error(`Failed to initialize for workspace ${workspaceId}`, error);
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
      try { session.qrCodeDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 }); } catch {}
    });

    client.on('authenticated', () => {
      this.logger.log(`Authenticated for workspace ${workspaceId}`);
      session.status = 'authenticated';
      session.qrCode = undefined;
      session.qrCodeDataUrl = undefined;
    });

    client.on('ready', async () => {
      this.logger.log(`WhatsApp ready for workspace ${workspaceId}`);
      session.status = 'ready';
      session.lastActivity = new Date();
      try {
        session.phoneNumber = client.info?.wid?.user ? `+${client.info.wid.user}` : undefined;
        this.logger.log(`Connected number: ${session.phoneNumber}`);
      } catch {}

      this.forwardToSigcore(workspaceId, 'status_change', { status: 'ready', phoneNumber: session.phoneNumber });

      // Build contact map + auto-sync (with delay for WhatsApp to load)
      this.scheduleAutoSync(workspaceId, session);
    });

    client.on('disconnected', (reason: string) => {
      this.logger.warn(`Disconnected for workspace ${workspaceId}: ${reason}`);
      session.status = 'disconnected';
      session.error = reason;
      this.forwardToSigcore(workspaceId, 'status_change', { status: 'disconnected', reason });
      this.scheduleReconnect(workspaceId, 1);
    });

    client.on('auth_failure', (message: string) => {
      this.logger.error(`Auth failure for workspace ${workspaceId}: ${message}`);
      session.status = 'error';
      session.error = message;
    });

    // Single event listener for ALL messages (suppressed during auto-sync — sync handles its own messages)
    client.on('message_create', (msg) => {
      if (this.syncing) return;
      this.handleRealTimeMessage(workspaceId, session, msg);
    });

    // Reactions: logged but NOT forwarded as messages — they mess up conversation ordering
    // WhatsApp shows reactions inline on the original message, not as separate entries
    client.on('message_reaction', async () => {
      session.lastActivity = new Date();
    });

    // Calls (suppressed during auto-sync)
    client.on('call', async (call: any) => {
      if (this.syncing) return;
      session.lastActivity = new Date();
      const peerId = call.peerJid || call.from || call.peer;
      if (!peerId) return;
      const resolved = this.resolvePhone(peerId);
      if (!resolved) return;
      const isFromMe = call.fromMe || false;
      const callType = call.isVideo ? '📞 Video call' : '📞 Voice call';

      await this.forwardToSigcore(workspaceId, 'message_inbound', {
        externalMessageId: `call_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        externalChatId: peerId,
        from: isFromMe ? (session.phoneNumber || '') : resolved.phone,
        to: isFromMe ? resolved.phone : (session.phoneNumber || ''),
        body: callType,
        timestamp: new Date().toISOString(),
        type: 'call', fromMe: isFromMe,
        contactName: resolved.name,
      });
    });
  }

  // =========================================================================
  // Contact map: LID→phone resolution (BATCH)
  // =========================================================================

  private resolvePhone(chatId: string): { phone: string; name: string | null } | null {
    // Check map first
    const cached = this.contactPhoneMap.get(chatId);
    if (cached) return cached;

    // For c.us, extract phone from ID
    if (chatId.endsWith('@c.us')) {
      const user = chatId.replace('@c.us', '');
      if (user && user !== '0') {
        const phone = user.startsWith('+') ? user : `+${user}`;
        return { phone, name: null };
      }
    }

    // For groups, use the group ID as identifier
    if (chatId.endsWith('@g.us')) {
      return { phone: chatId, name: null };
    }

    return null;
  }

  private async buildContactMap(client: Client): Promise<void> {
    this.logger.log('[ContactMap] Building contact map from getContacts()...');
    try {
      const allContacts = await client.getContacts();
      let mapped = 0;

      for (const contact of allContacts) {
        if (contact.isGroup) continue;

        let phone: string | null = null;
        const name = contact.name || contact.pushname || null;

        // Method 1: contact.number (most reliable in v1.34.6)
        if (contact.number && !contact.number.includes('@')) {
          phone = contact.number.startsWith('+') ? contact.number : `+${contact.number}`;
        }

        // Method 2: For c.us contacts, extract from ID
        if (!phone && contact.id?._serialized?.endsWith('@c.us')) {
          const user = contact.id.user;
          if (user && user !== '0') {
            phone = user.startsWith('+') ? user : `+${user}`;
          }
        }

        // Method 3: getFormattedNumber() as fallback
        if (!phone) {
          try {
            const formatted = await contact.getFormattedNumber();
            if (formatted) {
              phone = formatted.replace(/[\s\-()]/g, '');
              if (!phone.startsWith('+')) phone = `+${phone}`;
            }
          } catch {}
        }

        if (phone && phone.length <= 16) {
          this.contactPhoneMap.set(contact.id._serialized, { phone, name });
          mapped++;
        }
      }

      this.logger.log(`[ContactMap] Mapped ${mapped} contacts out of ${allContacts.length}`);
    } catch (e) {
      this.logger.error(`[ContactMap] Failed: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  // =========================================================================
  // Real-time message handler
  // =========================================================================

  private async handleRealTimeMessage(workspaceId: string, session: WhatsAppSession, message: WAMessage): Promise<void> {
    session.lastActivity = new Date();

    if (!message.from) return;

    const isGroup = message.from.endsWith('@g.us') || (message.to && message.to.endsWith('@g.us'));
    if (!isGroup && !message.from.endsWith('@c.us') && !message.from.endsWith('@lid')) return;

    // Build display body
    const body = this.buildDisplayBody(message.body, message.type, message.hasMedia);
    if (!body) return;

    const isFromMe = message.fromMe || false;

    // Download media for real-time messages
    const media = await this.downloadMessageMedia(message);

    if (isGroup) {
      const groupId = message.from.endsWith('@g.us') ? message.from : message.to;
      let groupName: string | null = null;
      try { const chat = await session.client.getChatById(groupId); groupName = chat?.name || null; } catch {}

      await this.forwardToSigcore(workspaceId, 'message_inbound', {
        externalMessageId: message.id._serialized,
        externalChatId: groupId,
        from: isFromMe ? (session.phoneNumber || '') : groupId,
        to: isFromMe ? groupId : (session.phoneNumber || ''),
        body, timestamp: message.timestamp ? new Date(message.timestamp * 1000).toISOString() : new Date().toISOString(),
        hasMedia: message.hasMedia, type: message.type, fromMe: isFromMe,
        contactName: groupName, isGroup: true,
        ...(media && { mediaData: media.data, mediaMimetype: media.mimetype, mediaFilename: media.filename }),
      });
      return;
    }

    // Individual chat: resolve phone from contact map
    const chatId = isFromMe ? message.to : message.from;
    const resolved = this.resolvePhone(chatId);
    if (!resolved) return;

    await this.forwardToSigcore(workspaceId, 'message_inbound', {
      externalMessageId: message.id._serialized,
      externalChatId: chatId,
      from: isFromMe ? (session.phoneNumber || '') : resolved.phone,
      to: isFromMe ? resolved.phone : (session.phoneNumber || ''),
      body, timestamp: message.timestamp ? new Date(message.timestamp * 1000).toISOString() : new Date().toISOString(),
      hasMedia: message.hasMedia, type: message.type, fromMe: isFromMe,
      contactName: resolved.name,
      ...(media && { mediaData: media.data, mediaMimetype: media.mimetype, mediaFilename: media.filename }),
    });
  }

  private buildDisplayBody(body: string | undefined, type: string, hasMedia: boolean): string {
    const labels: Record<string, string> = {
      image: '📷 Photo', video: '🎥 Video', audio: '🎵 Audio',
      ptt: '🎤 Voice message', document: '📄 Document', sticker: '🏷️ Sticker',
      location: '📍 Location', vcard: '👤 Contact', call_log: '📞 Call',
    };
    if (body && !hasMedia) return body;
    if (body && hasMedia) return `${labels[type] || '📎 Attachment'} ${body}`;
    return labels[type] || (hasMedia ? '📎 Attachment' : '');
  }

  private async downloadMessageMedia(message: WAMessage): Promise<{ data: string; mimetype: string; filename?: string } | null> {
    if (!message.hasMedia) return null;
    try {
      const media = await message.downloadMedia();
      if (!media?.data) return null;
      return { data: media.data, mimetype: media.mimetype, filename: media.filename || undefined };
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Puppeteer store fallback — reads messages from browser memory
  // This is the ONLY method that works for LID chats where fetchMessages crashes
  // =========================================================================

  private async fetchMessagesWithFallback(
    client: Client,
    chat: any,
    limit: number,
  ): Promise<StoreMessage[]> {
    // Try the normal API first
    try {
      const msgs = await chat.fetchMessages({ limit });
      if (msgs && msgs.length > 0) return msgs;
    } catch (e) {
      this.logger.debug(`[Fallback] fetchMessages failed for ${chat.id._serialized}, trying store...`);
    }

    // Puppeteer store fallback: read from WhatsApp Web's in-browser Store
    try {
      const pupPage = (client as any).pupPage;
      if (!pupPage) return [];

      const storeMessages: StoreMessage[] = await pupPage.evaluate(
        (chatId: string, msgLimit: number) => {
          const store = (window as any).Store;
          if (!store?.Chat) return [];
          const storeChat = store.Chat.get(chatId);
          if (!storeChat) return [];

          const models = storeChat.msgs?._models || storeChat.msgs?.models || [];
          const recent = models.slice(-msgLimit);

          return recent.map((m: any) => ({
            id: { _serialized: m.id?._serialized || `store_${Date.now()}_${Math.random().toString(36).substring(7)}` },
            body: m.body || '',
            type: m.type || 'chat',
            timestamp: m.t || m.timestamp || 0,
            fromMe: m.id?.fromMe || false,
            hasMedia: m.isMedia || m.isMMS || false,
          }));
        },
        chat.id._serialized,
        limit,
      );

      if (storeMessages.length > 0) {
        this.logger.debug(`[Fallback] Got ${storeMessages.length} messages from store for ${chat.id._serialized}`);
      }
      return storeMessages;
    } catch (e) {
      this.logger.debug(`[Fallback] Store fallback also failed for ${chat.id._serialized}`);
      return [];
    }
  }

  // =========================================================================
  // Auto-sync: runs after WhatsApp connects
  // =========================================================================

  private scheduleAutoSync(workspaceId: string, session: WhatsAppSession): void {
    // Wait 15s for WhatsApp to load chats, then sync
    setTimeout(() => this.runAutoSync(workspaceId, session), 15000);
  }

  private async runAutoSync(workspaceId: string, session: WhatsAppSession): Promise<void> {
    if (session.status !== 'ready') return;
    this.logger.log(`[AutoSync] Starting for workspace ${workspaceId}`);
    this.syncing = true;

    try {
      // Step 1: Build contact map (BATCH — one API call) with retry
      await this.buildContactMap(session.client);
      if (this.contactPhoneMap.size === 0) {
        this.logger.warn('[AutoSync] ContactMap empty after first attempt, retrying in 5s...');
        await this.delay(5000);
        await this.buildContactMap(session.client);
      }

      // Step 2: Get all chats, sorted by WhatsApp's own timestamp (most recent first)
      const allChats = await session.client.getChats();
      allChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      this.logger.log(`[AutoSync] Got ${allChats.length} chats, contactMap has ${this.contactPhoneMap.size} entries`);

      // Step 3: Build contacts list with metadata from chat objects
      const contacts: Array<{
        phone: string; externalChatId: string; name: string | null;
        avatarUrl: string | null; isGroup?: boolean;
        lastActivityAt: string | null; lastMessagePreview: string | null;
        unreadCount?: number;
      }> = [];

      // Resolve avatars in batch — try API first, then Puppeteer store fallback
      const avatarMap = new Map<string, string>();
      let avatarResolved = 0;

      // Method 1: client.getProfilePicUrl (works when privacy allows)
      for (const chat of allChats) {
        try {
          const url = await session.client.getProfilePicUrl(chat.id._serialized);
          if (url) {
            avatarMap.set(chat.id._serialized, url);
            avatarResolved++;
          }
        } catch {}
      }
      this.logger.log(`[AutoSync] Avatars from API: ${avatarResolved}/${allChats.length}`);

      // Method 2: Puppeteer store fallback — read profile pics WhatsApp Web has cached
      if (avatarResolved < allChats.length / 2) {
        try {
          const pupPage = (session.client as any).pupPage;
          if (pupPage) {
            const storeAvatars: Array<{ id: string; url: string }> = await pupPage.evaluate(() => {
              const store = (window as any).Store;
              if (!store?.ProfilePicThumb) return [];
              const results: Array<{ id: string; url: string }> = [];
              const thumbs = store.ProfilePicThumb.getModelsArray?.() || [];
              for (const thumb of thumbs) {
                const url = thumb.imgFull || thumb.img;
                if (url && thumb.id) {
                  results.push({ id: typeof thumb.id === 'string' ? thumb.id : thumb.id._serialized, url });
                }
              }
              return results;
            });

            for (const { id, url } of storeAvatars) {
              if (!avatarMap.has(id) && url) {
                avatarMap.set(id, url);
              }
            }
            this.logger.log(`[AutoSync] Avatars after store fallback: ${avatarMap.size}/${allChats.length}`);
          }
        } catch (e) {
          this.logger.debug(`[AutoSync] Store avatar fallback failed: ${e instanceof Error ? e.message : 'unknown'}`);
        }
      }

      // Per-chat contact fallback: if contactMap is empty, resolve per chat
      for (const chat of allChats) {
        const isGroup = chat.isGroup;
        const lastActivityAt = chat.timestamp ? new Date(chat.timestamp * 1000).toISOString() : null;
        const lastMsg = chat.lastMessage;
        const lastMessagePreview = lastMsg ? this.buildDisplayBody(lastMsg.body, lastMsg.type, lastMsg.hasMedia) : null;
        const avatar = avatarMap.get(chat.id._serialized) || null;

        if (isGroup) {
          if (!chat.name) continue;
          contacts.push({
            phone: chat.id._serialized,
            externalChatId: chat.id._serialized,
            name: chat.name,
            avatarUrl: avatar,
            isGroup: true,
            lastActivityAt,
            lastMessagePreview,
            unreadCount: chat.unreadCount || 0,
          });
        } else {
          let resolved = this.resolvePhone(chat.id._serialized);

          // Fallback: if contactMap missed this chat, try per-chat getContact()
          if (!resolved) {
            try {
              const contact = await chat.getContact();
              if (contact) {
                let phone: string | null = null;
                if (contact.number) {
                  phone = contact.number.startsWith('+') ? contact.number : `+${contact.number}`;
                }
                if (!phone) {
                  try {
                    const formatted = await contact.getFormattedNumber();
                    if (formatted) {
                      phone = formatted.replace(/[\s\-()]/g, '');
                      if (!phone.startsWith('+')) phone = `+${phone}`;
                    }
                  } catch {}
                }
                if (phone) {
                  const name = contact.name || contact.pushname || null;
                  this.contactPhoneMap.set(chat.id._serialized, { phone, name });
                  resolved = { phone, name };
                }
              }
            } catch {}
          }

          if (!resolved) continue;
          const contactInfo = this.contactPhoneMap.get(chat.id._serialized);
          contacts.push({
            phone: resolved.phone,
            externalChatId: chat.id._serialized,
            name: contactInfo?.name || resolved.name || chat.name || null,
            avatarUrl: avatar,
            lastActivityAt,
            lastMessagePreview,
            unreadCount: chat.unreadCount || 0,
          });
        }
      }

      // Step 4: Send contacts_sync (names + order arrive BEFORE messages)
      if (contacts.length > 0) {
        this.logger.log(`[AutoSync] Sending contacts_sync: ${contacts.length} contacts`);
        await this.forwardToSigcore(workspaceId, 'contacts_sync', {
          contacts,
          sessionPhone: session.phoneNumber || '',
        });
      }

      // Step 5: Sync messages for each chat (with throttle to avoid 429)
      let totalMessages = 0;
      let syncedChats = 0;

      for (const chat of allChats) {
        if (session.status !== 'ready') break;

        const isGroup = chat.isGroup;
        let chatPhone: string | null = null;
        let chatName: string | null = null;

        if (isGroup) {
          if (!chat.name) continue;
          chatPhone = chat.id._serialized;
          chatName = chat.name;
        } else {
          const resolved = this.resolvePhone(chat.id._serialized);
          if (!resolved) continue;
          chatPhone = resolved.phone;
          chatName = this.contactPhoneMap.get(chat.id._serialized)?.name || resolved.name;
        }

        // Sync history from server, then fetch messages (with Puppeteer fallback)
        try { await chat.syncHistory(); } catch {}

        const messages = await this.fetchMessagesWithFallback(session.client, chat, 20);

        for (const msg of messages) {
          const body = this.buildDisplayBody(msg.body, msg.type, msg.hasMedia);
          if (!body) continue;

          const isFromMe = msg.fromMe || false;
          const ts = msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : new Date().toISOString();

          await this.forwardToSigcore(workspaceId, 'message_inbound', {
            externalMessageId: msg.id._serialized,
            externalChatId: chat.id._serialized,
            from: isFromMe ? (session.phoneNumber || '') : (isGroup ? chat.id._serialized : chatPhone),
            to: isFromMe ? (isGroup ? chat.id._serialized : chatPhone) : (session.phoneNumber || ''),
            body, timestamp: ts,
            hasMedia: msg.hasMedia, type: msg.type,
            fromMe: isFromMe, contactName: chatName,
            ...(isGroup && { isGroup: true }),
          });
          totalMessages++;

          // Throttle: 75ms between messages to avoid 429 on Sigcore
          await this.delay(75);
        }
        syncedChats++;
      }

      this.logger.log(`[AutoSync] Done: ${syncedChats} chats synced, ${totalMessages} messages forwarded`);
    } finally {
      this.syncing = false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // =========================================================================
  // Forwarding to Sigcore
  // =========================================================================

  private async forwardToSigcore(workspaceId: string, eventType: string, data: Record<string, unknown>): Promise<void> {
    const sigcoreUrl = process.env.SIGCORE_API_URL;
    const webhookKey = process.env.SIGCORE_WEBHOOK_KEY;
    if (!sigcoreUrl || !webhookKey) return;

    try {
      await axios.post(
        `${sigcoreUrl}/webhooks/whatsapp/inbound`,
        { workspaceId, eventType, data, timestamp: new Date().toISOString() },
        { headers: { 'x-webhook-key': webhookKey, 'Content-Type': 'application/json' }, timeout: 30000 },
      );
    } catch (error) {
      this.logger.warn(`Failed to forward ${eventType}: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  // =========================================================================
  // Reconnection
  // =========================================================================

  private scheduleReconnect(workspaceId: string, attempt: number): void {
    if (attempt > 5) return;
    const delayMs = Math.min(5000 * Math.pow(2, attempt - 1), 80000);
    this.logger.log(`Reconnect scheduled for workspace ${workspaceId} in ${delayMs}ms (attempt ${attempt})`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(workspaceId);
      const session = this.sessions.get(workspaceId);
      if (session?.status === 'disconnected') {
        try { await this.initializeClient(workspaceId); } catch {
          this.scheduleReconnect(workspaceId, attempt + 1);
        }
      }
    }, delayMs);
    this.reconnectTimers.set(workspaceId, timer);
  }

  // =========================================================================
  // Public API (used by controller)
  // =========================================================================

  getSession(workspaceId: string): WhatsAppSession | null {
    return this.sessions.get(workspaceId) || null;
  }

  async downloadMediaForMessage(
    workspaceId: string,
    chatId: string,
    messageId: string,
  ): Promise<{ data: string; mimetype: string; filename?: string } | null> {
    const session = this.sessions.get(workspaceId);
    if (!session || session.status !== 'ready') return null;

    try {
      const chat = await session.client.getChatById(chatId);
      if (!chat) return null;

      const messages = await chat.fetchMessages({ limit: 50 });
      const target = messages.find(m => m.id._serialized === messageId);
      if (!target || !target.hasMedia) return null;

      const media = await target.downloadMedia();
      if (!media?.data) return null;
      return { data: media.data, mimetype: media.mimetype, filename: media.filename || undefined };
    } catch (e) {
      this.logger.debug(`[Media] Failed to download: ${e instanceof Error ? e.message : 'unknown'}`);
      return null;
    }
  }

  isConnected(workspaceId: string): boolean {
    return this.sessions.get(workspaceId)?.status === 'ready';
  }

  getQRCode(workspaceId: string): string | null {
    const session = this.sessions.get(workspaceId);
    return session?.status === 'qr_ready' && session.qrCodeDataUrl ? session.qrCodeDataUrl : null;
  }

  async sendMessage(workspaceId: string, to: string, body: string): Promise<WhatsAppSendResult> {
    const session = this.sessions.get(workspaceId);
    if (!session || session.status !== 'ready') {
      return { success: false, error: 'WhatsApp not connected.' };
    }

    try {
      const phoneNumber = to.replace(/\D/g, '');
      const numberId = await session.client.getNumberId(phoneNumber);
      if (!numberId) return { success: false, error: `${to} is not on WhatsApp` };

      const chatId = numberId._serialized;
      const message = await session.client.sendMessage(chatId, body, { sendSeen: false });
      session.lastActivity = new Date();
      return { success: true, messageId: message.id._serialized };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to send' };
    }
  }

  async disconnect(workspaceId: string): Promise<boolean> {
    const timer = this.reconnectTimers.get(workspaceId);
    if (timer) { clearTimeout(timer); this.reconnectTimers.delete(workspaceId); }

    const session = this.sessions.get(workspaceId);
    if (!session) return true;

    try {
      await session.client.logout();
      await session.client.destroy();
      this.sessions.delete(workspaceId);
      const sessionPath = path.join(this.sessionsPath, `session-${workspaceId}`);
      if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  getConnectedSessions(): Array<{ workspaceId: string; phoneNumber?: string; status: string }> {
    return Array.from(this.sessions.entries()).map(([workspaceId, session]) => ({
      workspaceId, phoneNumber: session.phoneNumber, status: session.status,
    }));
  }

  async getChatsWithMessages(workspaceId: string, messageLimit = 50): Promise<{ chats: any[] }> {
    const session = this.sessions.get(workspaceId);
    if (!session || session.status !== 'ready') return { chats: [] };

    const allChats = await session.client.getChats();
    allChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const result: any[] = [];
    for (const chat of allChats) {
      if (chat.isGroup) {
        if (!chat.name) continue;
        let messages: any[] = [];
        if (messageLimit > 0) {
          try {
            const fetched = await chat.fetchMessages({ limit: messageLimit });
            messages = fetched.map(msg => ({
              id: msg.id._serialized,
              from: msg.fromMe ? (session.phoneNumber || '') : chat.id._serialized,
              to: msg.fromMe ? chat.id._serialized : (session.phoneNumber || ''),
              body: this.buildDisplayBody(msg.body, msg.type, msg.hasMedia),
              timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : new Date().toISOString(),
              fromMe: msg.fromMe || false, hasMedia: msg.hasMedia || false, type: msg.type || 'chat',
            }));
          } catch {}
        }
        result.push({
          id: chat.id._serialized, name: chat.name, phone: chat.id._serialized,
          avatarUrl: null, isGroup: true,
          lastMessageAt: chat.timestamp ? new Date(chat.timestamp * 1000).toISOString() : null,
          unreadCount: chat.unreadCount || 0, messages,
        });
      } else {
        const resolved = this.resolvePhone(chat.id._serialized);
        if (!resolved) continue;
        const contactInfo = this.contactPhoneMap.get(chat.id._serialized);

        let messages: any[] = [];
        if (messageLimit > 0) {
          try {
            const fetched = await chat.fetchMessages({ limit: messageLimit });
            messages = fetched.map(msg => ({
              id: msg.id._serialized,
              from: msg.fromMe ? (session.phoneNumber || '') : resolved.phone,
              to: msg.fromMe ? resolved.phone : (session.phoneNumber || ''),
              body: this.buildDisplayBody(msg.body, msg.type, msg.hasMedia),
              timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : new Date().toISOString(),
              fromMe: msg.fromMe || false, hasMedia: msg.hasMedia || false, type: msg.type || 'chat',
            }));
          } catch {}
        }
        result.push({
          id: chat.id._serialized, name: contactInfo?.name || resolved.name || chat.name || null,
          phone: resolved.phone, avatarUrl: null,
          lastMessageAt: chat.timestamp ? new Date(chat.timestamp * 1000).toISOString() : null,
          unreadCount: chat.unreadCount || 0, messages,
        });
      }
    }

    return { chats: result };
  }
}
