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
   * The caller's OWN workspace/org identifier.
   *
   * Ownership: this identifier is owned by the consuming product. Sigcore
   * never generates, mutates, or interprets it. Sigcore stores it verbatim
   * and uses (product, externalWorkspaceId) as the idempotency key.
   *
   * Immutability: this value is IMMUTABLE. Once a Communication Identity
   * exists for a given (product, externalWorkspaceId) pair, any change to
   * the consumer's own workspace identifier requires the consumer to
   * request a new Communication Identity — Sigcore does not offer any
   * "rename" or "reassign" operation. Repeated calls with the same pair
   * are guaranteed to return the same Sigcore-side identity; a call with
   * a different pair provisions a fresh identity even if the consumer
   * considers it "the same workspace."
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
 * Response shape returned by the provisioning endpoint.
 *
 * The default provider today is Twilio — the endpoint always includes
 * exactly one integration entry for it. Additional providers (OpenPhone,
 * WhatsApp, Telegram, future ones) may be returned in the same list once
 * multi-provider provisioning is on the table; consumers must iterate
 * `integrations[]` and dispatch on `provider` rather than assuming a
 * fixed length or a Twilio-only shape.
 *
 * Internal note (not part of the consumer contract):
 * a `communication_identities` row is created for every provisioned
 * identity and its primary key serves as an internal handle for
 * Sigcore's own bookkeeping. That handle is **not** returned in this
 * response — it is intentionally kept internal. Consumers store
 * `workspaceId`, `tenantId`, and the `integrationId` values they care
 * about; future revisions may surface a stable opaque handle here, but
 * any such addition will be an additive change, not a breaking one.
 */
export interface ProvisionedIntegration {
  provider: string;
  integrationId: string;
  /** Lifecycle status: `active | inactive | error`. Reflects Sigcore's own
   * bookkeeping — does NOT imply the integration can service provider
   * operations. Consumers must consult `operationalStatus` for that. */
  status: string;
  /**
   * Wave-2 Task 6B.5A — operational readiness. Reflects whether the
   * provider integration can actually service operations end-to-end.
   *
   *   `pending_credentials`  provider setup not yet initiated
   *   `provisioning`         provider setup in flight (transient)
   *   `ready`                Sigcore has verified end-to-end; safe to use
   *   `error`                setup failed; retry allowed
   *
   * A newly provisioned identity starts at `pending_credentials`; a
   * Sigcore-owned lazy flow transitions it on the first voice-number
   * purchase. Grandfathered pre-6B.5A rows report `ready`.
   */
  operationalStatus: string;
  /**
   * Machine-readable reason accompanying `operationalStatus`. Null when
   * operationalStatus is `ready`. Values are stable code strings like
   * `TWILIO_CREDENTIALS_NOT_CONFIGURED`; unknown values should be treated
   * as opaque.
   */
  operationalReason: string | null;
}

export interface CommunicationIdentityResponse {
  workspaceId: string;
  tenantId: string;
  integrations: ProvisionedIntegration[];
}
