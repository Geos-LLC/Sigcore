import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

/**
 * Inline ID chip with copy-to-clipboard. Truncates the displayed text to
 * the first 8 chars but copies the full UUID. Reusable across the admin
 * pages where every row exposes one or more IDs.
 */
export function IdChip({
  label,
  value,
  className = '',
  short = true,
}: {
  label?: string;
  value: string | null | undefined;
  className?: string;
  short?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) {
    return (
      <span className={`text-xs text-gray-400 ${className}`}>
        {label ? `${label}: ` : ''}—
      </span>
    );
  }
  const display = short && value.length > 12 ? value.slice(0, 8) + '…' : value;
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-mono ${className}`}
      title={value}
    >
      {label && <span className="text-gray-400">{label}:</span>}
      <span className="text-gray-700">{display}</span>
      <button
        onClick={onCopy}
        className={`p-0.5 rounded hover:bg-gray-100 ${copied ? 'text-green-600' : 'text-gray-400'}`}
        title="Copy"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}
