import { useState } from 'react';
import { Book, Copy, Check } from 'lucide-react';

interface Endpoint {
  method: string;
  path: string;
  description: string;
  auth: string;
  body?: any;
  query?: string;
  response?: any;
}

export default function ApiDocsPage() {
  const [copiedEndpoint, setCopiedEndpoint] = useState<string | null>(null);

  const baseUrl = import.meta.env.VITE_API_URL || 'https://your-api-domain.com/api';

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedEndpoint(id);
    setTimeout(() => setCopiedEndpoint(null), 2000);
  };

  const endpoints: { category: string; description?: string; items: Endpoint[] }[] = [
    {
      category: 'Authentication',
      description: 'Connect communication providers to your workspace.',
      items: [
        {
          method: 'POST',
          path: '/integrations/openphone/connect',
          description: 'Connect OpenPhone integration. Registers webhooks for real-time message and call events.',
          auth: 'X-API-Key',
          body: { apiKey: 'your_openphone_api_key' },
          response: { data: { id: 'uuid', provider: 'openphone', status: 'active', metadata: { messageWebhookId: '...', callWebhookId: '...' } } },
        },
        {
          method: 'POST',
          path: '/integrations/twilio',
          description: 'Setup Twilio integration for SMS, voice, and phone number provisioning.',
          auth: 'X-API-Key',
          body: { accountSid: 'AC...', authToken: 'your_token', phoneNumber: '+1234567890' },
          response: { data: { id: 'uuid', provider: 'twilio', status: 'active' } },
        },
      ],
    },
    {
      category: 'Integrations',
      description: 'Manage connected integrations, phone numbers, and test connectivity.',
      items: [
        {
          method: 'GET',
          path: '/integrations/all',
          description: 'Get all configured integrations. Also returns workspaceId for Socket.IO real-time connections.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', provider: 'openphone', status: 'active' }], workspaceId: 'uuid' },
        },
        {
          method: 'GET',
          path: '/integrations',
          description: 'Get a single integration by provider.',
          auth: 'X-API-Key',
          query: 'provider=openphone',
          response: { data: { id: 'uuid', provider: 'openphone', status: 'active' } },
        },
        {
          method: 'GET',
          path: '/integrations/openphone/numbers',
          description: 'Get OpenPhone phone numbers.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'PN123', phoneNumber: '+1234567890', name: 'Main Line' }] },
        },
        {
          method: 'GET',
          path: '/integrations/twilio/phone-numbers',
          description: 'Get Twilio phone numbers.',
          auth: 'X-API-Key',
          response: { data: [{ sid: 'PN...', phoneNumber: '+1234567890', capabilities: { sms: true, voice: true } }] },
        },
        {
          method: 'GET',
          path: '/integrations/openphone/conversations',
          description: 'Fetch recent conversations live from OpenPhone API (not stored in DB). Single request using updatedAfter filter, sorted by lastActivityAt. Contact names resolved from OpenPhone contacts for conversations without a name.',
          auth: 'X-API-Key',
          query: 'days=1',
          response: { data: [{ participantPhone: '+1234567890', phoneNumberId: 'PNxxxxx', phoneNumber: '+0987654321', phoneNumberName: 'Main Line', lastMessageAt: '2026-02-11T...', conversationName: 'John Doe', contactName: 'John Doe' }] },
        },
        {
          method: 'GET',
          path: '/integrations/phone-numbers',
          description: 'Get all phone numbers across all providers.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', phoneNumber: '+1234567890', provider: 'openphone', name: 'Main Line' }] },
        },
        {
          method: 'DELETE',
          path: '/integrations/openphone/disconnect',
          description: 'Disconnect OpenPhone integration and remove webhooks.',
          auth: 'X-API-Key',
          response: null,
        },
        {
          method: 'DELETE',
          path: '/integrations/twilio',
          description: 'Delete Twilio integration.',
          auth: 'X-API-Key',
          response: null,
        },
      ],
    },
    {
      category: 'Conversations',
      description: 'List, view, and interact with conversations.',
      items: [
        {
          method: 'GET',
          path: '/v1/conversations',
          description: 'List conversations with pagination, search, and filtering.',
          auth: 'X-API-Key',
          query: 'page=1&limit=20&search=john&phoneNumberId=PN123&provider=openphone&startDate=2026-01-01&endDate=2026-02-11',
          response: { data: [{ id: 'uuid', phoneNumber: '+0987654321', participantPhoneNumber: '+1234567890', lastMessageAt: '2026-02-10T...' }], meta: { total: 100, page: 1 } },
        },
        {
          method: 'GET',
          path: '/v1/conversations/:id',
          description: 'Get a specific conversation with details.',
          auth: 'X-API-Key',
          response: { data: { id: 'uuid', phoneNumber: '+0987654321', participantPhoneNumber: '+1234567890', contactId: 'uuid' } },
        },
        {
          method: 'GET',
          path: '/v1/conversations/:id/messages',
          description: 'Get messages in a conversation.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', body: 'Hello', direction: 'inbound', status: 'delivered', createdAt: '2026-02-10T...' }] },
        },
        {
          method: 'POST',
          path: '/v1/conversations/:id/messages',
          description: 'Send a message to a conversation.',
          auth: 'X-API-Key',
          body: { body: 'Hello, how can I help?', fromNumber: '+1234567890' },
          response: { data: { id: 'uuid', body: 'Hello, how can I help?', status: 'sent' } },
        },
        {
          method: 'GET',
          path: '/v1/conversations/:id/calls',
          description: 'Get calls in a conversation.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', direction: 'inbound', duration: 120, status: 'completed' }] },
        },
      ],
    },
    {
      category: 'Messages',
      description: 'Send messages directly by phone number.',
      items: [
        {
          method: 'POST',
          path: '/v1/messages',
          description: 'Send a message to a phone number.',
          auth: 'X-API-Key',
          body: { fromNumber: '+0987654321', toNumber: '+1234567890', body: 'Hello!' },
          response: { data: { success: true, messageId: 'uuid' } },
        },
        {
          method: 'POST',
          path: '/v1/messages/send',
          description: 'Send message with sender mode (shared or dedicated number).',
          auth: 'X-API-Key',
          body: { to: '+1234567890', body: 'Hello!', sender: { mode: 'dedicated', fromNumber: '+0987654321' } },
          response: { data: { success: true, messageId: 'uuid' } },
        },
        {
          method: 'GET',
          path: '/v1/messages/senders',
          description: 'Get available message senders.',
          auth: 'X-API-Key',
          query: 'mode=dedicated',
          response: { data: [{ id: 'uuid', phoneNumber: '+1234567890', mode: 'dedicated', provider: 'twilio' }] },
        },
      ],
    },
    {
      category: 'Calls',
      description: 'View call details, transcripts, and recordings.',
      items: [
        {
          method: 'GET',
          path: '/calls/:callId',
          description: 'Get call details.',
          auth: 'X-API-Key',
          response: { data: { id: 'uuid', direction: 'inbound', duration: 120, status: 'completed', fromNumber: '+1234567890' } },
        },
        {
          method: 'GET',
          path: '/calls/:callId/transcript',
          description: 'Get call transcript.',
          auth: 'X-API-Key',
          response: { data: { transcript: 'Hello, how are you?', confidence: 0.95 } },
        },
        {
          method: 'GET',
          path: '/calls/:callId/recordings',
          description: 'Get call recording URLs.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', url: 'https://...', duration: 120 }] },
        },
        {
          method: 'POST',
          path: '/contacts/:contactId/calls/initiate',
          description: 'Initiate a call to a contact.',
          auth: 'X-API-Key',
          body: { fromNumber: '+1234567890' },
          response: { data: { type: 'deeplink', url: 'openphone://call?to=+1234567890' } },
        },
      ],
    },
    {
      category: 'Contacts',
      description: 'Send messages and view communication history for specific contacts.',
      items: [
        {
          method: 'GET',
          path: '/contacts/:contactId/messages',
          description: 'Get messages for a contact.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', body: 'Hello', direction: 'inbound', createdAt: '2026-02-10T...' }] },
        },
        {
          method: 'POST',
          path: '/contacts/:contactId/messages',
          description: 'Send a message to a contact.',
          auth: 'X-API-Key',
          body: { body: 'Hello!', fromNumber: '+1234567890' },
          response: { data: { id: 'uuid', body: 'Hello!', status: 'sent' } },
        },
        {
          method: 'GET',
          path: '/contacts/:contactId/calls',
          description: 'Get calls for a contact.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', direction: 'inbound', duration: 120, status: 'completed' }] },
        },
      ],
    },
    {
      category: 'Phone Numbers',
      description: 'Search, purchase, and manage phone numbers from Twilio.',
      items: [
        {
          method: 'GET',
          path: '/tenants/phone-numbers/search',
          description: 'Search available phone numbers. Filter by country, area code, city, state, and capabilities.',
          auth: 'X-API-Key',
          query: 'country=US&areaCode=415&locality=San Francisco&region=CA&smsCapable=true&voiceCapable=true',
          response: { data: [{ phoneNumber: '+14155551234', locality: 'San Francisco', region: 'CA', pricing: { twilioCost: 1.00, totalMonthlyPrice: 1.50 } }] },
        },
        {
          method: 'POST',
          path: '/tenants/:tenantId/phone-numbers/purchase',
          description: 'Purchase a phone number for a tenant.',
          auth: 'X-API-Key',
          body: { phoneNumber: '+14155551234', friendlyName: 'Support Line' },
          response: { data: { success: true, order: { id: 'uuid', status: 'provisioning' } } },
        },
        {
          method: 'POST',
          path: '/tenants/:tenantId/phone-numbers/:allocationId/release',
          description: 'Release a phone number.',
          auth: 'X-API-Key',
          response: { data: { success: true } },
        },
        {
          method: 'GET',
          path: '/v1/phone-numbers',
          description: 'Get all phone numbers in the workspace.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', phoneNumber: '+1234567890', provider: 'twilio', status: 'active' }] },
        },
        {
          method: 'GET',
          path: '/tenants/pricing',
          description: 'Get phone number pricing configuration.',
          auth: 'X-API-Key',
          response: { data: { monthlyMarkup: 0.50, setupFee: 1.00, currency: 'USD' } },
        },
        {
          method: 'PUT',
          path: '/tenants/pricing',
          description: 'Update pricing configuration.',
          auth: 'X-API-Key',
          body: { monthlyMarkup: 0.75, setupFee: 1.50 },
          response: { data: { monthlyMarkup: 0.75, setupFee: 1.50, currency: 'USD' } },
        },
      ],
    },
    {
      category: 'Tenants',
      description: 'Manage tenants (customers) and their configurations.',
      items: [
        {
          method: 'GET',
          path: '/tenants',
          description: 'Get all tenants.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', name: 'Acme Corp', externalId: 'acme_123', status: 'active' }] },
        },
        {
          method: 'POST',
          path: '/tenants',
          description: 'Create a new tenant. externalId is auto-generated from name if not provided. webhookSecret is auto-generated.',
          auth: 'X-API-Key',
          body: { name: 'Acme Corp' },
          response: { data: { id: 'uuid', externalId: 'acme-corp-a1b2', name: 'Acme Corp', webhookSecret: '64-char-hex...' } },
        },
        {
          method: 'GET',
          path: '/v1/tenants/by-external-id',
          description: 'Get a tenant by their external ID.',
          auth: 'X-API-Key',
          query: 'externalId=acme_123',
          response: { data: { id: 'uuid', externalId: 'acme_123', name: 'Acme Corp' } },
        },
        {
          method: 'PUT',
          path: '/tenants/:id',
          description: 'Update a tenant.',
          auth: 'X-API-Key',
          body: { name: 'Acme Corp Updated', metadata: { plan: 'pro' } },
          response: { data: { id: 'uuid', name: 'Acme Corp Updated' } },
        },
        {
          method: 'DELETE',
          path: '/tenants/:id',
          description: 'Delete a tenant.',
          auth: 'X-API-Key',
          response: null,
        },
        {
          method: 'GET',
          path: '/tenants/:id/integrations',
          description: 'Get integrations connected by a tenant.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', provider: 'openphone', status: 'active' }] },
        },
      ],
    },
    {
      category: 'Webhook Subscriptions',
      description: 'Subscribe to real-time events via outbound webhooks. The signing secret is auto-filled from the tenant record — no manual secret management needed.',
      items: [
        {
          method: 'GET',
          path: '/webhook-subscriptions',
          description: 'List all webhook subscriptions.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', name: 'My Webhook', webhookUrl: 'https://...', events: ['message.inbound'], status: 'active' }] },
        },
        {
          method: 'POST',
          path: '/webhook-subscriptions',
          description: 'Create a webhook subscription. The signing secret is auto-filled from the tenant record (no need to provide it).',
          auth: 'X-API-Key',
          body: { name: 'Message Notifications', webhookUrl: 'https://your-app.com/webhooks/sigcore', events: ['message.inbound', 'message.sent', 'call.completed', 'call.missed'] },
          response: { data: { id: 'uuid', name: 'Message Notifications', webhookUrl: 'https://your-app.com/webhooks/sigcore', events: ['message.inbound', 'message.sent', 'call.completed', 'call.missed'], status: 'active' } },
        },
        {
          method: 'PATCH',
          path: '/webhook-subscriptions/:id',
          description: 'Update a webhook subscription (name, URL, events, or status).',
          auth: 'X-API-Key',
          body: { webhookUrl: 'https://new-url.com/webhook', events: ['message.inbound'] },
          response: { data: { id: 'uuid', webhookUrl: 'https://new-url.com/webhook', events: ['message.inbound'] } },
        },
        {
          method: 'GET',
          path: '/webhook-subscriptions/secret',
          description: 'Get the tenant webhook signing secret. Tenants use this to verify inbound webhook signatures (X-Callio-Signature header).',
          auth: 'X-API-Key',
          response: { data: { secret: '64-char-hex-string...' } },
        },
        {
          method: 'POST',
          path: '/webhook-subscriptions/:id/test',
          description: 'Send a test event to verify your webhook endpoint.',
          auth: 'X-API-Key',
          response: { data: { success: true } },
        },
        {
          method: 'GET',
          path: '/webhook-subscriptions/events/types',
          description: 'Get all available event types you can subscribe to.',
          auth: 'X-API-Key',
          response: { data: [{ event: 'message.inbound', description: 'Triggered when an inbound message is received' }, { event: 'message.sent', description: 'Triggered when a message is sent' }] },
        },
        {
          method: 'DELETE',
          path: '/webhook-subscriptions/:id',
          description: 'Delete a webhook subscription.',
          auth: 'X-API-Key',
          response: null,
        },
      ],
    },
    {
      category: 'Sync',
      description: 'Sync conversations and contacts from connected providers into Sigcore.',
      items: [
        {
          method: 'POST',
          path: '/integrations/sync',
          description: 'Start background sync. Returns immediately with 202 Accepted.',
          auth: 'X-API-Key',
          body: { provider: 'openphone', limit: 50, since: '2026-01-01T00:00:00Z', syncMessages: true, onlySavedContacts: true },
          response: { data: { started: true, message: 'Sync started in background. Poll /sync/status for progress.' } },
        },
        {
          method: 'GET',
          path: '/integrations/sync/status',
          description: 'Get current sync status and progress.',
          auth: 'X-API-Key',
          response: { data: { status: 'running', progress: 50, total: 100, phase: 'conversations' } },
        },
        {
          method: 'POST',
          path: '/integrations/sync/cancel',
          description: 'Cancel a running sync.',
          auth: 'X-API-Key',
          response: { data: { success: true, cancelled: true } },
        },
        {
          method: 'POST',
          path: '/integrations/sync/contacts',
          description: 'Sync contacts from conversation participants.',
          auth: 'X-API-Key',
          body: { limit: 100 },
          response: { data: { synced: 45, total: 100 } },
        },
        {
          method: 'POST',
          path: '/integrations/sync/openphone-contacts',
          description: 'Sync contacts directly from OpenPhone contact list.',
          auth: 'X-API-Key',
          body: { limit: 100 },
          response: { data: { synced: 30 } },
        },
      ],
    },
    {
      category: 'API Keys',
      description: 'Manage workspace API keys for authentication.',
      items: [
        {
          method: 'GET',
          path: '/api-keys',
          description: 'List all API keys.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', name: 'Production Key', keyPreview: 'sc_...xyz', active: true, createdAt: '2026-01-01T...' }] },
        },
        {
          method: 'POST',
          path: '/api-keys',
          description: 'Create a new API key. The full key is only shown once.',
          auth: 'X-API-Key',
          body: { name: 'Production Key' },
          response: { data: { apiKey: { id: 'uuid', name: 'Production Key' }, fullKey: 'sc_workspace_abc123...' } },
        },
        {
          method: 'PATCH',
          path: '/api-keys/:id/toggle',
          description: 'Toggle an API key active/inactive.',
          auth: 'X-API-Key',
          response: { data: { id: 'uuid', name: 'Production Key', active: false } },
        },
        {
          method: 'DELETE',
          path: '/api-keys/:id',
          description: 'Delete an API key permanently.',
          auth: 'X-API-Key',
          response: null,
        },
      ],
    },
    {
      category: 'Tenant API Keys',
      description: 'Manage API keys scoped to specific tenants.',
      items: [
        {
          method: 'POST',
          path: '/tenants/:tenantId/api-keys',
          description: 'Create an API key scoped to a tenant.',
          auth: 'X-API-Key',
          body: { name: 'Tenant Portal Key' },
          response: { data: { apiKey: { id: 'uuid', name: 'Tenant Portal Key' }, fullKey: 'sc_tenant_abc123...' } },
        },
        {
          method: 'GET',
          path: '/tenants/:tenantId/api-keys',
          description: 'List API keys for a tenant.',
          auth: 'X-API-Key',
          response: { data: [{ id: 'uuid', name: 'Tenant Portal Key', keyPreview: 'sc_...xyz' }] },
        },
        {
          method: 'DELETE',
          path: '/tenants/:tenantId/api-keys/:keyId',
          description: 'Revoke a tenant API key.',
          auth: 'X-API-Key',
          response: null,
        },
      ],
    },
    {
      category: 'Analytics',
      description: 'Get communication analytics and metrics.',
      items: [
        {
          method: 'GET',
          path: '/analytics',
          description: 'Get analytics for messages and calls.',
          auth: 'X-API-Key',
          query: 'period=7d&startDate=2026-02-01&endDate=2026-02-11&phoneNumber=+1234567890',
          response: { data: { totalMessages: 150, totalCalls: 30, inbound: 80, outbound: 100 } },
        },
      ],
    },
    {
      category: 'Voice (Twilio)',
      description: 'Browser-based calling via Twilio Voice SDK.',
      items: [
        {
          method: 'GET',
          path: '/integrations/twilio/voice-token',
          description: 'Get a Twilio Voice access token for browser-based calling.',
          auth: 'X-API-Key',
          response: { data: { token: 'eyJ...' } },
        },
        {
          method: 'GET',
          path: '/integrations/twilio/voice-config',
          description: 'Get Twilio voice configuration.',
          auth: 'X-API-Key',
          response: { data: { twimlAppSid: 'AP...', configured: true } },
        },
        {
          method: 'POST',
          path: '/integrations/twilio/voice/twiml',
          description: 'Generate TwiML for an outgoing call.',
          auth: 'X-API-Key',
          body: { to: '+1234567890', from: '+0987654321' },
          response: { data: { twiml: '<Response>...</Response>' } },
        },
      ],
    },
    {
      category: 'Portal',
      description: 'Tenant self-service portal endpoints.',
      items: [
        {
          method: 'POST',
          path: '/portal/auth',
          description: 'Authenticate a tenant with their API key.',
          auth: 'None',
          body: { apiKey: 'sc_tenant_abc123...' },
          response: { data: { tenant: { id: 'uuid', name: 'Acme Corp' }, token: '...' } },
        },
        {
          method: 'GET',
          path: '/portal/account',
          description: 'Get tenant account information.',
          auth: 'X-API-Key (tenant)',
          response: { data: { id: 'uuid', name: 'Acme Corp', phoneNumbers: [] } },
        },
        {
          method: 'GET',
          path: '/portal/phone-numbers',
          description: 'Get tenant phone numbers.',
          auth: 'X-API-Key (tenant)',
          response: { data: [{ phoneNumber: '+1234567890', name: 'Main Line', status: 'active' }] },
        },
      ],
    },
  ];

  const methodColors: Record<string, string> = {
    GET: 'bg-green-100 text-green-800',
    POST: 'bg-blue-100 text-blue-800',
    PUT: 'bg-yellow-100 text-yellow-800',
    PATCH: 'bg-orange-100 text-orange-800',
    DELETE: 'bg-red-100 text-red-800',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API Documentation</h1>
          <p className="text-sm text-gray-500">Complete reference for Sigcore API endpoints</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <Book className="h-4 w-4" />
          <span>v1.0</span>
        </div>
      </div>

      {/* Base URL */}
      <div className="card p-5 bg-blue-50 border border-blue-200">
        <h3 className="text-sm font-semibold text-blue-900 mb-2">Base URL</h3>
        <div className="flex items-center gap-2">
          <code className="flex-1 p-2 bg-white rounded border border-blue-200 text-sm text-blue-900 font-mono">
            {baseUrl}
          </code>
          <button
            onClick={() => copyToClipboard(baseUrl, 'base-url')}
            className="p-2 hover:bg-blue-100 rounded"
            title="Copy"
          >
            {copiedEndpoint === 'base-url' ? (
              <Check className="h-4 w-4 text-green-600" />
            ) : (
              <Copy className="h-4 w-4 text-blue-600" />
            )}
          </button>
        </div>
      </div>

      {/* Authentication */}
      <div className="card p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Authentication</h3>
        <p className="text-sm text-gray-600 mb-3">
          All API requests require authentication using an API key. Include your API key in the request header:
        </p>
        <code className="block p-3 bg-gray-50 rounded border border-gray-200 text-sm font-mono">
          x-api-key: sc_tenant_your_api_key_here
        </code>
        <p className="text-xs text-gray-500 mt-3">
          Tenant API keys (prefixed <code className="text-xs">sc_tenant_</code>) automatically resolve the workspace and tenant context. No additional headers are needed.
        </p>
      </div>

      {/* Real-Time Events */}
      <div className="card p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Real-Time Events (Socket.IO)</h3>
        <p className="text-sm text-gray-600 mb-3">
          Sigcore uses Socket.IO for real-time event delivery. Connect to the same host as the API and join your workspace room to receive live updates.
        </p>
        <div className="space-y-3">
          <div>
            <h4 className="text-xs font-semibold text-gray-700 mb-1">Connection</h4>
            <pre className="p-3 bg-gray-900 text-gray-100 rounded text-xs overflow-auto">{`import { io } from 'socket.io-client';

const socket = io('https://your-api-domain.com');
socket.emit('join', workspaceId);  // from GET /integrations/all`}</pre>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-gray-700 mb-2">Events</h4>
            <div className="space-y-2 text-sm">
              <div className="flex items-start gap-3 p-2 bg-gray-50 rounded">
                <code className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-mono text-xs whitespace-nowrap">message:new</code>
                <span className="text-gray-600 text-xs">New message received or sent. Payload: <code className="text-xs">{`{ id, conversationId, direction, body, fromNumber, toNumber, status, createdAt }`}</code></span>
              </div>
              <div className="flex items-start gap-3 p-2 bg-gray-50 rounded">
                <code className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-mono text-xs whitespace-nowrap">conversation:new</code>
                <span className="text-gray-600 text-xs">New conversation created. Payload: <code className="text-xs">{`{ id, phoneNumber, participantPhoneNumber, contactName, lastMessage, lastMessageAt }`}</code></span>
              </div>
              <div className="flex items-start gap-3 p-2 bg-gray-50 rounded">
                <code className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-mono text-xs whitespace-nowrap">conversation:update</code>
                <span className="text-gray-600 text-xs">Conversation updated with new message. Payload: <code className="text-xs">{`{ id, participantPhoneNumber, contactName, lastMessage, lastMessageAt }`}</code></span>
              </div>
              <div className="flex items-start gap-3 p-2 bg-gray-50 rounded">
                <code className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-mono text-xs whitespace-nowrap">call:new</code>
                <span className="text-gray-600 text-xs">New call logged. Payload: <code className="text-xs">{`{ id, conversationId, direction, duration, fromNumber, toNumber, status, createdAt }`}</code></span>
              </div>
              <div className="flex items-start gap-3 p-2 bg-gray-50 rounded">
                <code className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-mono text-xs whitespace-nowrap">call:update</code>
                <span className="text-gray-600 text-xs">Call status changed. Payload: <code className="text-xs">{`{ id, phoneNumber, participantPhoneNumber, contactName }`}</code></span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Outbound Webhooks */}
      <div className="card p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Outbound Webhook Signatures</h3>
        <p className="text-sm text-gray-600 mb-3">
          When Sigcore sends webhooks to your subscription URL, each request includes these headers for verification:
        </p>
        <div className="space-y-2 text-sm mb-4">
          <div className="flex items-start gap-3 p-2 bg-gray-50 rounded">
            <code className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-mono text-xs whitespace-nowrap">X-Callio-Event</code>
            <span className="text-gray-600 text-xs">The event type (e.g., <code className="text-xs">message.inbound</code>)</span>
          </div>
          <div className="flex items-start gap-3 p-2 bg-gray-50 rounded">
            <code className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-mono text-xs whitespace-nowrap">X-Callio-Timestamp</code>
            <span className="text-gray-600 text-xs">ISO 8601 timestamp of when the event was sent</span>
          </div>
          <div className="flex items-start gap-3 p-2 bg-gray-50 rounded">
            <code className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-mono text-xs whitespace-nowrap">X-Callio-Signature</code>
            <span className="text-gray-600 text-xs">HMAC-SHA256 hex digest of the request body, signed with the tenant&apos;s webhook secret. Fetch secret via <code className="text-xs">GET /webhook-subscriptions/secret</code></span>
          </div>
        </div>
        <pre className="p-3 bg-gray-900 text-gray-100 rounded text-xs overflow-auto">{`// Verify webhook signature (Node.js)
const crypto = require('crypto');
const computed = crypto.createHmac('sha256', webhookSecret)
  .update(rawBody).digest('hex');
if (computed !== req.headers['x-callio-signature']) {
  throw new Error('Invalid signature');
}`}</pre>
      </div>

      {/* Incoming Provider Webhooks */}
      <div className="card p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Incoming Provider Webhooks</h3>
        <p className="text-sm text-gray-600 mb-3">
          Sigcore receives webhooks from connected providers at these endpoints. These are configured automatically when you connect an integration.
        </p>
        <div className="space-y-2 text-sm">
          <div className="flex items-start gap-3 p-2 bg-gray-50 rounded">
            <code className="px-2 py-0.5 bg-purple-100 text-purple-800 rounded font-mono text-xs">POST</code>
            <div>
              <code className="text-xs font-mono">/webhooks/openphone/:webhookId</code>
              <p className="text-xs text-gray-500 mt-0.5">Receives message.received, message.delivered, call.completed, call.ringing events</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-2 bg-gray-50 rounded">
            <code className="px-2 py-0.5 bg-purple-100 text-purple-800 rounded font-mono text-xs">POST</code>
            <div>
              <code className="text-xs font-mono">/webhooks/twilio/sms/:webhookId</code>
              <p className="text-xs text-gray-500 mt-0.5">Receives incoming Twilio SMS messages</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-2 bg-gray-50 rounded">
            <code className="px-2 py-0.5 bg-purple-100 text-purple-800 rounded font-mono text-xs">POST</code>
            <div>
              <code className="text-xs font-mono">/webhooks/twilio/voice/:webhookId</code>
              <p className="text-xs text-gray-500 mt-0.5">Receives incoming Twilio voice calls</p>
            </div>
          </div>
        </div>
      </div>

      {/* Endpoints by Category */}
      {endpoints.map((category) => (
        <div key={category.category} className="card">
          <div className="p-5 border-b border-gray-200 bg-gray-50">
            <h2 className="text-lg font-semibold text-gray-900">{category.category}</h2>
            {category.description && (
              <p className="text-sm text-gray-500 mt-1">{category.description}</p>
            )}
          </div>
          <div className="divide-y divide-gray-100">
            {category.items.map((endpoint, idx) => {
              const endpointId = `${category.category}-${idx}`;
              const curlCommand = `curl -X ${endpoint.method} "${baseUrl}${endpoint.path}${endpoint.query ? '?' + endpoint.query : ''}" \\
  -H "x-api-key: sc_tenant_your_api_key_here"${endpoint.body ? ` \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(endpoint.body, null, 2)}'` : ''}`;

              return (
                <div key={idx} className="p-5 hover:bg-gray-50">
                  <div className="flex items-start gap-3 mb-3">
                    <span className={`px-2 py-1 rounded text-xs font-bold ${methodColors[endpoint.method]}`}>
                      {endpoint.method}
                    </span>
                    <div className="flex-1">
                      <code className="text-sm font-mono text-gray-900">{endpoint.path}</code>
                      {endpoint.query && (
                        <p className="text-xs text-gray-400 font-mono mt-0.5">?{endpoint.query}</p>
                      )}
                      <p className="text-sm text-gray-600 mt-1">{endpoint.description}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        <strong>Auth:</strong> {endpoint.auth}
                      </p>
                    </div>
                    <button
                      onClick={() => copyToClipboard(curlCommand, endpointId)}
                      className="p-2 hover:bg-gray-200 rounded"
                      title="Copy cURL command"
                    >
                      {copiedEndpoint === endpointId ? (
                        <Check className="h-4 w-4 text-green-600" />
                      ) : (
                        <Copy className="h-4 w-4 text-gray-600" />
                      )}
                    </button>
                  </div>

                  {endpoint.body && (
                    <details className="mb-2">
                      <summary className="text-xs font-semibold text-gray-700 cursor-pointer hover:text-gray-900">
                        Request Body
                      </summary>
                      <pre className="mt-2 p-3 bg-gray-900 text-gray-100 rounded text-xs overflow-auto">
                        {JSON.stringify(endpoint.body, null, 2)}
                      </pre>
                    </details>
                  )}

                  {endpoint.response !== undefined && (
                    <details>
                      <summary className="text-xs font-semibold text-gray-700 cursor-pointer hover:text-gray-900">
                        Response Example
                      </summary>
                      {endpoint.response === null ? (
                        <p className="mt-2 text-xs text-gray-500 italic">204 No Content</p>
                      ) : (
                        <pre className="mt-2 p-3 bg-gray-900 text-gray-100 rounded text-xs overflow-auto">
                          {JSON.stringify(endpoint.response, null, 2)}
                        </pre>
                      )}
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Response Codes */}
      <div className="card p-5">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Response Codes</h3>
        <div className="space-y-2 text-sm">
          <div className="flex items-start gap-3">
            <code className="px-2 py-1 bg-green-100 text-green-800 rounded font-mono text-xs">200</code>
            <span className="text-gray-600">Success - Request completed successfully</span>
          </div>
          <div className="flex items-start gap-3">
            <code className="px-2 py-1 bg-blue-100 text-blue-800 rounded font-mono text-xs">201</code>
            <span className="text-gray-600">Created - Resource created successfully</span>
          </div>
          <div className="flex items-start gap-3">
            <code className="px-2 py-1 bg-blue-100 text-blue-800 rounded font-mono text-xs">202</code>
            <span className="text-gray-600">Accepted - Background task started (e.g., sync)</span>
          </div>
          <div className="flex items-start gap-3">
            <code className="px-2 py-1 bg-gray-100 text-gray-800 rounded font-mono text-xs">204</code>
            <span className="text-gray-600">No Content - Delete completed successfully</span>
          </div>
          <div className="flex items-start gap-3">
            <code className="px-2 py-1 bg-red-100 text-red-800 rounded font-mono text-xs">400</code>
            <span className="text-gray-600">Bad Request - Invalid request parameters</span>
          </div>
          <div className="flex items-start gap-3">
            <code className="px-2 py-1 bg-red-100 text-red-800 rounded font-mono text-xs">401</code>
            <span className="text-gray-600">Unauthorized - Invalid or missing API key</span>
          </div>
          <div className="flex items-start gap-3">
            <code className="px-2 py-1 bg-red-100 text-red-800 rounded font-mono text-xs">404</code>
            <span className="text-gray-600">Not Found - Resource not found</span>
          </div>
          <div className="flex items-start gap-3">
            <code className="px-2 py-1 bg-red-100 text-red-800 rounded font-mono text-xs">500</code>
            <span className="text-gray-600">Server Error - Internal server error</span>
          </div>
        </div>
      </div>
    </div>
  );
}
