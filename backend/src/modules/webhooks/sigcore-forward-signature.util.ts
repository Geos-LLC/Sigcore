import * as crypto from 'crypto';

/**
 * Wave-2 authenticated Sigcore-forwarded inbound voice envelope — SIGNER side.
 *
 * The canonicalization here MUST stay bit-identical to Callio's
 * `sigcore-forward-signature.util.ts`. Any drift breaks staging validation.
 * There is a cross-service contract test in
 * `tenant-voice-forwarder.service.contract.spec.ts` that fails if the two
 * implementations diverge.
 *
 * Order-locked, order-locked, order-locked. Do not reorder fields, do not
 * add or remove blank lines, do not change line endings.
 */

export const SIGCORE_FORWARD_HEADERS = {
  workspaceId: 'x-sigcore-forwarded-workspace-id',
  tenantId: 'x-sigcore-forwarded-tenant-id',
  callSid: 'x-sigcore-forwarded-call-sid',
  timestamp: 'x-sigcore-forwarded-timestamp',
  signature: 'x-sigcore-forwarded-signature',
} as const;

const SIGNATURE_PREFIX = 'v1=';

export type ForwardEnvelope = {
  method: string;
  path: string;
  timestamp: string;
  workspaceId: string;
  tenantId: string;
  callSid: string;
  rawBody: Buffer | string;
};

export function canonicalize(env: ForwardEnvelope): string {
  const body = typeof env.rawBody === 'string' ? env.rawBody : env.rawBody.toString('utf8');
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  return [
    env.method.toUpperCase(),
    env.path,
    env.timestamp,
    env.workspaceId,
    env.tenantId,
    env.callSid,
    bodyHash,
  ].join('\n');
}

export function sign(secret: string, env: ForwardEnvelope): string {
  const canonical = canonicalize(env);
  const mac = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  return `${SIGNATURE_PREFIX}${mac}`;
}
