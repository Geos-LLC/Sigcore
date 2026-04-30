import {
  attributePlatforms,
  tenantsByPlatform,
  PLATFORM_ANCHORS,
  AttributionTenant,
} from './platform-attribution';

// ---------------------------------------------------------------------------
// 1. Anchor by name (signal 1) — same as the original spec
// ---------------------------------------------------------------------------
describe('attributePlatforms — signal 1: anchor by name', () => {
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
    expect(result.byTenantId.get('t4')).toBe('callio');
    expect(result.reasonByTenantId.get('t1')).toBe('anchor_name');
    expect(result.reasonByTenantId.get('t2')).toBe('anchor_name');
    expect(result.reasonByTenantId.get('t3')).toBe('anchor_name');
    expect(result.reasonByTenantId.get('t4')).toBe('anchor_name');
  });

  it('matches case-insensitively and trims whitespace', () => {
    const result = attributePlatforms([
      { id: 't1', name: '  leadbridge  ' },
      { id: 't2', name: 'HIREFUNNEL' },
    ]);
    expect(result.byTenantId.get('t1')).toBe('leadbridge');
    expect(result.byTenantId.get('t2')).toBe('hirefunnel');
  });
});

// ---------------------------------------------------------------------------
// 2. product_workspace.product_type (signal 2)
// ---------------------------------------------------------------------------
describe('attributePlatforms — signal 2: product_workspace.product_type', () => {
  it('uses leadbridge product_type when name is not an anchor', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'Spotless Homes Tampa', productWorkspaceProductType: 'leadbridge' },
    ]);
    expect(result.byTenantId.get('t1')).toBe('leadbridge');
    expect(result.reasonByTenantId.get('t1')).toBe('product_workspace:leadbridge');
  });

  it('uses serviceflow product_type', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'Customer X', productWorkspaceProductType: 'serviceflow' },
    ]);
    expect(result.byTenantId.get('t1')).toBe('serviceflow');
    expect(result.reasonByTenantId.get('t1')).toBe('product_workspace:serviceflow');
  });

  it('uses callio product_type', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'Customer X', productWorkspaceProductType: 'callio' },
    ]);
    expect(result.byTenantId.get('t1')).toBe('callio');
    expect(result.reasonByTenantId.get('t1')).toBe('product_workspace:callio');
  });

  it('does NOT use product_type=sigcore as a signal — it is a registry artifact', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'Account abc', productWorkspaceProductType: 'sigcore' },
    ]);
    expect(result.byTenantId.get('t1')).toBe('unclassified');
    expect(result.reasonByTenantId.get('t1')).toBe('unclassified');
  });

  it('handles unrecognised product_type values as no signal', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'X', productWorkspaceProductType: 'fancyproduct' },
    ]);
    expect(result.byTenantId.get('t1')).toBe('unclassified');
  });
});

// ---------------------------------------------------------------------------
// 3. webhook_subscriptions.webhook_url (signal 3)
// ---------------------------------------------------------------------------
describe('attributePlatforms — signal 3: webhook URL hostname', () => {
  it.each([
    ['https://thumbtack-bridge-production.up.railway.app/api/webhooks/sigcore/inbound-sms', 'leadbridge', 'webhook_url:thumbtack-bridge'],
    ['https://www.leadbridge360.com/api/webhooks/sigcore/delivery-status',                 'leadbridge', 'webhook_url:leadbridge360'],
    ['https://service-flow-backend-production-4568.up.railway.app/api/communications/webhooks/sigcore', 'serviceflow', 'webhook_url:service-flow-backend'],
    ['https://callio-production-47ac.up.railway.app/api/webhooks/sigcore',                 'callio',     'webhook_url:callio-production'],
    ['https://app.hirefunnel.app/webhook',                                                  'hirefunnel', 'webhook_url:hirefunnel'],
    ['https://hiringflow.example.com/wh',                                                   'hirefunnel', 'webhook_url:hiringflow'],
  ])('classifies %s', (url, platform, reason) => {
    const result = attributePlatforms([
      { id: 't1', name: 'Random Customer', webhookUrls: [url] },
    ]);
    expect(result.byTenantId.get('t1')).toBe(platform);
    expect(result.reasonByTenantId.get('t1')).toBe(reason);
  });

  it('matches when only one of multiple webhook URLs is recognised', () => {
    const result = attributePlatforms([
      {
        id: 't1',
        name: 'X',
        webhookUrls: [
          'https://example.com/random',
          'https://thumbtack-bridge-production.up.railway.app/api/webhooks/sigcore',
        ],
      },
    ]);
    expect(result.byTenantId.get('t1')).toBe('leadbridge');
    expect(result.reasonByTenantId.get('t1')).toBe('webhook_url:thumbtack-bridge');
  });

  it('returns unclassified when no webhook URL matches a known host', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'X', webhookUrls: ['https://random.example.com/wh'] },
    ]);
    expect(result.byTenantId.get('t1')).toBe('unclassified');
  });
});

