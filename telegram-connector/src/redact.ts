// Secret patterns that must never appear in logs. The set is intentionally
// narrow — broad redaction tends to mangle innocent text.
const TOKEN_PATTERNS: RegExp[] = [
  // Telegram bot token: "<digits>:<35-char alnum/-_>"
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
  // MTProto session strings (StringSession) are long base64-ish blobs — redact
  // anything >40 chars of urlsafe-base64 to be safe when paired with the right
  // label. Conservative to avoid false positives on innocuous IDs.
  /(session=)["']?[A-Za-z0-9_\-+/=]{40,}["']?/gi,
];

const SECRET_FIELDS = new Set([
  'botToken',
  'bot_token',
  'botTokenEncrypted',
  'gramjsSession',
  'gramjsSessionEncrypted',
  'session',
  'sessionString',
  'authPassword',
  'phoneCode',
  'password',
  'secret',
  'apiKey',
  'webhookKey',
  'x-api-key',
  'x-webhook-key',
  'x-telegram-bot-api-secret-token',
]);

export function redactString(input: string): string {
  let out = input;
  for (const p of TOKEN_PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}

export function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELDS.has(k) || SECRET_FIELDS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}
