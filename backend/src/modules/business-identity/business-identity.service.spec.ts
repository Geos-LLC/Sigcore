import { NotFoundException } from '@nestjs/common';
import { BusinessIdentityService } from './business-identity.service';
import { EndpointRoute } from '../../database/entities/endpoint-route.entity';

// ---------------------------------------------------------------------------
// Mock repository factory
// ---------------------------------------------------------------------------
function mockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (entity: any) => ({ id: 'generated-id', ...entity })),
    create: jest.fn((dto: any) => dto),
  };
}

function buildService() {
  const businessRepo = mockRepo();
  const workspaceRepo = mockRepo();
  const assetRepo = mockRepo();
  const linkRepo = mockRepo();
  const routeRepo = mockRepo();

  const service = new BusinessIdentityService(
    businessRepo as any,
    workspaceRepo as any,
    assetRepo as any,
    linkRepo as any,
    routeRepo as any,
  );

  return { service, businessRepo, workspaceRepo, assetRepo, linkRepo, routeRepo };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeRoute(overrides: Partial<EndpointRoute> = {}): EndpointRoute {
  const r = new EndpointRoute();
  r.id = overrides.id || 'route-1';
  r.tenantId = overrides.tenantId || 'tenant-1';
  r.provider = overrides.provider || 'openphone';
  r.providerAccountId = overrides.providerAccountId;
  r.endpointId = overrides.endpointId;
  r.phoneNumber = overrides.phoneNumber;
  r.channel = overrides.channel || 'sms';
  r.role = overrides.role;
  r.purpose = overrides.purpose;
  r.priority = overrides.priority ?? 0;
  r.isActive = overrides.isActive ?? true;
  r.routeSource = overrides.routeSource || 'manual';
  r.metadata = overrides.metadata;
  r.createdAt = new Date();
  r.updatedAt = new Date();
  return r;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('BusinessIdentityService', () => {
  // ═══ Normalization ═══
  describe('normalizePhone', () => {
    it('adds +1 to 10-digit numbers', () => {
      const { service } = buildService();
      expect(service.normalizePhone('2025551234')).toBe('+12025551234');
    });

    it('adds + to 11-digit numbers starting with 1', () => {
      const { service } = buildService();
      expect(service.normalizePhone('12025551234')).toBe('+12025551234');
    });

    it('preserves already-formatted E.164', () => {
      const { service } = buildService();
      expect(service.normalizePhone('+12025551234')).toBe('+12025551234');
    });

    it('strips non-digit characters', () => {
      const { service } = buildService();
      expect(service.normalizePhone('(202) 555-1234')).toBe('+12025551234');
    });

    it('returns empty string for empty input', () => {
      const { service } = buildService();
      expect(service.normalizePhone('')).toBe('');
    });
  });

  describe('normalizeEmail', () => {
    it('lowercases and trims', () => {
      const { service } = buildService();
      expect(service.normalizeEmail('  Test@Example.COM  ')).toBe('test@example.com');
    });
  });

  // ═══ Route CRUD ═══
  describe('createRoute', () => {
    it('creates a new route when no existing match', async () => {
      const { service, routeRepo } = buildService();
      routeRepo.findOne.mockResolvedValue(null);

      const { route, created } = await service.createRoute('tenant-1', {
        provider: 'openphone',
        endpoint_id: 'PNm5YIDoXV',
        channel: 'sms',
        role: 'primary',
      });

      expect(created).toBe(true);
      expect(route.tenantId).toBe('tenant-1');
      expect(route.provider).toBe('openphone');
      expect(route.endpointId).toBe('PNm5YIDoXV');
      expect(route.isActive).toBe(true);
      expect(routeRepo.save).toHaveBeenCalled();
    });

    it('returns existing route (idempotent) when endpoint already registered', async () => {
      const { service, routeRepo } = buildService();
      const existing = makeRoute({
        tenantId: 'tenant-1',
        endpointId: 'PNm5YIDoXV',
        provider: 'openphone',
      });
      routeRepo.findOne.mockResolvedValue(existing);

      const { route, created } = await service.createRoute('tenant-1', {
        provider: 'openphone',
        endpoint_id: 'PNm5YIDoXV',
        channel: 'sms',
      });

      expect(created).toBe(false);
      expect(route.id).toBe('route-1');
    });

    it('updates tenant on existing route if different tenant claims it', async () => {
      const { service, routeRepo } = buildService();
      const existing = makeRoute({
        tenantId: 'tenant-1',
        endpointId: 'PNm5YIDoXV',
        provider: 'openphone',
      });
      routeRepo.findOne.mockResolvedValue(existing);

      const { route } = await service.createRoute('tenant-2', {
        provider: 'openphone',
        endpoint_id: 'PNm5YIDoXV',
        channel: 'sms',
      });

      expect(route.tenantId).toBe('tenant-2');
      expect(routeRepo.save).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-2' }));
    });

    it('normalizes phone number on creation', async () => {
      const { service, routeRepo } = buildService();
      routeRepo.findOne.mockResolvedValue(null);

      const { route } = await service.createRoute('tenant-1', {
        provider: 'twilio',
        phone_number: '(202) 555-1234',
      });

      expect(route.phoneNumber).toBe('+12025551234');
    });

    it('defaults channel to sms', async () => {
      const { service, routeRepo } = buildService();
      routeRepo.findOne.mockResolvedValue(null);

      const { route } = await service.createRoute('tenant-1', {
        provider: 'openphone',
        endpoint_id: 'ep-1',
      });

      expect(route.channel).toBe('sms');
    });

    it('defaults route_source to manual', async () => {
      const { service, routeRepo } = buildService();
      routeRepo.findOne.mockResolvedValue(null);

      const { route } = await service.createRoute('tenant-1', {
        provider: 'openphone',
        endpoint_id: 'ep-1',
      });

      expect(route.routeSource).toBe('manual');
    });
  });

  describe('listRoutes', () => {
    it('defaults to active routes only', async () => {
      const { service, routeRepo } = buildService();
      routeRepo.find.mockResolvedValue([]);

      await service.listRoutes({});

      expect(routeRepo.find).toHaveBeenCalledWith({
        where: { isActive: true },
        order: { createdAt: 'DESC' },
      });
    });

    it('filters by tenant_id and provider', async () => {
      const { service, routeRepo } = buildService();
      routeRepo.find.mockResolvedValue([]);

      await service.listRoutes({ tenant_id: 't-1', provider: 'twilio' });

      expect(routeRepo.find).toHaveBeenCalledWith({
        where: { tenantId: 't-1', provider: 'twilio', isActive: true },
        order: { createdAt: 'DESC' },
      });
    });

    it('can list inactive routes explicitly', async () => {
      const { service, routeRepo } = buildService();
      routeRepo.find.mockResolvedValue([]);

      await service.listRoutes({ is_active: false });

      expect(routeRepo.find).toHaveBeenCalledWith({
        where: { isActive: false },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('updateRoute', () => {
    it('updates role and purpose', async () => {
      const { service, routeRepo } = buildService();
      const existing = makeRoute();
      routeRepo.findOne.mockResolvedValue(existing);

      const updated = await service.updateRoute('route-1', { role: 'primary', purpose: 'sales' });

      expect(updated.role).toBe('primary');
      expect(updated.purpose).toBe('sales');
    });

    it('sets deactivatedAt when deactivating', async () => {
      const { service, routeRepo } = buildService();
      const existing = makeRoute();
      routeRepo.findOne.mockResolvedValue(existing);

      const updated = await service.updateRoute('route-1', { is_active: false });

      expect(updated.isActive).toBe(false);
      expect(updated.deactivatedAt).toBeInstanceOf(Date);
    });

    it('throws NotFoundException for missing route', async () => {
      const { service, routeRepo } = buildService();
      routeRepo.findOne.mockResolvedValue(null);

      await expect(service.updateRoute('missing-id', { role: 'x' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteRoute', () => {
    it('soft-deactivates the route', async () => {
      const { service, routeRepo } = buildService();
      const existing = makeRoute();
      routeRepo.findOne.mockResolvedValue(existing);

      await service.deleteRoute('route-1');

      expect(routeRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false, deactivatedAt: expect.any(Date) }),
      );
    });

    it('is a no-op for missing route', async () => {
      const { service, routeRepo } = buildService();
      routeRepo.findOne.mockResolvedValue(null);

      await service.deleteRoute('missing-id');

      expect(routeRepo.save).not.toHaveBeenCalled();
    });
  });

  // ═══ Deterministic Resolve ═══
  describe('resolveRoute', () => {
    it('Step A: resolves by exact endpoint match', async () => {
      const { service, routeRepo } = buildService();
      const route = makeRoute({ endpointId: 'PNm5YIDoXV', provider: 'openphone' });
      routeRepo.find.mockResolvedValueOnce([route]);

      const result = await service.resolveRoute({
        provider: 'openphone',
        endpoint_id: 'PNm5YIDoXV',
      });

      expect(result.route).toBe(route);
      expect(result.step).toBe('A');
      expect(result.ambiguous).toBe(false);
    });

    it('Step A: returns ambiguous when multiple routes match endpoint', async () => {
      const { service, routeRepo } = buildService();
      const r1 = makeRoute({ id: 'r1', endpointId: 'ep-1', tenantId: 't-1' });
      const r2 = makeRoute({ id: 'r2', endpointId: 'ep-1', tenantId: 't-2' });
      routeRepo.find.mockResolvedValueOnce([r1, r2]);

      const result = await service.resolveRoute({
        provider: 'openphone',
        endpoint_id: 'ep-1',
      });

      expect(result.route).toBeNull();
      expect(result.step).toBe('A');
      expect(result.ambiguous).toBe(true);
      expect(result.candidates).toHaveLength(2);
    });

    it('Step C: falls through to provider account when endpoint has no match', async () => {
      const { service, routeRepo } = buildService();
      const route = makeRoute({ providerAccountId: 'acct-123' });
      routeRepo.find
        .mockResolvedValueOnce([])  // Step A: no match
        .mockResolvedValueOnce([route]);  // Step C: account match

      const result = await service.resolveRoute({
        provider: 'openphone',
        endpoint_id: 'unknown-ep',
        provider_account_id: 'acct-123',
      });

      expect(result.route).toBe(route);
      expect(result.step).toBe('C');
    });

    it('Step D: falls through to phone fallback', async () => {
      const { service, routeRepo } = buildService();
      const route = makeRoute({ phoneNumber: '+12025551234' });
      routeRepo.find
        .mockResolvedValueOnce([])  // Step A
        .mockResolvedValueOnce([])  // Step C
        .mockResolvedValueOnce([route]);  // Step D

      const result = await service.resolveRoute({
        provider: 'openphone',
        endpoint_id: 'unknown',
        provider_account_id: 'unknown',
        phone_number: '2025551234',
      });

      expect(result.route).toBe(route);
      expect(result.step).toBe('D');
    });

    it('Step D: returns ambiguous when multiple phone matches', async () => {
      const { service, routeRepo } = buildService();
      const r1 = makeRoute({ id: 'r1', phoneNumber: '+12025551234', tenantId: 't-1' });
      const r2 = makeRoute({ id: 'r2', phoneNumber: '+12025551234', tenantId: 't-2' });
      routeRepo.find
        .mockResolvedValueOnce([])  // Step A
        .mockResolvedValueOnce([])  // Step C
        .mockResolvedValueOnce([r1, r2]);  // Step D

      const result = await service.resolveRoute({
        provider: 'openphone',
        endpoint_id: 'unknown',
        provider_account_id: 'unknown',
        phone_number: '+12025551234',
      });

      expect(result.route).toBeNull();
      expect(result.step).toBe('D');
      expect(result.ambiguous).toBe(true);
      expect(result.candidates).toHaveLength(2);
    });

    it('returns no match when nothing found at any step', async () => {
      const { service, routeRepo } = buildService();
      routeRepo.find.mockResolvedValue([]);

      const result = await service.resolveRoute({
        provider: 'openphone',
        endpoint_id: 'unknown',
        provider_account_id: 'unknown',
        phone_number: '+19999999999',
      });

      expect(result.route).toBeNull();
      expect(result.step).toBeNull();
      expect(result.ambiguous).toBe(false);
      expect(result.candidates).toHaveLength(0);
    });

    it('defaults channel to sms', async () => {
      const { service, routeRepo } = buildService();
      routeRepo.find.mockResolvedValue([]);

      await service.resolveRoute({ provider: 'openphone', endpoint_id: 'ep-1' });

      expect(routeRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ channel: 'sms' }),
        }),
      );
    });

    it('skips Step A when no endpoint_id provided', async () => {
      const { service, routeRepo } = buildService();
      const route = makeRoute({ providerAccountId: 'acct-1' });
      routeRepo.find.mockResolvedValueOnce([route]);

      const result = await service.resolveRoute({
        provider: 'openphone',
        provider_account_id: 'acct-1',
      });

      // Should go straight to Step C (only 1 find call)
      expect(routeRepo.find).toHaveBeenCalledTimes(1);
      expect(result.step).toBe('C');
    });

    it('skips Steps A and C when only phone provided', async () => {
      const { service, routeRepo } = buildService();
      const route = makeRoute({ phoneNumber: '+12025551234' });
      routeRepo.find.mockResolvedValueOnce([route]);

      const result = await service.resolveRoute({
        provider: 'openphone',
        phone_number: '+12025551234',
      });

      expect(routeRepo.find).toHaveBeenCalledTimes(1);
      expect(result.step).toBe('D');
    });
  });
});
