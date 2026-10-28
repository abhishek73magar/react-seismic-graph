import type { CSSProperties } from 'react'

/**
 * Toolbar / row / header styling. Three ways to change it:
 *  1. CSS variables (no props): .my-app { --rsg-active-bg: #16a34a; --rsg-btn-radius: 2px }
 *  2. fixed class names on every part (rsg-toolbar, rsg-btn, rsg-btn[aria-pressed="true"], ...) or the classNames prop
 *  3. unstyled: no built-in inline styles at all, style everything with your own classes (e.g. Tailwind)
 * --rsg-primary sets the active button and the canvas trace together. Canvas colours read --rsg-<key> / --rsg-dark-<key>
 * (e.g. --rsg-trace, --rsg-background, --rsg-dark-grid) or the `colors` prop, which wins.
 */
export type ClassNames = Partial<Record<Part, string>>
export type Part = 'root' | 'toolbar' | 'group' | 'label' | 'button' | 'buttonActive' | 'row' | 'empty' | 'station' | 'stationHeader'

const v = (name: string, fallback: string) => `var(--rsg-${name}, ${fallback})`
const font = v('font', 'system-ui, sans-serif')
const border = `1px solid ${v('border', '#e2e8f0')}`

export const STYLES: Record<Exclude<Part, 'buttonActive'>, CSSProperties> = {
  root: { color: v('text', 'inherit'), background: v('bg', 'transparent') },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: 8, borderBottom: border, fontSize: 12, fontFamily: font, background: v('toolbar-bg', 'transparent') },
  group: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  label: { marginRight: 4, fontWeight: 700 },
  button: {
    display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: v('btn-radius', '6px'), padding: '6px 8px', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: font,
    border: `1px solid ${v('btn-border', '#cbd5e1')}`, background: v('btn-bg', 'transparent'), color: v('btn-color', 'inherit'),
  },
  row: { padding: '6px 8px', borderBottom: border, background: v('row-bg', 'transparent') },
  empty: { padding: 16, color: v('muted', '#64748b'), fontSize: 13, fontFamily: font },
  station: { border, marginBottom: 12 },
  stationHeader: { padding: '8px 12px', background: v('header-bg', '#f1f5f9'), color: v('header-color', 'inherit'), fontWeight: 700, fontSize: 14, fontFamily: font },
}

const primary = v('primary', '#0284c7')
const ACTIVE: CSSProperties = { background: v('active-bg', primary), color: v('active-color', '#fff'), borderColor: v('active-border', v('active-bg', primary)) }

/** className + style for one part: fixed rsg-* class, the caller's class, built-in style unless unstyled */
export function part(name: Exclude<Part, 'buttonActive'>, classNames: ClassNames | undefined, unstyled: boolean, active = false) {
  const cls = [`rsg-${name}`, classNames?.[name], active && classNames?.buttonActive].filter(Boolean).join(' ')
  const style = unstyled ? undefined : active ? { ...STYLES[name], ...ACTIVE } : STYLES[name]
  return { className: cls, style }
}
