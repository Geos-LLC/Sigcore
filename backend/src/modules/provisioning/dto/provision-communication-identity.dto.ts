import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * The set of products currently permitted to request a communication
 * identity. Kept hand-curated (rather than an open string) so we don't
 * accidentally provision infrastructure for an unrecognised caller.
 *
 * Adding a new product here is a small deliberate step — expected as
 * LeadBridge/ServiceFlow/etc. come online.
 */
export const KNOWN_PRODUCTS = ['callio'] as const;
export type KnownProduct = (typeof KNOWN_PRODUCTS)[number];

export class ProvisionCommunicationIdentityDto {
  @IsString()
  @IsIn(KNOWN_PRODUCTS as unknown as string[])
  product!: KnownProduct;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  workspaceName!: string;

  /**
   * The caller's OWN workspace/org identifier. Sigcore treats this as
   * opaque and uses (product, externalWorkspaceId) as the idempotency
   * key. Repeated calls with the same pair MUST return the same identity.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  externalWorkspaceId!: string;

  /**
   * Consumer-supplied opaque metadata. Sigcore does not interpret this.
   * Optional. Stored on the identity row for consumer-side bookkeeping.
   */
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

/**
 * The response is deliberately shaped to hide the internal
 * workspace/tenant/integration triple. Consumers must depend only on
 * `communicationIdentityId` and the integration entries they care about.
 * `workspaceId` / `tenantId` are returned for today's Callio consumer's
 * `workspaces.sigcore_workspace_id` cache and the existing registrar's
 * env-var equivalents — they are NOT contract-stable and may be removed
 * once consumers stop referencing them.
 */
export interface ProvisionedIntegration {
  provider: string;
  integrationId: string;
  status: string;
}

export interface CommunicationIdentityResponse {
  communicationIdentityId: string;
  workspaceId: string;
  tenantId: string;
  integrations: ProvisionedIntegration[];
}
