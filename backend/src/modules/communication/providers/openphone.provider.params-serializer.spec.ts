import axios from 'axios';

/**
 * Contract test — OpenPhone's OpenAPI schema parser reads
 * `?participants[]=X` as a different field than `participants`, so a
 * request built with axios 1.x's default array serializer is rejected
 * with `400 "/participants: Expected required property"` and every
 * message-sync attempt fails. The provider's createClient sets
 * `paramsSerializer: { indexes: null }` to produce the repeat form Quo
 * expects. This test byte-pins that behavior so a future axios upgrade
 * or config edit that flips it back gets caught at CI time.
 */
describe('OpenPhone axios client — array params serialization', () => {
  const buildUri = (paramsSerializer: unknown, params: Record<string, unknown>) => {
    const client = axios.create({
      baseURL: 'https://api.openphone.com/v1',
      paramsSerializer: paramsSerializer as any,
    });
    return client.getUri({ url: '/messages', params });
  };

  it('serializes array params in the repeat form (?k=v1&k=v2), not bracketed (?k[]=v)', () => {
    const uri = buildUri({ indexes: null }, {
      phoneNumberId: 'PN123',
      participants: ['+19045372162'],
      maxResults: 100,
    });

    // Repeat form — what OpenPhone expects
    expect(uri).toContain('participants=%2B19045372162');
    // Bracketed form — what axios defaults to and OpenPhone rejects
    expect(uri).not.toContain('participants%5B%5D=');
    expect(uri).not.toContain('participants[]=');
  });

  it('preserves the repeat form for multiple participant values', () => {
    const uri = buildUri({ indexes: null }, {
      phoneNumberId: 'PN123',
      participants: ['+19045372162', '+18139212100'],
    });

    // Both values as separate participants=... pairs
    expect(uri).toMatch(/participants=%2B19045372162.*participants=%2B18139212100/);
    expect(uri).not.toContain('participants%5B');
  });

  it('proves the default (no paramsSerializer) produces the broken shape — negative control', () => {
    const uri = buildUri(undefined, {
      phoneNumberId: 'PN123',
      participants: ['+19045372162'],
    });

    // Documents WHY the paramsSerializer is required. If axios ever
    // changes its default to repeat-form, this assertion flips and the
    // paramsSerializer becomes redundant — worth revisiting at that point.
    expect(uri).toContain('participants%5B%5D=%2B19045372162');
  });
});
