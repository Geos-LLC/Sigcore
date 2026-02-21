import { useState, useEffect } from 'react';
import {
  Plus,
  Trash2,
  Check,
  X,
  Building2,
  Loader2,
  AlertCircle,
  Copy,
  ChevronDown,
  ChevronUp,
  Key,
  Eye,
  EyeOff,
  Link,
  FileText,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { Tenant, TenantApiKeyInfo } from '../../types';

const STORED_KEYS_KEY = 'tenantApiFullKeys';

function loadStoredKeys(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORED_KEYS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveStoredKey(keyId: string, fullKey: string) {
  const stored = loadStoredKeys();
  stored[keyId] = fullKey;
  localStorage.setItem(STORED_KEYS_KEY, JSON.stringify(stored));
}

function removeStoredKey(keyId: string) {
  const stored = loadStoredKeys();
  delete stored[keyId];
  localStorage.setItem(STORED_KEYS_KEY, JSON.stringify(stored));
}

export default function AdminTenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTenantName, setNewTenantName] = useState('');
  const [creating, setCreating] = useState(false);

  const [expandedTenantId, setExpandedTenantId] = useState<string | null>(null);

  const [tenantApiKeys, setTenantApiKeys] = useState<Record<string, TenantApiKeyInfo[]>>({});
  const [fullKeys, setFullKeys] = useState<Record<string, string>>(loadStoredKeys);
  const [revealedKeyId, setRevealedKeyId] = useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const apiUrl = import.meta.env.VITE_API_URL || `${window.location.origin}/api`;

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(apiUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const tenantsData = await adminApi.getTenants();
      setTenants(tenantsData);

      // Load API key counts for all tenants so collapsed cards show correct count
      const keyResults = await Promise.all(
        tenantsData.map(async (t: Tenant) => {
          try {
            const keys = await adminApi.getTenantApiKeys(t.id);
            return { tenantId: t.id, keys };
          } catch {
            return { tenantId: t.id, keys: [] };
          }
        }),
      );
      const keysMap: Record<string, TenantApiKeyInfo[]> = {};
      for (const r of keyResults) {
        keysMap[r.tenantId] = r.keys;
        for (const k of r.keys) {
          if (k.key) saveStoredKey(k.id, k.key);
        }
      }
      setTenantApiKeys(keysMap);
      setFullKeys(loadStoredKeys());
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTenant = async () => {
    if (!newTenantName.trim()) return;
    try {
      setCreating(true);
      const tenant = await adminApi.createTenant({
        name: newTenantName.trim(),
      });
      setTenants([tenant, ...tenants]);
      setShowCreateModal(false);
      setNewTenantName('');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to create tenant');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteTenant = async (tenantId: string) => {
    if (!confirm('Are you sure you want to delete this tenant? This will revoke all API keys.')) return;
    try {
      await adminApi.deleteTenant(tenantId);
      setTenants(tenants.filter(t => t.id !== tenantId));
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete tenant');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const loadTenantApiKeys = async (tenantId: string) => {
    try {
      const keys = await adminApi.getTenantApiKeys(tenantId);
      for (const k of keys) {
        if (k.key) saveStoredKey(k.id, k.key);
      }
      setTenantApiKeys((prev) => ({ ...prev, [tenantId]: keys }));
      setFullKeys(loadStoredKeys());
    } catch {
      // Silently fail
    }
  };

  const handleGenerateApiKey = async (tenantId: string) => {
    try {
      setGeneratingKey(true);
      const result = await adminApi.createTenantApiKey(tenantId, 'Portal Key');
      saveStoredKey(result.id, result.key);
      setFullKeys(loadStoredKeys());
      setRevealedKeyId(result.id);
      await loadTenantApiKeys(tenantId);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to generate API key');
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleRevokeApiKey = async (tenantId: string, keyId: string) => {
    if (!confirm('Are you sure? The tenant will lose access to the portal.')) return;
    try {
      await adminApi.deleteTenantApiKey(tenantId, keyId);
      removeStoredKey(keyId);
      setFullKeys(loadStoredKeys());
      setRevealedKeyId(null);
      await loadTenantApiKeys(tenantId);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to revoke API key');
    }
  };

  const handleCopyKey = (keyId: string, fullKey: string) => {
    navigator.clipboard.writeText(fullKey);
    setCopiedKeyId(keyId);
    setTimeout(() => setCopiedKeyId(null), 2000);
  };

  const handleToggleExpand = (tenantId: string) => {
    const isExpanding = expandedTenantId !== tenantId;
    setExpandedTenantId(isExpanding ? tenantId : null);
    setRevealedKeyId(null);
    if (isExpanding) {
      loadTenantApiKeys(tenantId);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tenants</h1>
          <p className="text-sm text-gray-500 mt-1">
            Create tenants and generate API keys for portal access
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="btn btn-primary flex items-center gap-2"
        >
          <Plus className="h-4 w-4" />
          Add Tenant
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-red-700">{error}</p>
          </div>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <Building2 className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <p className="text-sm text-gray-500">Total Tenants</p>
            <p className="text-2xl font-bold">{tenants.length}</p>
          </div>
        </div>
      </div>

      {/* Tenants List */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Tenants</h2>
        </div>
        {tenants.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Building2 className="h-12 w-12 mx-auto mb-4 text-gray-300" />
            <p>No tenants yet. Create your first tenant to get started.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {tenants.map((tenant) => (
              <div key={tenant.id} className="p-4">
                <div className="flex items-center justify-between">
                  <div
                    className="flex items-center gap-3 cursor-pointer flex-1"
                    onClick={() => handleToggleExpand(tenant.id)}
                  >
                    <div className="p-2 bg-gray-100 rounded-lg">
                      <Building2 className="h-5 w-5 text-gray-600" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-gray-900">{tenant.name}</h3>
                        <span className={`px-2 py-0.5 text-xs rounded-full ${
                          tenant.status === 'active'
                            ? 'bg-green-100 text-green-700'
                            : tenant.status === 'suspended'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-gray-100 text-gray-700'
                        }`}>
                          {tenant.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-gray-500">
                        <span>ID: {tenant.externalId}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); copyToClipboard(tenant.id); }}
                          className="p-1 hover:bg-gray-100 rounded"
                          title="Copy tenant ID"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                        <span className="text-gray-300">|</span>
                        <span>{(tenantApiKeys[tenant.id] || []).length} API keys</span>
                      </div>
                    </div>
                    {expandedTenantId === tenant.id ? (
                      <ChevronUp className="h-5 w-5 text-gray-400" />
                    ) : (
                      <ChevronDown className="h-5 w-5 text-gray-400" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <button
                      onClick={() => handleDeleteTenant(tenant.id)}
                      className="p-2 text-red-500 hover:bg-red-50 rounded"
                      title="Delete tenant"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {expandedTenantId === tenant.id && (
                  <div className="mt-4 pl-12">
                    {/* API URL */}
                    <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Link className="h-4 w-4 text-blue-500" />
                          <span className="text-sm font-medium text-blue-900">API URL</span>
                        </div>
                        <button
                          onClick={handleCopyUrl}
                          className={`p-1 rounded ${copiedUrl ? 'text-green-600' : 'text-blue-500 hover:bg-blue-100'}`}
                          title="Copy API URL"
                        >
                          {copiedUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        </button>
                      </div>
                      <code className="text-xs font-mono text-blue-800 mt-1 block">{apiUrl}</code>
                    </div>

                    {/* API Keys Section */}
                    <h4 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                      <Key className="h-4 w-4" />
                      Portal API Keys
                    </h4>

                    {(tenantApiKeys[tenant.id] || []).length > 0 ? (
                      <div className="space-y-2">
                        {(tenantApiKeys[tenant.id] || []).map((k) => {
                          const hasFullKey = !!fullKeys[k.id];
                          const isRevealed = revealedKeyId === k.id;
                          const isCopied = copiedKeyId === k.id;

                          return (
                            <div key={k.id} className={`p-3 rounded-lg ${isRevealed ? 'bg-green-50 border border-green-200' : 'bg-gray-50'}`}>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <Key className={`h-4 w-4 ${isRevealed ? 'text-green-500' : 'text-gray-400'}`} />
                                  <div>
                                    <span className="text-sm font-medium text-gray-900">{k.name}</span>
                                    <div className="text-xs text-gray-500 font-mono">{k.keyPreview}</div>
                                    {k.lastUsedAt && (
                                      <span className="text-xs text-gray-400">
                                        Last used: {new Date(k.lastUsedAt).toLocaleDateString()}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1">
                                  {hasFullKey && (
                                    <button
                                      onClick={() => setRevealedKeyId(isRevealed ? null : k.id)}
                                      className={`p-1 rounded ${isRevealed ? 'text-green-700 hover:bg-green-100' : 'text-gray-400 hover:bg-gray-100'}`}
                                      title={isRevealed ? 'Hide key' : 'Show key'}
                                    >
                                      {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </button>
                                  )}
                                  {hasFullKey && (
                                    <button
                                      onClick={() => handleCopyKey(k.id, fullKeys[k.id])}
                                      className={`p-1 rounded ${isCopied ? 'text-green-600' : 'text-gray-400 hover:bg-gray-100'}`}
                                      title="Copy full key"
                                    >
                                      {isCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                                    </button>
                                  )}
                                  <button
                                    onClick={() => handleRevokeApiKey(tenant.id, k.id)}
                                    className="p-1 text-red-500 hover:bg-red-50 rounded"
                                    title="Revoke key"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                              </div>
                              {isRevealed && hasFullKey && (
                                <div className="mt-2 pl-7">
                                  <code className="text-xs font-mono bg-white px-2 py-1 rounded border border-green-200 block break-all">
                                    {fullKeys[k.id]}
                                  </code>
                                  <p className="text-xs text-green-700 mt-1">
                                    Portal URL: <code className="bg-white px-1 rounded">{window.location.origin}/portal/login</code>
                                  </p>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500">
                        No API keys. Generate one to give the tenant portal access.
                      </p>
                    )}

                    <button
                      onClick={() => handleGenerateApiKey(tenant.id)}
                      disabled={generatingKey}
                      className="mt-3 btn btn-secondary btn-sm flex items-center gap-1"
                    >
                      {generatingKey ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Plus className="h-3 w-3" />
                      )}
                      Generate API Key
                    </button>

                    {/* Setup Instructions */}
                    <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg">
                      <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        Tenant Setup Instructions
                      </h4>
                      <ol className="text-xs text-gray-600 space-y-2 list-decimal list-inside">
                        <li>
                          Add these environment variables to the tenant&apos;s backend <code className="bg-white px-1 py-0.5 rounded border text-gray-800">.env</code>:
                          <pre className="mt-1 ml-4 bg-white p-2 rounded border text-gray-800 font-mono whitespace-pre-wrap">{`SIGCORE_URL=${apiUrl}\nSIGCORE_API_KEY=<paste the API key above>`}</pre>
                        </li>
                        <li>
                          All API requests must include the header:
                          <pre className="mt-1 ml-4 bg-white p-2 rounded border text-gray-800 font-mono whitespace-pre-wrap">{`x-api-key: <tenant API key>`}</pre>
                        </li>
                        <li>
                          Connect integrations via API:
                          <pre className="mt-1 ml-4 bg-white p-2 rounded border text-gray-800 font-mono whitespace-pre-wrap">{`POST ${apiUrl}/integrations/openphone/connect\n{ "apiKey": "<openphone-api-key>" }\n\nPOST ${apiUrl}/integrations/twilio\n{ "accountSid": "...", "authToken": "...", "phoneNumber": "..." }`}</pre>
                        </li>
                        <li>
                          Register a webhook to receive events (secret is auto-filled from tenant record):
                          <pre className="mt-1 ml-4 bg-white p-2 rounded border text-gray-800 font-mono whitespace-pre-wrap">{`POST ${apiUrl}/webhook-subscriptions\n{\n  "name": "${tenant.name} Webhook",\n  "webhookUrl": "https://<tenant-domain>/webhooks/sigcore",\n  "events": ["message.inbound", "message.sent",\n    "call.completed", "call.missed"]\n}`}</pre>
                        </li>
                      </ol>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Tenant Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold mb-4">Create Tenant</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input
                  type="text"
                  value={newTenantName}
                  onChange={(e) => setNewTenantName(e.target.value)}
                  placeholder="e.g., Acme Corp"
                  className="input w-full"
                  onKeyDown={(e) => { if (e.key === 'Enter' && newTenantName.trim()) handleCreateTenant(); }}
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => { setShowCreateModal(false); setNewTenantName(''); }}
                className="btn btn-secondary"
                disabled={creating}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateTenant}
                className="btn btn-primary flex items-center gap-2"
                disabled={creating || !newTenantName.trim()}
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
