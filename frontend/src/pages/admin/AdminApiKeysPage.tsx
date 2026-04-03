import { useState, useEffect } from 'react';
import { Key, Plus, Trash2, Copy, Check, RefreshCw, Loader2, ToggleLeft, ToggleRight, Link } from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { WorkspaceApiKey } from '../../types';

export default function AdminApiKeysPage() {
  const [apiKeys, setApiKeys] = useState<WorkspaceApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newKeyFullValue, setNewKeyFullValue] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const apiUrl = import.meta.env.VITE_API_URL || `${window.location.origin}/api`;

  const loadApiKeys = async () => {
    setLoading(true);
    setError(null);
    try {
      const keys = await adminApi.getApiKeys();
      setApiKeys(keys);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadApiKeys();
  }, []);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    try {
      setCreating(true);
      setNewKeyFullValue(null);
      const result = await adminApi.createApiKey(newKeyName.trim());
      setNewKeyFullValue(result.fullKey);
      setNewKeyName('');
      await loadApiKeys();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to create API key');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (keyId: string) => {
    if (!confirm('Are you sure you want to delete this API key? This action cannot be undone.')) return;
    try {
      await adminApi.deleteApiKey(keyId);
      setApiKeys(apiKeys.filter(k => k.id !== keyId));
      setNewKeyFullValue(null);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete API key');
    }
  };

  const handleToggle = async (keyId: string) => {
    try {
      const updated = await adminApi.toggleApiKey(keyId);
      setApiKeys(apiKeys.map(k => k.id === keyId ? updated : k));
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to toggle API key');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API Keys</h1>
          <p className="text-sm text-gray-500">Manage workspace API keys for admin access</p>
        </div>
        <button onClick={loadApiKeys} className="btn-secondary flex items-center gap-2" disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
      )}

      {/* API URL */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2 flex items-center gap-2">
          <Link className="h-5 w-5 text-blue-500" />
          API URL
        </h2>
        <p className="text-sm text-gray-500 mb-3">
          Tenants use this URL to connect their systems to Sigcore. Include it with the API key when onboarding a new tenant.
        </p>
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono bg-blue-50 border border-blue-200 px-3 py-2 rounded flex-1 text-blue-800 break-all">
            {apiUrl}
          </code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(apiUrl);
              setCopiedUrl(true);
              setTimeout(() => setCopiedUrl(false), 2000);
            }}
            className={`flex-shrink-0 p-2 rounded ${copiedUrl ? 'text-green-600 bg-green-50' : 'text-blue-600 hover:bg-blue-50'}`}
            title="Copy API URL"
          >
            {copiedUrl ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Create New Key */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Create New API Key</h2>
        <div className="flex gap-3">
          <input
            type="text"
            className="input flex-1"
            placeholder="Key name (e.g., Admin Dashboard, CI/CD)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <button
            onClick={handleCreate}
            className="btn btn-primary flex items-center gap-2"
            disabled={creating || !newKeyName.trim()}
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create
          </button>
        </div>

        {newKeyFullValue && (
          <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-sm font-medium text-green-800 mb-2">
              API key created! Copy it now — it won't be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="text-sm font-mono bg-white px-3 py-2 rounded border border-green-200 flex-1 break-all">
                {newKeyFullValue}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(newKeyFullValue);
                  setCopiedKey(true);
                  setTimeout(() => setCopiedKey(false), 2000);
                }}
                className="flex-shrink-0 p-2 text-green-700 hover:bg-green-100 rounded"
                title="Copy"
              >
                {copiedKey ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Keys List */}
      <div className="card">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Existing Keys</h2>
        </div>
        {apiKeys.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Key className="h-12 w-12 mx-auto mb-4 text-gray-300" />
            <p>No API keys yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {apiKeys.map((key) => (
              <div key={key.id} className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Key className={`h-5 w-5 ${key.active ? 'text-green-500' : 'text-gray-300'}`} />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900">{key.name}</span>
                      <span className={`px-2 py-0.5 text-xs rounded-full ${
                        key.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {key.active ? 'Active' : 'Inactive'}
                      </span>
                      <span className="px-2 py-0.5 text-xs rounded-full bg-blue-50 text-blue-600">
                        {key.scope}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 font-mono mt-0.5">{key.keyPreview}</div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      Created: {new Date(key.createdAt).toLocaleDateString()}
                      {key.lastUsedAt && ` · Last used: ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggle(key.id)}
                    className={`p-1 rounded hover:bg-gray-100 ${key.active ? 'text-green-500' : 'text-gray-400'}`}
                    title={key.active ? 'Disable' : 'Enable'}
                  >
                    {key.active ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
                  </button>
                  <button
                    onClick={() => handleDelete(key.id)}
                    className="p-1 text-red-500 hover:bg-red-50 rounded"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
