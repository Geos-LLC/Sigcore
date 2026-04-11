import { useState, useEffect, useRef, useCallback } from 'react';
import { CheckCircle, XCircle, Loader2, Plug, Unplug, MessageSquare, QrCode, RefreshCw, Send, Smartphone, Database, ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, Users } from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import { adminApi } from '../../services/adminApi';

type Status = 'idle' | 'loading' | 'success' | 'error';

interface SyncedConversation {
  id: string;
  phoneNumber: string;
  participantPhoneNumber: string;
  contactId: string | null;
  contactName: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  metadata?: { avatarUrl?: string; isGroup?: boolean };
  participantContacts?: { phoneNumber: string; contactName: string | null }[] | null;
}

export default function AdminWhatsAppTestPage() {
  // Connection state
  const [status, setStatus] = useState<string>('unknown');
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [serviceAvailable, setServiceAvailable] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Message sending
  const [toNumber, setToNumber] = useState(() => localStorage.getItem('wa_test_to') || '');
  const [messageBody, setMessageBody] = useState('');
  const [sendStatus, setSendStatus] = useState<Status>('idle');
  const [sendResult, setSendResult] = useState<any>(null);

  // Synced conversations
  const [conversations, setConversations] = useState<SyncedConversation[]>([]);
  const [convMeta, setConvMeta] = useState<{ total: number; page: number; totalPages: number } | null>(null);
  const [convLoading, setConvLoading] = useState(false);
  const [convPage, setConvPage] = useState(1);
  const [expandedConv, setExpandedConv] = useState<string | null>(null);
  const [convMessages, setConvMessages] = useState<Record<string, any[]>>({});
  const [convHasMore, setConvHasMore] = useState<Record<string, boolean>>({});
  const [loadingMessages, setLoadingMessages] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const msgContainerRef = useRef<HTMLDivElement | null>(null);
  const [syncPollCount, setSyncPollCount] = useState(0);

  // QR polling
  const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Sync polling
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // WebSocket
  const socketRef = useRef<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);

  useEffect(() => {
    checkHealth();
    checkStatus();
    connectSocket();
    return () => {
      stopQrPolling();
      stopSyncPolling();
      socketRef.current?.disconnect();
    };
  }, []);

  // Load conversations when connected
  useEffect(() => {
    if (status === 'ready') {
      loadConversations(1);
    }
  }, [status]);

  // WebSocket: connect and listen for new messages
  function connectSocket() {
    const workspaceId = adminApi.getWorkspaceId();
    if (!workspaceId || socketRef.current?.connected) return;

    if (socketRef.current) socketRef.current.disconnect();

    const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
    const socketUrl = apiUrl && apiUrl.startsWith('http') ? new URL(apiUrl).origin : undefined;

    const socket = io(socketUrl || window.location.origin, {
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      setSocketConnected(true);
      socket.emit('join', workspaceId);
    });

    socket.on('disconnect', () => setSocketConnected(false));

    // Real-time: when a new message arrives, reload conversations so it jumps to top
    socket.on('message:new', (data: any) => {
      if (data?.message?.channel === 'whatsapp' || data?.message?.provider === 'whatsapp') {
        loadConversations(1, true);
        // If the conversation is expanded, refresh its messages too
        if (expandedConv && data?.conversationId === expandedConv) {
          loadMessagesForConv(expandedConv);
        }
      }
    });

    socketRef.current = socket;
  }

  async function checkHealth() {
    try {
      const result = await adminApi.getWhatsAppHealth();
      setServiceAvailable(result.available);
    } catch {
      setServiceAvailable(false);
    }
  }

  async function checkStatus() {
    try {
      const result = await adminApi.getWhatsAppStatus();
      setStatus(result.status);
      setPhoneNumber(result.phoneNumber || null);
      setError(result.error || null);
      if (result.status === 'ready') {
        setQrCode(null);
        stopQrPolling();
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    setQrCode(null);
    try {
      await adminApi.connectWhatsApp();
      startQrPolling();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setError(null);
    try {
      await adminApi.disconnectWhatsApp();
      setStatus('disconnected');
      setPhoneNumber(null);
      setQrCode(null);
      setConversations([]);
      setConvMeta(null);
      stopQrPolling();
      stopSyncPolling();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDisconnecting(false);
    }
  }

  function startQrPolling() {
    stopQrPolling();
    pollQr();
    qrPollRef.current = setInterval(pollQr, 3000);
  }

  function stopQrPolling() {
    if (qrPollRef.current) { clearInterval(qrPollRef.current); qrPollRef.current = null; }
  }

  async function pollQr() {
    try {
      const result = await adminApi.getWhatsAppQR();
      if (result.connected) {
        setStatus('ready');
        setPhoneNumber(result.phoneNumber || null);
        setQrCode(null);
        stopQrPolling();
        startSyncPolling();
        return;
      }
      if (result.qrCode) { setQrCode(result.qrCode); setStatus('qr_ready'); }
      else { setStatus(result.status || 'initializing'); }
    } catch { /* ignore */ }
  }

  function startSyncPolling() {
    stopSyncPolling();
    setSyncPollCount(0);
    syncPollRef.current = setInterval(async () => {
      setSyncPollCount(prev => prev + 1);
      await loadConversations(1, true);
    }, 5000);
    setTimeout(() => stopSyncPolling(), 90000);
  }

  function stopSyncPolling() {
    if (syncPollRef.current) { clearInterval(syncPollRef.current); syncPollRef.current = null; }
  }

  const loadConversations = useCallback(async (page: number, silent = false) => {
    if (!silent) setConvLoading(true);
    try {
      const result = await adminApi.getConversations({ page, limit: 20, provider: 'whatsapp' });
      setConversations(result.conversations);
      setConvMeta(result.meta);
      setConvPage(page);
    } catch { /* ignore */ }
    finally { if (!silent) setConvLoading(false); }
  }, []);

  async function loadMessagesForConv(convId: string) {
    setLoadingMessages(convId);
    try {
      const result = await adminApi.getConversationMessages(convId, { limit: 30 });
      setConvMessages(prev => ({ ...prev, [convId]: result.data }));
      setConvHasMore(prev => ({ ...prev, [convId]: result.hasMore }));
      // Scroll to bottom after initial load
      setTimeout(() => {
        if (msgContainerRef.current) {
          msgContainerRef.current.scrollTop = msgContainerRef.current.scrollHeight;
        }
      }, 50);
    } catch {
      setConvMessages(prev => ({ ...prev, [convId]: [] }));
      setConvHasMore(prev => ({ ...prev, [convId]: false }));
    } finally {
      setLoadingMessages(null);
    }
  }

  async function loadOlderMessages(convId: string) {
    const existing = convMessages[convId];
    if (!existing || existing.length === 0 || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const oldest = existing[0];
      const result = await adminApi.getConversationMessages(convId, { limit: 30, before: oldest.createdAt });
      if (result.data.length > 0) {
        // Preserve scroll position
        const container = msgContainerRef.current;
        const prevHeight = container?.scrollHeight || 0;
        setConvMessages(prev => ({ ...prev, [convId]: [...result.data, ...(prev[convId] || [])] }));
        setConvHasMore(prev => ({ ...prev, [convId]: result.hasMore }));
        setTimeout(() => {
          if (container) {
            container.scrollTop = container.scrollHeight - prevHeight;
          }
        }, 50);
      } else {
        setConvHasMore(prev => ({ ...prev, [convId]: false }));
      }
    } catch {
      setConvHasMore(prev => ({ ...prev, [convId]: false }));
    } finally {
      setLoadingOlder(false);
    }
  }

  function handleMessagesScroll(convId: string, e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop < 40 && convHasMore[convId] && !loadingOlder) {
      loadOlderMessages(convId);
    }
  }

  async function toggleMessages(convId: string) {
    if (expandedConv === convId) { setExpandedConv(null); return; }
    setExpandedConv(convId);
    if (!convMessages[convId]) await loadMessagesForConv(convId);
  }

  async function handleSend() {
    if (!toNumber || !messageBody) return;
    setSendStatus('loading');
    setSendResult(null);
    localStorage.setItem('wa_test_to', toNumber);
    try {
      const result = await adminApi.sendWhatsAppMessage(toNumber, messageBody);
      setSendStatus('success');
      setSendResult(result);
      setMessageBody('');
      setTimeout(() => loadConversations(convPage), 2000);
    } catch (e: any) {
      setSendStatus('error');
      setSendResult({ error: e.response?.data?.message || e.message });
    }
  }

  const statusColor: Record<string, string> = {
    ready: 'text-green-600 bg-green-50',
    qr_ready: 'text-blue-600 bg-blue-50',
    initializing: 'text-yellow-600 bg-yellow-50',
    authenticated: 'text-yellow-600 bg-yellow-50',
    disconnected: 'text-gray-500 bg-gray-50',
    error: 'text-red-600 bg-red-50',
    not_initialized: 'text-gray-400 bg-gray-50',
  };

  const statusLabel: Record<string, string> = {
    ready: 'Connected',
    qr_ready: 'Scan QR Code',
    initializing: 'Initializing...',
    authenticated: 'Authenticating...',
    disconnected: 'Disconnected',
    error: 'Error',
    not_initialized: 'Not Initialized',
  };

  const isSyncing = syncPollRef.current !== null;
  const displayName = (conv: SyncedConversation) => conv.contactName || conv.participantContacts?.[0]?.contactName || null;
  const avatarUrl = (conv: SyncedConversation) => (conv as any).avatarUrl || conv.metadata?.avatarUrl || null;
  const isGroup = (conv: SyncedConversation) => conv.metadata?.isGroup || conv.participantPhoneNumber?.includes('@g.us');

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-green-100 rounded-lg">
            <MessageSquare className="h-6 w-6 text-green-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">WhatsApp</h1>
            <p className="text-sm text-gray-500">Connect, sync, and send WhatsApp messages</p>
          </div>
        </div>
        {socketConnected && (
          <span className="flex items-center gap-1.5 text-xs text-green-600">
            <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
            Live
          </span>
        )}
      </div>

      {/* Service Health */}
      <div className="card p-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${serviceAvailable === true ? 'bg-green-500' : serviceAvailable === false ? 'bg-red-500' : 'bg-gray-300'}`} />
          <span className="text-sm font-medium text-gray-700">
            WhatsApp Service: {serviceAvailable === true ? 'Running' : serviceAvailable === false ? 'Unavailable' : 'Checking...'}
          </span>
        </div>
        <button onClick={checkHealth} className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1">
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      {/* Connection Card */}
      <div className="card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Smartphone className="h-5 w-5" /> Connection
          </h2>
          <span className={`px-3 py-1 rounded-full text-xs font-bold ${statusColor[status] || 'text-gray-500 bg-gray-50'}`}>
            {statusLabel[status] || status}
          </span>
        </div>

        {phoneNumber && (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span className="font-mono font-medium">{phoneNumber}</span>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
            <XCircle className="h-4 w-4 shrink-0" /> <span>{error}</span>
          </div>
        )}

        {qrCode && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="flex items-center gap-2 text-sm text-blue-600">
              <QrCode className="h-4 w-4" />
              <span className="font-medium">Scan with WhatsApp on your phone</span>
            </div>
            <img src={qrCode} alt="WhatsApp QR Code" className="w-64 h-64 border-2 border-gray-200 rounded-xl" />
            <p className="text-xs text-gray-400">QR code refreshes automatically</p>
          </div>
        )}

        <div className="flex gap-3">
          {status !== 'ready' ? (
            <button onClick={handleConnect} disabled={connecting || serviceAvailable === false}
              className="btn btn-primary flex items-center gap-2 disabled:opacity-50">
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              {connecting ? 'Connecting...' : 'Connect WhatsApp'}
            </button>
          ) : (
            <button onClick={handleDisconnect} disabled={disconnecting}
              className="btn btn-secondary flex items-center gap-2 text-red-600 hover:bg-red-50">
              {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
              {disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </button>
          )}
          <button onClick={checkStatus} className="btn btn-secondary flex items-center gap-2">
            <RefreshCw className="h-4 w-4" /> Refresh Status
          </button>
        </div>
      </div>

      {/* Send Message */}
      {status === 'ready' && (
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Send className="h-5 w-5" /> Send Test Message
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">To (phone number)</label>
              <input type="tel" value={toNumber} onChange={e => setToNumber(e.target.value)}
                placeholder="+1234567890" className="input w-full" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Message</label>
            <textarea value={messageBody} onChange={e => setMessageBody(e.target.value)}
              placeholder="Hello from Sigcore WhatsApp!" rows={3} className="input w-full resize-none" />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={handleSend} disabled={sendStatus === 'loading' || !toNumber || !messageBody}
              className="btn btn-success flex items-center gap-2 disabled:opacity-50">
              {sendStatus === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {sendStatus === 'loading' ? 'Sending...' : 'Send WhatsApp Message'}
            </button>
            {sendStatus === 'success' && <span className="flex items-center gap-1 text-sm text-green-600"><CheckCircle className="h-4 w-4" /> Sent!</span>}
            {sendStatus === 'error' && <span className="flex items-center gap-1 text-sm text-red-600"><XCircle className="h-4 w-4" /> Failed</span>}
          </div>
          {sendResult && (
            <pre className={`text-xs p-3 rounded-lg overflow-auto max-h-40 ${sendStatus === 'error' ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-700'}`}>
              {JSON.stringify(sendResult, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Synced Conversations */}
      {status === 'ready' && (
        <div className="card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <Database className="h-5 w-5" /> Conversations
              {convMeta && <span className="text-sm font-normal text-gray-400">({convMeta.total})</span>}
            </h2>
            <div className="flex items-center gap-3">
              {isSyncing && (
                <span className="flex items-center gap-1.5 text-xs text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full">
                  <Loader2 className="h-3 w-3 animate-spin" /> Syncing...
                </span>
              )}
              <button onClick={() => loadConversations(convPage)} disabled={convLoading}
                className="btn btn-secondary text-xs flex items-center gap-1.5 py-1.5 px-3">
                {convLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Refresh
              </button>
            </div>
          </div>

          {/* Sync Progress */}
          {isSyncing && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>Syncing conversations from WhatsApp...</span>
                <span>{convMeta?.total || 0} conversations</span>
              </div>
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-green-400 to-green-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(syncPollCount * 6, 95)}%` }} />
              </div>
            </div>
          )}

          {/* Conversation List */}
          {conversations.length === 0 && !convLoading && !isSyncing ? (
            <div className="text-center py-8 text-gray-400 text-sm">No WhatsApp conversations synced yet.</div>
          ) : conversations.length === 0 && (convLoading || isSyncing) ? (
            <div className="text-center py-8 text-gray-400 text-sm flex flex-col items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-blue-400" /> Waiting for sync...
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {conversations.map(conv => (
                <div key={conv.id}>
                  <button onClick={() => toggleMessages(conv.id)}
                    className="w-full text-left py-3 px-2 hover:bg-gray-50 rounded-lg transition-colors flex items-center gap-3">
                    <div className="shrink-0">
                      {expandedConv === conv.id ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
                    </div>
                    {/* Avatar */}
                    <div className="shrink-0">
                      {avatarUrl(conv) ? (
                        <img src={avatarUrl(conv)!} alt="" className="w-9 h-9 rounded-full object-cover"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      ) : (
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${
                          isGroup(conv) ? 'bg-blue-100 text-blue-600' : 'bg-green-100 text-green-600'
                        }`}>
                          {isGroup(conv) ? <Users className="h-4 w-4" /> : (displayName(conv) || conv.participantPhoneNumber || '?').charAt(0).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {displayName(conv) ? (
                          <>
                            <span className="text-sm font-medium text-gray-900">{displayName(conv)}</span>
                            {isGroup(conv) && <span className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded font-bold">GROUP</span>}
                            {!isGroup(conv) && <span className="text-xs text-gray-400 font-mono">{conv.participantPhoneNumber}</span>}
                          </>
                        ) : (
                          <span className="font-mono text-sm font-medium text-gray-900">{conv.participantPhoneNumber}</span>
                        )}
                      </div>
                      {conv.lastMessage && (
                        <p className="text-xs text-gray-400 truncate mt-0.5">{conv.lastMessage}</p>
                      )}
                    </div>
                    <div className="shrink-0 text-right flex flex-col items-end gap-1">
                      {conv.lastMessageAt && (
                        <span className="text-xs text-gray-400">
                          {new Date(conv.lastMessageAt).toLocaleDateString()} {new Date(conv.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                      {conv.unreadCount > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-green-500 text-white text-[11px] font-bold">
                          {conv.unreadCount}
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Messages */}
                  {expandedConv === conv.id && (
                    <div
                      ref={msgContainerRef}
                      onScroll={e => handleMessagesScroll(conv.id, e)}
                      className="ml-9 mb-3 bg-gray-50 rounded-lg p-3 max-h-80 overflow-y-auto space-y-2"
                    >
                      {loadingOlder && (
                        <div className="text-center py-2"><Loader2 className="h-3 w-3 animate-spin text-gray-400 mx-auto" /></div>
                      )}
                      {convHasMore[conv.id] && !loadingOlder && (convMessages[conv.id] || []).length > 0 && (
                        <p className="text-[10px] text-gray-400 text-center py-1 cursor-pointer hover:text-gray-600"
                          onClick={() => loadOlderMessages(conv.id)}>Scroll up for older messages</p>
                      )}
                      {loadingMessages === conv.id ? (
                        <div className="text-center py-4"><Loader2 className="h-4 w-4 animate-spin text-gray-400 mx-auto" /></div>
                      ) : (convMessages[conv.id] || []).length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-2">No messages synced yet</p>
                      ) : (
                        (convMessages[conv.id] || []).map((msg: any) => (
                          <div key={msg.id} className={`flex items-start gap-2 text-xs ${msg.direction === 'out' ? 'flex-row-reverse' : ''}`}>
                            <div className="shrink-0 mt-0.5">
                              {msg.direction === 'in' ? <ArrowDownLeft className="h-3 w-3 text-blue-400" /> : <ArrowUpRight className="h-3 w-3 text-green-400" />}
                            </div>
                            <div className={`rounded-lg px-3 py-1.5 max-w-[80%] ${
                              msg.direction === 'out' ? 'bg-green-100 text-green-900' : 'bg-white text-gray-800 border border-gray-200'
                            }`}>
                              {msg.metadata?.mediaPath && msg.metadata?.mediaMimetype?.startsWith('image/') && (
                                <img
                                  src={`/api/conversations/messages/${msg.id}/media`}
                                  alt=""
                                  className="rounded max-w-[240px] max-h-[200px] object-cover mb-1"
                                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                                />
                              )}
                              {msg.metadata?.mediaPath && msg.metadata?.mediaMimetype?.startsWith('video/') && (
                                <video
                                  src={`/api/conversations/messages/${msg.id}/media`}
                                  controls
                                  className="rounded max-w-[240px] max-h-[200px] mb-1"
                                />
                              )}
                              {msg.metadata?.mediaPath && (msg.metadata?.mediaMimetype?.startsWith('audio/') || msg.metadata?.mediaMimetype === 'audio/ogg') && (
                                <audio src={`/api/conversations/messages/${msg.id}/media`} controls className="mb-1 max-w-[240px]" />
                              )}
                              <p>{msg.body}</p>
                              <span className="text-[10px] text-gray-400 mt-0.5 block">
                                {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {convMeta && convMeta.totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-gray-400">Page {convMeta.page} of {convMeta.totalPages}</span>
              <div className="flex gap-2">
                <button onClick={() => loadConversations(convPage - 1)} disabled={convPage <= 1 || convLoading}
                  className="btn btn-secondary text-xs py-1.5 px-3 disabled:opacity-30">Previous</button>
                <button onClick={() => loadConversations(convPage + 1)} disabled={convPage >= convMeta.totalPages || convLoading}
                  className="btn btn-secondary text-xs py-1.5 px-3 disabled:opacity-30">Next</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
