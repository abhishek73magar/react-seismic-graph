import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { toMs } from '../core/time'
import { groupStations, stationIdOf } from '../core/seismogram'
import type { MseedInput } from '../seisplotjs/mseed'
import { useMseed } from './useMseed'
import type { PWave, StationData, StreamData, ThemeName, ViewMode, YMode } from '../core/types'
import { SeismicGraph } from './SeismicGraph'
import { SpSeismograph } from './SeisplotjsElements'
import { DEFAULT_ICONS, DownloadButton, type IconSet } from './icons'

export type StreamViewMode = ViewMode | 'seisplotjs'

const VIEW_MODES: { name: StreamViewMode; title: string }[] = [
  { name: 'dual', title: 'Dual (waveform + spectrogram)' },
  { name: 'waveform', title: 'Waveform' },
  { name: 'spectrogram', title: 'Spectrogram' },
  { name: 'seisplotjs', title: 'seisplotjs seismograph (old view)' },
]

const S = {
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: 8, borderBottom: '1px solid #e2e8f0', fontSize: 12, fontFamily: 'system-ui, sans-serif' },
  group: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  btn: (active: boolean): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid #cbd5e1', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: active ? '#0284c7' : 'transparent', color: active ? '#fff' : 'inherit' }),
  row: { padding: '6px 8px', borderBottom: '1px solid #e2e8f0' },
  empty: { padding: 16, color: '#64748b', fontSize: 13, fontFamily: 'system-ui, sans-serif' },
} satisfies Record<string, CSSProperties | ((a: boolean) => CSSProperties)>

const REALTIME_LEFT_MARGIN_SEC = 5 // realtime: seconds of buffered data kept hidden past the left edge

// per-channel zoom (seconds visible) and pan (seconds back from live); '*' = shared by all channels when linked
const useLinkedZoom = () => {
  const [zoomSec, setZoomSec] = useState<Record<string, number | null>>({})
  const [panSec, setPanSec] = useState<Record<string, number>>({})
  const [linkZoom, setLinkZoom] = useState(true)
  const key = (channel: string) => linkZoom ? '*' : channel
  return {
    linkZoom, setLinkZoom,
    zoomOf: (channel: string) => zoomSec[key(channel)] ?? undefined,
    setZoom: (channel: string) => (sec: number | null) => setZoomSec((prev) => ({ ...prev, [key(channel)]: sec })),
    panOf: (channel: string) => panSec[key(channel)] ?? 0,
    setPan: (channel: string) => (sec: number) => setPanSec((prev) => ({ ...prev, [key(channel)]: sec })),
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
  className?: string
  style?: CSSProperties
}

/** channel picker + toolbar + one graph per selected channel, all on one time axis */
export function SeismicStream({
  stationId: stationIdProp, streams: streamsProp, mseed, live = false, pWaves, displayHeight, timeMode = 'local', defaultViewMode = 'dual', defaultTheme = 'white',
  defaultYMode = 'offset', defaultChannels, toolbar = true, downloadable = false, icons, toolbarExtra, className, style,
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
  const zoom = useLinkedZoom()
  const ic = { ...DEFAULT_ICONS, ...icons }

  // 'All' on = every channel, off = back to the first one; the last selected channel can't be turned off
  const toggle = (name: string) => {
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

  if(m.loading) return <div style={S.empty}>Loading miniSEED…</div>
  if(m.error) return <div style={S.empty}>miniSEED error: {m.error.message}</div>
  if(streams.length === 0) return <div style={S.empty}>No streams</div>

  return (
    <div className={className} style={style}>
      {toolbar && (
        <div style={S.bar}>
          <div style={S.group}>
            <b style={{ marginRight: 4 }}>Channels:</b>
            <button type='button' style={S.btn(allSelected)} aria-pressed={allSelected} onClick={() => toggle('*')}>All</button>
            {codes.map(c => <button type='button' key={c} style={S.btn(selected.includes(c))} aria-pressed={selected.includes(c)} onClick={() => toggle(c)}>{c}</button>)}
          </div>
          <div style={S.group}>
            {viewMode !== 'seisplotjs' && (
              <>
                <button type='button' style={S.btn(false)} title={theme === 'white' ? 'Light theme - click for dark' : 'Dark theme - click for light'} aria-label='Toggle theme' onClick={() => setTheme(theme === 'white' ? 'dark' : 'white')}>{theme === 'white' ? ic.light : ic.dark}</button>
                <button type='button' style={S.btn(false)} title='Raw values / offset from mean' onClick={() => setYMode(yMode === 'raw' ? 'offset' : 'raw')}>{yMode === 'raw' ? 'RAW' : 'OFFSET'}</button>
                <button type='button' style={S.btn(zoom.linkZoom)} title={zoom.linkZoom ? 'Zoom/pan all channels together - click to unlink' : 'Zoom/pan one channel only - click to link'} aria-label='Link zoom and pan across channels' aria-pressed={zoom.linkZoom} onClick={() => zoom.setLinkZoom(!zoom.linkZoom)}>{zoom.linkZoom ? ic.link : ic.unlink}</button>
              </>
            )}
            {downloadable && <DownloadButton streams={streams.filter(s => selected.includes(s.channel) && s.samples.length > 0)} fallbackId={stationId} icon={ic.download} label={null} />}
            {VIEW_MODES.map(m => <button type='button' key={m.name} title={m.title} aria-label={m.title} style={S.btn(viewMode === m.name)} aria-pressed={viewMode === m.name} onClick={() => setViewMode(m.name)}>{ic[m.name]}</button>)}
            {toolbarExtra}
          </div>
        </div>
      )}
      {/* stream order, not click order */}
      {streams.filter(s => selected.includes(s.channel)).map(s => {
        const info = prepared.byChannel[s.channel]
        if(!info) return <div key={s.channel} style={S.empty}>{s.channel}: no data</div>
        const markers = s.pWaves ?? pWaves
        if(viewMode === 'seisplotjs') return (
          <div key={s.channel} style={S.row}>
            <SpSeismograph data={s} pWaves={markers} unit={s.unit} channel={s.channel} style={{ height: 180 }} />
          </div>
        )
        return (
          <div key={s.channel} style={S.row}>
            <SeismicGraph
              stationId={`${stationId}.${s.channel}`}
              channelCode={s.channel}
              unit={s.unit}
              samples={s.samples}
              sampleRate={s.sampleRate}
              endTime={prepared.axisEnd}
              dataEndTime={info.end}
              displayHeight={displayHeight}
              timeWindowSec={zoom.zoomOf(s.channel) ?? prepared.diff}
              onTimeWindowChange={zoom.setZoom(s.channel)}
              panOffsetSec={zoom.panOf(s.channel)}
              onPanChange={zoom.setPan(s.channel)}
              pWaves={markers}
              viewMode={viewMode}
              timeMode={timeMode}
              theme={theme}
              yMode={yMode}
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
  if(m.loading) return <div style={S.empty}>Loading miniSEED…</div>
  if(m.error) return <div style={S.empty}>miniSEED error: {m.error.message}</div>
  if(stations.length === 0) return <div style={S.empty}>No stations</div>
  return (
    <>
      {stations.map(st => (
        <section key={st.id} style={{ border: '1px solid #e2e8f0', marginBottom: 12 }}>
          <header style={{ padding: '8px 12px', background: '#f1f5f9', fontWeight: 700, fontSize: 14, fontFamily: 'system-ui, sans-serif' }}>{st.title ?? st.id}</header>
          <SeismicStream stationId={st.id} streams={st.streams} {...rest} />
        </section>
      ))}
    </>
  )
}
