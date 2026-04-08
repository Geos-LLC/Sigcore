import { useState, useEffect, useRef } from 'react';
import { CheckCircle, XCircle, Loader2, Plug, Unplug, MessageSquare, QrCode, RefreshCw, Send, Smartphone } from 'lucide-react';
import { adminApi } from '../../services/adminApi';

type Status = 'idle' | 'loading' | 'success' | 'error';

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

  // QR polling
  const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    checkHealth();
    checkStatus();
    return () => stopQrPolling();
  }, []);

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
      // Start polling for QR code
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
      stopQrPolling();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDisconnecting(false);
    }
  }

  function startQrPolling() {
    stopQrPolling();
    pollQr(); // immediate first poll
    qrPollRef.current = setInterval(pollQr, 3000);
  }

  function stopQrPolling() {
    if (qrPollRef.current) {
      clearInterval(qrPollRef.current);
      qrPollRef.current = null;
    }
  }

  async function pollQr() {
    try {
      const result = await adminApi.getWhatsAppQR();
      if (result.connected) {
        setStatus('ready');
        setPhoneNumber(result.phoneNumber || null);
        setQrCode(null);
        stopQrPolling();
        return;
      }
      if (result.qrCode) {
        setQrCode(result.qrCode);
        setStatus('qr_ready');
      } else {
        setStatus(result.status || 'initializing');
      }
    } catch {
      // ignore polling errors
    }
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

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-green-100 rounded-lg">
          <MessageSquare className="h-6 w-6 text-green-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">WhatsApp Tester</h1>
          <p className="text-sm text-gray-500">Connect, test, and send WhatsApp messages via Sigcore</p>
        </div>
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
            <Smartphone className="h-5 w-5" />
            Connection
          </h2>
          <span className={`px-3 py-1 rounded-full text-xs font-bold ${statusColor[status] || 'text-gray-500 bg-gray-50'}`}>
            {statusLabel[status] || status}
          </span>
        </div>

        {/* Phone number */}
        {phoneNumber && (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span className="font-mono font-medium">{phoneNumber}</span>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
            <XCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* QR Code */}
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

        {/* Connect / Disconnect buttons */}
        <div className="flex gap-3">
          {status !== 'ready' ? (
            <button
              onClick={handleConnect}
              disabled={connecting || serviceAvailable === false}
              className="btn btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              {connecting ? 'Connecting...' : 'Connect WhatsApp'}
            </button>
          ) : (
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="btn btn-secondary flex items-center gap-2 text-red-600 hover:bg-red-50"
            >
              {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
              {disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </button>
          )}
          <button onClick={checkStatus} className="btn btn-secondary flex items-center gap-2">
            <RefreshCw className="h-4 w-4" /> Refresh Status
          </button>
        </div>
      </div>

      {/* Send Message Card */}
      {status === 'ready' && (
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Send className="h-5 w-5" />
            Send Test Message
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">To (phone number)</label>
              <input
                type="tel"
                value={toNumber}
                onChange={e => setToNumber(e.target.value)}
                placeholder="+1234567890"
                className="input w-full"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Message</label>
            <textarea
              value={messageBody}
              onChange={e => setMessageBody(e.target.value)}
              placeholder="Hello from Sigcore WhatsApp!"
              rows={3}
              className="input w-full resize-none"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleSend}
              disabled={sendStatus === 'loading' || !toNumber || !messageBody}
              className="btn btn-success flex items-center gap-2 disabled:opacity-50"
            >
              {sendStatus === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {sendStatus === 'loading' ? 'Sending...' : 'Send WhatsApp Message'}
            </button>

            {sendStatus === 'success' && (
              <span className="flex items-center gap-1 text-sm text-green-600">
                <CheckCircle className="h-4 w-4" /> Sent!
              </span>
            )}
            {sendStatus === 'error' && (
              <span className="flex items-center gap-1 text-sm text-red-600">
                <XCircle className="h-4 w-4" /> Failed
              </span>
            )}
          </div>

          {sendResult && (
            <pre className={`text-xs p-3 rounded-lg overflow-auto max-h-40 ${
              sendStatus === 'error' ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-700'
            }`}>
              {JSON.stringify(sendResult, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
