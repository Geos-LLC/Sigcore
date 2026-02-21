import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { formatPhoneE164, isValidE164 } from '../../utils/phone';
import {
  MessageSquare, Send, Plus, Trash2, CheckCircle, XCircle,
  Loader2, RefreshCw, AlertCircle, Phone, ArrowDownLeft, ArrowUpRight,
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const STATUS_COLORS: Record<string, string> = {
  queued:      'bg-gray-100 text-gray-700',
  sent:        'bg-blue-100 text-blue-700',
  delivered:   'bg-green-100 text-green-700',
  undelivered: 'bg-orange-100 text-orange-700',
  failed:      'bg-red-100 text-red-700',
  received:    'bg-purple-100 text-purple-700',
};

interface Assignment {
  id: string;
  numberE164: string;
  type: 'BOT' | 'DEDICATED';
  region?: string;
  active: boolean;
  createdAt: string;
}

interface SmsMessage {
  id: string;
  businessId: string;
  leadId?: string;
  direction: 'OUTBOUND' | 'INBOUND';
  fromNumber: string;
  toNumber: string;
  body: string;
  status: string;
  providerSid?: string;
  errorCode?: string;
  createdAt: string;
}

function makeClient(apiKey: string) {
  return axios.create({
    baseURL: API_URL,
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
  });
}

export default function AdminSmsTestPage() {
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('sms_api_key') || '');
  const [workspaceId, setWorkspaceId] = useState(() => localStorage.getItem('sms_workspace_id') || '');

  // Phone number assignments
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [newNumber, setNewNumber] = useState('');
  const [newType, setNewType] = useState<'BOT' | 'DEDICATED'>('BOT');
  const [newRegion, setNewRegion] = useState('');
  const [addingNumber, setAddingNumber] = useState(false);
  const [addNumberResult, setAddNumberResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Send SMS
  const [toPhone, setToPhone] = useState(() => localStorage.getItem('sms_to_phone') || '');
  const [messageBody, setMessageBody] = useState('');
  const [leadId, setLeadId] = useState('');
  const [source, setSource] = useState('admin-ui');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; msg: string; data?: any } | null>(null);

  // Message history
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const saveCredentials = () => {
    localStorage.setItem('sms_api_key', apiKey);
    localStorage.setItem('sms_workspace_id', workspaceId);
    localStorage.setItem('sms_to_phone', toPhone);
  };

  const loadData = async (currentApiKey?: string) => {
    // Fall back to DOM value in case password manager autofilled without triggering onChange
    const domKey = apiKeyRef.current?.value || '';
    const key = currentApiKey ?? apiKey || domKey;
    if (domKey && !apiKey) { setApiKey(domKey); localStorage.setItem('sms_api_key', domKey); }
    if (!key) { setLoadError('Enter your API key above first.'); return; }
    setLoadError(null);
    const client = makeClient(key);
    const bust = `_=${Date.now()}`;
    try {
      const [assignRes, msgRes] = await Promise.all([
        client.get(`/internal/messages/assignments?${bust}`),
        client.get(`/internal/messages?${bust}`),
      ]);
      setAssignments(assignRes.data);
      setMessages(msgRes.data);
    } catch (err: any) {
      setLoadError(err.response?.data?.message || err.message || 'Failed to load data');
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleAddNumber = async () => {
    console.log('[SMS] handleAddNumber called', { newNumber, apiKey: apiKey ? `${apiKey.slice(0,10)}...` : 'EMPTY', newType });
    if (!newNumber) { console.warn('[SMS] newNumber is empty — returning'); return; }
    if (!apiKey) { console.warn('[SMS] apiKey is empty — returning'); return; }
    setAddingNumber(true);
    setAddNumberResult(null);
    saveCredentials();
    try {
      console.log('[SMS] POST /internal/messages/assignments', { numberE164: newNumber, type: newType });
      const res = await makeClient(apiKey).post('/internal/messages/assignments', {
        numberE164: newNumber,
        type: newType,
        ...(newRegion ? { region: newRegion } : {}),
      });
      console.log('[SMS] POST response:', res.data);
      // Immediately show the new record in the list
      if (res.data) {
        setAssignments(prev => [res.data, ...prev.filter(a => a.id !== res.data.id)]);
      }
      setAddNumberResult({ ok: true, msg: `Number ${newNumber} registered as ${newType}.` });
      setNewNumber('');
      await loadData();
    } catch (err: any) {
      console.error('[SMS] POST error:', err.response?.data || err.message);
      setAddNumberResult({ ok: false, msg: err.response?.data?.message || err.message });
    } finally {
      setAddingNumber(false);
    }
  };

  const handleRemoveNumber = async (id: string, number: string) => {
    if (!confirm(`Remove ${number}?`)) return;
    try {
      await makeClient(apiKey).delete(`/internal/messages/assignments/${id}`);
      await loadData();
    } catch (err: any) {
      alert(err.response?.data?.message || err.message);
    }
  };

  const handleSend = async () => {
    if (!toPhone || !messageBody) return;
    setSending(true);
    setSendResult(null);
    saveCredentials();
    try {
      const res = await makeClient(apiKey).post('/internal/messages/send', {
        businessId: workspaceId,
        toPhone,
        body: messageBody,
        ...(leadId ? { leadId } : {}),
        source,
      });
      setSendResult({ ok: true, msg: `Sent! Message ID: ${res.data.messageId}`, data: res.data });
      setMessageBody('');
      await loadData();
    } catch (err: any) {
      setSendResult({ ok: false, msg: err.response?.data?.message || err.message });
    } finally {
      setSending(false);
    }
  };

  const handleRefreshMessages = async () => {
    setLoadingMessages(true);
    await loadData();
    setLoadingMessages(false);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">SMS Tester</h1>
        <p className="text-sm text-gray-500 mt-1">
          Test two-way SMS for LeadBridge. Register bot numbers, send outbound messages, and view incoming replies.
        </p>
      </div>

      {/* Credentials */}
      <div className="card">
        <div className="p-5 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">Credentials</h2>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tenant API Key</label>
            <input
              ref={apiKeyRef}
              type="password"
              value={apiKey}
              onChange={e => { setApiKey(e.target.value); localStorage.setItem('sms_api_key', e.target.value); }}
              onBlur={e => { if (e.target.value && !apiKey) { setApiKey(e.target.value); localStorage.setItem('sms_api_key', e.target.value); }}}
              placeholder="sc_tenant_..."
              className="input w-full font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Workspace ID (businessId)</label>
            <input
              type="text"
              value={workspaceId}
              onChange={e => { setWorkspaceId(e.target.value); localStorage.setItem('sms_workspace_id', e.target.value); }}
              placeholder="uuid"
              className="input w-full font-mono text-xs"
            />
          </div>
          <button onClick={() => { saveCredentials(); loadData(); }} className="btn-secondary flex items-center gap-2 text-sm">
            <RefreshCw className="h-4 w-4" /> Load Data
          </button>
          {loadError && (
            <p className="text-xs text-red-600 flex items-center gap-1"><AlertCircle className="h-3 w-3" />{loadError}</p>
          )}
        </div>
      </div>

      {/* Phone Number Assignments */}
      <div className="card">
        <div className="p-5 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-gray-500" />
            <h2 className="text-base font-semibold text-gray-900">Phone Number Assignments</h2>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Register Twilio numbers for this workspace. Inbound SMS to these numbers will be routed to the workspace.
          </p>
        </div>
        <div className="p-5 space-y-4">
          {/* Existing assignments */}
          {assignments.length > 0 ? (
            <div className="space-y-2">
              {assignments.map(a => (
                <div key={a.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${a.type === 'BOT' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                      {a.type}
                    </span>
                    <span className="font-mono text-sm">{a.numberE164}</span>
                    {a.region && <span className="text-xs text-gray-400">{a.region}</span>}
                    <span className={`text-xs ${a.active ? 'text-green-600' : 'text-gray-400'}`}>
                      {a.active ? '● active' : '○ inactive'}
                    </span>
                  </div>
                  <button
                    onClick={() => handleRemoveNumber(a.id, a.numberE164)}
                    className="p-1.5 hover:bg-red-50 rounded text-gray-400 hover:text-red-600"
                    title="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">No numbers registered yet.</p>
          )}

          {/* Add new number */}
          <div className="border-t border-gray-100 pt-4 space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Register Number</p>
            <div className="flex gap-3">
              <input
                type="text"
                value={newNumber}
                onChange={e => setNewNumber(e.target.value)}
                onBlur={e => setNewNumber(formatPhoneE164(e.target.value))}
                placeholder="+19045778584"
                className={`input flex-1 font-mono ${newNumber && !isValidE164(newNumber) ? 'border-orange-400' : ''}`}
              />
              <select
                value={newType}
                onChange={e => setNewType(e.target.value as 'BOT' | 'DEDICATED')}
                className="input w-32"
              >
                <option value="BOT">BOT</option>
                <option value="DEDICATED">DEDICATED</option>
              </select>
              <input
                type="text"
                value={newRegion}
                onChange={e => setNewRegion(e.target.value)}
                placeholder="US"
                className="input w-16"
              />
              <button
                onClick={handleAddNumber}
                disabled={addingNumber || !newNumber || !apiKey}
                title={!apiKey ? 'Enter API key in Credentials above first' : !newNumber ? 'Enter a phone number' : ''}
                className="btn-primary flex items-center gap-2"
              >
                {addingNumber ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add
              </button>
            </div>
            {!apiKey && (
              <p className="text-xs text-red-600 flex items-center gap-1"><AlertCircle className="h-3 w-3" />Enter your API key in the Credentials section above to enable Add.</p>
            )}
            {newNumber && !isValidE164(newNumber) && (
              <p className="text-xs text-orange-600">Format should be E.164, e.g. +19045778584</p>
            )}
            {addNumberResult && (
              <div className={`flex items-center gap-2 text-sm ${addNumberResult.ok ? 'text-green-700' : 'text-red-700'}`}>
                {addNumberResult.ok ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                {addNumberResult.msg}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Send SMS */}
      <div className="card">
        <div className="p-5 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Send className="h-4 w-4 text-blue-600" />
            <h2 className="text-base font-semibold text-gray-900">Send Outbound SMS</h2>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Sends via Twilio using the BOT number assigned to this workspace. Requires at least one number registered above.
          </p>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">To Phone</label>
              <input
                type="text"
                value={toPhone}
                onChange={e => setToPhone(e.target.value)}
                onBlur={e => setToPhone(formatPhoneE164(e.target.value))}
                placeholder="+1XXXXXXXXXX"
                className={`input w-full ${toPhone && !isValidE164(toPhone) ? 'border-orange-400 focus:border-orange-500' : ''}`}
              />
              {toPhone && !isValidE164(toPhone) && (
                <p className="text-xs text-orange-600 mt-1">Format should be E.164, e.g. +12125551234</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Lead ID (optional)</label>
              <input
                type="text"
                value={leadId}
                onChange={e => setLeadId(e.target.value)}
                placeholder="lb_lead_abc123"
                className="input w-full"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
            <textarea
              rows={3}
              value={messageBody}
              onChange={e => setMessageBody(e.target.value)}
              placeholder="Hi John, thanks for your inquiry! We'll be in touch shortly."
              className="input w-full resize-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Source (optional)</label>
            <input
              type="text"
              value={source}
              onChange={e => setSource(e.target.value)}
              placeholder="admin-ui"
              className="input w-48"
            />
          </div>

          <button
            onClick={handleSend}
            disabled={sending || !toPhone || !messageBody || !apiKey || assignments.length === 0}
            className="btn-primary flex items-center gap-2 w-full justify-center py-3 text-base"
          >
            {sending ? (
              <><Loader2 className="h-5 w-5 animate-spin" /> Sending...</>
            ) : (
              <><Send className="h-5 w-5" /> Send SMS</>
            )}
          </button>

          {assignments.length === 0 && (
            <p className="text-xs text-center text-orange-600">
              Register a BOT number above before sending.
            </p>
          )}

          {sendResult && (
            <div className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${
              sendResult.ok
                ? 'bg-green-50 border-green-200 text-green-800'
                : 'bg-red-50 border-red-200 text-red-800'
            }`}>
              {sendResult.ok ? <CheckCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /> : <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />}
              <div>
                <p>{sendResult.msg}</p>
                {sendResult.data && (
                  <p className="text-xs mt-1 font-mono opacity-70">
                    SID: {sendResult.data.providerSid} · status: {sendResult.data.status}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Message Log */}
      <div className="card">
        <div className="p-5 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-gray-500" />
            <h2 className="text-base font-semibold text-gray-900">Message Log</h2>
            <span className="text-xs text-gray-400">(last 50)</span>
          </div>
          <button
            onClick={handleRefreshMessages}
            disabled={loadingMessages}
            className="btn-secondary flex items-center gap-1 text-xs py-1.5"
          >
            {loadingMessages ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </button>
        </div>

        {messages.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">No messages yet.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {messages.map(msg => (
              <div key={msg.id} className="p-4 hover:bg-gray-50">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {msg.direction === 'OUTBOUND' ? (
                      <ArrowUpRight className="h-4 w-4 text-blue-500" />
                    ) : (
                      <ArrowDownLeft className="h-4 w-4 text-purple-500" />
                    )}
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[msg.status] || 'bg-gray-100 text-gray-600'}`}>
                      {msg.status}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 break-words">{msg.body}</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1">
                      <span className="text-xs text-gray-400 font-mono">{msg.fromNumber} → {msg.toNumber}</span>
                      {msg.leadId && <span className="text-xs text-gray-400">lead: {msg.leadId}</span>}
                      {msg.errorCode && <span className="text-xs text-red-500">error: {msg.errorCode}</span>}
                    </div>
                  </div>
                  <div className="text-xs text-gray-400 flex-shrink-0">
                    {new Date(msg.createdAt).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="card p-5 bg-gray-50">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">How it works</h3>
        <ol className="space-y-2 text-sm text-gray-600 list-decimal list-inside">
          <li>Register a <strong>BOT number</strong> — this is your shared Twilio number. All SMS sent from this workspace use it as the sender.</li>
          <li>Point that Twilio number's <strong>incoming SMS webhook</strong> to <code className="text-xs bg-gray-200 px-1 rounded">POST /api/webhooks/twilio/sms</code>.</li>
          <li>Send an outbound SMS using the <strong>Send SMS</strong> form above. The message will appear in the log with status <em>queued</em>.</li>
          <li>Twilio updates delivery status via <code className="text-xs bg-gray-200 px-1 rounded">POST /api/webhooks/twilio/sms-status</code> — status changes to <em>sent → delivered</em>.</li>
          <li>When a lead replies to the BOT number, Sigcore receives it, stores it as <em>INBOUND</em>, and emits <code className="text-xs bg-gray-200 px-1 rounded">sms.message.received</code> to your webhook subscription.</li>
        </ol>
      </div>
    </div>
  );
}