// ---------------------------------------------------------------------------
// 4. api_key.name (signal 4)
// ---------------------------------------------------------------------------
describe('attributePlatforms — signal 4: api_key.name pattern', () => {
  it.each([
    ['LeadBridge Key',     'leadbridge',  'api_key_name:leadbridge'],
    ['Lead Bridge Portal', 'leadbridge',  'api_key_name:leadbridge'],
    ['HireFunnel Reminders Key', 'hirefunnel', 'api_key_name:hirefunnel'],
    ['HiringFlow Key',     'hirefunnel',  'api_key_name:hiringflow'],
    ['ServiceFlow Key',    'serviceflow', 'api_key_name:serviceflow'],
    ['Callio CI',          'callio',      'api_key_name:callio'],
  ])('classifies api_key name %s', (name, platform, reason) => {
    const result = attributePlatforms([
      { id: 't1', name: 'X', apiKeyNames: [name] },
    ]);
    expect(result.byTenantId.get('t1')).toBe(platform);
    expect(result.reasonByTenantId.get('t1')).toBe(reason);
  });

  it('returns unclassified when no api key name matches', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'X', apiKeyNames: ['Portal Key', 'CI/CD'] },
    ]);
    expect(result.byTenantId.get('t1')).toBe('unclassified');
  });
});

