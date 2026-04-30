import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import {
  Radio,
  LayoutDashboard,
  Users,
  DollarSign,
  ClipboardList,
  Key,
  LogOut,
  TestTube,
  Book,
  PhoneCall,
  MessageSquare,
  PhoneIncoming,
  RefreshCw,
  Layers,
  UserCircle,
  Phone,
  Archive,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useAdminAuthStore } from '../../store/adminAuthStore';

// Routes whose detail pages live under a parent path. For these, a partial
// startsWith match keeps the parent highlighted while a child route is open.
const STARTS_WITH_PATHS = new Set<string>([
  '/admin/platforms',
  '/admin/phone-numbers',
  '/admin/legacy',
]);

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout } = useAdminAuthStore();

  const handleLogout = () => {
    logout();
    navigate('/admin/login');
  };

  const isActive = (path: string) => {
    if (STARTS_WITH_PATHS.has(path)) {
      return location.pathname === path || location.pathname.startsWith(path + '/');
    }
    return location.pathname === path;
  };

  const navLinkClass = (path: string) =>
    `flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      isActive(path)
        ? 'bg-primary-50 text-primary-700'
        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
    }`;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-2">
              <Radio className="h-8 w-8 text-primary-600" />
              <div>
                <span className="text-xl font-bold text-gray-900">Sigcore</span>
                <span className="ml-2 text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full font-medium">
                  Admin
                </span>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="text-gray-400 hover:text-gray-600 flex items-center gap-1 text-sm"
              title="Logout"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex gap-6">
          <nav className="w-56 flex-shrink-0">
            <div className="space-y-4">
              <NavGroup>
                <Link to="/admin/dashboard" className={navLinkClass('/admin/dashboard')}>
                  <LayoutDashboard className="h-4 w-4" />
                  Dashboard
                </Link>
              </NavGroup>

              <NavGroup label="Hierarchy">
                <Link to="/admin/platforms" className={navLinkClass('/admin/platforms')}>
                  <Layers className="h-4 w-4" />
                  Platforms
                </Link>
                <Link to="/admin/tenants" className={navLinkClass('/admin/tenants')}>
                  <Users className="h-4 w-4" />
                  Workspaces
                </Link>
                <DisabledNavItem icon={<UserCircle className="h-4 w-4" />} label="Profiles" />
                <Link to="/admin/phone-numbers" className={navLinkClass('/admin/phone-numbers')}>
                  <Phone className="h-4 w-4" />
                  Phone Numbers
                </Link>
              </NavGroup>

              <NavGroup label="Provisioning">
                <Link to="/admin/provisioning" className={navLinkClass('/admin/provisioning')}>
                  <PhoneIncoming className="h-4 w-4" />
                  Provisioning
                </Link>
                <Link to="/admin/orders" className={navLinkClass('/admin/orders')}>
                  <ClipboardList className="h-4 w-4" />
                  Orders
                </Link>
              </NavGroup>

              <NavGroup label="Integrations">
                <Link to="/admin/api-keys" className={navLinkClass('/admin/api-keys')}>
                  <Key className="h-4 w-4" />
                  API Keys
                </Link>
                <Link to="/admin/sync-monitor" className={navLinkClass('/admin/sync-monitor')}>
                  <RefreshCw className="h-4 w-4" />
                  Sync Monitor
                </Link>
              </NavGroup>

              <NavGroup label="Testing">
                <Link
                  to="/admin/test-integrations"
                  className={navLinkClass('/admin/test-integrations')}
                >
                  <TestTube className="h-4 w-4" />
                  Test Integrations
                </Link>
                <Link to="/admin/call-connect" className={navLinkClass('/admin/call-connect')}>
                  <PhoneCall className="h-4 w-4" />
                  Call Connect
                </Link>
                <Link to="/admin/sms" className={navLinkClass('/admin/sms')}>
                  <MessageSquare className="h-4 w-4" />
                  SMS Tester
                </Link>
                <Link to="/admin/whatsapp" className={navLinkClass('/admin/whatsapp')}>
                  <MessageSquare className="h-4 w-4" />
                  WhatsApp
                </Link>
              </NavGroup>

              <NavGroup label="System">
                <Link to="/admin/pricing" className={navLinkClass('/admin/pricing')}>
                  <DollarSign className="h-4 w-4" />
                  Pricing
                </Link>
                <Link to="/admin/legacy" className={navLinkClass('/admin/legacy')}>
                  <Archive className="h-4 w-4" />
                  Legacy
                </Link>
                <a href="/api-docs" className={navLinkClass('/api-docs')}>
                  <Book className="h-4 w-4" />
                  API Docs
                </a>
              </NavGroup>
            </div>
          </nav>

          <main className="flex-1 min-w-0">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}

function NavGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div>
      {label && (
        <div className="px-4 mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          {label}
        </div>
      )}
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function DisabledNavItem({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div
      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-gray-400 cursor-not-allowed select-none"
      title="Coming soon"
    >
      {icon}
      <span>{label}</span>
      <span className="ml-auto text-[10px] uppercase tracking-wider text-gray-300">soon</span>
    </div>
  );
}
