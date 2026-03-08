import { useState, useEffect, useRef } from 'react';
import {
  RefreshCw,
  Play,
  Square,
  Trash2,
  Building2,
  Phone,
  Loader2,
  AlertCircle,
  CheckCircle,
  XCircle,
  X,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';

interface TenantOverview {
  id: string;
  externalId: string;
  name: string;
  status: string;
  phoneNumbers: Array<{ id: string; phoneNumber: string; provider: string; friendlyName?: string }>;
  integrations: Array<{ id: string; provider: string; status: string }>;
  createdAt: string;
}

interface SyncStatus {
  status: 'idle' | 'running' | 'completed' | 'error' | 'cancelled';
  phase: string;
  current: number;
  total: number;
  message: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: {
    conversationsFromProvider: number;
    conversationsSynced: number;
    messagesSynced: number;
    callsSynced: number;
    errors: number;
    conversationsSkipped: number;
  };
}

interface OrphanTenant {
  id: string;
  externalId: string;
  name: string;
  status: string;
  createdAt: string;
}

export default function AdminSyncMonitorPage() {
  const [tenants, setTenants] = useState<TenantOverview[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [orphans, setOrphans] = useState<OrphanTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [deletingOrphans, setDeletingOrphans] = useState(false);
  const [expandedTenant, setExpandedTenant] = useState<string | null>(null);
  const [showOrphans, setShowOrphans] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadData();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const overview = await adminApi.getSyncOverview();
      setTenants(overview.tenants);
      setSyncStatus(overview.syncStatus);

      if (overview.syncStatus?.status === 'running') {
        startPolling();
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await adminApi.getTenantSyncStatus();
        setSyncStatus(status);
        if (status.status !== 'running') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setSyncing(false);
          if (status.status === 'completed') {
            setSuccess('Sync completed successfully');
            setTimeout(() => setSuccess(null), 5000);
          }
        }
      } catch {
        // ignore poll errors
      }
    }, 2000);
  };

  const handleTriggerSync = async () => {
    try {
      setSyncing(true);
      setError(null);
      await adminApi.triggerTenantSync({ syncMessages: true });
      startPolling();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to start sync');
      setSyncing(false);
    }
  };

  const handleCancelSync = async () => {
    try {
      await adminApi.cancelTenantSync();
      setSuccess('Sync cancellation requested');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to cancel sync');
    }
  };

  const handleLoadOrphans = async () => {
    try {
      setShowOrphans(true);
      const data = await adminApi.getOrphanedTenants();
      setOrphans(data);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load orphans');
    }
  };

  const handleDeleteOrphans = async () => {
    if (!confirm(`Delete ${orphans.length} orphaned tenants? This cannot be undone.`)) return;
    try {
      setDeletingOrphans(true);
      const result = await adminApi.deleteOrphanedTenants();
      setSuccess(`Deleted ${result.deleted} orphaned tenants`);
      setTimeout(() => setSuccess(null), 4000);
      setOrphans([]);
      await loadData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete orphans');
    } finally {
      setDeletingOrphans(false);
    }
  };

  const handleDeleteSingleOrphan = async (tenantId: string) => {
    if (!confirm('Delete this orphaned tenant?')) return;
    try {
      const result = await adminApi.deleteOrphanedTenants([tenantId]);
      if (result.deleted > 0) {
        setOrphans(prev => prev.filter(o => o.id !== tenantId));
        setSuccess('Tenant deleted');
        setTimeout(() => setSuccess(null), 3000);
        await loadData();
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete tenant');
    }
  };

  const progressPercent = syncStatus?.total
    ? Math.min(100, Math.round((syncStatus.current / syncStatus.total) * 100))
    : 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sync Monitor</h1>
          <p className="text-sm text-gray-500 mt-1">
            Monitor OpenPhone sync progress and manage tenant cleanup
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={loadData}
            className="btn btn-secondary flex items-center gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700 flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
          <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-green-700 flex-1">{success}</p>
          <button onClick={() => setSuccess(null)} className="text-green-500 hover:text-green-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Sync Status Card */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">OpenPhone Sync</h2>
          <div className="flex items-center gap-2">
            {syncStatus?.status === 'running' ? (
              <button
                onClick={handleCancelSync}
                className="btn btn-secondary flex items-center gap-2 text-red-600 hover:bg-red-50"
              >
                <Square className="h-4 w-4" />
                Cancel
              </button>
            ) : (
              <button
                onClick={handleTriggerSync}
                disabled={syncing}
                className="btn btn-primary flex items-center gap-2"
              >
                {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Start Sync
              </button>
            )}
          </div>
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-3 mb-4">
          <div className={`w-3 h-3 rounded-full ${
            syncStatus?.status === 'running' ? 'bg-blue-500 animate-pulse' :
            syncStatus?.status === 'completed' ? 'bg-green-500' :
            syncStatus?.status === 'error' ? 'bg-red-500' :
            syncStatus?.status === 'cancelled' ? 'bg-yellow-500' :
            'bg-gray-300'
          }`} />
          <span className="text-sm font-medium text-gray-700 capitalize">
            {syncStatus?.status || 'idle'}
          </span>
          {syncStatus?.phase && (
            <span className="text-sm text-gray-500">— {syncStatus.phase}</span>
          )}
          {syncStatus?.message && syncStatus.status === 'running' && (
            <span className="text-sm text-gray-400 ml-auto">{syncStatus.message}</span>
          )}
        </div>

        {/* Progress bar */}
        {syncStatus?.status === 'running' && syncStatus.total > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">
                {syncStatus.current} / {syncStatus.total}
              </span>
              <span className="font-medium text-blue-600">{progressPercent}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div
                className="bg-blue-500 h-3 rounded-full transition-all duration-700 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Completed result */}
        {syncStatus?.result && syncStatus.status !== 'running' && (
          <div className="mt-4 grid grid-cols-3 gap-4">
            <div className="bg-blue-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-blue-700">{syncStatus.result.conversationsSynced}</p>
              <p className="text-xs text-blue-500">Conversations</p>
            </div>
            <div className="bg-green-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-green-700">{syncStatus.result.messagesSynced}</p>
              <p className="text-xs text-green-500">Messages</p>
            </div>
            <div className="bg-purple-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-purple-700">{syncStatus.result.callsSynced}</p>
              <p className="text-xs text-purple-500">Calls</p>
            </div>
            {syncStatus.result.errors > 0 && (
              <div className="bg-red-50 rounded-lg p-3 text-center">
                <p className="text-2xl font-bold text-red-700">{syncStatus.result.errors}</p>
                <p className="text-xs text-red-500">Errors</p>
              </div>
            )}
            {syncStatus.result.conversationsSkipped > 0 && (
              <div className="bg-gray-50 rounded-lg p-3 text-center">
                <p className="text-2xl font-bold text-gray-700">{syncStatus.result.conversationsSkipped}</p>
                <p className="text-xs text-gray-500">Skipped</p>
              </div>
            )}
          </div>
        )}

        {/* Error display */}
        {syncStatus?.status === 'error' && syncStatus.error && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
            <XCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{syncStatus.error}</p>
          </div>
        )}
      </div>

      {/* Tenants Overview */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Tenants ({tenants.length})</h2>
            <p className="text-sm text-gray-500">All tenants with their integrations and phone numbers</p>
          </div>
          <button
            onClick={handleLoadOrphans}
            className="btn btn-secondary flex items-center gap-2 text-sm"
          >
            <Trash2 className="h-4 w-4" />
            Find Orphans
          </button>
        </div>

        {tenants.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Building2 className="h-12 w-12 mx-auto mb-4 text-gray-300" />
            <p>No tenants found.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {tenants.map((tenant) => (
              <div key={tenant.id} className="p-4">
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => setExpandedTenant(expandedTenant === tenant.id ? null : tenant.id)}
                >
                  <div className="flex items-center gap-3 flex-1">
                    <div className="p-2 bg-gray-100 rounded-lg">
                      <Building2 className="h-5 w-5 text-gray-600" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-gray-900">{tenant.name}</h3>
                        <span className={`px-2 py-0.5 text-xs rounded-full ${
                          tenant.status === 'active'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-700'
                        }`}>
                          {tenant.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-sm text-gray-500 mt-0.5">
                        <span>ID: {tenant.externalId}</span>
                        <span className="text-gray-300">|</span>
                        <span>{tenant.phoneNumbers.length} phones</span>
                        <span className="text-gray-300">|</span>
                        <span>{tenant.integrations.length} integrations</span>
                      </div>
                    </div>
                  </div>
                  {expandedTenant === tenant.id
                    ? <ChevronUp className="h-5 w-5 text-gray-400" />
                    : <ChevronDown className="h-5 w-5 text-gray-400" />
                  }
                </div>

                {expandedTenant === tenant.id && (
                  <div className="mt-4 pl-12 space-y-3">
                    <div className="text-xs text-gray-400">
                      Internal ID: <code className="bg-gray-100 px-1 rounded">{tenant.id}</code>
                      <span className="ml-4">Created: {new Date(tenant.createdAt).toLocaleDateString()}</span>
                    </div>

                    {/* Phone Numbers */}
                    {tenant.phoneNumbers.length > 0 && (
                      <div>
                        <h4 className="text-xs font-medium text-gray-500 uppercase mb-1">Phone Numbers</h4>
                        <div className="flex flex-wrap gap-2">
                          {tenant.phoneNumbers.map(pn => (
                            <span key={pn.id} className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-50 text-blue-700 text-sm rounded-lg">
                              <Phone className="h-3.5 w-3.5" />
                              {pn.phoneNumber}
                              <span className="text-blue-400 text-xs">({pn.provider})</span>
                              {pn.friendlyName && <span className="text-blue-400 text-xs">- {pn.friendlyName}</span>}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Integrations */}
                    {tenant.integrations.length > 0 && (
                      <div>
                        <h4 className="text-xs font-medium text-gray-500 uppercase mb-1">Integrations</h4>
                        <div className="flex flex-wrap gap-2">
                          {tenant.integrations.map(intg => (
                            <span key={intg.id} className={`inline-flex items-center gap-1.5 px-3 py-1 text-sm rounded-lg ${
                              intg.status === 'active'
                                ? 'bg-green-50 text-green-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}>
                              {intg.provider}
                              <span className="text-xs opacity-60">({intg.status})</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {tenant.phoneNumbers.length === 0 && tenant.integrations.length === 0 && (
                      <p className="text-sm text-orange-600 bg-orange-50 px-3 py-2 rounded-lg">
                        No phone numbers or integrations — this tenant may be orphaned.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Orphan Cleanup */}
      {showOrphans && (
        <div className="bg-white rounded-lg shadow">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-orange-700">Orphaned Tenants ({orphans.length})</h2>
              <p className="text-sm text-gray-500">Tenants with no integrations and no phone numbers</p>
            </div>
            {orphans.length > 0 && (
              <button
                onClick={handleDeleteOrphans}
                disabled={deletingOrphans}
                className="btn flex items-center gap-2 text-sm text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
              >
                {deletingOrphans ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete All Orphans
              </button>
            )}
          </div>

          {orphans.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <CheckCircle className="h-12 w-12 mx-auto mb-4 text-green-300" />
              <p>No orphaned tenants found.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {orphans.map(orphan => (
                <div key={orphan.id} className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-orange-100 rounded-lg">
                      <Building2 className="h-5 w-5 text-orange-600" />
                    </div>
                    <div>
                      <h3 className="font-medium text-gray-900">{orphan.name}</h3>
                      <div className="text-sm text-gray-500">
                        <span>ID: {orphan.externalId}</span>
                        <span className="ml-3">Created: {new Date(orphan.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteSingleOrphan(orphan.id)}
                    className="p-2 text-red-500 hover:bg-red-50 rounded"
                    title="Delete orphan"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
