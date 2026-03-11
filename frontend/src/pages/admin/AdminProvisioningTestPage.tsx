import { useState, useEffect, useCallback } from 'react';
import {
  Phone,
  Search,
  ShoppingCart,
  Trash2,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  ChevronDown,
  DollarSign,
  ClipboardList,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { PhoneNumberOrder } from '../../types';

interface Tenant {
  id: string;
  name: string;
  externalId?: string;
}

interface AvailableNumber {
  phoneNumber: string;
  locality?: string;
  region?: string;
  country: string;
  capabilities: string[];
  twilioCost: number;
  markupAmount: number;
  totalMonthlyPrice: number;
  setupFee: number;
}

interface AllocatedNumber {
  id: string;
  phoneNumber: string;
  friendlyName?: string;
  provider: string;
  status: string;
  a2pStatus?: string;
  monthlyCost?: number;
  provisionedAt?: string;
  messagingServiceSid?: string;
}

type Order = PhoneNumberOrder;

type LoadingKey = string;

export default function AdminProvisioningTestPage() {
  // Tenants
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState(() => localStorage.getItem('prov_tenant_id') || '');
  const [tenantsLoading, setTenantsLoading] = useState(false);

  // Search
  const [areaCode, setAreaCode] = useState(() => localStorage.getItem('prov_area_code') || '');
  const [locality, setLocality] = useState('');
  const [region, setRegion] = useState('');
  const [searchResults, setSearchResults] = useState<AvailableNumber[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  // Allocated numbers for tenant
  const [allocatedNumbers, setAllocatedNumbers] = useState<AllocatedNumber[]>([]);
  const [allocatedLoading, setAllocatedLoading] = useState(false);

  // Orders
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);

  // Per-row loading states (purchase, release, retry)
  const [loadingKeys, setLoadingKeys] = useState<Set<LoadingKey>>(new Set());
  const [messages, setMessages] = useState<Record<string, { type: 'success' | 'error'; text: string }>>({});

  const setLoading = (key: LoadingKey, val: boolean) => {
    setLoadingKeys((prev) => {
      const next = new Set(prev);
      val ? next.add(key) : next.delete(key);
      return next;
    });
  };

  const setMsg = (key: string, type: 'success' | 'error', text: string) => {
    setMessages((prev) => ({ ...prev, [key]: { type, text } }));
    setTimeout(() => setMessages((prev) => { const n = { ...prev }; delete n[key]; return n; }), 6000);
  };

  // Load tenants on mount
  useEffect(() => {
    loadTenants();
  }, []);

  // Load allocated numbers + orders when tenant changes
  useEffect(() => {
    if (selectedTenantId) {
      localStorage.setItem('prov_tenant_id', selectedTenantId);
      loadAllocatedNumbers();
      loadOrders();
    }
  }, [selectedTenantId]);

  const loadTenants = async () => {
    setTenantsLoading(true);
    try {
      const data = await adminApi.getTenants();
      setTenants(data);
    } catch {
      // ignore
    } finally {
      setTenantsLoading(false);
    }
  };

  const loadAllocatedNumbers = useCallback(async () => {
    if (!selectedTenantId) return;
    setAllocatedLoading(true);
    try {
      const data = await adminApi.getTenantPhoneNumbers(selectedTenantId);
      setAllocatedNumbers(data || []);
    } catch {
      setAllocatedNumbers([]);
    } finally {
      setAllocatedLoading(false);
    }
  }, [selectedTenantId]);

  const loadOrders = useCallback(async () => {
    if (!selectedTenantId) return;
    setOrdersLoading(true);
    try {
      const all = await adminApi.getWorkspaceOrders();
      setOrders(all);
    } catch {
      setOrders([]);
    } finally {
      setOrdersLoading(false);
    }
  }, [selectedTenantId]);

  const handleSearch = async () => {
    if (!selectedTenantId) {
      setSearchError('Select a tenant first.');
      return;
    }
    setSearchError('');
    setSearchResults([]);
    setSearching(true);
    localStorage.setItem('prov_area_code', areaCode);
    try {
      const opts: any = {};
      if (areaCode.trim()) opts.areaCode = areaCode.trim();
      if (locality.trim()) opts.locality = locality.trim();
      if (region.trim()) opts.region = region.trim();
      const results = await adminApi.searchAvailablePhoneNumbers('US', opts);
      setSearchResults(results || []);
      if (!results?.length) setSearchError('No numbers found for those filters.');
    } catch (err: any) {
      setSearchError(err.response?.data?.message || err.message || 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  const handlePurchase = async (number: AvailableNumber) => {
    const key = `purchase_${number.phoneNumber}`;
    setLoading(key, true);
    try {
      await adminApi.purchasePhoneNumber(selectedTenantId, number.phoneNumber);
      setMsg('purchase', 'success', `${number.phoneNumber} purchased successfully!`);
      // Remove from search results
      setSearchResults((prev) => prev.filter((n) => n.phoneNumber !== number.phoneNumber));
      // Reload allocated numbers and orders
      await loadAllocatedNumbers();
      await loadOrders();
    } catch (err: any) {
      setMsg('purchase', 'error', err.response?.data?.message || err.message || 'Purchase failed');
    } finally {
      setLoading(key, false);
    }
  };

  const handleRelease = async (allocation: AllocatedNumber) => {
    if (!confirm(`Release ${allocation.phoneNumber}? This will remove it from Twilio.`)) return;
    const key = `release_${allocation.id}`;
    setLoading(key, true);
    try {
      await adminApi.releasePhoneNumber(selectedTenantId, allocation.id);
      setMsg('release', 'success', `${allocation.phoneNumber} released.`);
      await loadAllocatedNumbers();
      await loadOrders();
    } catch (err: any) {
      setMsg('release', 'error', err.response?.data?.message || err.message || 'Release failed');
    } finally {
      setLoading(key, false);
    }
  };

  const handleRetryA2P = async (allocation: AllocatedNumber) => {
    const key = `a2p_${allocation.id}`;
    setLoading(key, true);
    try {
      const result = await adminApi.retryA2PAttachment(selectedTenantId, allocation.id);
      setMsg(`a2p_${allocation.id}`, result.success ? 'success' : 'error',
        result.success ? 'A2P attachment successful.' : `A2P failed: ${result.error || 'unknown'}`);
      await loadAllocatedNumbers();
    } catch (err: any) {
      setMsg(`a2p_${allocation.id}`, 'error', err.response?.data?.message || err.message || 'Retry failed');
    } finally {
      setLoading(key, false);
    }
  };

  const selectedTenant = tenants.find((t) => t.id === selectedTenantId);

  const a2pBadge = (status?: string) => {
    if (status === 'ready') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700"><CheckCircle className="h-3 w-3" />A2P Ready</span>;
    if (status === 'failed') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700"><XCircle className="h-3 w-3" />A2P Failed</span>;
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600"><AlertCircle className="h-3 w-3" />No A2P</span>;
  };

  const orderStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      ACTIVE: 'bg-green-100 text-green-700',
      RELEASED: 'bg-gray-100 text-gray-600',
      FAILED: 'bg-red-100 text-red-700',
      PENDING: 'bg-yellow-100 text-yellow-700',
      PROVISIONING: 'bg-blue-100 text-blue-700',
      RELEASING: 'bg-orange-100 text-orange-700',
    };
    return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-600'}`}>{status}</span>;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Provisioning Tester</h1>
        <p className="text-sm text-gray-500 mt-1">Search, purchase, and manage Twilio phone numbers for tenants.</p>
      </div>

      {/* Global flash messages */}
      {messages['purchase'] && (
        <div className={`rounded-lg px-4 py-3 text-sm flex items-center gap-2 ${messages['purchase'].type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
          {messages['purchase'].type === 'success' ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {messages['purchase'].text}
        </div>
      )}
      {messages['release'] && (
        <div className={`rounded-lg px-4 py-3 text-sm flex items-center gap-2 ${messages['release'].type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
          {messages['release'].type === 'success' ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {messages['release'].text}
        </div>
      )}

      {/* ── Step 1: Select Tenant ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-primary-600 text-white text-xs flex items-center justify-center font-bold">1</span>
          Select Tenant
        </h2>
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <select
              value={selectedTenantId}
              onChange={(e) => setSelectedTenantId(e.target.value)}
              className="w-full appearance-none border border-gray-300 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">— Select a tenant —</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.externalId ? ` (${t.externalId})` : ''}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          </div>
          <button onClick={loadTenants} className="p-2 text-gray-400 hover:text-gray-600" title="Refresh tenants">
            {tenantsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          {selectedTenant && (
            <span className="text-sm text-gray-500">ID: <code className="bg-gray-100 px-1 rounded text-xs">{selectedTenant.id}</code></span>
          )}
        </div>
      </div>

      {/* ── Step 2: Search Available Numbers ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-primary-600 text-white text-xs flex items-center justify-center font-bold">2</span>
          Search Available Numbers
        </h2>
        <div className="flex flex-wrap gap-3 mb-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Area Code</label>
            <input
              type="text"
              placeholder="e.g. 415"
              value={areaCode}
              onChange={(e) => setAreaCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">City</label>
            <input
              type="text"
              placeholder="e.g. San Francisco"
              value={locality}
              onChange={(e) => setLocality(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-44 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">State</label>
            <input
              type="text"
              placeholder="e.g. CA"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={handleSearch}
              disabled={searching || !selectedTenantId}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Search
            </button>
          </div>
        </div>

        {searchError && (
          <p className="text-sm text-red-600 mb-3">{searchError}</p>
        )}

        {searchResults.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                  <th className="pb-2 font-medium">Phone Number</th>
                  <th className="pb-2 font-medium">Location</th>
                  <th className="pb-2 font-medium">Capabilities</th>
                  <th className="pb-2 font-medium">Monthly Price</th>
                  <th className="pb-2 font-medium">Setup Fee</th>
                  <th className="pb-2 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {searchResults.map((num) => {
                  const purchaseKey = `purchase_${num.phoneNumber}`;
                  const isLoading = loadingKeys.has(purchaseKey);
                  return (
                    <tr key={num.phoneNumber} className="hover:bg-gray-50">
                      <td className="py-2.5 font-mono font-medium text-gray-900">{num.phoneNumber}</td>
                      <td className="py-2.5 text-gray-600">{[num.locality, num.region].filter(Boolean).join(', ') || '—'}</td>
                      <td className="py-2.5">
                        <div className="flex gap-1">
                          {num.capabilities.map((c) => (
                            <span key={c} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs">{c}</span>
                          ))}
                        </div>
                      </td>
                      <td className="py-2.5 text-gray-900 font-medium">
                        ${num.totalMonthlyPrice.toFixed(2)}
                        <span className="text-xs text-gray-400 ml-1">(Twilio ${num.twilioCost.toFixed(2)} + ${num.markupAmount.toFixed(2)})</span>
                      </td>
                      <td className="py-2.5 text-gray-600">${num.setupFee.toFixed(2)}</td>
                      <td className="py-2.5">
                        <button
                          onClick={() => handlePurchase(num)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-50"
                        >
                          {isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShoppingCart className="h-3 w-3" />}
                          Purchase
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-xs text-gray-400 mt-2">{searchResults.length} numbers found. Showing all.</p>
          </div>
        )}
      </div>

      {/* ── Step 3: Tenant's Allocated Numbers ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-primary-600 text-white text-xs flex items-center justify-center font-bold">3</span>
            <Phone className="h-4 w-4 text-gray-400" />
            Allocated Numbers
            {selectedTenant && <span className="font-normal text-gray-500">— {selectedTenant.name}</span>}
          </h2>
          <button
            onClick={loadAllocatedNumbers}
            disabled={!selectedTenantId || allocatedLoading}
            className="p-1.5 text-gray-400 hover:text-gray-600 disabled:opacity-50"
            title="Refresh"
          >
            {allocatedLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>

        {!selectedTenantId ? (
          <p className="text-sm text-gray-400">Select a tenant to view their numbers.</p>
        ) : allocatedLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Loading...</div>
        ) : allocatedNumbers.length === 0 ? (
          <p className="text-sm text-gray-400">No phone numbers allocated to this tenant yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                  <th className="pb-2 font-medium">Phone Number</th>
                  <th className="pb-2 font-medium">Provider</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">A2P</th>
                  <th className="pb-2 font-medium">Monthly Cost</th>
                  <th className="pb-2 font-medium">Provisioned</th>
                  <th className="pb-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {allocatedNumbers.map((num) => {
                  const releaseKey = `release_${num.id}`;
                  const a2pKey = `a2p_${num.id}`;
                  return (
                    <tr key={num.id} className="hover:bg-gray-50">
                      <td className="py-2.5 font-mono font-medium text-gray-900">{num.phoneNumber}</td>
                      <td className="py-2.5 text-gray-600 capitalize">{num.provider?.toLowerCase() || '—'}</td>
                      <td className="py-2.5">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${num.status === 'ACTIVE' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                          {num.status}
                        </span>
                      </td>
                      <td className="py-2.5">{a2pBadge(num.a2pStatus)}</td>
                      <td className="py-2.5 text-gray-600">{num.monthlyCost != null ? `$${Number(num.monthlyCost).toFixed(2)}/mo` : '—'}</td>
                      <td className="py-2.5 text-gray-400 text-xs">{num.provisionedAt ? new Date(num.provisionedAt).toLocaleDateString() : '—'}</td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-2">
                          {num.a2pStatus !== 'ready' && (
                            <button
                              onClick={() => handleRetryA2P(num)}
                              disabled={loadingKeys.has(a2pKey)}
                              title="Retry A2P attachment"
                              className="flex items-center gap-1 px-2 py-1 border border-blue-300 text-blue-600 rounded text-xs hover:bg-blue-50 disabled:opacity-50"
                            >
                              {loadingKeys.has(a2pKey) ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                              Retry A2P
                            </button>
                          )}
                          <button
                            onClick={() => handleRelease(num)}
                            disabled={loadingKeys.has(releaseKey)}
                            title="Release number from Twilio"
                            className="flex items-center gap-1 px-2 py-1 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50 disabled:opacity-50"
                          >
                            {loadingKeys.has(releaseKey) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                            Release
                          </button>
                        </div>
                        {messages[a2pKey] && (
                          <p className={`text-xs mt-1 ${messages[a2pKey].type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                            {messages[a2pKey].text}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Step 4: Order History ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-primary-600 text-white text-xs flex items-center justify-center font-bold">4</span>
            <ClipboardList className="h-4 w-4 text-gray-400" />
            Order History (Workspace)
          </h2>
          <button
            onClick={loadOrders}
            disabled={ordersLoading}
            className="p-1.5 text-gray-400 hover:text-gray-600 disabled:opacity-50"
            title="Refresh"
          >
            {ordersLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>

        {ordersLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Loading...</div>
        ) : orders.length === 0 ? (
          <p className="text-sm text-gray-400">No orders yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                  <th className="pb-2 font-medium">Phone Number</th>
                  <th className="pb-2 font-medium">Type</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Price</th>
                  <th className="pb-2 font-medium">Created</th>
                  <th className="pb-2 font-medium">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {orders.map((order) => (
                  <tr key={order.id} className="hover:bg-gray-50">
                    <td className="py-2.5 font-mono text-gray-900">{order.phoneNumber}</td>
                    <td className="py-2.5">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${order.orderType === 'purchase' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>
                        {order.orderType}
                      </span>
                    </td>
                    <td className="py-2.5">{orderStatusBadge(order.status)}</td>
                    <td className="py-2.5 text-gray-600">
                      {order.totalPrice != null ? (
                        <span className="flex items-center gap-1"><DollarSign className="h-3 w-3" />{Number(order.totalPrice).toFixed(2)}/mo</span>
                      ) : '—'}
                    </td>
                    <td className="py-2.5 text-gray-400 text-xs">{new Date(order.createdAt).toLocaleString()}</td>
                    <td className="py-2.5 text-gray-400 text-xs">{order.completedAt ? new Date(order.completedAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── How it works ── */}
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">How it works</h3>
        <ol className="text-sm text-gray-600 space-y-1 list-decimal list-inside">
          <li>Select a tenant to provision numbers for.</li>
          <li>Search Twilio for available US numbers by area code, city, or state.</li>
          <li>Click <strong>Purchase</strong> — Sigcore buys the number from Twilio, configures webhooks, and attaches it to the A2P Messaging Service.</li>
          <li>If A2P attachment failed, click <strong>Retry A2P</strong> to re-attempt.</li>
          <li>Click <strong>Release</strong> to release the number back to Twilio (irreversible).</li>
        </ol>
        <p className="text-xs text-gray-400 mt-3">Requires: active Twilio integration connected in Test Integrations page.</p>
      </div>
    </div>
  );
}
