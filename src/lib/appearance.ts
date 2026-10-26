import type { CSSProperties } from 'react'
export type Palette = {
  background: string
  surface: string
  accent: string
  text: string
  bodyText: string
  muted: string
  line: string
  soft: string
  accentInk: string
  link: string
  cardLink: string
}
export type AppearanceState = {
  mode: string
  accent: string
  background: string | null
  surface: string | null
}
export interface Appearance {
  apply: (patch: Partial<AppearanceState>) => void
  get: () => AppearanceState
  colors: () => Palette
  palettes: Record<string, string[]>
  accents: string[]
}
declare global {
  interface Window {
    ThreadlyAppearance: Appearance
  }
}
export type Style = CSSProperties
