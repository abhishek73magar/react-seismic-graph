import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { RaspTraceWidget, type RaspTraceWidgetOptions, type TraceFlag } from '../core/SpectrogramWidget'
import { toMs } from '../core/time'
import { stationIdOf } from '../core/seismogram'
import type { MseedInput } from '../seisplotjs/mseed'
import { useMseed } from './useMseed'
import { DownloadButton } from './icons'
import type { PWave, Samples, StreamData, ThemeName, ViewMode, YMode } from '../core/types'

export interface SeismicGraphProps {
  /** shown while there is no data, e.g. 'NP.KTM.00.HHZ'; default from miniSEED metadata */
  stationId?: string
  /** also picks the channel out of `mseed` (default: its first channel) */
  channelCode?: string
  /** miniSEED v2/v3 bytes, File/Blob or URL; replaces samples / sampleRate / endTime */
  mseed?: MseedInput | null
  unit?: string
  /** samples to show; re-hydrates whenever the array identity changes (memoize it) */
  samples?: Samples
  sampleRate?: number
  /** UTC time the time axis ends at; default: end of samples / now */
  endTime?: number | string | Date
  /** when this channel's data ends before endTime (late packet): span left empty */
  dataEndTime?: number | string | Date
  displayHeight?: number
  viewMode?: ViewMode
  /** visible seconds; default: the whole data (120 s without data) */
  timeWindowSec?: number
  onTimeWindowChange?: (sec: number | null) => void
  onPanChange?: (sec: number) => void
  panOffsetSec?: number // controlled pan (linked channels); undefined = widget pans on its own
  sensitivityPreset?: 'normal' | 'high' | 'low'
  timeMode?: string // 'local' | IANA timezone
  theme?: ThemeName
  colors?: RaspTraceWidgetOptions['colors']
  fonts?: RaspTraceWidgetOptions['fonts']
  /** called with the widget whenever it (re)builds: use it for live data (widget.addSamples) */
  onReady?: (widget: RaspTraceWidget) => void | (() => void)
  pWaves?: PWave[]
  flags?: TraceFlag[]
  onFlagAdd?: (t: number) => void
  onFlagMove?: (id: string, t: number) => void
  onFlagRemove?: (id: string) => void
  flagEditable?: boolean // click to flag, drag, right-click to remove
  yMode?: YMode
  /** show a download button: saves NET.STA.LOC.CHA.mseed (original records for miniSEED input) */
  downloadable?: boolean
  className?: string
  style?: CSSProperties
}

