/**
 * Pure helpers used by the BackfillBusinessesProfilesAssignments migration.
 *
 * Frozen here so the migration's classification stays deterministic over
 * time even if the equivalent admin-side helper (platform-attribution.ts)
 * evolves. Tested independently in source-classifier.spec.ts.
 *
 * Locked decisions for source classification (PR1):
 *   anchor 'LeadBridge'    → 'leadbridge'
 *   anchor 'Service Flow'  → 'serviceflow'   (NOT 'internal')
 *   anchor 'Callio'        → 'callio'        (NOT 'internal')
 *   anchor 'HireFunnel'    → 'hirefunnel'    (NOT 'internal')
 *   webhook URL pattern    → matching platform
 *   api_key.name pattern   → matching platform
 *   no signal              → 'internal'
 */

export type ProfileSourceValue =
  | 'leadbridge'
  | 'hirefunnel'
  | 'serviceflow'
  | 'callio'
  | 'thumbtack'
  | 'yelp'
  | 'facebook'
  | 'craigslist'
  | 'indeed'
  | 'manual'
  | 'internal';

/** Exact-match anchor names (case-insensitive, trimmed). */
const ANCHOR_NAMES: Record<string, ProfileSourceValue> = {
  'leadbridge': 'leadbridge',
  'service flow': 'serviceflow',
  'serviceflow': 'serviceflow',
  'callio': 'callio',
  'hirefunnel': 'hirefunnel',
};

/**
 * Hostname patterns in webhook URLs. Iterated in declaration order so
 * conflicting webhooks pick a deterministic answer.
 */
const WEBHOOK_PATTERNS: Array<{ pattern: RegExp; source: ProfileSourceValue }> = [
  { pattern: /thumbtack-bridge/i,    source: 'leadbridge'  },
  { pattern: /leadbridge360/i,        source: 'leadbridge'  },
  { pattern: /service-flow-backend/i, source: 'serviceflow' },
  { pattern: /callio-production/i,    source: 'callio'      },
  { pattern: /hirefunnel/i,           source: 'hirefunnel'  },
  { pattern: /hiringflow/i,           source: 'hirefunnel'  },
];

/** Lowest-priority signal — api_key name patterns. */
const API_KEY_PATTERNS: Array<{ pattern: RegExp; source: ProfileSourceValue }> = [
  { pattern: /lead\s*bridge/i,  source: 'leadbridge'  },
  { pattern: /service\s*flow/i, source: 'serviceflow' },
  { pattern: /hire\s*funnel/i,  source: 'hirefunnel'  },
  { pattern: /hiring\s*flow/i,  source: 'hirefunnel'  },
  { pattern: /callio/i,          source: 'callio'     },
];

/**
 * Classify a tenant into one of the known sources, falling through to
 * 'internal' when no signal matches. Pure — no I/O.
 */
export function classifyTenantSource(
  name: string | null | undefined,
  webhookUrls: string[],
  apiKeyNames: string[],
): ProfileSourceValue {
  // Rule 1 — anchor name
  const normalized = (name ?? '').trim().toLowerCase();
  if (ANCHOR_NAMES[normalized]) return ANCHOR_NAMES[normalized];

  // Rule 2 — webhook URL hostname
  for (const { pattern, source } of WEBHOOK_PATTERNS) {
    if (webhookUrls.some((u) => u && pattern.test(u))) return source;
  }

  // Rule 3 — api_key name
  for (const { pattern, source } of API_KEY_PATTERNS) {
    if (apiKeyNames.some((n) => n && pattern.test(n))) return source;
  }

  // Rule 4 — fallthrough
  return 'internal';
}

/**
 * Build a deterministic slug from a name with an 8-char id suffix.
 * Empty / unsluggable names fall back to "workspace-<id8>".
 *
 * Examples:
 *   ("Spotless Homes Tampa", "63bcdb33-…")  → "spotless-homes-tampa-63bcdb33"
 *   ("ABC Solutions - Always Best Cleaning", "20013407-…") → "abc-solutions-always-best-cleaning-20013407"
 *   ("",                    "abc12345-…")  → "workspace-abc12345"
 */
export function makeSlug(name: string | null | undefined, id: string): string {
  const idSuffix = (id || '').slice(0, 8);
  const trimmed = (name ?? '').trim();
  if (!trimmed) {
    return `workspace-${idSuffix || 'unknown'}`;
  }
  const cleaned = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned ? `${cleaned}-${idSuffix}` : `workspace-${idSuffix || 'unknown'}`;
}
