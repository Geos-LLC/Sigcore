// ==================== Admin Types ====================

export interface Tenant {
  id: string;
  workspaceId: string;
  externalId: string;
  name: string;
  status: 'active' | 'inactive' | 'suspended';
  webhookSecret?: string;
  metadata?: Record<string, unknown>;
  phoneNumbers?: TenantPhoneNumber[];
  createdAt: string;
  updatedAt: string;
}

export interface TenantPhoneNumber {
  id: string;
  workspaceId: string;
  tenantId: string;
  phoneNumber: string;
  friendlyName?: string;
  provider: 'twilio' | 'openphone' | 'whatsapp';
  providerId?: string;
  channel: 'sms' | 'whatsapp' | 'voice';
  status: 'active' | 'inactive' | 'pending';
  isDefault: boolean;
  metadata?: Record<string, unknown>;
  a2pStatus?: string;
  messagingServiceSid?: string;
  a2pAttachedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AvailablePhoneNumber {
  phoneNumber: string;
  friendlyName: string | null;
  provider: 'twilio' | 'openphone' | 'whatsapp';
  providerId: string;
  capabilities?: string[];
  allocated: boolean;
  allocatedTo?: {
    tenantId: string;
    tenantName: string;
  };
}

export interface CreateTenantDto {
  externalId?: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface AllocatePhoneNumberDto {
  phoneNumber: string;
  provider: 'twilio' | 'openphone' | 'whatsapp';
  providerId?: string;
  friendlyName?: string;
  channel?: 'sms' | 'whatsapp' | 'voice';
  isDefault?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PricingConfig {
  pricingType: 'fixed_markup' | 'percentage_markup' | 'fixed_price';
  monthlyBasePrice?: number;
  monthlyMarkupAmount: number;
  monthlyMarkupPercentage: number;
  setupFee: number;
  allowTenantPurchase: boolean;
  allowTenantRelease: boolean;
  messagingServiceSid?: string;
}

export interface UpdatePricingConfigDto {
  pricingType?: string;
  monthlyBasePrice?: number;
  monthlyMarkupAmount?: number;
  monthlyMarkupPercentage?: number;
  setupFee?: number;
  allowTenantPurchase?: boolean;
  allowTenantRelease?: boolean;
  messagingServiceSid?: string;
}

export interface PhoneNumberOrder {
  id: string;
  workspaceId: string;
  tenantId?: string;
  phoneNumber?: string;
  phoneNumberSid?: string;
  orderType: 'purchase' | 'release';
  status: 'pending' | 'provisioning' | 'active' | 'releasing' | 'released' | 'failed' | 'cancelled';
  twilioCost?: number;
  markupAmount?: number;
  totalPrice?: number;
  orderedBy?: string;
  tenantPhoneNumberId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  tenant?: Tenant;
}

export interface TenantApiKeyResponse {
  id: string;
  name: string;
  key: string;
  scope: string;
  createdAt: string;
}

export interface TenantApiKeyInfo {
  id: string;
  name: string;
  key?: string;
  keyPreview: string;
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface WorkspaceApiKey {
  id: string;
  name: string;
  keyPreview: string;
  scope: string;
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface WorkspaceApiKeyCreateResponse {
  apiKey: WorkspaceApiKey;
  fullKey: string;
}

// ==================== Portal Types ====================

export interface PortalTenantProfile {
  id: string;
  name: string;
  externalId: string;
  status: 'active' | 'inactive' | 'suspended';
  createdAt: string;
  updatedAt?: string;
  phoneNumberCount: number;
}

export interface PortalApiKeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PortalAuthResponse {
  tenant: PortalTenantProfile;
  apiKey: PortalApiKeyInfo;
}

export interface PortalPhoneNumber {
  id: string;
  phoneNumber: string;
  friendlyName?: string;
  provider: 'twilio' | 'openphone' | 'whatsapp';
  channel: 'sms' | 'whatsapp' | 'voice';
  status: 'active' | 'inactive' | 'pending';
  isDefault: boolean;
  provisionedViaCallio: boolean;
  monthlyCost?: number;
  provisionedAt?: string;
  a2pStatus?: string;
  messagingServiceSid?: string;
  a2pAttachedAt?: string;
  createdAt: string;
}

export interface PortalOrder {
  id: string;
  workspaceId: string;
  tenantId?: string;
  phoneNumber?: string;
  orderType: 'purchase' | 'release';
  status: string;
  twilioCost?: number;
  markupAmount?: number;
  totalPrice?: number;
  createdAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface PortalBilling {
  pricing: {
    pricingType: string;
    setupFee: number;
  };
  summary: {
    activeNumbers: number;
    provisionedNumbers: number;
    totalMonthlyCost: number;
    totalOrders: number;
    totalSpent: number;
  };
}

// ==================== Common ====================

export interface ApiResponse<T> {
  data: T;
}
