import {
  attributePlatforms,
  tenantsByPlatform,
  PLATFORM_ANCHORS,
} from './platform-attribution';

describe('attributePlatforms', () => {
  it('returns empty maps for an empty workspace', () => {
    const result = attributePlatforms([]);
    expect(result.byTenantId.size).toBe(0);
    expect(result.anchors).toEqual({
      leadbridge: null,
      hirefunnel: null,
      serviceflow: null,
      callio: null,
      unclassified: null,
    });
  });

  it('attributes the four canonical anchors', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'LeadBridge' },
      { id: 't2', name: 'HireFunnel' },
      { id: 't3', name: 'Service Flow' },
      { id: 't4', name: 'Callio' },
    ]);
    expect(result.anchors.leadbridge).toBe('t1');
    expect(result.anchors.hirefunnel).toBe('t2');
    expect(result.anchors.serviceflow).toBe('t3');
    expect(result.anchors.callio).toBe('t4');
    expect(result.byTenantId.get('t1')).toBe('leadbridge');
    expect(result.byTenantId.get('t2')).toBe('hirefunnel');
    expect(result.byTenantId.get('t3')).toBe('serviceflow');
    expect(result.byTenantId.get('t4')).toBe('callio');
  });

  it('matches anchors case-insensitively and trims whitespace', () => {
    const result = attributePlatforms([
      { id: 't1', name: '  leadbridge  ' },
      { id: 't2', name: 'HIREFUNNEL' },
      { id: 't3', name: 'service flow' },
      { id: 't4', name: 'CaLLiO' },
    ]);
    expect(result.byTenantId.get('t1')).toBe('leadbridge');
    expect(result.byTenantId.get('t2')).toBe('hirefunnel');
    expect(result.byTenantId.get('t3')).toBe('serviceflow');
    expect(result.byTenantId.get('t4')).toBe('callio');
  });

  it('does NOT default unmatched tenants to LeadBridge — they are unclassified', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'Spotless Homes Tampa' },
      { id: 't2', name: 'Account 7e0f0b3b-…' },
      { id: 't3', name: 'Lavanda Cleaning' },
      { id: 't4', name: 'Georgiy Sayapin' },
    ]);
    expect(result.byTenantId.get('t1')).toBe('unclassified');
    expect(result.byTenantId.get('t2')).toBe('unclassified');
    expect(result.byTenantId.get('t3')).toBe('unclassified');
    expect(result.byTenantId.get('t4')).toBe('unclassified');
    expect(result.anchors.leadbridge).toBeNull();
  });

  it('classifies a typo as unclassified rather than guessing', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'Lead Bridge' }, // space — not the anchor
      { id: 't2', name: 'ServiceFlow' }, // no space — not the anchor
      { id: 't3', name: 'HireFunnel ' }, // trailing space tolerated by trim
    ]);
    expect(result.byTenantId.get('t1')).toBe('unclassified');
    expect(result.byTenantId.get('t2')).toBe('unclassified');
    expect(result.byTenantId.get('t3')).toBe('hirefunnel');
  });

  it('handles a real-world flat workspace mixing anchors with customers', () => {
    const tenants = [
      { id: 'a-lb', name: 'LeadBridge' },
      { id: 'a-callio', name: 'Callio' },
      { id: 'a-sf-1', name: 'Service Flow' },
      { id: 'a-sf-2', name: 'Service Flow' }, // duplicate anchor name
      { id: 'a-hf', name: 'HireFunnel' },
      { id: 'c-1', name: 'Spotless Homes Tampa' },
      { id: 'c-2', name: 'Spotless Homes Jacksonville' },
      { id: 'c-3', name: 'NatashaHome Cleaning' },
      { id: 'c-4', name: 'Lavanda Cleaning' },
      { id: 'c-5', name: 'ABC Solutions - Always Best Cleaning' },
      { id: 'c-6', name: 'Account fa4a8d5b-bf63-4b17-8249-d0178ce610aa' },
      { id: 'c-7', name: 'Georgiy Sayapin' },
    ];
    const result = attributePlatforms(tenants);
    const grouped = tenantsByPlatform(result);

    expect(result.anchors.leadbridge).toBe('a-lb');
    expect(result.anchors.callio).toBe('a-callio');
    expect(result.anchors.serviceflow).toBe('a-sf-1'); // first wins
    expect(result.anchors.hirefunnel).toBe('a-hf');

    expect(grouped.leadbridge).toEqual(['a-lb']);
    expect(grouped.callio).toEqual(['a-callio']);
    expect(grouped.hirefunnel).toEqual(['a-hf']);
    expect(grouped.serviceflow).toEqual(['a-sf-1']);
    // duplicate-anchor SF row + every customer row + Georgiy → unclassified
    expect(grouped.unclassified).toEqual([
      'a-sf-2',
      'c-1',
      'c-2',
      'c-3',
      'c-4',
      'c-5',
      'c-6',
      'c-7',
    ]);
  });

  it('treats null/undefined/empty names as unclassified without crashing', () => {
    const result = attributePlatforms([
      { id: 't1', name: '' },
      { id: 't2', name: null as any },
      { id: 't3', name: undefined as any },
    ]);
    expect(result.byTenantId.get('t1')).toBe('unclassified');
    expect(result.byTenantId.get('t2')).toBe('unclassified');
    expect(result.byTenantId.get('t3')).toBe('unclassified');
  });
});

describe('tenantsByPlatform', () => {
  it('produces a complete keyset including unclassified', () => {
    const result = attributePlatforms([{ id: 't1', name: 'LeadBridge' }]);
    const grouped = tenantsByPlatform(result);
    expect(Object.keys(grouped).sort()).toEqual(
      ['callio', 'hirefunnel', 'leadbridge', 'serviceflow', 'unclassified'].sort(),
    );
    for (const key of Object.keys(grouped)) {
      expect(Array.isArray((grouped as any)[key])).toBe(true);
    }
  });
});

describe('PLATFORM_ANCHORS sanity', () => {
  it('uses lowercase comparable strings', () => {
    for (const v of Object.values(PLATFORM_ANCHORS)) {
      expect(v).toBe(v.toLowerCase());
      expect(v).toBe(v.trim());
    }
  });
});
