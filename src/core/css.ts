import type { ThemeName } from './types'

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
const VAR = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/s

/**
 * Canvas palette from CSS custom properties on (or inherited by) `el`, e.g. :root { --rsg-trace: #16a34a }.
 * Per key: colors option > --rsg-dark-<key> (dark theme only) > --rsg-<key> > --rsg-[dark-]primary (primaryKeys) > default.
 * Any value may itself be 'var(--brand, #0284c7)'. Non-string keys (arrays) only take the override.
 */
export function resolveColors<T extends object>(el: Element | null | undefined, theme: ThemeName, defaults: T, overrides: Partial<T> = {}, primaryKeys: readonly string[] = []): T {
    const css = el && typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
    const read = (name: string) => css?.getPropertyValue?.(name)?.trim() || ''
    const themed = (name: string) => (theme === 'dark' && read(`--rsg-dark-${name}`)) || read(`--rsg-${name}`)
    const resolve = (value: string): string => {
        const m = VAR.exec(value.trim())
        if (!m) return value
        return read(m[1]) || (m[2] ? resolve(m[2]) : '')
    }
    const primary = themed('primary')
    const out = { ...defaults } as Record<string, unknown>
    const given = overrides as Record<string, unknown>
    for (const [key, fallback] of Object.entries(defaults)) {
        if (typeof fallback !== 'string') { if (given[key] !== undefined) out[key] = given[key]; continue }
        const value = (given[key] as string | undefined) ?? (themed(kebab(key)) || (primaryKeys.includes(key) && primary) || fallback)
        out[key] = resolve(value) || fallback
    }
    return out as T
}
