import { createContext, useContext, useMemo, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { toMs } from '../core/time'
import { groupStations, stationIdOf } from '../core/seismogram'
import type { MseedInput } from '../mseed'
import { useMseed } from './useMseed'
import type { PWave, StationData, StreamData, ThemeName, ViewMode, YMode } from '../core/types'
import { SeismicGraph } from './SeismicGraph'
import type { RaspTraceWidget, TraceFlag } from '../core/SpectrogramWidget'
import { DEFAULT_ICONS, DownloadButton, type IconSet } from './icons'
import { part, type ClassNames } from './styles'
import type { SeismicGraphProps } from './SeismicGraph'

export type StreamViewMode = ViewMode

const VIEW_MODES: { name: StreamViewMode; title: string }[] = [
  { name: 'dual', title: 'Dual (waveform + spectrogram)' },
  { name: 'waveform', title: 'Waveform' },
  { name: 'spectrogram', title: 'Spectrogram' },
]

const REALTIME_LEFT_MARGIN_SEC = 5 // realtime: seconds of buffered data kept hidden past the left edge

/** zoom/pan shared by synced stations: absolute right edge (UTC ms, null = axis end / live), so stations with different end times line up */
export interface ZoomView { windowSec: number | null; rightMs: number | null }
type SharedZoom = { view: ZoomView; setView: Dispatch<SetStateAction<ZoomView>> }
const ZoomSyncContext = createContext<SharedZoom | null>(null)

/** stations (SeismicStream) inside share one zoom/pan once their toolbar sync button is on; SeismicStations adds one itself */
export function ZoomSync({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ZoomView>({ windowSec: null, rightMs: null })
  const value = useMemo(() => ({ view, setView }), [view])
  return <ZoomSyncContext.Provider value={value}>{children}</ZoomSyncContext.Provider>
}

// per-channel zoom (seconds visible) and pan (seconds back from live); '*' = shared by all channels when linked.
// `shared` (station synced): linked channels use the cross-station view instead of '*'
const useLinkedZoom = (shared: SharedZoom | null, axisEnd: number) => {
  const [zoomSec, setZoomSec] = useState<Record<string, number | null>>({})
  const [panSec, setPanSec] = useState<Record<string, number>>({})
  const [linkZoom, setLinkZoom] = useState(true)
  const key = (channel: string) => linkZoom ? '*' : channel
  const s = linkZoom ? shared : null
  const end = Number.isFinite(axisEnd) ? axisEnd : null
  const toPan = (rightMs: number | null) => rightMs == null || end == null ? 0 : (end - rightMs) / 1000
  const toRight = (sec: number) => sec === 0 || end == null ? null : end - sec * 1000
  return {
    linkZoom, setLinkZoom,
    zoomOf: (channel: string) => (s ? s.view.windowSec : zoomSec[key(channel)]) ?? undefined,
    setZoom: (channel: string) => (sec: number | null) => s
      ? s.setView((v) => ({ ...v, windowSec: sec }))
      : setZoomSec((prev) => ({ ...prev, [key(channel)]: sec })),
    panOf: (channel: string) => s ? toPan(s.view.rightMs) : panSec[key(channel)] ?? 0,
    setPan: (channel: string) => (sec: number) => s
      ? s.setView((v) => ({ ...v, rightMs: toRight(sec) }))
      : setPanSec((prev) => ({ ...prev, [key(channel)]: sec })),
    /** the station's own linked view, as a shared view (when it starts the sync) */
    localView: (): ZoomView => ({ windowSec: zoomSec['*'] ?? null, rightMs: toRight(panSec['*'] ?? 0) }),
    /** keep the shared view as its own when leaving the sync, so nothing jumps */
    keepView: (v: ZoomView) => {
      setZoomSec((prev) => ({ ...prev, '*': v.windowSec }))
      setPanSec((prev) => ({ ...prev, '*': toPan(v.rightMs) }))
    },
  }
}

export interface SeismicStreamProps {
  /** default from the streams' metadata ('NET.STA.LOC') */
  stationId?: string
  streams?: StreamData[]
  /** miniSEED v2/v3 bytes, File/Blob or URL; used when `streams` is not given */
  mseed?: MseedInput | null
  /** realtime: shared axis ends at the freshest channel and hides the first few seconds; default false (historical) */
  live?: boolean
  pWaves?: PWave[] // used for channels without their own
  displayHeight?: number
  timeMode?: string
  defaultViewMode?: StreamViewMode
  defaultTheme?: ThemeName
  defaultYMode?: YMode
  /** channel codes on at start; default: the first channel */
  defaultChannels?: string[]
  toolbar?: boolean
  /** show a download button: selected channels saved as NET.STA.LOC.CHA.mseed */
  downloadable?: boolean
  /** override toolbar icons, e.g. { dark: <FaMoon /> } */
  icons?: IconSet
  /** extra content at the right of the toolbar */
  toolbarExtra?: ReactNode
  /** extra classes per part (root, toolbar, group, label, button, buttonActive, row, empty); rsg-* classes are always set */
  classNames?: ClassNames
  /** drop the built-in inline styles (style it all with classNames / your CSS) */
  unstyled?: boolean
  /** canvas colours (trace, background, grid ...), per theme; a function gives each channel its own */
  colors?: SeismicGraphProps['colors'] | ((channel: string) => SeismicGraphProps['colors'])
  fonts?: SeismicGraphProps['fonts']
  /**
   * each channel's widget, e.g. for live data: hydrate it, then push packets with widget.addSamples.
   * Channels listed in `streams` without samples are still drawn when this is given. Return a cleanup.
   */
  onReady?: (channel: string, widget: RaspTraceWidget) => void | (() => void)
  /** flags for all channels; each graph shows those whose channel_code is its channel */
  flags?: TraceFlag[]
  flagEditable?: boolean
  onFlagAdd?: (ms: number, channel: string) => void
  onFlagMove?: (id: string, ms: number) => void
  onFlagRemove?: (id: string) => void
  /** shows a realtime enable/disable toggle in the toolbar; shown only when both are given. Each returns the resulting enabled state */
  onRealtimeEnable?: () => boolean
  onRealtimeDisable?: () => boolean
  /** inside <ZoomSync> / SeismicStations: start with the station's zoom synced to the other stations; default false */
  defaultSynced?: boolean
  /** shows a close button in the toolbar when given */
  onClose?: () => void
  className?: string
  style?: CSSProperties
}

/** channel picker + toolbar + one graph per selected channel, all on one time axis */
export function SeismicStream({
  stationId: stationIdProp, 
  streams: streamsProp, 
  mseed, 
  live = false, 
  pWaves, 
  displayHeight, 
  timeMode = 'local', 
  defaultViewMode = 'dual', 
  defaultTheme = 'white',
  defaultYMode = 'offset', 
  defaultChannels, 
  toolbar = true, 
  downloadable = false, 
  icons, 
  toolbarExtra, 
  className, 
  style,
  classNames, 
  unstyled = false, 
  colors, 
  fonts, 
  onReady, 
  flags, 
  flagEditable = false, 
  onFlagAdd, 
  onFlagMove, 
  onFlagRemove,
  onRealtimeEnable, 
  onRealtimeDisable, 
  onClose,
  defaultSynced = false,
}: SeismicStreamProps) {
  const m = useMseed(streamsProp ? null : mseed)
  const streams = streamsProp ?? m.streams
  const stationId = stationIdProp ?? stationIdOf(streams[0])
  const codes = useMemo(() => streams.map(s => s.channel), [streams])
  const [picked, setPicked] = useState<string[] | null>(defaultChannels ?? null)
  const selected = useMemo(() => {
    const kept = (picked ?? []).filter(c => codes.includes(c))
    return kept.length > 0 ? kept : codes.slice(0, 1)
  }, [picked, codes])
  const allSelected = codes.length > 0 && codes.every(c => selected.includes(c))
  const [viewMode, setViewMode] = useState<StreamViewMode>(defaultViewMode)
  const [theme, setTheme] = useState<ThemeName>(defaultTheme)
  const [yMode, setYMode] = useState<YMode>(defaultYMode)
  const ic = { ...DEFAULT_ICONS, ...icons }
  const p = (name: Parameters<typeof part>[0], active = false) => part(name, classNames, unstyled, active)

  // realtime toggle: shown only when both callbacks are given; each reports back the state it actually ended up in
  const canToggleRealtime = !!(onRealtimeEnable && onRealtimeDisable)
  const [realtimeOn, setRealtimeOn] = useState(live)
  const toggleRealtime = () => setRealtimeOn((realtimeOn ? onRealtimeDisable : onRealtimeEnable)?.() ?? realtimeOn)

  // 'All' on = every channel, off = back to the first one; the last selected channel can't be turned off
  const toggle = (name: string) => {
    if(codes.length < 1) return;
    if(name === '*') return setPicked(allSelected ? codes.slice(0, 1) : codes)
    if(!selected.includes(name)) return setPicked([...selected, name])
    if(selected.length > 1) setPicked(selected.filter(c => c !== name))
  }

  // all channels share one time axis: same x = same UTC time everywhere (a shorter channel gets an empty tail)
  const prepared = useMemo(() => {
    const infos = streams.map(s => {
      const start = toMs(s.startTime)
      const end = s.endTime != null ? toMs(s.endTime) : start + ((s.samples.length - 1) / s.sampleRate) * 1000
      return { stream: s, start, end }
    }).filter(i => !Number.isNaN(i.start) && i.stream.samples.length > 0)
    if(infos.length === 0) return { axisEnd: NaN, diff: 10, byChannel: {} as Record<string, (typeof infos)[number]> }
    const axisEnd = Math.max(...infos.map(i => i.end))
    const axisStart = live
      ? Math.max(...infos.map(i => i.start)) + REALTIME_LEFT_MARGIN_SEC * 1000 // trimmed buffer starts never visible
      : Math.min(...infos.map(i => i.start))
    return {
      axisEnd,
      diff: Math.max(10, Math.floor((axisEnd - axisStart) / 1000)),
      byChannel: Object.fromEntries(infos.map(i => [i.stream.channel, i])),
    }
  }, [streams, live])

  // cross-station sync (toolbar button, only inside a ZoomSync): joining adopts the shared view, the first one in sets it
  const sync = useContext(ZoomSyncContext)
  const [synced, setSynced] = useState(defaultSynced)
  const zoom = useLinkedZoom(sync && synced ? sync : null, prepared.axisEnd)
  const toggleSync = () => {
    if(!sync) return
    if(synced) zoom.keepView(sync.view)
    else if(sync.view.windowSec == null && sync.view.rightMs == null) sync.setView(zoom.localView())
    setSynced(!synced)
  }

  // stable per channel: SeismicGraph re-runs onReady whenever its identity changes
  const readyFor = useMemo(() => {
    const cache = new Map<string, (w: RaspTraceWidget) => void | (() => void)>()
    return (channel: string) => {
      let fn = cache.get(channel)
      if(!fn) cache.set(channel, fn = (w) => onReady?.(channel, w))
      return fn
    }
  }, [onReady])
  const flagsFor = useMemo(() => {
    const byChannel = new Map<string, TraceFlag[]>()
    for(const f of flags ?? []) {
      const key = (f.channel_code ?? '').toLowerCase()
      byChannel.set(key, [...(byChannel.get(key) ?? []), f])
    }
    const none: TraceFlag[] = []
    return (channel: string) => byChannel.get(channel.toLowerCase()) ?? none
  }, [flags])

  const totalChannel = useMemo(() => streams.length, [streams])

  if(m.loading) return <div {...p('empty')}>Loading miniSEED…</div>
  if(m.error) return <div {...p('empty')}>miniSEED error: {m.error.message}</div>
  if(streams.length === 0) return <div {...p('empty')}>No streams</div>

  const root = p('root')
  return (
    <div className={[root.className, className].filter(Boolean).join(' ')} style={{ ...root.style, ...style }}>
      {toolbar && (
        <div {...p('toolbar')}>
          <div {...p('group')}>
            <span {...p('label')}>Channel{totalChannel > 1 ? 's' : ''}:</span>
            {totalChannel > 1 &&<button type='button' {...p('button', allSelected)} aria-pressed={allSelected} onClick={() => toggle('*')}>All</button>}
            {codes.map(c => <button type='button' key={c} {...p('button', selected.includes(c))} data-channel={c} aria-pressed={selected.includes(c)} onClick={() => toggle(c)}>{c}</button>)}
          </div>
          <div {...p('group')}>
            <button type='button' {...p('button')} title={theme === 'white' ? 'Light theme - click for dark' : 'Dark theme - click for light'} aria-label='Toggle theme' onClick={() => setTheme(theme === 'white' ? 'dark' : 'white')}>{theme === 'white' ? ic.light : ic.dark}</button>
            <button type='button' {...p('button')} title='Raw values / offset from mean' onClick={() => setYMode(yMode === 'raw' ? 'offset' : 'raw')}>{yMode === 'raw' ? 'RAW' : 'OFFSET'}</button>
            <button type='button' {...p('button', zoom.linkZoom)} title={zoom.linkZoom ? 'Zoom/pan all channels together - click to unlink' : 'Zoom/pan one channel only - click to link'} aria-label='Link zoom and pan across channels' aria-pressed={zoom.linkZoom} onClick={() => zoom.setLinkZoom(!zoom.linkZoom)}>{zoom.linkZoom ? ic.link : ic.unlink}</button>
            {sync && <button type='button' {...p('button', synced)} title={synced ? 'Zoom/pan synced with other stations - click to stop' : 'Sync zoom/pan with other stations'} aria-label='Sync zoom and pan across stations' aria-pressed={synced} onClick={toggleSync}>{ic.sync}</button>}
            {downloadable && <DownloadButton streams={streams.filter(s => selected.includes(s.channel) && s.samples.length > 0)} fallbackId={stationId} icon={ic.download} {...p('button')} />}
            {VIEW_MODES.map(m => <button type='button' key={m.name} title={m.title} aria-label={m.title} {...p('button', viewMode === m.name)} aria-pressed={viewMode === m.name} onClick={() => setViewMode(m.name)}>{ic[m.name]}</button>)}
            {canToggleRealtime && <button type='button' {...p('button', realtimeOn)} title={realtimeOn ? 'Realtime enabled - click to disable' : 'Realtime disabled - click to enable'} aria-label='Toggle realtime' aria-pressed={realtimeOn} onClick={toggleRealtime}>{ic.realtime}</button>}
            {toolbarExtra}
            {onClose && <button type='button' {...p('button')} title='Close' aria-label='Close' onClick={onClose}>{ic.close}</button>}
          </div>
        </div>
      )}
      {/* stream order, not click order */}
      {streams.filter(s => selected.includes(s.channel)).map(s => {
        const info = prepared.byChannel[s.channel]
        // live channels (onReady) may start empty: their data is pushed into the widget
        if(!info && !onReady) return <div key={s.channel} {...p('empty')}>{s.channel}: no data</div>
        const markers = s.pWaves ?? pWaves
        return (
          <div key={s.channel} {...p('row')} data-channel={s.channel}>
            <SeismicGraph
              stationId={`${stationId}.${s.channel}`}
              channelCode={s.channel}
              unit={s.unit}
              samples={info ? s.samples : undefined}
              sampleRate={s.sampleRate}
              endTime={info ? prepared.axisEnd : undefined}
              dataEndTime={info?.end}
              displayHeight={displayHeight}
              timeWindowSec={zoom.zoomOf(s.channel) ?? (info ? prepared.diff : undefined)}
              onTimeWindowChange={zoom.setZoom(s.channel)}
              panOffsetSec={zoom.panOf(s.channel)}
              onPanChange={zoom.setPan(s.channel)}
              pWaves={markers}
              viewMode={viewMode}
              timeMode={timeMode}
              theme={theme}
              yMode={yMode}
              colors={typeof colors === 'function' ? colors(s.channel) : colors}
              fonts={fonts}
              onReady={onReady && readyFor(s.channel)}
              flags={flags && flagsFor(s.channel)}
              flagEditable={flagEditable}
              onFlagAdd={onFlagAdd && ((ms) => onFlagAdd(ms, s.channel))}
              onFlagMove={onFlagMove}
              onFlagRemove={onFlagRemove}
            />
          </div>
        )
      })}
    </div>
  )
}

export interface SeismicStationsProps extends Omit<SeismicStreamProps, 'stationId' | 'streams' | 'mseed'> {
  stations?: StationData[]
  /** miniSEED v2/v3 with any number of stations; grouped by NET.STA.LOC */
  mseed?: MseedInput | null
}

/** one titled SeismicStream per station */
export function SeismicStations({ stations: stationsProp, mseed, ...rest }: SeismicStationsProps) {
  const m = useMseed(stationsProp ? null : mseed)
  const stations = useMemo(() => stationsProp ?? groupStations(m.streams), [stationsProp, m.streams])
  const p = (name: 'empty' | 'station' | 'stationHeader') => part(name, rest.classNames, !!rest.unstyled)
  const inSync = useContext(ZoomSyncContext)
  if(m.loading) return <div {...p('empty')}>Loading miniSEED…</div>
  if(m.error) return <div {...p('empty')}>miniSEED error: {m.error.message}</div>
  if(stations.length === 0) return <div {...p('empty')}>No stations</div>
  const list = stations.map(st => (
    <section key={st.id} {...p('station')} data-station={st.id}>
      <header {...p('stationHeader')}>{st.title ?? st.id}</header>
      <SeismicStream stationId={st.id} streams={st.streams} {...rest} />
    </section>
  ))
  // own sync group unless already inside one (then it syncs with the stations around it too)
  return inSync ? <>{list}</> : <ZoomSync>{list}</ZoomSync>
}
