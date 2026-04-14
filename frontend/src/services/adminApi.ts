import axios, { AxiosInstance } from 'axios';
import type {
  Tenant,
  TenantPhoneNumber,
  AvailablePhoneNumber,
  CreateTenantDto,
  AllocatePhoneNumberDto,
  PricingConfig,
  UpdatePricingConfigDto,
  PhoneNumberOrder,
  TenantApiKeyResponse,
  TenantApiKeyInfo,
  WorkspaceApiKey,
  WorkspaceApiKeyCreateResponse,
  ApiResponse,
} from '../types';

const API_URL = import.meta.env.VITE_API_URL || '/api';

class AdminApiService {
  private client: AxiosInstance;
  private apiKey: string | null = null;
  private workspaceId: string | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: API_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Load key from storage
    this.apiKey = localStorage.getItem('adminApiKey');
    if (this.apiKey) {
      this.client.defaults.headers.common['X-API-Key'] = this.apiKey;
    }

    // Response interceptor for 401
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          this.clearAuth();
          window.location.href = '/admin/login';
        }
        return Promise.reject(error);
      },
    );
  }

  setApiKey(key: string) {
    this.apiKey = key;
    localStorage.setItem('adminApiKey', key);
    this.client.defaults.headers.common['X-API-Key'] = key;
  }

  clearAuth() {
    this.apiKey = null;
    localStorage.removeItem('adminApiKey');
    delete this.client.defaults.headers.common['X-API-Key'];
  }

  isAuthenticated(): boolean {
    return !!this.apiKey;
  }

  // Validate key by fetching tenants
  async validate(): Promise<boolean> {
    try {
      await this.client.get<ApiResponse<Tenant[]>>('/tenants');
      return true;
    } catch {
      return false;
    }
  }

  // ==================== Tenants ====================

  async getTenants(): Promise<Tenant[]> {
    const response = await this.client.get<ApiResponse<Tenant[]>>('/tenants');
    return response.data.data;
  }

  async createTenant(data: CreateTenantDto): Promise<Tenant> {
    const response = await this.client.post<ApiResponse<Tenant>>('/tenants', data);
    return response.data.data;
  }

  async deleteTenant(tenantId: string): Promise<void> {
    await this.client.delete(`/tenants/${tenantId}`);
  }

  // ==================== Phone Numbers ====================

  async getAvailablePhoneNumbers(): Promise<AvailablePhoneNumber[]> {
    const response = await this.client.get<ApiResponse<AvailablePhoneNumber[]>>('/tenants/phone-numbers/available');
    return response.data.data;
  }

  async allocatePhoneNumber(tenantId: string, data: AllocatePhoneNumberDto): Promise<TenantPhoneNumber> {
    const response = await this.client.post<ApiResponse<TenantPhoneNumber>>(`/tenants/${tenantId}/phone-numbers`, data);
    return response.data.data;
  }

  async deallocatePhoneNumber(tenantId: string, allocationId: string): Promise<void> {
    await this.client.delete(`/tenants/${tenantId}/phone-numbers/${allocationId}`);
  }

  async setDefaultPhoneNumber(tenantId: string, allocationId: string): Promise<TenantPhoneNumber> {
    const response = await this.client.post<ApiResponse<TenantPhoneNumber>>(`/tenants/${tenantId}/phone-numbers/${allocationId}/default`);
    return response.data.data;
  }

  async retryA2PAttachment(tenantId: string, allocationId: string): Promise<{ success: boolean; a2pStatus: string; error?: string }> {
    const response = await this.client.post<ApiResponse<{ success: boolean; a2pStatus: string; error?: string }>>(`/tenants/${tenantId}/phone-numbers/${allocationId}/retry-a2p`);
    return response.data.data;
  }

  // ==================== Pricing & Orders ====================

  async getPricingConfig(): Promise<PricingConfig> {
    const response = await this.client.get<ApiResponse<PricingConfig>>('/tenants/pricing');
    return response.data.data;
  }

  async updatePricingConfig(data: UpdatePricingConfigDto): Promise<PricingConfig> {
    const response = await this.client.put<ApiResponse<PricingConfig>>('/tenants/pricing', data);
    return response.data.data;
  }

  async getWorkspaceOrders(): Promise<PhoneNumberOrder[]> {
    const response = await this.client.get<ApiResponse<PhoneNumberOrder[]>>('/tenants/phone-numbers/orders');
    return response.data.data;
  }

  // ==================== Tenant API Keys ====================

  async createTenantApiKey(tenantId: string, name: string): Promise<TenantApiKeyResponse> {
    const response = await this.client.post<ApiResponse<TenantApiKeyResponse>>(`/tenants/${tenantId}/api-keys`, { name });
    return response.data.data;
  }

  async getTenantApiKeys(tenantId: string): Promise<TenantApiKeyInfo[]> {
    const response = await this.client.get<ApiResponse<TenantApiKeyInfo[]>>(`/tenants/${tenantId}/api-keys?_=${Date.now()}`);
    return response.data.data;
  }

  async deleteTenantApiKey(tenantId: string, keyId: string): Promise<void> {
    await this.client.delete(`/tenants/${tenantId}/api-keys/${keyId}`);
  }

  // ==================== Workspace API Keys ====================

  async getApiKeys(): Promise<WorkspaceApiKey[]> {
    const response = await this.client.get<{ data: WorkspaceApiKey[] }>('/api-keys');
    return response.data.data;
  }

  async createApiKey(name: string): Promise<WorkspaceApiKeyCreateResponse> {
    const response = await this.client.post<{ data: WorkspaceApiKeyCreateResponse }>('/api-keys', { name });
    return response.data.data;
  }

  async deleteApiKey(keyId: string): Promise<void> {
    await this.client.delete(`/api-keys/${keyId}`);
  }

  async toggleApiKey(keyId: string): Promise<WorkspaceApiKey> {
    const response = await this.client.patch<{ data: WorkspaceApiKey }>(`/api-keys/${keyId}/toggle`);
    return response.data.data;
  }

  // ==================== Integration Testing ====================

  async getIntegrations(): Promise<any> {
    const response = await this.client.get<{ data: any; workspaceId?: string }>('/integrations/all');
    if (response.data.workspaceId) {
      this.workspaceId = response.data.workspaceId;
    }
    return response.data.data;
  }

  getWorkspaceId(): string | null {
    return this.workspaceId;
  }

  async connectOpenPhone(apiKey: string): Promise<any> {
    const response = await this.client.post<ApiResponse<any>>('/integrations/openphone/connect', { apiKey });
    return response.data.data;
  }

  async setupTwilio(data: {
    accountSid: string;
    authToken: string;
    phoneNumber?: string;
    phoneNumberSid?: string;
    friendlyName?: string;
  }): Promise<any> {
    const response = await this.client.post<ApiResponse<any>>('/integrations/twilio', data);
    return response.data.data;
  }

  async disconnectOpenPhone(): Promise<{ success: boolean }> {
    const response = await this.client.delete<ApiResponse<{ success: boolean }>>('/integrations/openphone/disconnect');
    return response.data.data;
  }

  async disconnectTwilio(): Promise<{ success: boolean }> {
    const response = await this.client.delete<ApiResponse<{ success: boolean }>>('/integrations/twilio');
    return response.data.data;
  }

  async getOpenPhoneNumbers(): Promise<any[]> {
    const response = await this.client.get<ApiResponse<any[]>>('/integrations/openphone/numbers');
    return response.data.data;
  }

  async getTwilioPhoneNumbers(): Promise<any[]> {
    const response = await this.client.get<ApiResponse<any[]>>('/integrations/twilio/phone-numbers');
    return response.data.data;
  }

  // WhatsApp integration
  async getWhatsAppStatus(): Promise<any> {
    const response = await this.client.get<ApiResponse<any>>('/integrations/whatsapp/status');
    return response.data.data;
  }

  async connectWhatsApp(): Promise<any> {
    const response = await this.client.post<ApiResponse<any>>('/integrations/whatsapp/connect');
    return response.data.data;
  }

  async getWhatsAppQR(): Promise<any> {
    const response = await this.client.get<ApiResponse<any>>('/integrations/whatsapp/qr');
    return response.data.data;
  }

  async disconnectWhatsApp(): Promise<any> {
    const response = await this.client.delete<ApiResponse<any>>('/integrations/whatsapp/disconnect');
    return response.data.data;
  }

  async getWhatsAppHealth(): Promise<any> {
    const response = await this.client.get<ApiResponse<any>>('/integrations/whatsapp/health');
    return response.data.data;
  }

  async sendWhatsAppMessage(to: string, message: string): Promise<any> {
    const response = await this.client.post<ApiResponse<any>>('/integrations/whatsapp/send', { to, message });
    return response.data.data;
  }

  async startSync(options?: { provider?: string; limit?: number }): Promise<any> {
    const response = await this.client.post<ApiResponse<any>>('/integrations/sync', options);
    return response.data.data;
  }

  async getSyncStatus(): Promise<any> {
    const response = await this.client.get<ApiResponse<any>>('/integrations/sync/status');
    return response.data.data;
  }

  async getTenantPhoneNumbers(tenantId: string): Promise<any[]> {
    const response = await this.client.get<ApiResponse<any[]>>(`/tenants/${tenantId}/phone-numbers`);
    return response.data.data;
  }

  async purchasePhoneNumber(tenantId: string, phoneNumber: string, friendlyName?: string): Promise<any> {
    const response = await this.client.post<ApiResponse<any>>(`/tenants/${tenantId}/phone-numbers/purchase`, { phoneNumber, friendlyName });
    return response.data.data;
  }

  async releasePhoneNumber(tenantId: string, allocationId: string): Promise<any> {
    const response = await this.client.post<ApiResponse<any>>(`/tenants/${tenantId}/phone-numbers/${allocationId}/release`);
    return response.data.data;
  }

  async searchAvailablePhoneNumbers(country: string = 'US', options?: { areaCode?: string; locality?: string; region?: string }): Promise<any[]> {
    const queryParams = new URLSearchParams({ country });
    if (options?.areaCode) queryParams.append('areaCode', options.areaCode);
    if (options?.locality) queryParams.append('locality', options.locality);
    if (options?.region) queryParams.append('region', options.region);
    queryParams.append('smsCapable', 'true');
    queryParams.append('voiceCapable', 'true');

    const response = await this.client.get<ApiResponse<any[]>>(`/tenants/phone-numbers/search?${queryParams.toString()}`);
    return response.data.data;
  }

  async getOpenPhoneConversations(days: number = 1): Promise<any[]> {
    const response = await this.client.get<ApiResponse<any[]>>(`/integrations/openphone/conversations?days=${days}`);
    return response.data.data;
  }

  // ==================== Sync Monitor ====================

  async getSyncOverview(): Promise<{ tenants: any[]; syncStatus: any }> {
    const response = await this.client.get<ApiResponse<{ tenants: any[]; syncStatus: any }>>('/tenants/sync/overview');
    return response.data.data;
  }

  async getTenantSyncStatus(): Promise<any> {
    const response = await this.client.get<ApiResponse<any>>('/tenants/sync/status');
    return response.data.data;
  }

  async triggerTenantSync(options?: { syncMessages?: boolean; provider?: string; limit?: number }): Promise<any> {
    const response = await this.client.post<ApiResponse<any>>('/tenants/sync/trigger', options);
    return response.data.data;
  }

  async cancelTenantSync(): Promise<any> {
    const response = await this.client.post<ApiResponse<any>>('/tenants/sync/cancel');
    return response.data.data;
  }

  // ==================== Orphan Cleanup ====================

  async getOrphanedTenants(): Promise<any[]> {
    const response = await this.client.get<ApiResponse<any[]>>('/tenants/orphans');
    return response.data.data;
  }

  async deleteOrphanedTenants(tenantIds?: string[]): Promise<{ deleted: number; skipped: number }> {
    const response = await this.client.delete<ApiResponse<{ deleted: number; skipped: number }>>('/tenants/orphans', {
      data: tenantIds ? { tenantIds } : undefined,
    });
    return response.data.data;
  }

  // ==================== Conversations (from DB) ====================

  /**
   * Fetch message media as a blob via the authenticated client (X-API-Key header).
   * Browser <img src> can't carry the auth header, so callers convert the blob
   * to an object URL and use it in the src attribute.
   */
  async fetchMessageMediaBlob(messageId: string): Promise<Blob> {
    const response = await this.client.get(`/conversations/messages/${messageId}/media`, { responseType: 'blob' });
    return response.data as Blob;
  }

  async getConversationMessages(conversationId: string, options?: { limit?: number; before?: string }): Promise<{ data: any[]; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (options?.limit) params.append('limit', String(options.limit));
    if (options?.before) params.append('before', options.before);
    const qs = params.toString();
    const response = await this.client.get<{ data: any[]; meta: { hasMore: boolean } }>(`/conversations/${conversationId}/messages${qs ? `?${qs}` : ''}`);
    return { data: response.data.data, hasMore: response.data.meta?.hasMore ?? false };
  }

  async getConversations(options?: { page?: number; limit?: number; provider?: string }): Promise<{ conversations: any[]; meta: any }> {
    const params = new URLSearchParams();
    if (options?.page) params.append('page', String(options.page));
    if (options?.limit) params.append('limit', String(options.limit));
    if (options?.provider) params.append('provider', options.provider);
    const response = await this.client.get<{ data: any[]; meta: any }>(`/conversations?${params.toString()}`);
    return { conversations: response.data.data, meta: response.data.meta };
  }
}

export const adminApi = new AdminApiService();
