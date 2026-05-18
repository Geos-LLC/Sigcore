import { redact, safeStringify } from './redact';

describe('redact', () => {
  it('removes obvious bot-token-shaped strings', () => {
    const out = redact('Calling https://api.telegram.org/bot1234567:ABCDEFGHIJKLMNOPQRSTUVWXYZ_-abcdef/sendMessage');
    expect(out).toContain('[REDACTED_BOT_TOKEN]');
    expect(out).not.toContain('1234567:ABCDEFGHIJKLMNOPQRSTUVWXYZ_-abcdef');
  });

  it('redacts known secret keys in objects', () => {
    const out = redact({ botToken: 'abc', password: 'p', other: 'fine' }) as Record<string, unknown>;
    expect(out.botToken).toBe('[REDACTED:3]');
    expect(out.password).toBe('[REDACTED:1]');
    expect(out.other).toBe('fine');
  });

  it('walks nested structures', () => {
    const out = redact({
      a: { gramjsSession: 'long-session-string', items: [{ token: 't' }] },
    }) as any;
    expect(out.a.gramjsSession).toBe('[REDACTED:19]');
    expect(out.a.items[0].token).toBe('[REDACTED:1]');
  });

  it('safeStringify returns redacted JSON', () => {
    const json = safeStringify({ botToken: 'x' });
    expect(json).toContain('REDACTED');
    expect(json).not.toContain('"x"');
  });

  it('handles null / non-objects', () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
  });
});
