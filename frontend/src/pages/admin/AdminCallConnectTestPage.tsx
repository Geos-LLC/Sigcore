import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import {
  Phone, PhoneOff, PhoneCall, PhoneIncoming, CheckCircle, XCircle,
  Loader2, RefreshCw, Settings, Play, Square, Clock, AlertCircle,
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const STATUS_COLORS: Record<string, string> = {
  CREATED:        'bg-gray-100 text-gray-700',
  CALLING_AGENT:  'bg-blue-100 text-blue-700',
  AGENT_ANSWERED: 'bg-blue-100 text-blue-700',
  AGENT_ACCEPTED: 'bg-indigo-100 text-indigo-700',
  CALLING_LEAD:   'bg-yellow-100 text-yellow-700',
  LEAD_ANSWERED:  'bg-yellow-100 text-yellow-700',
  BRIDGED:        'bg-green-100 text-green-700',
  ENDED:          'bg-gray-100 text-gray-700',
  FAILED:         'bg-red-100 text-red-700',
  CANCELED:       'bg-gray-100 text-gray-500',
};

const STATUS_ICONS: Record<string, JSX.Element> = {
  CREATED:        <Clock className="h-4 w-4" />,
  CALLING_AGENT:  <PhoneCall className="h-4 w-4 animate-pulse" />,
  AGENT_ANSWERED: <Phone className="h-4 w-4" />,
  AGENT_ACCEPTED: <CheckCircle className="h-4 w-4" />,
  CALLING_LEAD:   <PhoneIncoming className="h-4 w-4 animate-pulse" />,
  LEAD_ANSWERED:  <Phone className="h-4 w-4" />,
  BRIDGED:        <CheckCircle className="h-4 w-4" />,
  ENDED:          <PhoneOff className="h-4 w-4" />,
  FAILED:         <XCircle className="h-4 w-4" />,
  CANCELED:       <Square className="h-4 w-4" />,
};

const TERMINAL = new Set(['ENDED', 'FAILED', 'CANCELED']);

interface Session {
  id: string;
  status: string;
  mode: string;
  agentPhoneE164: string;
  leadPhoneE164: string;
  fromNumberE164: string;
  agentCallSid: string | null;
  leadCallSid: string | null;
  conferenceName: string | null;
  failureReason: string | null;
  attempt: number;
  timeline: Array<{ at: string; status?: string; reason?: string }>;
  createdAt: string;
}

function makeClient(apiKey: string) {
  return axios.create({
    baseURL: API_URL,
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
  });
}

export default function AdminCallConnectTestPage() {
  // Stored credentials
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('cc_api_key') || 'sc_tenant_2a7c371274582fa65c526782f1ad3c150e5acd5ab27949a3dee9cfb9b80456c5');
  const [workspaceId, setWorkspaceId] = useState(() => localStorage.getItem('cc_workspace_id') || '1bcbb4e0-df1b-481c-83ba-0730df47a720');

  // Settings state
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [botNumber, setBotNumber] = useState(() => localStorage.getItem('cc_bot_number') || '+19045778584');
  const [agentPhone, setAgentPhone] = useState(() => localStorage.getItem('cc_agent_phone') || '');
  const [mode, setMode] = useState<'AGENT_FIRST' | 'PARALLEL'>('AGENT_FIRST');
  const [ringTimeout, setRingTimeout] = useState(20);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsResult, setSettingsResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Call form state
  const [leadPhone, setLeadPhone] = useState(() => localStorage.getItem('cc_lead_phone') || '');
  const [leadSummary, setLeadSummary] = useState('Test lead from admin UI');
  const [leadId, setLeadId] = useState(() => `test-${Date.now()}`);

  // Session state
  const [session, setSession] = useState<Session | null>(null);
  const [starting, setStarting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load settings from backend on mount
  useEffect(() => {
    if (!apiKey) return;
    makeClient(apiKey).get('/internal/call-connect/settings')
      .then(res => {
        const s = res.data;
        if (s) {
          if (s.botNumberE164) setBotNumber(s.botNumberE164);
          if (s.agentPhoneE164) setAgentPhone(s.agentPhoneE164);
          if (s.mode) setMode(s.mode);
          if (s.ringTimeoutSeconds) setRingTimeout(s.ringTimeoutSeconds);
        }
      })
      .catch(() => {});
  }, []);

  // Poll session status
  useEffect(() => {
    if (session && !TERMINAL.has(session.status)) {
      pollRef.current = setInterval(async () => {
        try {
          const res = await makeClient(apiKey).get(`/internal/call-connect/sessions/${session.id}`);
          setSession(res.data);
          if (TERMINAL.has(res.data.status)) {
            clearInterval(pollRef.current!);
          }
        } catch {
          clearInterval(pollRef.current!);
        }
      }, 2000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [session?.id, session?.status]);

  const saveCredentials = () => {
    localStorage.setItem('cc_api_key', apiKey);
    localStorage.setItem('cc_workspace_id', workspaceId);
    localStorage.setItem('cc_bot_number', botNumber);
    localStorage.setItem('cc_agent_phone', agentPhone);
    localStorage.setItem('cc_lead_phone', leadPhone);
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    setSettingsResult(null);
    saveCredentials();
    try {
      await makeClient(apiKey).post('/internal/call-connect/settings', {
        enabled: true,
        mode,
        botNumberE164: botNumber,
        agentPhoneE164: agentPhone,
        ringTimeoutSeconds: ringTimeout,
        maxAgentAttempts: 2,
      });
      setSettingsResult({ ok: true, msg: 'Settings saved.' });
    } catch (err: any) {
      setSettingsResult({ ok: false, msg: err.response?.data?.message || err.message });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleStartCall = async () => {
    setStarting(true);
    setStartError(null);
    setSession(null);
    saveCredentials();
    localStorage.setItem('cc_lead_phone', leadPhone);
    const newLeadId = `test-${Date.now()}`;
    setLeadId(newLeadId);
    try {
      const res = await makeClient(apiKey).post('/internal/call-connect/start', {
        businessId: workspaceId,
        leadId: newLeadId,
        leadPhoneE164: leadPhone,
        leadSummary,
        source: 'admin-ui',
      });
      // Fetch full session
      const sessionRes = await makeClient(apiKey).get(`/internal/call-connect/sessions/${res.data.sessionId}`);
      setSession(sessionRes.data);
    } catch (err: any) {
      setStartError(err.response?.data?.message || err.message || 'Failed to start session');
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!session) return;
    setCanceling(true);
    try {
      await makeClient(apiKey).post('/internal/call-connect/cancel', { sessionId: session.id });
      const res = await makeClient(apiKey).get(`/internal/call-connect/sessions/${session.id}`);
      setSession(res.data);
    } catch (err: any) {
      console.error('Cancel failed:', err.message);
    } finally {
      setCanceling(false);
    }
  };

  const handleRefreshSession = async () => {
    if (!session) return;
    try {
      const res = await makeClient(apiKey).get(`/internal/call-connect/sessions/${session.id}`);
      setSession(res.data);
    } catch {}
  };

  const isActive = session && !TERMINAL.has(session.status);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Call Connect Tester</h1>
        <p className="text-sm text-gray-500 mt-1">
          Simulate a lead arriving and triggering an instant call bridge. Use real phone numbers — your phone will ring.
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
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sc_tenant_..."
              className="input w-full font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Workspace ID (businessId)</label>
            <input
              type="text"
              value={workspaceId}
              onChange={e => setWorkspaceId(e.target.value)}
              placeholder="uuid"
              className="input w-full font-mono text-xs"
            />
          </div>
        </div>
      </div>

      {/* Settings */}
      <div className="card">
        <button
          className="w-full p-5 border-b border-gray-200 flex items-center justify-between hover:bg-gray-50"
          onClick={() => setSettingsOpen(o => !o)}
        >
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-gray-500" />
            <h2 className="text-base font-semibold text-gray-900">Call Connect Settings</h2>
          </div>
          <span className="text-xs text-gray-400">{settingsOpen ? 'Hide' : 'Show'}</span>
        </button>

        {settingsOpen && (
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  From (Bot) Number
                  <span className="text-xs text-gray-400 ml-1">— calls appear from this number</span>
                </label>
                <input
                  type="text"
                  value={botNumber}
                  onChange={e => setBotNumber(e.target.value)}
                  placeholder="+19045778584"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Agent Phone
                  <span className="text-xs text-gray-400 ml-1">— rings first</span>
                </label>
                <input
                  type="text"
                  value={agentPhone}
                  onChange={e => setAgentPhone(e.target.value)}
                  placeholder="+1XXXXXXXXXX"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mode</label>
                <select
                  value={mode}
                  onChange={e => setMode(e.target.value as 'AGENT_FIRST' | 'PARALLEL')}
                  className="input w-full"
                >
                  <option value="AGENT_FIRST">AGENT_FIRST — agent answers first, press 1 to bridge</option>
                  <option value="PARALLEL">PARALLEL — both ring simultaneously</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ring Timeout (seconds)</label>
                <input
                  type="number"
                  min={5}
                  max={60}
                  value={ringTimeout}
                  onChange={e => setRingTimeout(Number(e.target.value))}
                  className="input w-full"
                />
              </div>
            </div>

            <button
              onClick={handleSaveSettings}
              disabled={savingSettings || !agentPhone || !botNumber}
              className="btn-primary flex items-center gap-2"
            >
              {savingSettings ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              Save Settings
            </button>

            {settingsResult && (
              <div className={`flex items-center gap-2 text-sm ${settingsResult.ok ? 'text-green-700' : 'text-red-700'}`}>
                {settingsResult.ok ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                {settingsResult.msg}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Start a call */}
      <div className="card">
        <div className="p-5 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-green-600" />
            <h2 className="text-base font-semibold text-gray-900">Start Call Connect</h2>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Each click generates a new leadId. The agent phone will ring first (AGENT_FIRST mode) — answer and press 1 to connect the lead.
          </p>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Lead Phone
              <span className="text-xs text-gray-400 ml-1">— called after agent accepts</span>
            </label>
            <input
              type="text"
              value={leadPhone}
              onChange={e => setLeadPhone(e.target.value)}
              placeholder="+1XXXXXXXXXX"
              className="input w-full"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Lead Summary (optional)</label>
            <input
              type="text"
              value={leadSummary}
              onChange={e => setLeadSummary(e.target.value)}
              placeholder="e.g. John Smith - Plumbing - New York"
              className="input w-full"
            />
          </div>

          <button
            onClick={handleStartCall}
            disabled={starting || !leadPhone || !agentPhone || !!isActive}
            className="btn-primary flex items-center gap-2 w-full justify-center py-3 text-base"
          >
            {starting ? (
              <><Loader2 className="h-5 w-5 animate-spin" /> Starting call...</>
            ) : (
              <><Play className="h-5 w-5" /> Start Call Connect</>
            )}
          </button>
          {isActive && (
            <p className="text-xs text-center text-gray-400">Cancel the active session below before starting a new one.</p>
          )}

          {startError && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              {startError}
            </div>
          )}
        </div>
      </div>

      {/* Session status */}
      {session && (
        <div className="card">
          <div className="p-5 border-b border-gray-200 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_COLORS[session.status] || 'bg-gray-100 text-gray-700'}`}>
                {STATUS_ICONS[session.status]}
                {session.status}
              </div>
              {!TERMINAL.has(session.status) && (
                <span className="flex items-center gap-1 text-xs text-blue-600">
                  <span className="inline-block h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                  Polling every 2s...
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={handleRefreshSession} className="btn-secondary flex items-center gap-1 text-xs py-1.5">
                <RefreshCw className="h-3 w-3" /> Refresh
              </button>
              {!TERMINAL.has(session.status) && (
                <button
                  onClick={handleCancel}
                  disabled={canceling}
                  className="btn-secondary flex items-center gap-1 text-xs py-1.5 text-red-600 border-red-300 hover:bg-red-50"
                >
                  {canceling ? <Loader2 className="h-3 w-3 animate-spin" /> : <PhoneOff className="h-3 w-3" />}
                  Cancel
                </button>
              )}
            </div>
          </div>

          <div className="p-5 space-y-4">
            {/* Call info grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
              <div>
                <span className="text-xs text-gray-400 block">Session ID</span>
                <span className="font-mono text-xs text-gray-700 break-all">{session.id}</span>
              </div>
              <div>
                <span className="text-xs text-gray-400 block">Mode</span>
                <span className="font-medium">{session.mode}</span>
              </div>
              <div>
                <span className="text-xs text-gray-400 block">Attempt</span>
                <span className="font-medium">{session.attempt}</span>
              </div>
              <div>
                <span className="text-xs text-gray-400 block">From (bot)</span>
                <span className="font-mono text-xs">{session.fromNumberE164}</span>
              </div>
              <div>
                <span className="text-xs text-gray-400 block">Agent</span>
                <span className="font-mono text-xs">{session.agentPhoneE164 || '—'}</span>
              </div>
              <div>
                <span className="text-xs text-gray-400 block">Lead</span>
                <span className="font-mono text-xs">{session.leadPhoneE164}</span>
              </div>
              {session.agentCallSid && (
                <div>
                  <span className="text-xs text-gray-400 block">Agent Call SID</span>
                  <span className="font-mono text-xs text-gray-600">{session.agentCallSid}</span>
                </div>
              )}
              {session.leadCallSid && (
                <div>
                  <span className="text-xs text-gray-400 block">Lead Call SID</span>
                  <span className="font-mono text-xs text-gray-600">{session.leadCallSid}</span>
                </div>
              )}
              {session.conferenceName && (
                <div>
                  <span className="text-xs text-gray-400 block">Conference</span>
                  <span className="font-mono text-xs text-gray-600">{session.conferenceName}</span>
                </div>
              )}
            </div>

            {session.failureReason && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                {session.failureReason}
              </div>
            )}

            {/* Timeline */}
            {session.timeline?.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Timeline</h3>
                <div className="space-y-1">
                  {session.timeline.map((entry, i) => (
                    <div key={i} className="flex items-start gap-3 text-sm">
                      <span className="text-xs text-gray-400 w-20 flex-shrink-0 pt-0.5">
                        {new Date(entry.at).toLocaleTimeString()}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {entry.status && (
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[entry.status] || 'bg-gray-100 text-gray-700'}`}>
                            {entry.status}
                          </span>
                        )}
                        {entry.reason && (
                          <span className="text-xs text-red-600">{entry.reason}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {session.status === 'AGENT_FIRST' && session.status === 'CALLING_AGENT' && (
            <div className="px-5 pb-5">
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
                <strong>Your phone should be ringing.</strong> Answer and press <kbd className="bg-white border border-blue-300 px-1.5 py-0.5 rounded font-mono text-xs">1</kbd> to connect the lead.
              </div>
            </div>
          )}
          {session.status === 'CALLING_AGENT' && (
            <div className="px-5 pb-5">
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
                <strong>Agent phone is ringing.</strong> Answer and press <kbd className="bg-white border border-blue-300 px-1.5 py-0.5 rounded font-mono text-xs">1</kbd> to connect the lead.
              </div>
            </div>
          )}
          {session.status === 'CALLING_LEAD' && (
            <div className="px-5 pb-5">
              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
                <strong>Calling the lead now.</strong> Lead phone should ring shortly.
              </div>
            </div>
          )}
          {session.status === 'BRIDGED' && (
            <div className="px-5 pb-5">
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                <strong>Bridged!</strong> Agent and lead are connected on the same call.
              </div>
            </div>
          )}
          {session.status === 'ENDED' && (
            <div className="px-5 pb-5">
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">
                Call ended successfully.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Instructions */}
      <div className="card p-5 bg-gray-50">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">How it works</h3>
        <ol className="space-y-2 text-sm text-gray-600 list-decimal list-inside">
          <li>Save settings with your real <strong>agent phone</strong> (the number that rings first) and the <strong>bot number</strong> (caller ID shown to the agent).</li>
          <li>Enter the <strong>lead phone</strong> — this is called after the agent accepts.</li>
          <li>Click <strong>Start Call Connect</strong>. Your agent phone rings immediately.</li>
          <li>Answer the call. You'll hear the lead summary read aloud, then press <kbd className="bg-white border border-gray-300 px-1 rounded font-mono">1</kbd> to accept.</li>
          <li>The lead phone rings. When they answer, both parties are in a bridged conference call.</li>
        </ol>
      </div>
    </div>
  );
}
