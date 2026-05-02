import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Layers,
  Users,
  Phone,
  Key,
  Webhook,
  Activity,
  RefreshCw,
  ChevronRight,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { PlatformSummary, PlatformId } from '../../types';

const PLATFORM_ORDER: PlatformId[] = [
  'leadbridge',
  'hirefunnel',
  'serviceflow',
  'callio',
  'unclassified',
];

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (ms < day) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString();
}

export default function AdminPlatformsPage() {
  const [platforms, setPlatforms] = useState<PlatformSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi.getPlatforms();
      // Sort by canonical order so the layout is stable.
      const sorted = [...data].sort(
        (a, b) => PLATFORM_ORDER.indexOf(a.id) - PLATFORM_ORDER.indexOf(b.id),
      );
      setPlatforms(sorted);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to load platforms');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Platforms</h1>
          <p className="text-sm text-gray-500">
            Apps using Sigcore — derived from platform anchors and communication
            profile sources. Read-only.
          </p>
        </div>
        <button
          onClick={load}
          className="btn-secondary flex items-center gap-2"
          disabled={loading}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-3">Platform</th>
                <th className="text-left px-4 py-3">Workspaces</th>
                <th className="text-left px-4 py-3">Phone numbers</th>
                <th className="text-left px-4 py-3">API keys</th>
                <th className="text-left px-4 py-3">Webhooks</th>
                <th className="text-left px-4 py-3">Last activity</th>
                <th className="text-right px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading && platforms.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              ) : platforms.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    No platforms found.
                  </td>
                </tr>
              ) : (
                platforms
                  .filter((p) => {
                    // PR14.2 — hide Unclassified row when there are zero
                    // workspaces in it. (Empty unclassified is noise; keep it
                    // visible only when something actually lands there.)
                    if (
                      p.id === 'unclassified' &&
                      (p.workspaceCount ?? 0) === 0
                    ) {
                      return false;
                    }
                    return true;
                  })
                  .map((p) => {
                  const isUnclassified = p.id === 'unclassified';
                  const noAnchor = !isUnclassified && !p.anchorTenantId;
                  return (
                    <tr key={p.id} className={isUnclassified ? 'bg-amber-50/30' : ''}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {isUnclassified ? (
                            <HelpCircle className="h-4 w-4 text-amber-500" />
                          ) : (
                            <Layers className="h-4 w-4 text-primary-500" />
                          )}
                          <div>
                            <div className="font-medium text-gray-900">{p.name}</div>
                            {isUnclassified && (
                              <div className="text-xs text-amber-700">
                                tenants with no anchor — review manually
                              </div>
                            )}
                            {noAnchor && (
                              <div className="text-xs text-gray-400">
                                no anchor tenant in this workspace
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Cell icon={<Users className="h-3.5 w-3.5" />} value={p.workspaceCount} />
                      </td>
                      <td className="px-4 py-3">
                        <Cell icon={<Phone className="h-3.5 w-3.5" />} value={p.phoneNumberCount} />
                      </td>
                      <td className="px-4 py-3">
                        <Cell icon={<Key className="h-3.5 w-3.5" />} value={p.apiKeyCount} />
                      </td>
                      <td className="px-4 py-3">
                        <Cell
                          icon={<Webhook className="h-3.5 w-3.5" />}
                          value={p.webhookSubscriptionCount}
                        />
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        <span className="inline-flex items-center gap-1">
                          <Activity className="h-3.5 w-3.5" />
                          {formatRelative(p.lastActivityAt)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          to={`/admin/platforms/${p.id}`}
                          className="inline-flex items-center text-primary-600 hover:text-primary-800"
                          title="Open detail"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-gray-400">
        Platform attribution combines anchor tenants (<code className="font-mono">LeadBridge</code>,{' '}
        <code className="font-mono">HireFunnel</code>,{' '}
        <code className="font-mono">Service Flow</code>,{' '}
        <code className="font-mono">Callio</code>) with communication profile sources
        (<code className="font-mono">thumbtack</code>, <code className="font-mono">yelp</code>, …).
        Tenants whose attribution and source signals don't match a known platform are surfaced as{' '}
        <span className="font-medium">Unclassified</span> rather than guessed.
      </div>
    </div>
  );
}

function Cell({ icon, value }: { icon: React.ReactNode; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-gray-700">
      <span className="text-gray-400">{icon}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  );
}
