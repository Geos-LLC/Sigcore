import { useEffect, useState } from 'react';
import {
  Archive,
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  HelpCircle,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type {
  InventoryRow,
  LegacyAssignmentGroup,
  LegacySmsRow,
} from '../../types';

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function AdminLegacyPage() {
  const [assignments, setAssignments] = useState<LegacyAssignmentGroup[]>([]);
  const [duplications, setDuplications] = useState<InventoryRow[]>([]);
  const [smsMessages, setSmsMessages] = useState<LegacySmsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, d, s] = await Promise.all([
        adminApi.getLegacyAssignments(),
        adminApi.getLegacyDuplications(),
        adminApi.getLegacySmsMessages(100),
      ]);
      setAssignments(a);
      setDuplications(d);
      setSmsMessages(s);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to load legacy data');
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
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Archive className="h-6 w-6 text-amber-600" />
            Legacy
          </h1>
          <p className="text-sm text-gray-500">
            Diagnostic / migration view. Read-only. Tracks{' '}
            <code className="font-mono">phone_number_assignments</code>,{' '}
            <code className="font-mono">sms_messages</code>, and number duplication across
            current/legacy tables.
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

      <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900 flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <div>
          These tables back the legacy SMS path (
          <code className="font-mono">POST /api/internal/messages/send</code>). New work should
          target <code className="font-mono">tenant_phone_numbers</code> and{' '}
          <code className="font-mono">/api/v1/messages</code>. Nothing here is editable from the
          UI yet.
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <Section
        title="phone_number_assignments"
        subtitle="Grouped by business_id with workspace / tenant / unknown resolution."
        count={assignments.reduce((acc, g) => acc + g.rows.length, 0)}
      >
        {loading && assignments.length === 0 ? (
          <Empty msg="Loading…" />
        ) : assignments.length === 0 ? (
          <Empty msg="No legacy phone_number_assignments rows for this workspace." />
        ) : (
          <div className="divide-y divide-gray-200">
            {assignments.map((g) => (
              <AssignmentGroup key={g.businessId} group={g} />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Duplicated numbers"
        subtitle="Numbers that exist in BOTH tenant_phone_numbers AND phone_number_assignments."
        count={duplications.length}
      >
        {loading && duplications.length === 0 ? (
          <Empty msg="Loading…" />
        ) : duplications.length === 0 ? (
          <Empty msg="No numbers are present in both tables." />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Number</th>
                <th className="text-left px-4 py-2">Provider</th>
                <th className="text-left px-4 py-2">Current tenant</th>
                <th className="text-left px-4 py-2">Legacy business_id</th>
                <th className="text-left px-4 py-2">Legacy resolution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {duplications.map((r) => (
                <tr key={`${r.number}-${r.current?.id ?? ''}-${r.legacy?.id ?? ''}`}>
                  <td className="px-4 py-2 font-mono">{r.number}</td>
                  <td className="px-4 py-2 text-gray-700">{r.provider ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-700">
                    {r.current?.tenantName ?? r.current?.tenantId ?? '—'}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500 break-all">
                    {r.legacy?.businessId ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-gray-700">
                    {r.legacy ? <ResolutionBadge value={r.legacy.businessIdResolution} /> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section
        title="sms_messages (recent 100)"
        subtitle="Direct rows from the legacy sms_messages table."
        count={smsMessages.length}
      >
        {loading && smsMessages.length === 0 ? (
          <Empty msg="Loading…" />
        ) : smsMessages.length === 0 ? (
          <Empty msg="No legacy sms_messages rows for this workspace." />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Time</th>
                <th className="text-left px-4 py-2">Direction</th>
                <th className="text-left px-4 py-2">From</th>
                <th className="text-left px-4 py-2">To</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2">Owner</th>
                <th className="text-left px-4 py-2">Body</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {smsMessages.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">
                    {fmt(m.createdAt)}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`px-2 py-0.5 text-xs rounded-full ${
                        m.direction === 'INBOUND'
                          ? 'bg-blue-50 text-blue-700'
                          : 'bg-purple-50 text-purple-700'
                      }`}
                    >
                      {m.direction}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{m.fromNumber}</td>
                  <td className="px-4 py-2 font-mono text-xs">{m.toNumber}</td>
                  <td className="px-4 py-2 text-gray-700">{m.status}</td>
                  <td className="px-4 py-2">
                    <ResolutionBadge value={m.resolution} />
                  </td>
                  <td className="px-4 py-2 text-gray-600 max-w-md truncate" title={m.body}>
                    {m.body}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle?: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="card">
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50"
        onClick={() => setOpen((o) => !o)}
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900">{title}</span>
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full tabular-nums">
              {count}
            </span>
          </div>
          {subtitle && <div className="text-xs text-gray-500 mt-0.5 text-left">{subtitle}</div>}
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        )}
      </button>
      {open && (
        <div className="border-t border-gray-200 overflow-x-auto">{children}</div>
      )}
    </div>
  );
}

function AssignmentGroup({ group }: { group: LegacyAssignmentGroup }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <ResolutionBadge value={group.resolution} />
        <span className="text-sm font-medium text-gray-900">
          {group.resolvedName ?? '(unnamed)'}
        </span>
        <span className="font-mono text-xs text-gray-400 break-all">{group.businessId}</span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs uppercase text-gray-500">
          <tr>
            <th className="text-left px-3 py-2">Number</th>
            <th className="text-left px-3 py-2">Type</th>
            <th className="text-left px-3 py-2">Active</th>
            <th className="text-left px-3 py-2">Region</th>
            <th className="text-left px-3 py-2">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {group.rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-mono">{r.numberE164}</td>
              <td className="px-3 py-2">
                <span
                  className={`px-2 py-0.5 text-xs rounded-full ${
                    r.type === 'BOT'
                      ? 'bg-purple-50 text-purple-700'
                      : 'bg-indigo-50 text-indigo-700'
                  }`}
                >
                  {r.type}
                </span>
              </td>
              <td className="px-3 py-2 text-gray-700">{r.active ? 'yes' : 'no'}</td>
              <td className="px-3 py-2 text-gray-500">{r.region ?? '—'}</td>
              <td className="px-3 py-2 text-gray-500">{new Date(r.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResolutionBadge({
  value,
}: {
  value: 'workspace' | 'tenant' | 'unknown';
}) {
  if (value === 'workspace') {
    return (
      <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-blue-50 text-blue-700 border border-blue-200">
        workspace
      </span>
    );
  }
  if (value === 'tenant') {
    return (
      <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-green-50 text-green-700 border border-green-200">
        tenant
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-amber-50 text-amber-700 border border-amber-200">
      <HelpCircle className="h-3 w-3" />
      unknown
    </span>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-4 py-6 text-center text-sm text-gray-400">{msg}</div>;
}
