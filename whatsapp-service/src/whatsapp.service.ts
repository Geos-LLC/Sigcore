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
  // LID→phone map built from getContacts() — reused across sync + real-time
  private contactPhoneMap: Map<string, { phone: string; name: string | null }> = new Map();

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

    // Single event listener for ALL messages (incoming + sent + synced history)
    client.on('message_create', (msg) => this.handleRealTimeMessage(workspaceId, session, msg));

    // Reactions
    client.on('message_reaction', async (reaction: any) => {
      if (!reaction.msgId || !reaction.reaction) return;
      session.lastActivity = new Date();
      const senderId = reaction.senderId || reaction.id?.participant;
      const resolved = senderId ? this.resolvePhone(senderId) : null;
      if (!resolved) return;

      await this.forwardToSigcore(workspaceId, 'message_inbound', {
        externalMessageId: `react_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        externalChatId: senderId,
        from: resolved.phone,
        to: session.phoneNumber || '',
        body: `Reacted ${reaction.reaction}`,
        timestamp: new Date().toISOString(),
        type: 'reaction', fromMe: false,
        contactName: resolved.name,
      });
    });

    // Calls
    client.on('call', async (call: any) => {
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
    });
  }

  private buildDisplayBody(body: string | undefined, type: string, hasMedia: boolean): string {
    if (body) return body;
    const labels: Record<string, string> = {
      image: '📷 Photo', video: '🎥 Video', audio: '🎵 Audio',
      ptt: '🎤 Voice message', document: '📄 Document', sticker: '🏷️ Sticker',
      location: '📍 Location', vcard: '👤 Contact', call_log: '📞 Call',
    };
    return labels[type] || (hasMedia ? '📎 Attachment' : '');
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

    // Step 1: Build contact map (BATCH — one API call)
    await this.buildContactMap(session.client);

    // Step 2: Get all chats, sorted by WhatsApp's own timestamp (most recent first)
    let allChats = await session.client.getChats();
    allChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    this.logger.log(`[AutoSync] Got ${allChats.length} chats`);

    // Step 3: Build contacts list with metadata from chat objects
    const contacts: Array<{
      phone: string; externalChatId: string; name: string | null;
      avatarUrl: string | null; isGroup?: boolean;
      lastActivityAt: string | null; lastMessagePreview: string | null;
    }> = [];

    // Resolve avatars in batch
    const avatarMap = new Map<string, string | null>();
    for (const chat of allChats) {
      try {
        const url = await session.client.getProfilePicUrl(chat.id._serialized);
        if (url) avatarMap.set(chat.id._serialized, url);
      } catch {}
    }

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
        });
      } else {
        const resolved = this.resolvePhone(chat.id._serialized);
        if (!resolved) continue;
        const contactInfo = this.contactPhoneMap.get(chat.id._serialized);
        contacts.push({
          phone: resolved.phone,
          externalChatId: chat.id._serialized,
          name: contactInfo?.name || resolved.name || chat.name || null,
          avatarUrl: avatar,
          lastActivityAt,
          lastMessagePreview,
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

    // Step 5: Sync messages for each chat
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

      // Sync history from server, then fetch messages
      try { await chat.syncHistory(); } catch {}

      let messages: WAMessage[] = [];
      try {
        messages = await chat.fetchMessages({ limit: 20 });
      } catch (e) {
        this.logger.debug(`[AutoSync] fetchMessages failed for ${chatPhone}: ${e instanceof Error ? e.message : 'unknown'}`);
        continue;
      }

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
      }
      syncedChats++;
    }

    this.logger.log(`[AutoSync] Done: ${syncedChats} chats synced, ${totalMessages} messages forwarded`);
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
