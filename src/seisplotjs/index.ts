/**
 * Thin helpers around seisplotjs' own web components (<sp-helicorder>, <sp-seismograph>).
 * Importing this entry imports seisplotjs, which registers those custom elements.
 */
import * as sp from 'seisplotjs'
import { toMs } from '../core/time'
import type { PWave, StreamData } from '../core/types'

type Seismogram = sp.seismogram.Seismogram
type SDD = sp.seismogram.SeismogramDisplayData
export type SeismogramInput = Seismogram | Seismogram[] | StreamData | StreamData[]

const iso = (ms: number) => sp.util.isoToDateTime(new Date(ms).toISOString())

/** plain samples -> seisplotjs Seismogram */
export const toSeismogram = (s: StreamData): Seismogram =>
  sp.seismogram.Seismogram.fromContiguousData(Float32Array.from(s.samples), s.sampleRate, iso(toMs(s.startTime)),
    s.network || s.station ? sp.fdsnsourceid.FDSNSourceId.fromNslc(s.network || 'XX', s.station || 'XXXX', s.location || '', s.channel) : undefined)

const isStreamData = (v: unknown): v is StreamData => !!v && typeof v === 'object' && 'samples' in v

const toDisplayData = (input: SeismogramInput): SDD[] =>
  (Array.isArray(input) ? input : [input]).map(v => sp.seismogram.SeismogramDisplayData.fromSeismogram(isStreamData(v) ? toSeismogram(v) : v))

/** marker per P-wave / earthquake */
export const addPWaveMarkers = (seis: SDD, pWaves: PWave[]) => {
  pWaves.forEach((p) => {
    const datetime = p.datetime.split('.')[0]
    const type = p.type || 'P Wave'
    const description = type.toLowerCase() === 'earthquake'
      ? `Magnitude: ${p.magnitude} (${datetime})`
      : `amplitude: ${p.amplitude} (${datetime})`
    seis.addMarkers({ name: p.name || 'P', time: sp.util.isoToDateTime(new Date(Date.parse(p.datetime)).toISOString()), markertype: type, description })
  })
}

export interface SpSeismographOptions {
  pWaves?: PWave[]
  channel?: string
  unit?: string
  lineColors?: string[]
  wheelZoom?: boolean
  /** tweak anything else on the config before it is applied */
  configure?: (config: sp.seismographconfig.SeismographConfig) => void
}

/** fill an <sp-seismograph> element with one or more seismograms */
export function renderSpSeismograph(el: sp.seismograph.Seismograph, data: SeismogramInput, opts: SpSeismographOptions = {}) {
  const seisData = toDisplayData(data)
  if(opts.pWaves?.length) seisData.forEach(s => addPWaveMarkers(s, opts.pWaves!))
  const config = new sp.seismographconfig.SeismographConfig()
  config.showTitle = false
  config.ySublabelIsUnits = false
  config.wheelZoom = opts.wheelZoom ?? true
  config.xLabel = 'Time'
  if(opts.channel) config.xSublabel = opts.channel
  config.lineColors = opts.lineColors ?? ['skyblue', '#1B1212']
  config.ySublabel = opts.unit || 'μm/s'
  opts.configure?.(config)
  el.seismographConfig = config
  el.seisData = seisData
  return el
}

export interface SpHelicorderOptions {
  /** default: data start, floored to a whole line */
  start?: number | string | Date
  /** default: data end */
  end?: number | string | Date
  /** length of one line; default 3600 (1 h). 60 = one line per minute */
  lineDurationSec?: number
  pWaves?: PWave[]
  /** 'UTC' | 'Local' | IANA zone for the line labels */
  timeZone?: string
  lineColors?: string[]
  /** click on a line: UTC ms of the clicked time */
  onClick?: (ms: number) => void
  configure?: (config: sp.helicorder.HelicorderConfig) => void
}

/** fill an <sp-helicorder> element; one line per lineDurationSec (default 1 h) of start..end. Returns a cleanup for the click listener */
export function renderSpHelicorder(el: sp.helicorder.Helicorder, data: SeismogramInput, opts: SpHelicorderOptions) {
  const seisData = toDisplayData(data)
  const lineMs = (opts.lineDurationSec || 3600) * 1000
  const start = opts.start != null ? toMs(opts.start) : Math.floor(Math.min(...seisData.map(s => s.startTime.valueOf())) / lineMs) * lineMs
  const end = opts.end != null ? toMs(opts.end) : Math.max(...seisData.map(s => s.endTime.valueOf()))
  if(opts.pWaves?.length) seisData.forEach(s => addPWaveMarkers(s, opts.pWaves!))
  el.seisData = seisData

  // seisplotjs splits the range evenly over numLines: round the end up so every line is exactly lineDurationSec
  const numLines = Math.max(1, Math.ceil((end - start) / lineMs))
  const config = new sp.helicorder.HelicorderConfig(sp.util.startEnd(iso(start), iso(start + numLines * lineMs)))
  config.numLines = numLines
  config.lineColors = opts.lineColors ?? ['skyblue', '#1B1212']
  config.title = ''
  config.xLabel = 'Time'
  config.ySublabelIsUnits = true
  config.maxHeight = Math.max(300, 800 + ((numLines - 12) * 20))
  config.isXAxisTop = false
  config.markerFlagpoleBase = 'center'
  config.yLabelTimeZone = opts.timeZone ?? 'UTC'
  config.yLabelRightTimeZone = opts.timeZone ?? 'UTC'
  opts.configure?.(config)
  el.heliConfig = config

  if(!opts.onClick) return () => {}
  const onClick = (e: Event) => opts.onClick!((e as CustomEvent<{ time: { valueOf(): number } }>).detail.time.valueOf())
  el.addEventListener('heliclick', onClick)
  return () => el.removeEventListener('heliclick', onClick)
}

export { parseMseed, loadMseed, streamMseed, streamsToMseed3, downloadMseed, mseedFileName, mseedBytesOf } from './mseed'
export type { MseedInput } from './mseed'
export { sp }
