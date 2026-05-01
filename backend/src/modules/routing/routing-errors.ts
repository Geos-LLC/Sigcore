/**
 * Error codes returned by the routing resolvers. The HTTP layer (in PR4
 * when the outbound endpoint switches over) maps these to status codes:
 *   CROSS_TENANT_PROFILE   → 403
 *   AMBIGUOUS_FROM_NUMBER  → 422
 *   PROFILE_NOT_CONFIGURED → 422
 *   INVALID_PROFILE_PHONE  → 422
 *   PROFILE_NOT_FOUND      → 404
 *
 * Throw RoutingError from a resolver; tests assert on `.code`.
 */
export const RoutingErrorCode = {
  CROSS_TENANT_PROFILE: 'CROSS_TENANT_PROFILE',
  AMBIGUOUS_FROM_NUMBER: 'AMBIGUOUS_FROM_NUMBER',
  PROFILE_NOT_CONFIGURED: 'PROFILE_NOT_CONFIGURED',
  INVALID_PROFILE_PHONE: 'INVALID_PROFILE_PHONE',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
} as const;

export type RoutingErrorCodeValue =
  (typeof RoutingErrorCode)[keyof typeof RoutingErrorCode];

export class RoutingError extends Error {
  readonly code: RoutingErrorCodeValue;

  constructor(code: RoutingErrorCodeValue, message: string) {
    super(message);
    this.code = code;
    this.name = 'RoutingError';
  }
}
