import { memo, useState } from 'react';
import type { JsonValue } from './protocol';

// Scalars take the main page's code colours (CodeViewport's `tok-*`).

const MAX_ENTRIES = 200;

function Scalar({ value }: { value: JsonValue }) {
  if (value === null) return <span className="tok-keyword">null</span>;
  if (typeof value === 'string') return <span className="tok-string">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="tok-number">{value}</span>;
  if (typeof value === 'boolean') return <span className="tok-keyword">{String(value)}</span>;
  return null;
}

/** A collapsible JSON tree; objects open to `openDepth`. */
export const JsonView = memo(function JsonView({
  value,
  label,
  openDepth = 1,
  depth = 0,
}: {
  value: JsonValue | undefined;
  label?: string;
  openDepth?: number;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < openDepth);
  if (value === undefined) return <span className="muted">—</span>;
  const key = label !== undefined ? <span className="j-key">{label}: </span> : null;
  if (value === null || typeof value !== 'object') {
    return (
      <div className="j-row">
        {key}
        <Scalar value={value} />
      </div>
    );
  }
  const entries: [string, JsonValue][] = Array.isArray(value) ? value.map((entry, index) => [String(index), entry]) : Object.entries(value);
  const brackets = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0) {
    return (
      <div className="j-row">
        {key}
        <span className="j-punct">{brackets.join('')}</span>
      </div>
    );
  }
  return (
    <div className="j-row">
      <button type="button" className="j-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="j-caret">{open ? '▾' : '▸'}</span>
        {key}
        <span className="j-punct">{brackets[0]}</span>
        {!open && (
          <span className="j-summary">
            {entries.length} {Array.isArray(value) ? 'items' : 'keys'} {brackets[1]}
          </span>
        )}
      </button>
      {open && (
        <div className="j-children">
          {entries.slice(0, MAX_ENTRIES).map(([name, entry]) => (
            <JsonView key={name} value={entry} label={Array.isArray(value) ? undefined : name} openDepth={openDepth} depth={depth + 1} />
          ))}
          {entries.length > MAX_ENTRIES && <div className="j-more">… {entries.length - MAX_ENTRIES} more</div>}
          <span className="j-punct">{brackets[1]}</span>
        </div>
      )}
    </div>
  );
});
