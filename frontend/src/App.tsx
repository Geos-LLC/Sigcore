import { Routes, Route, Navigate } from 'react-router-dom';

// Admin
import AdminLoginPage from './pages/admin/AdminLoginPage';
import AdminLayout from './components/ui/AdminLayout';
import AdminProtectedRoute from './components/ui/AdminProtectedRoute';
import AdminDashboardPage from './pages/admin/AdminDashboardPage';
import AdminTenantsPage from './pages/admin/AdminTenantsPage';
import AdminPricingPage from './pages/admin/AdminPricingPage';
import AdminOrdersPage from './pages/admin/AdminOrdersPage';
import AdminApiKeysPage from './pages/admin/AdminApiKeysPage';
import AdminIntegrationTestPage from './pages/admin/AdminIntegrationTestPage';
import AdminApiDocsPage from './pages/admin/AdminApiDocsPage';
import AdminCallConnectTestPage from './pages/admin/AdminCallConnectTestPage';

// Portal
import TenantPortalLoginPage from './pages/portal/TenantPortalLoginPage';
import TenantPortalLayout from './components/ui/TenantPortalLayout';
import TenantPortalProtectedRoute from './components/ui/TenantPortalProtectedRoute';
import TenantAccountPage from './pages/portal/TenantAccountPage';
import TenantPhoneNumbersPage from './pages/portal/TenantPhoneNumbersPage';
import TenantOrdersPage from './pages/portal/TenantOrdersPage';
import TenantBillingPage from './pages/portal/TenantBillingPage';

export default function App() {
  return (
    <Routes>
      {/* Admin */}
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route
        path="/admin"
        element={
          <AdminProtectedRoute>
            <AdminLayout />
          </AdminProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/admin/dashboard" replace />} />
        <Route path="dashboard" element={<AdminDashboardPage />} />
        <Route path="tenants" element={<AdminTenantsPage />} />
        <Route path="pricing" element={<AdminPricingPage />} />
        <Route path="orders" element={<AdminOrdersPage />} />
        <Route path="api-keys" element={<AdminApiKeysPage />} />
        <Route path="test-integrations" element={<AdminIntegrationTestPage />} />
        <Route path="call-connect" element={<AdminCallConnectTestPage />} />
        <Route path="api-docs" element={<AdminApiDocsPage />} />
      </Route>

      {/* Portal */}
      <Route path="/portal/login" element={<TenantPortalLoginPage />} />
      <Route
        path="/portal"
        element={
          <TenantPortalProtectedRoute>
            <TenantPortalLayout />
          </TenantPortalProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/portal/account" replace />} />
        <Route path="account" element={<TenantAccountPage />} />
        <Route path="phone-numbers" element={<TenantPhoneNumbersPage />} />
        <Route path="orders" element={<TenantOrdersPage />} />
        <Route path="billing" element={<TenantBillingPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/admin/login" replace />} />
    </Routes>
  );
}
