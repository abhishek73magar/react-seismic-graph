import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { HelicorderWidget, type ChunkSource, type HelicorderOptions } from '../core/HelicorderWidget'
import { toMs } from '../core/time'
import { stationIdOf } from '../core/seismogram'
import { mseedBytesOf, streamMseed, type MseedInput } from '../mseed'
import { DownloadButton } from './icons'
import { part } from './styles'
import type { PWave, Samples, StreamData, ThemeName } from '../core/types'


interface Channel {
  channel_code: string
  unit: string
  gain: number
  azimuth: number
  dip: number
  depth: number
}

export interface HelicorderProps {
  /** start of the first line; default: data start floored to a whole line, else today 00:00 UTC */
  startTime?: number | string | Date
  /** default: enough lines for the data (grows while streaming), else 24 */
  numLines?: number
  /** miniSEED v2/v3 bytes, File/Blob or URL; streamed in and plotted as records arrive */
  mseed?: MseedInput | null
  /**
   * any chunk source (paged history, socket replay, streamMseed ...): each chunk is plotted at its own time.
   * Prefer a factory (() => source): an async iterator can be read only once, a factory survives remounts
   */
  stream?: ChunkSource | (() => ChunkSource) | null
  /** channel to take from `mseed` / `stream` (default: the first seen) */
  channelCode?: string
  lineDurationSec?: number
  samples?: Samples
  sampleRate?: number
  /** time of samples[0]; default: startTime */
  dataStartTime?: number | string | Date
  height?: number
  theme?: ThemeName
  colors?: HelicorderOptions['colors']
  timeMode?: string
  gain?: number
  clip?: boolean
  /** default from miniSEED metadata, e.g. 'NP.KTM.00.HHZ' */
  title?: string
  pWaves?: PWave[]
  onClick?: (ms: number) => void
  /** show a download button: saves NET.STA.LOC.CHA.mseed (original records for miniSEED input) */
  downloadable?: boolean
  /** widget handle for live data: widget.addSamples(samples, startTime) */
  onReady?: (widget: HelicorderWidget) => void | (() => void)
  className?: string
  style?: CSSProperties
  /** shown as a channel picker in the toolbar; the active one is found by matching `channelCode` against `channel_code` */
  channels?: Channel[]
  /** fired when a channel button is clicked; receives the full matching entry from `channels` (looked up by channel_code) */
  onChannelChange?: (channel: Channel) => void
  /** shows a date picker in the toolbar when set; fired with the picked day as UTC midnight ms */
  onDateChange?: (ms: string) => void
}

type Load = { total: number; done: boolean; error: string | null; first: StreamData | null; download: StreamData | null }

