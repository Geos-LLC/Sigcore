const SECRET_KEYS = new Set([
  'bottoken',
  'bot_token',
  'token',
  'gramjssession',
  'gramjs_session',
  'session',
  'sessionstring',
  'authorization',
  'auth',
  'password',
  'phonecode',
  'phone_code',
  'twofa',
  'two_fa',
  'twofapassword',
  'secret',
  'webhook_secret',
  'x-api-key',
  'x-telegram-bot-api-secret-token',
]);

const BOT_TOKEN_PATTERN = /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g;

export function redact(input: unknown): unknown {
  if (input == null) return input;

  if (typeof input === 'string') return redactString(input);

  if (Array.isArray(input)) return input.map(redact);

  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k.toLowerCase())) {
        out[k] = typeof v === 'string' && v.length > 0 ? `[REDACTED:${v.length}]` : '[REDACTED]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }

  return input;
}

function redactString(s: string): string {
  return s.replace(BOT_TOKEN_PATTERN, '[REDACTED_BOT_TOKEN]');
}

export function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(redact(input));
  } catch {
    return '[unserializable]';
  }
}
