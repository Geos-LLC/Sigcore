/**
 * Sigcore tenant-webhooks signing tests.
 *
 * Mirror of outbound-webhooks.signing.spec.ts. Asserts the X-Callio-* headers
 * + HMAC format on TenantWebhooksService match the SF /lead-status verifier
 * (epoch ts header, HMAC over `${ts}.${rawBody}`).
 *
 * Single source of truth for the receiver-side shape lives in SF's
 * `lib/webhook-signature.js` — this file re-implements the verifier locally
 * so a contract drift in either repo fails this suite.
 */

import * as crypto from 'crypto';
import axios from 'axios';
import {
  TenantWebhooksService,
  TenantWebhookEventType,
} from './tenant-webhooks.service';
import { MessageStatus } from '../../database/entities/communication-message.entity';

jest.mock('axios');
const mockedAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;

const REPLAY_TOLERANCE_S = 5 * 60;

function verifySfShape({
  headers,
  rawBody,
  secret,
  nowSec = Math.floor(Date.now() / 1000),
}: {
  headers: Record<string, string>;
  rawBody: string;
  secret: string;
  nowSec?: number;
}): { valid: boolean; reason: string | null } {
  const sigHeader = headers['X-Callio-Signature'];
  const tsHeader = headers['X-Callio-Timestamp'];
  if (!sigHeader || !tsHeader) {
    return { valid: false, reason: 'missing_signature_or_timestamp' };
  }
  const tsNum = parseInt(tsHeader, 10);
  if (!Number.isFinite(tsNum)) return { valid: false, reason: 'invalid_timestamp' };
  if (Math.abs(nowSec - tsNum) > REPLAY_TOLERANCE_S) {
    return { valid: false, reason: 'stale_timestamp' };
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${tsHeader}.${rawBody}`)
    .digest('hex');
  const provided = String(sigHeader).replace(/^sha256=/i, '');
  if (expected.length !== provided.length) {
    return { valid: false, reason: 'length_mismatch' };
  }
  const match = crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(provided, 'hex'),
  );
  return { valid: match, reason: match ? null : 'signature_mismatch' };
}

function buildTenant(over: Partial<any> = {}): any {
  return {
    id: 'tenant-test-id',
    name: 'Test Tenant',
    webhookUrl: 'https://example.test/tenant-hook',
    webhookSecret: 'tenant-secret-32-bytes-of-randomness',
    ...over,
  };
}

function buildMessage(over: Partial<any> = {}): any {
  return {
    id: 'msg-1',
    providerMessageId: 'prov-1',
    fromNumber: '+15555550100',
    toNumber: '+15555550101',
    metadata: { tenantId: 'tenant-test-id', leadId: 'lead-1' },
    ...over,
  };
}

function buildService(tenant: any) {
  const tenantRepo: any = {
    findOne: jest.fn().mockResolvedValue(tenant),
  };
  return new TenantWebhooksService(tenantRepo);
}

beforeEach(() => {
  mockedAxiosPost.mockReset();
  mockedAxiosPost.mockResolvedValue({ status: 200, data: {} } as any);
});

describe('TenantWebhooksService — outbound signature contract', () => {
  const SECRET = 'tenant-secret-32-bytes-of-randomness';

  test('forwardStatusToTenant sends epoch X-Callio-Timestamp + ts.body HMAC', async () => {
    const tenant = buildTenant({ webhookSecret: SECRET });
    const service = buildService(tenant);

    const before = Math.floor(Date.now() / 1000);
    await service.forwardStatusToTenant(buildMessage(), MessageStatus.DELIVERED);
    const after = Math.floor(Date.now() / 1000);

    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedAxiosPost.mock.calls[0] as any;
    expect(url).toBe(tenant.webhookUrl);
    const headers = opts.headers as Record<string, string>;

    expect(headers['X-Callio-Tenant-Id']).toBe(tenant.id);
    expect(headers['X-Callio-Event']).toBe(TenantWebhookEventType.MESSAGE_DELIVERED);

    expect(headers['X-Callio-Timestamp']).toMatch(/^\d{10}$/);
    const ts = parseInt(headers['X-Callio-Timestamp'], 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);

    expect(headers['X-Callio-Signature']).toMatch(/^[a-f0-9]{64}$/);

    const r = verifySfShape({
      headers,
      rawBody: JSON.stringify(body),
      secret: SECRET,
    });
    expect(r).toEqual({ valid: true, reason: null });
  });

  test('signature is hex(HMAC-SHA256(secret, `${ts}.${body}`)) — explicit reproduction', async () => {
    const tenant = buildTenant({ webhookSecret: SECRET });
    const service = buildService(tenant);
    await service.forwardStatusToTenant(buildMessage(), MessageStatus.FAILED, 'E1', 'boom');

    const [, body, opts] = mockedAxiosPost.mock.calls[0] as any;
    const ts = (opts.headers as any)['X-Callio-Timestamp'];
    const sig = (opts.headers as any)['X-Callio-Signature'];
    const expected = crypto
      .createHmac('sha256', SECRET)
      .update(`${ts}.${JSON.stringify(body)}`)
      .digest('hex');
    expect(sig).toBe(expected);
  });

  test('event payload body still carries ISO timestamp field', async () => {
    const tenant = buildTenant({ webhookSecret: SECRET });
    const service = buildService(tenant);
    await service.forwardStatusToTenant(buildMessage(), MessageStatus.DELIVERED);
    const [, body] = mockedAxiosPost.mock.calls[0] as any;
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(body.event).toBe(TenantWebhookEventType.MESSAGE_DELIVERED);
    expect(body.data).toBeDefined();
    expect(body.data.tenantId).toBe('tenant-test-id');
  });

  test('SF verifier rejects when body is tampered after Sigcore signs', async () => {
    const tenant = buildTenant({ webhookSecret: SECRET });
    const service = buildService(tenant);
    await service.forwardStatusToTenant(buildMessage(), MessageStatus.DELIVERED);
    const [, body, opts] = mockedAxiosPost.mock.calls[0] as any;
    const tampered = JSON.stringify({ ...body, data: { ...body.data, messageId: 'EVIL' } });
    const r = verifySfShape({
      headers: opts.headers,
      rawBody: tampered,
      secret: SECRET,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('signature_mismatch');
  });

  test('replay window: a sig captured 6 min ago is rejected even if otherwise valid', async () => {
    const tenant = buildTenant({ webhookSecret: SECRET });
    const service = buildService(tenant);
    await service.forwardStatusToTenant(buildMessage(), MessageStatus.DELIVERED);
    const [, body, opts] = mockedAxiosPost.mock.calls[0] as any;
    const tsCaptured = parseInt((opts.headers as any)['X-Callio-Timestamp'], 10);
    const r = verifySfShape({
      headers: opts.headers,
      rawBody: JSON.stringify(body),
      secret: SECRET,
      nowSec: tsCaptured + 6 * 60,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('stale_timestamp');
  });

  test('OLD body-only signature format would be REJECTED by SF — proves the contract changed', async () => {
    const tenant = buildTenant({ webhookSecret: SECRET });
    const service = buildService(tenant);
    await service.forwardStatusToTenant(buildMessage(), MessageStatus.DELIVERED);
    const [, body, opts] = mockedAxiosPost.mock.calls[0] as any;
    const oldFormatSig = crypto
      .createHmac('sha256', SECRET)
      .update(JSON.stringify(body))
      .digest('hex');
    const headers = { ...opts.headers, 'X-Callio-Signature': oldFormatSig };
    const r = verifySfShape({
      headers,
      rawBody: JSON.stringify(body),
      secret: SECRET,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('signature_mismatch');
  });

  test('tenants without webhookSecret get unsigned deliveries — no X-Callio-Signature header', async () => {
    const tenant = buildTenant({ webhookSecret: undefined });
    const service = buildService(tenant);
    await service.forwardStatusToTenant(buildMessage(), MessageStatus.DELIVERED);
    const [, , opts] = mockedAxiosPost.mock.calls[0] as any;
    expect((opts.headers as any)['X-Callio-Signature']).toBeUndefined();
    expect((opts.headers as any)['X-Callio-Timestamp']).toMatch(/^\d{10}$/);
  });

  test('skips delivery when tenant has no webhookUrl (current production state)', async () => {
    const tenant = buildTenant({ webhookUrl: undefined, webhookSecret: SECRET });
    const service = buildService(tenant);
    await service.forwardStatusToTenant(buildMessage(), MessageStatus.DELIVERED);
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });
});
