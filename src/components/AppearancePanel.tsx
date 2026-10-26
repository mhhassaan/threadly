import { useState } from 'react'
import type { AppearanceState } from '../lib/appearance'
export function AppearancePanel({ onClose }: { onClose: () => void }) {
  const appearance = window.ThreadlyAppearance
  const [state, setState] = useState(appearance.get())
  const colors = appearance.colors()
  const apply = (patch: Partial<AppearanceState>) => {
    appearance.apply(patch)
    setState(appearance.get())
  }
  return (
    <div className="appearance-controls">
      <p className="dialog-description">
        Choose your background and color palette. Changes apply to both windows
        and image exports.
      </p>
      <fieldset className="theme-fieldset">
        <legend>Background</legend>
        <div className="theme-presets">
          {Object.entries(appearance.palettes).map(([mode, palette]) => (
            <button
              key={mode}
              className="theme-preset"
              type="button"
              data-mode={mode}
              aria-pressed={
                state.mode === mode && !state.background && !state.surface
              }
              onClick={() => apply({ mode, background: null, surface: null })}
            >
              <span style={{ background: palette[0], borderColor: palette[1] }}>
                <i
                  style={{
                    background:
                      palette[1] === '#ffffff' ? '#bdc8c0' : '#657381',
                  }}
                />
                <i
                  style={{
                    background:
                      palette[1] === '#ffffff' ? '#bdc8c0' : '#657381',
                  }}
                />
              </span>
              <strong>{mode[0].toUpperCase() + mode.slice(1)}</strong>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="theme-fieldset">
        <legend>Accent color</legend>
        <div className="accent-presets">
          {appearance.accents.map((color, i) => (
            <button
              key={color}
              className="accent-swatch"
              style={{ background: color, color: '#fff' }}
              aria-label={
                ['Blue', 'Green', 'Purple', 'Orange', 'Pink', 'Gold'][i] +
                ' accent'
              }
              aria-pressed={state.accent === color}
              onClick={() => apply({ accent: color })}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="theme-fieldset">
        <legend>Your own tones</legend>
        <div className="custom-tones">
          {(['background', 'surface', 'accent'] as const).map((key, i) => (
            <label key={key}>
              {['Page', 'Cards', 'Accent'][i]}
              <input
                type="color"
                name={key}
                value={colors[key]}
                onChange={(e) => apply({ [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="theme-preview">
        <span className="mini-avatar">≋</span>
        <div>
          <strong>A little easier on the eyes.</strong>
          <p>Your theme follows you into every thread.</p>
        </div>
      </div>
      <div className="appearance-footer">
        <button
          className="secondary"
          onClick={() =>
            apply({
              mode: 'paper',
              accent: '#256647',
              background: null,
              surface: null,
            })
          }
        >
          Reset to Paper
        </button>
        <button className="copy-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