/** canvas helicorder: the day (or any range) folded into lines; static samples, or chunks streamed in */
export function Helicorder({
  startTime: startProp, 
  numLines: linesProp, 
  lineDurationSec = 3600, 
  mseed, 
  stream, 
  channelCode, 
  samples, 
  sampleRate = 100,
  dataStartTime, 
  height, 
  theme = 'white', 
  colors, 
  timeMode = 'local', 
  gain = 1, 
  clip = true, 
  title: titleProp,
  channels,
  onChannelChange,
  onDateChange,
  pWaves, onClick, downloadable = false, onReady, className, style,
}: HelicorderProps) {
  const streaming = !!(stream || mseed)
  // static samples: range from the data when the caller gives none (streaming sets it from the first chunk)
  const lineMs = lineDurationSec * 1000
  const dataStartMs = dataStartTime == null ? undefined : toMs(dataStartTime)
  const startTime = startProp ?? (!streaming && dataStartMs !== undefined ? Math.floor(dataStartMs / lineMs) * lineMs : undefined)
  const startMs = startTime == null ? undefined : toMs(startTime)
  const numLines = linesProp ?? (!streaming && dataStartMs !== undefined && samples?.length && startMs !== undefined
    ? Math.max(1, Math.ceil((dataStartMs + (samples.length / sampleRate) * 1000 - startMs) / lineMs))
    : 24)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [widget, setWidget] = useState<HelicorderWidget | null>(null)
  const [load, setLoad] = useState<Load | null>(null)
  const clickRef = useRef(onClick)
  useEffect(() => { clickRef.current = onClick })
  const initial = useRef({ theme, colors, timeMode, gain, clip, height })

  useEffect(() => {
    if(!canvasRef.current) return
    const w = new HelicorderWidget(canvasRef.current, { ...initial.current, startTime: startMs, numLines, lineDurationSec, sampleRate, onClick: (ms) => clickRef.current?.(ms) })
    setWidget(w)
    return () => { w.destroy(); setWidget(null) }
  }, [startMs, numLines, lineDurationSec, sampleRate])

  const first = load?.first
  const title = titleProp ?? (first ? `${stationIdOf(first)}.${first.channel}` : '')
  useEffect(() => { widget?.setTheme(theme) }, [widget, theme])
  useEffect(() => { widget?.setTimeMode(timeMode) }, [widget, timeMode])
  useEffect(() => { widget?.setGain(gain) }, [widget, gain])
  useEffect(() => { widget?.setClip(clip) }, [widget, clip])
  useEffect(() => { widget?.setTitle(title) }, [widget, title])
  useEffect(() => { widget?.setHeight(height) }, [widget, height])
  useEffect(() => { widget?.setPWaves(pWaves || []) }, [widget, pWaves])
  useEffect(() => {
    if(widget && samples && !streaming) widget.setData(samples, sampleRate, dataStartMs ?? widget.startMs)
  }, [widget, samples, sampleRate, dataStartMs, streaming])

  // streaming: plot chunks as they arrive, progress throttled to one React update per frame
  useEffect(() => {
    if(!widget || !(stream || mseed)) return
    const ctrl = new AbortController()
    const chunks: StreamData[] = []
    let state: Load = { total: 0, done: false, error: null, first: null, download: null }
    let raf = 0
    const publish = (next: Partial<Load>) => {
      state = { ...state, ...next }
      if(!raf) raf = requestAnimationFrame(() => { raf = 0; setLoad(state) })
    }
    setLoad(state)
    const source = typeof stream === 'function' ? stream() : stream ?? streamMseed(mseed!, { signal: ctrl.signal })
    widget.consume(source, {
      channel: channelCode, autoStart: startProp == null, autoGrow: linesProp == null, signal: ctrl.signal,
      onChunk: (chunk, total) => { chunks.push(chunk); publish({ total, first: state.first ?? chunk }) },
    }).then(
      () => {
        if(ctrl.signal.aborted) return
        // one file for the whole channel: the received records (or samples written as miniSEED 3), in order
        const parts = chunks.map(c => new Uint8Array(mseedBytesOf(c)))
        const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
        parts.reduce((at, p) => { bytes.set(p, at); return at + p.byteLength }, 0)
        publish({ done: true, download: state.first && { ...state.first, samples: [], mseedBytes: bytes.buffer } })
      },
      (e: unknown) => { if(!ctrl.signal.aborted) publish({ done: true, error: e instanceof Error ? e.message : String(e) }) },
    )
    return () => { ctrl.abort(); cancelAnimationFrame(raf) }
    // startProp / linesProp are read once per load: changing them rebuilds the widget, which restarts this
  }, [widget, stream, mseed, channelCode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if(widget) return onReady?.(widget) || undefined }, [widget, onReady])

  const download: StreamData[] = streaming ? (load?.download ? [load.download] : [])
    : samples?.length ? [{ channel: channelCode || 'XXX', samples, sampleRate, startTime: dataStartMs ?? (startMs ?? Date.now()) }]
    : []
  const status = load?.error ? `Error: ${load.error}`
    : load && !load.done ? `Loading… ${load.total.toLocaleString()} samples`
    : null

  // channel buttons: active one found by matching channelCode against each entry's channel_code
  const pickChannel = (code: string) => {
    const match = channels?.find(c => c.channel_code === code)
    if(match) onChannelChange?.(match)
  }

  // yyyy-mm-dd (UTC) for <input type="date">; onDateChange gets that day's UTC midnight back
  const dateValue = startMs !== undefined ? new Date(startMs).toISOString().slice(0, 10) : ''
  const handleDateChange = (value: string) => {
    if(!value) return
    onDateChange?.(value)
  }

  return (
    <div className={className} style={style}>
      {(channels?.length || onDateChange || downloadable || status) && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          fontFamily: 'system-ui, sans-serif',
          padding: '4px 8px',
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
            {!!channels?.length && (
              <>
                <span style={{ fontWeight: 'bold', marginRight: 4 }}>Channels:</span>
                {channels.map(c => {
                  const active = c.channel_code === channelCode
                  const { className: btnClass, style: btnStyle } = part('button', undefined, false, active)
                  return (
                    <button type='button' key={c.channel_code} className={btnClass} style={btnStyle} data-channel={c.channel_code}
                      aria-pressed={active} onClick={() => pickChannel(c.channel_code)}>
                      {c.channel_code}
                    </button>
                  )
                })}
              </>
            )}
            {onDateChange && (
              <div style={{ paddingInline: "4px" }}>
              <input 
                type='date' 
                value={dateValue} 
                onChange={e => handleDateChange(e.target.value)} 
                aria-label='Select date'
                style={part('button', undefined, false).style} 
              />
              (UTC)
              </div>
            )}
            
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              gap: 8,
              color: load?.error ? '#dc2626' : '#64748b',
            }}
          >
            {status && <span role='status'>{status}</span>}
            {downloadable && <DownloadButton streams={download} fallbackId={title || undefined} />}
          </div>
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%' }} />
    </div>
  )
}
