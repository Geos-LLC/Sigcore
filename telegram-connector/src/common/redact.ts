const SECRET_KEYS = new Set([
  'botToken',
  'bot_token',
  'botTokenEncrypted',
  'gramjsSession',
  'gramjs_session',
  'gramjsSessionEncrypted',
  'session',
  'sessionString',
  'phoneCode',
  'phone_code',
  'password',
  'twoFactorPassword',
  'authPayload',
  'token',
  'apiKey',
  'api_key',
  'x-api-key',
  'x-telegram-bot-api-secret-token',
  'authorization',
]);

const BOT_TOKEN_RE = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;

export function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) || SECRET_KEYS.has(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

function redactString(s: string): string {
  return s.replace(BOT_TOKEN_RE, '[REDACTED_BOT_TOKEN]');
}
