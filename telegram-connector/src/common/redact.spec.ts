import { redact } from './redact';

describe('redact', () => {
  it('redacts botToken keys', () => {
    expect(redact({ botToken: 'abc' })).toEqual({ botToken: '[REDACTED]' });
  });

  it('redacts session and password fields recursively', () => {
    expect(redact({ a: { session: 'xx', nested: { password: 'p' } } })).toEqual({
      a: { session: '[REDACTED]', nested: { password: '[REDACTED]' } },
    });
  });

  it('redacts inline bot-token-shaped strings', () => {
    const url = 'https://api.telegram.org/bot7000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage';
    const out = redact(url) as string;
    expect(out).not.toContain('7000000000');
    expect(out).toContain('[REDACTED_BOT_TOKEN]');
  });

  it('leaves regular values alone', () => {
    expect(redact({ message: 'hello', count: 3 })).toEqual({ message: 'hello', count: 3 });
  });

  it('handles arrays', () => {
    expect(redact([{ token: 'x' }, { ok: true }])).toEqual([{ token: '[REDACTED]' }, { ok: true }]);
  });
});
