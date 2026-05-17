import { redact, redactString } from './redact';

describe('redactString', () => {
  it('redacts telegram bot tokens in free text', () => {
    const out = redactString('error: token 1234567890:AAA1BBB2CCC3DDD4EEE5FFF6GGG7HHH8III99 failed');
    expect(out).not.toContain('1234567890:AAA1BBB2CCC3DDD4EEE5FFF6GGG7HHH8III99');
    expect(out).toContain('[REDACTED]');
  });

  it('does not mangle short colon-separated ids', () => {
    expect(redactString('chatId=123:456 msg=hi')).toBe('chatId=123:456 msg=hi');
  });
});

describe('redact (object walker)', () => {
  it('replaces values for known secret keys', () => {
    const out = redact({
      botToken: '1234567890:AAAA',
      gramjsSession: 'long-session-blob',
      apiKey: 'k',
      keep: 'me',
    }) as Record<string, unknown>;
    expect(out.botToken).toBe('[REDACTED]');
    expect(out.gramjsSession).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.keep).toBe('me');
  });

  it('recurses into nested objects', () => {
    const out = redact({ outer: { botToken: 'x', text: 'hi' } }) as Record<string, any>;
    expect(out.outer.botToken).toBe('[REDACTED]');
    expect(out.outer.text).toBe('hi');
  });

  it('redacts phone codes and auth passwords for MTProto flows', () => {
    const out = redact({
      phoneCode: '12345',
      authPassword: 'hunter2',
    }) as Record<string, unknown>;
    expect(out.phoneCode).toBe('[REDACTED]');
    expect(out.authPassword).toBe('[REDACTED]');
  });

  it('redacts the x-telegram-bot-api-secret-token header value', () => {
    const out = redact({ 'x-telegram-bot-api-secret-token': 'shh' }) as Record<string, unknown>;
    expect(out['x-telegram-bot-api-secret-token']).toBe('[REDACTED]');
  });
});