// ---------------------------------------------------------------------------
// 5. Priority order — anchor > product_workspace > webhook_url > api_key_name
// ---------------------------------------------------------------------------
describe('attributePlatforms — priority order', () => {
  it('anchor_name wins over product_workspace', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'LeadBridge', productWorkspaceProductType: 'serviceflow' },
    ]);
    expect(result.byTenantId.get('t1')).toBe('leadbridge');
    expect(result.reasonByTenantId.get('t1')).toBe('anchor_name');
  });

  it('product_workspace wins over webhook_url', () => {
    const result = attributePlatforms([
      {
        id: 't1',
        name: 'Customer X',
        productWorkspaceProductType: 'leadbridge',
        webhookUrls: ['https://service-flow-backend-production.up.railway.app/'],
      },
    ]);
    expect(result.byTenantId.get('t1')).toBe('leadbridge');
    expect(result.reasonByTenantId.get('t1')).toBe('product_workspace:leadbridge');
  });

  it('webhook_url wins over api_key_name', () => {
    const result = attributePlatforms([
      {
        id: 't1',
        name: 'Customer X',
        webhookUrls: ['https://callio-production-47ac.up.railway.app/api/webhooks/sigcore'],
        apiKeyNames: ['LeadBridge Key'],
      },
    ]);
    expect(result.byTenantId.get('t1')).toBe('callio');
    expect(result.reasonByTenantId.get('t1')).toBe('webhook_url:callio-production');
  });

  it('api_key_name is the last signal before unclassified', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'Account abc', apiKeyNames: ['LeadBridge Key'] },
    ]);
    expect(result.byTenantId.get('t1')).toBe('leadbridge');
    expect(result.reasonByTenantId.get('t1')).toBe('api_key_name:leadbridge');
  });

  it('falls through to unclassified when ALL signals miss', () => {
    const result = attributePlatforms([
      {
        id: 't1',
        name: 'Spotless Homes Tampa',
        productWorkspaceProductType: 'sigcore', // not a signal
        webhookUrls: ['https://random.example.com/wh'],
        apiKeyNames: ['Portal Key'],
      },
    ]);
    expect(result.byTenantId.get('t1')).toBe('unclassified');
    expect(result.reasonByTenantId.get('t1')).toBe('unclassified');
  });

  it('NEVER defaults to LeadBridge when no signal matches', () => {
    const result = attributePlatforms([
      { id: 't1', name: 'Random Customer' },
      { id: 't2', name: '' },
      { id: 't3', name: 'Account 1234' }, // looks like LB convention but no actual signal
    ]);
    for (const id of ['t1', 't2', 't3']) {
      expect(result.byTenantId.get(id)).toBe('unclassified');
      expect(result.reasonByTenantId.get(id)).toBe('unclassified');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Real-world fixture from the workspace 1bcbb4e0… audit
// ---------------------------------------------------------------------------
describe('attributePlatforms — real-world prod fixture', () => {
  it('correctly classifies a sample of the 48 prod tenants under workspace 1bcbb4e0', () => {
    const tenants: AttributionTenant[] = [
      // Anchors — name match
      { id: 'a-lb',     name: 'LeadBridge' },
      { id: 'a-callio', name: 'Callio' },
      { id: 'a-sf',     name: 'Service Flow' },
      { id: 'a-hf',     name: 'HireFunnel' },

      // LB customer accounts — webhook URL pointing at thumbtack-bridge
      {
        id: 'c-lb-1',
        name: 'Account fa4a8d5b…',
        webhookUrls: ['https://thumbtack-bridge-production.up.railway.app/api/webhooks/sigcore/inbound-sms?accountId=…'],
      },
      {
        id: 'c-lb-spotless',
        name: 'Spotless Homes Tampa',
        webhookUrls: ['https://thumbtack-bridge-production.up.railway.app/api/webhooks/sigcore/call-connect?accountId=…'],
        apiKeyNames: ['LeadBridge Key'],
      },

      // SF tenant — product_workspace.product_type='serviceflow'
      {
        id: 'c-sf',
        name: 'Service Flow staging',
        productWorkspaceProductType: 'serviceflow',
        webhookUrls: ['https://service-flow-backend-staging-303f.up.railway.app/api/communications/webhooks/sigcore'],
      },

      // Callio tenant — both signals
      {
        id: 'c-callio',
        name: 'Callio prod',
        productWorkspaceProductType: 'callio',
        webhookUrls: ['https://callio-production-47ac.up.railway.app/api/webhooks/sigcore'],
      },

      // Truly unclassified — name doesn't match, no useful signals
      { id: 'c-unknown', name: 'Georgiy Sayapin' },

      // Sigcore-as-business-identity rows — must NOT attribute via product_type
      { id: 'c-sigcore', name: 'NatashaHome cleaning', productWorkspaceProductType: 'sigcore' },
    ];

    const result = attributePlatforms(tenants);
    const grouped = tenantsByPlatform(result);

    expect(result.reasonByTenantId.get('a-lb')).toBe('anchor_name');
    expect(result.reasonByTenantId.get('a-callio')).toBe('anchor_name');
    expect(result.reasonByTenantId.get('a-sf')).toBe('anchor_name');
    expect(result.reasonByTenantId.get('a-hf')).toBe('anchor_name');

    expect(result.byTenantId.get('c-lb-1')).toBe('leadbridge');
    expect(result.reasonByTenantId.get('c-lb-1')).toBe('webhook_url:thumbtack-bridge');

    expect(result.byTenantId.get('c-lb-spotless')).toBe('leadbridge');
    // webhook_url wins over api_key_name in priority order
    expect(result.reasonByTenantId.get('c-lb-spotless')).toBe('webhook_url:thumbtack-bridge');

    expect(result.byTenantId.get('c-sf')).toBe('serviceflow');
    expect(result.reasonByTenantId.get('c-sf')).toBe('product_workspace:serviceflow');

    expect(result.byTenantId.get('c-callio')).toBe('callio');
    expect(result.reasonByTenantId.get('c-callio')).toBe('product_workspace:callio');

    expect(result.byTenantId.get('c-unknown')).toBe('unclassified');
    expect(result.byTenantId.get('c-sigcore')).toBe('unclassified');

    expect(grouped.leadbridge.sort()).toEqual(['a-lb', 'c-lb-1', 'c-lb-spotless'].sort());
    expect(grouped.serviceflow.sort()).toEqual(['a-sf', 'c-sf'].sort());
    expect(grouped.callio.sort()).toEqual(['a-callio', 'c-callio'].sort());
    expect(grouped.hirefunnel).toEqual(['a-hf']);
    expect(grouped.unclassified.sort()).toEqual(['c-sigcore', 'c-unknown'].sort());
  });
});

// ---------------------------------------------------------------------------
// 7. Defensive coverage
// ---------------------------------------------------------------------------
describe('attributePlatforms — defensive', () => {
  it('returns empty maps for an empty workspace', () => {
    const result = attributePlatforms([]);
    expect(result.byTenantId.size).toBe(0);
    expect(result.reasonByTenantId.size).toBe(0);
    expect(result.anchors).toEqual({
      leadbridge: null,
      hirefunnel: null,
      serviceflow: null,
      callio: null,
      unclassified: null,
    });
  });

  it('treats null/undefined/empty fields as no-signal without crashing', () => {
    const result = attributePlatforms([
      {
        id: 't1',
        name: null as any,
        productWorkspaceProductType: null,
        webhookUrls: undefined,
        apiKeyNames: [],
      },
    ]);
    expect(result.byTenantId.get('t1')).toBe('unclassified');
    expect(result.reasonByTenantId.get('t1')).toBe('unclassified');
  });
});

describe('tenantsByPlatform', () => {
  it('produces a complete keyset including unclassified', () => {
    const result = attributePlatforms([{ id: 't1', name: 'LeadBridge' }]);
    const grouped = tenantsByPlatform(result);
    expect(Object.keys(grouped).sort()).toEqual(
      ['callio', 'hirefunnel', 'leadbridge', 'serviceflow', 'unclassified'].sort(),
    );
  });
});

describe('PLATFORM_ANCHORS sanity', () => {
  it('uses lowercase trimmed comparable strings', () => {
    for (const v of Object.values(PLATFORM_ANCHORS)) {
      expect(v).toBe(v.toLowerCase());
      expect(v).toBe(v.trim());
    }
  });
});