/** waveform + spectrogram (dual / waveform / spectrogram) on one canvas */
export function SeismicGraph({
  stationId: stationIdProp,
  channelCode: channelProp,
  mseed,
  unit: unitProp,
  samples: samplesProp,
  sampleRate: sampleRateProp,
  endTime: endTimeProp,
  dataEndTime,
  displayHeight = 450,
  viewMode = 'dual',
  timeWindowSec: timeWindowProp,
  onTimeWindowChange,
  onPanChange,
  panOffsetSec,
  sensitivityPreset = 'normal',
  timeMode = 'local',
  theme = 'white',
  colors,
  fonts,
  onReady,
  pWaves,
  flags,
  onFlagAdd,
  onFlagMove,
  onFlagRemove,
  flagEditable = false,
  yMode = 'offset',
  downloadable = false,
  className,
  style,
}: SeismicGraphProps) {
  // miniSEED fills whatever the caller did not pass; codes come from the record headers
  const { streams } = useMseed(mseed)
  const ms = streams.find(s => !channelProp || s.channel === channelProp) ?? streams[0]
  const samples = ms?.samples ?? samplesProp
  const sampleRate = sampleRateProp ?? ms?.sampleRate ?? 100
  const endTime = endTimeProp ?? ms?.endTime
  const channelCode = channelProp ?? ms?.channel
  const unit = unitProp ?? ms?.unit
  const stationId = stationIdProp ?? (ms ? `${stationIdOf(ms)}.${ms.channel}` : '')
  const timeWindowSec = timeWindowProp ?? (samples?.length ? Math.max(10, samples.length / sampleRate) : 120)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  // the live widget as state, so the setter effects below re-run once it exists / after a rebuild
  const [widget, setWidget] = useState<RaspTraceWidget | null>(null)
  // via ref: parents pass a fresh closure each render, which must not rebuild the widget
  const callbacks = useRef({ onTimeWindowChange, onPanChange, onFlagAdd, onFlagMove, onFlagRemove })
  useEffect(() => { callbacks.current = { onTimeWindowChange, onPanChange, onFlagAdd, onFlagMove, onFlagRemove } })
  // the remaining props are applied through setters below; read once at build time only
  const initial = useRef({ viewMode, timeWindowSec, timeMode, theme, displayHeight, channelCode, unit, yMode, colors, fonts })

  // rebuilt only for station / rate / sensitivity: rebuilding drops the loaded data
  useEffect(() => {
    if(!canvasRef.current) return
    const i = initial.current
    const w = new RaspTraceWidget(canvasRef.current, {
      stationId,
      sampleRate,
      viewMode: i.viewMode,
      timeWindowSec: i.timeWindowSec,
      onTimeWindowChange: (sec) => callbacks.current.onTimeWindowChange?.(sec),
      onPanChange: (sec) => callbacks.current.onPanChange?.(sec),
      onFlagAdd: (t) => callbacks.current.onFlagAdd?.(t),
      onFlagMove: (id, t) => callbacks.current.onFlagMove?.(id, t),
      onFlagRemove: (id) => callbacks.current.onFlagRemove?.(id),
      timeMode: i.timeMode,
      theme: i.theme,
      colors: i.colors,
      fonts: i.fonts,
      displayHeight: i.displayHeight,
      sensitivityPreset,
      channel: i.channelCode,
      unit: i.unit,
      yMode: i.yMode,
    })
    setWidget(w)
    return () => { w.destroy(); setWidget(null) }
  }, [sampleRate, sensitivityPreset, stationId])

  // setters, not rebuilds (realtime changes the window on every packet); `widget` in deps re-applies after a rebuild
  useEffect(() => { widget?.setTimeWindow(timeWindowSec) }, [widget, timeWindowSec])
  useEffect(() => { if(panOffsetSec !== undefined) widget?.setPanOffset(panOffsetSec) }, [widget, panOffsetSec])
  useEffect(() => { widget?.setTheme(theme) }, [widget, theme])
  useEffect(() => { widget?.setChannel(channelCode) }, [widget, channelCode])
  useEffect(() => { widget?.setUnit(unit) }, [widget, unit])
  useEffect(() => { widget?.setYMode(yMode) }, [widget, yMode])
  useEffect(() => { widget?.setDisplayHeight(displayHeight) }, [widget, displayHeight])
  useEffect(() => { widget?.setTimeMode(timeMode) }, [widget, timeMode])
  useEffect(() => { widget?.setViewMode(viewMode) }, [widget, viewMode])
  useEffect(() => { widget?.setPWaves(pWaves || []) }, [widget, pWaves])
  useEffect(() => { widget?.setFlags(flags || []) }, [widget, flags])
  useEffect(() => { widget?.setFlagEditable(flagEditable) }, [widget, flagEditable])

  const endMs = endTime == null ? undefined : toMs(endTime)
  const dataEndMs = dataEndTime == null ? undefined : toMs(dataEndTime)
  useEffect(() => {
    if(widget && samples?.length) widget.hydrateHistorical(samples, sampleRate, endMs, dataEndMs)
  }, [widget, samples, sampleRate, endMs, dataEndMs])
  // re-run on widget rebuild too, so a new widget gets its data again
  useEffect(() => { if(widget) return onReady?.(widget) || undefined }, [widget, onReady])

  // what the download button saves: the miniSEED channel as given, else the samples on screen
  const download: StreamData[] = ms ? [ms]
    : samples?.length ? [{ channel: channelCode || 'XXX', unit, samples, sampleRate, startTime: (endMs ?? Date.now()) - ((samples.length - 1) / sampleRate) * 1000 }]
    : []

  // the widget sizes the canvas to this wrapper's width
  return (
    <div className={className} style={style}>
      {downloadable && <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}><DownloadButton streams={download} fallbackId={stationId} /></div>}
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%' }} />
    </div>
  )
}
