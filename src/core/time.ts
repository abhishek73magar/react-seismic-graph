const formatters = new Map<string, Intl.DateTimeFormat>()

/** 'local' -> browser timezone, anything else is an IANA name ('UTC', 'Asia/Kathmandu') */
export const resolveTimeZone = (tz?: string) => !tz || tz === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : tz

/** HH:mm:ss (or HH:mm) of a UTC ms timestamp in a timezone; formatters cached, this runs every frame */
export function formatTime(ms: number, tz?: string, seconds = true) {
  const zone = resolveTimeZone(tz)
  const key = `${zone}|${seconds}`
  let f = formatters.get(key)
  if(!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined, hourCycle: 'h23' })
    formatters.set(key, f)
  }
  return f.format(ms)
}

export const toMs = (t: number | string | Date | undefined | null) => t == null ? NaN : typeof t === 'number' ? t : new Date(t).valueOf()
