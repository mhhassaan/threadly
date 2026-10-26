import { useState } from 'react'
import type { ThreadRecord } from '../lib/thread'
export function ExportOptions({
  record,
  selected,
  onSelect,
  onExport,
  busy,
  onAppearance,
}: {
  record: ThreadRecord
  selected: Set<number>
  onSelect: (i: number) => void
  onExport: (indices: number[]) => void
  busy: boolean
  onAppearance: () => void
}) {
  const [scope, setScope] = useState('all')
  const [single, setSingle] = useState(0)
  const indices =
    scope === 'all'
      ? record.posts.map((_, i) => i)
      : scope === 'single'
        ? [single]
        : [...selected].sort((a, b) => a - b)
  return (
    <div className="image-export-options">
      <p className="dialog-description">
        Your colors, your words. Export a clean PNG without editing controls.
      </p>
      <fieldset className="export-scopes">
        <legend>What would you like to save?</legend>
        {[
          ['all', 'All tweets', record.posts.length],
          ['selected', 'Selected tweets', selected.size],
          ['single', 'One tweet', null],
        ].map(([value, label, count]) => (
          <label key={value}>
            <input
              type="radio"
              name="exportScope"
              value={String(value)}
              checked={scope === value}
              onChange={() => setScope(String(value))}
            />
            {label}
            {count !== null && <span>{count}</span>}
          </label>
        ))}
      </fieldset>
      <div className="export-checklist" hidden={scope !== 'selected'}>
        {record.posts.map((text, i) => (
          <label key={i}>
            <input
              type="checkbox"
              aria-label={'Include tweet ' + (i + 1) + ' in image'}
              checked={selected.has(i)}
              onChange={() => onSelect(i)}
            />
            <span>
              {i + 1}. {text.slice(0, 100)}
              {text.length > 100 ? '…' : ''}
            </span>
          </label>
        ))}
      </div>
      <label className="single-tweet-picker" hidden={scope !== 'single'}>
        Choose a tweet
        <select
          value={single}
          onChange={(e) => setSingle(Number(e.target.value))}
        >
          {record.posts.map((_, i) => (
            <option key={i} value={i}>
              Tweet {i + 1} of {record.posts.length}
            </option>
          ))}
        </select>
      </label>
      <div className="export-theme-preview">
        <span className="mini-avatar">≋</span>
        <div>
          <strong>Threadly</strong>
          <p>Exported in your current theme</p>
        </div>
        <button className="text-button" onClick={onAppearance}>
          Change appearance
        </button>
      </div>
      <p className="export-note">
        Long threads become numbered PNG pages in one ZIP. Original tweet
        numbers are preserved.
      </p>
      <button
        className="generate export-download"
        disabled={busy || !indices.length}
        aria-busy={busy}
        onClick={() => onExport(indices)}
      >
        {busy
          ? 'Creating image…'
          : `Download ${indices.length} tweet${indices.length === 1 ? '' : 's'} as PNG`}
      </button>
    </div>
  )
}
