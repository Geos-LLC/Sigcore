import { classifyTenantSource, makeSlug } from './source-classifier';

describe('classifyTenantSource', () => {
  // ---------- Rule 1: anchor names ----------
  it('classifies the four canonical anchors to their respective platform (NOT "internal")', () => {
    expect(classifyTenantSource('LeadBridge', [], [])).toBe('leadbridge');
    expect(classifyTenantSource('Service Flow', [], [])).toBe('serviceflow');
    expect(classifyTenantSource('ServiceFlow', [], [])).toBe('serviceflow');
    expect(classifyTenantSource('Callio', [], [])).toBe('callio');
    expect(classifyTenantSource('HireFunnel', [], [])).toBe('hirefunnel');
  });

  it('matches anchor names case-insensitively and trims whitespace', () => {
    expect(classifyTenantSource('  leadbridge  ', [], [])).toBe('leadbridge');
    expect(classifyTenantSource('CALLIO', [], [])).toBe('callio');
    expect(classifyTenantSource('service flow', [], [])).toBe('serviceflow');
  });

  // ---------- Rule 2: webhook URL hostnames ----------
  it.each([
    ['https://thumbtack-bridge-production.up.railway.app/api/webhooks/sigcore', 'leadbridge'],
    ['https://www.leadbridge360.com/webhooks',                                  'leadbridge'],
    ['https://service-flow-backend-production.up.railway.app/api/webhooks',     'serviceflow'],
    ['https://callio-production-47ac.up.railway.app/api/webhooks/sigcore',      'callio'],
    ['https://app.hirefunnel.app/webhook',                                       'hirefunnel'],
    ['https://hiringflow.example.com/wh',                                        'hirefunnel'],
  ])('classifies webhook URL %s', (url, expected) => {
    expect(classifyTenantSource('Customer X', [url], [])).toBe(expected);
  });

  it('returns "internal" for unrecognised webhook URLs', () => {
    expect(classifyTenantSource('Customer X', ['https://random.example.com/wh'], [])).toBe('internal');
  });

  // ---------- Rule 3: api_key names ----------
  it.each([
    ['LeadBridge Key',           'leadbridge'],
    ['Lead Bridge Portal',       'leadbridge'],
    ['ServiceFlow Key',          'serviceflow'],
    ['Service Flow Production',  'serviceflow'],
    ['Callio CI',                'callio'],
    ['HireFunnel Reminders',     'hirefunnel'],
    ['HiringFlow Key',           'hirefunnel'],
  ])('classifies api_key name %s', (name, expected) => {
    expect(classifyTenantSource('Customer Y', [], [name])).toBe(expected);
  });

  it('returns "internal" for unrecognised api_key names', () => {
    expect(classifyTenantSource('Customer Y', [], ['Portal Key', 'CI/CD'])).toBe('internal');
  });

  // ---------- Priority order ----------
  it('anchor name beats webhook beats api_key', () => {
    expect(
      classifyTenantSource(
        'LeadBridge', // anchor
        ['https://service-flow-backend.up.railway.app'], // would say serviceflow
        ['Callio Key'], // would say callio
      ),
    ).toBe('leadbridge');

    expect(
      classifyTenantSource(
        'Random Customer',
        ['https://callio-production-47ac.up.railway.app'], // webhook → callio
        ['LeadBridge Key'], // would say leadbridge
      ),
    ).toBe('callio');
  });

  // ---------- Defensive ----------
  it('handles null / undefined / empty inputs', () => {
    expect(classifyTenantSource(null, [], [])).toBe('internal');
    expect(classifyTenantSource(undefined, [], [])).toBe('internal');
    expect(classifyTenantSource('', [], [])).toBe('internal');
    expect(classifyTenantSource('Random', [''], [''])).toBe('internal');
  });

  // ---------- Real-world prod scenarios ----------
  it('correctly classifies the 5 anchor + 3 archetype prod tenants', () => {
    // 4 platform anchors
    expect(classifyTenantSource('LeadBridge', [], [])).toBe('leadbridge');
    expect(classifyTenantSource('Service Flow', [], [])).toBe('serviceflow');
    expect(classifyTenantSource('Callio', [], [])).toBe('callio');
    expect(classifyTenantSource('HireFunnel', [], [])).toBe('hirefunnel');

    // LB customer with thumbtack-bridge webhook
    expect(
      classifyTenantSource(
        'Spotless Homes Tampa',
        ['https://thumbtack-bridge-production.up.railway.app/api/webhooks/sigcore/inbound-sms?accountId=…'],
        [],
      ),
    ).toBe('leadbridge');

    // LB customer with no webhook but "LeadBridge Key" api_key
    expect(
      classifyTenantSource('Account fa4a8d5b-…', [], ['LeadBridge Key']),
    ).toBe('leadbridge');

    // Truly unclassified
    expect(classifyTenantSource('Georgiy Sayapin', [], [])).toBe('internal');
  });
});

describe('makeSlug', () => {
  it('produces deterministic kebab-case + 8-char id suffix', () => {
    expect(makeSlug('Spotless Homes Tampa', '63bcdb33-1111-2222-3333-444444444444'))
      .toBe('spotless-homes-tampa-63bcdb33');
    expect(makeSlug('LeadBridge', 'ee06c09a-1d1e-4f67-b585-84d1efe22e34'))
      .toBe('leadbridge-ee06c09a');
  });

  it('strips special characters and collapses whitespace', () => {
    expect(makeSlug('ABC Solutions - Always Best Cleaning', '20013407-aaaa-bbbb-cccc-dddddddddddd'))
      .toBe('abc-solutions-always-best-cleaning-20013407');
    expect(makeSlug('NatashaHome cleaning', 'f386ee6c-1111-2222-3333-444444444444'))
      .toBe('natashahome-cleaning-f386ee6c');
  });

  it('falls back to workspace-<id8> for empty / null / unsluggable names', () => {
    expect(makeSlug('', 'abc12345-…')).toBe('workspace-abc12345');
    expect(makeSlug(null, 'def67890-…')).toBe('workspace-def67890');
    expect(makeSlug(undefined, 'aaaaaaaa-…')).toBe('workspace-aaaaaaaa');
    expect(makeSlug('   ', 'bbbbbbbb-…')).toBe('workspace-bbbbbbbb');
    expect(makeSlug('!!!@@@###', 'cccccccc-…')).toBe('workspace-cccccccc');
  });

  it('produces unique slugs for duplicate-named tenants', () => {
    const a = makeSlug('Spotless Homes Tampa', '63bcdb33-1111-2222-3333-444444444444');
    const b = makeSlug('Spotless Homes Tampa', '45ea9010-aaaa-bbbb-cccc-dddddddddddd');
    expect(a).not.toBe(b);
    expect(a).toBe('spotless-homes-tampa-63bcdb33');
    expect(b).toBe('spotless-homes-tampa-45ea9010');
  });
});
