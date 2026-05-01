/**
 * Color-coded source badge. Source values come from
 * communication_profiles.source — see source-classifier.ts for the lexicon.
 */
const SOURCE_COLORS: Record<string, string> = {
  leadbridge: 'bg-orange-50 text-orange-700 border-orange-200',
  hirefunnel: 'bg-purple-50 text-purple-700 border-purple-200',
  serviceflow: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  callio: 'bg-pink-50 text-pink-700 border-pink-200',
  thumbtack: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  yelp: 'bg-rose-50 text-rose-700 border-rose-200',
  facebook: 'bg-blue-50 text-blue-700 border-blue-200',
  craigslist: 'bg-amber-50 text-amber-700 border-amber-200',
  indeed: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  manual: 'bg-gray-100 text-gray-700 border-gray-200',
  internal: 'bg-gray-100 text-gray-500 border-gray-200',
};

export function SourceBadge({ source }: { source: string | null | undefined }) {
  const v = (source || 'internal').toLowerCase();
  const cls = SOURCE_COLORS[v] || 'bg-gray-100 text-gray-600 border-gray-200';
  return (
    <span
      className={`inline-block px-2 py-0.5 text-[10px] rounded-full font-mono border ${cls}`}
      title={`source: ${v}`}
    >
      {v}
    </span>
  );
}
