import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { Radio, LayoutDashboard, Users, DollarSign, ClipboardList, Key, LogOut, TestTube, Book, PhoneCall } from 'lucide-react';
import { useAdminAuthStore } from '../../store/adminAuthStore';

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout } = useAdminAuthStore();

  const handleLogout = () => {
    logout();
    navigate('/admin/login');
  };

  const isActive = (path: string) => location.pathname === path;

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
            <div className="space-y-1">
              <Link to="/admin/dashboard" className={navLinkClass('/admin/dashboard')}>
                <LayoutDashboard className="h-4 w-4" />
                Dashboard
              </Link>
              <Link to="/admin/tenants" className={navLinkClass('/admin/tenants')}>
                <Users className="h-4 w-4" />
                Tenants
              </Link>
              <Link to="/admin/pricing" className={navLinkClass('/admin/pricing')}>
                <DollarSign className="h-4 w-4" />
                Pricing
              </Link>
              <Link to="/admin/orders" className={navLinkClass('/admin/orders')}>
                <ClipboardList className="h-4 w-4" />
                Orders
              </Link>
              <Link to="/admin/api-keys" className={navLinkClass('/admin/api-keys')}>
                <Key className="h-4 w-4" />
                API Keys
              </Link>
              <Link to="/admin/test-integrations" className={navLinkClass('/admin/test-integrations')}>
                <TestTube className="h-4 w-4" />
                Test Integrations
              </Link>
              <Link to="/admin/call-connect" className={navLinkClass('/admin/call-connect')}>
                <PhoneCall className="h-4 w-4" />
                Call Connect
              </Link>
              <Link to="/admin/api-docs" className={navLinkClass('/admin/api-docs')}>
                <Book className="h-4 w-4" />
                API Docs
              </Link>
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
