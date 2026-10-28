import { StrictMode, useCallback, useMemo, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  SeismicGraph, SeismicStream, SeismicStations, Helicorder, ZoomSync,
  streamsToMseed3, type SpectrogramWidget, type HelicorderWidget, type StreamData, type StationData, type PWave,
} from 'react-seismic-graph/react'
import { makeTrace } from './synthetic'
import { CODE } from './snippets'

const NOW = Date.now()
const SR = 100

// 10 min of 3 channels ending now, one quake 4 min ago
const QUAKE = NOW - 4 * 60_000
const PWAVES: PWave[] = [{ datetime: new Date(QUAKE).toISOString(), name: 'KTM', type: 'Earthquake', magnitude: 4.6 }]
const streamsOf = (seed: number, start = NOW - 600_000): StreamData[] => ['HHZ', 'HHN', 'HHE'].map((channel, i) => ({
  channel,
  unit: 'm/s',
  sampleRate: SR,
  startTime: start,
  samples: makeTrace(start, 600, SR, [{ at: QUAKE, amp: 12 - i * 3 }], seed + i),
}))

function Section({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return <section><h2>{title}</h2><p>{text}</p>{children}</section>
}

// 1. one graph, historical samples
function HistoricalExample() {
  const [viewMode, setViewMode] = useState<'dual' | 'waveform' | 'spectrogram'>('dual')
  const [theme, setTheme] = useState<'white' | 'dark'>('white')
  const stream = useMemo(() => streamsOf(1)[0], [])
  return (
    <Section title='SeismicGraph: historical' text='Wheel = zoom, drag = pan, double-click = reset. Spectrogram uses a 256-point FFT with an inferno colormap.'>
      <div style={{ marginBottom: 8, display: 'flex', gap: 6 }}>
        {(['dual', 'waveform', 'spectrogram'] as const).map(m => <button key={m} onClick={() => setViewMode(m)} aria-pressed={viewMode === m}>{m}</button>)}
        <button onClick={() => setTheme(theme === 'white' ? 'dark' : 'white')}>theme: {theme}</button>
      </div>
      <SeismicGraph
        stationId='NP.KTM.00.HHZ'
        channelCode='HHZ'
        unit='m/s'
        samples={stream.samples}
        sampleRate={SR}
        endTime={NOW}
        timeWindowSec={600}
        viewMode={viewMode}
        theme={theme}
        pWaves={PWAVES}
        downloadable
      />
    </Section>
  )
}

// 2. live: push packets through the widget handle
function LiveExample() {
  const onReady = useCallback((w: SpectrogramWidget) => {
    let t = Date.now()
    const id = setInterval(() => {
      const packet = makeTrace(t, 0.5, SR, Math.random() < 0.02 ? [{ at: t, amp: 8 }] : [], t % 1e6)
      t += 500
      w.addSamples(packet, t)
    }, 500)
    return () => clearInterval(id) // runs on unmount / widget rebuild
  }, [])
  return (
    <Section title='SeismicGraph: live' text='onReady gives the widget; call widget.addSamples(samples, lastSampleUtcMs) per packet.'>
      <SeismicGraph stationId='NP.LIVE.00.HHZ' channelCode='HHZ' unit='counts' timeWindowSec={60} theme='dark' onReady={onReady} displayHeight={380} />
    </Section>
  )
}

// 3. one station, many channels (stream wise)
function StreamExample() {
  const streams = useMemo(() => streamsOf(10), [])
  return (
    <Section title='SeismicStream: channels of one station' text='Pick channels, switch dual/waveform/spectrogram, link zoom across channels.'>
      <SeismicStream stationId='NP.KTM.00' streams={streams} pWaves={PWAVES} displayHeight={360} defaultChannels={['HHZ', 'HHE']} downloadable />
    </Section>
  )
}

// 4. many stations (station wise)
function StationsExample() {
  const stations: StationData[] = useMemo(() => [
    { id: 'NP.KTM.00', title: 'KTM - Kathmandu', streams: streamsOf(20) },
    { id: 'NP.PKR.00', title: 'PKR - Pokhara', streams: streamsOf(30) },
  ], [])
  return (
    <Section title='SeismicStations: station wise' text='One titled SeismicStream per station. Turn on the sync button (↻) in two toolbars: zooming one station zooms the other.'>
      <SeismicStations stations={stations} pWaves={PWAVES} displayHeight={300} defaultViewMode='waveform' />
    </Section>
  )
}

// 4b. zoom sync across stations: <ZoomSync> around any SeismicStreams (SeismicStations has one built in).
// Sync is per station (toolbar ↻ button): joining jumps to the shared view, then all synced stations zoom/pan together,
// lined up on UTC time even when their data ends at different times. Channel link inside a station works as before.
function ZoomSyncExample() {
  const ktm = useMemo(() => streamsOf(70), [])
  const pkr = useMemo(() => streamsOf(80, NOW - 540_000), []) // starts 1 min later
  const brt = useMemo(() => streamsOf(90).map(s => ({ ...s, samples: Array.prototype.slice.call(s.samples, 0, -30 * SR) })), []) // ends 30 s earlier
  return (
    <Section title='Zoom sync across stations' text='KTM and PKR start synced (defaultSynced): wheel-zoom or drag either one. BRT is not: zoom it, then press its ↻ button to snap it to the shared view. Double-click resets the shared view.'>
      <ZoomSync>
        <SeismicStream stationId='NP.KTM.00' streams={ktm} pWaves={PWAVES} displayHeight={220} defaultViewMode='waveform' defaultSynced />
        <SeismicStream stationId='NP.PKR.00' streams={pkr} pWaves={PWAVES} displayHeight={220} defaultViewMode='waveform' defaultSynced />
        <SeismicStream stationId='NP.BRT.00' streams={brt} pWaves={PWAVES} displayHeight={220} defaultViewMode='waveform' />
      </ZoomSync>
    </Section>
  )
}

// window + line length pickers shared by the helicorder examples; default 1 h of 1-minute lines
function useHeliControls() {
  const [windowH, setWindowH] = useState(1)
  const [lineMin, setLineMin] = useState(1)
  const lineMs = lineMin * 60_000
  const start = Math.floor((NOW - windowH * 3_600_000) / lineMs) * lineMs
  const controls = (
    <div style={{ display: 'flex', gap: 12, fontSize: 13, marginBottom: 8 }}>
      <label>window{' '}
        <select value={windowH} onChange={e => setWindowH(+e.target.value)}>{[1, 3, 6, 12, 24].map(h => <option key={h} value={h}>{h} h</option>)}</select>
      </label>
      <label>line length{' '}
        <select value={lineMin} onChange={e => setLineMin(+e.target.value)}>{[1, 5, 10, 15, 30, 60].map(m => <option key={m} value={m}>{m} min</option>)}</select>
      </label>
    </div>
  )
  return { start, lineSec: lineMin * 60, numLines: Math.max(1, Math.ceil((NOW - start) / lineMs)), controls }
}

// 24 h of 20 sps ending now, quakes in the last hour and earlier
const HELI_SR = 20
const HELI_START = Math.floor((NOW - 24 * 3_600_000) / 3_600_000) * 3_600_000
const HELI_QUAKES = [{ at: NOW - 25 * 60_000, amp: 15 }, { at: NOW - 5 * 3_600_000, amp: 8 }, { at: NOW - 14 * 3_600_000, amp: 6 }]
const HELI_PWAVES: PWave[] = HELI_QUAKES.map((q, i) => ({ datetime: new Date(q.at).toISOString(), name: `EQ${i + 1}`, magnitude: 5 - i * 0.5 }))
let heliDay: Float32Array | null = null
const heliSamples = () => (heliDay ??= makeTrace(HELI_START, (NOW - HELI_START) / 1000, HELI_SR, HELI_QUAKES, 7))

// 5. own helicorder, click a line -> graph of ±5 min
function HelicorderExample() {
  const heli = useHeliControls()
  const samples = heliSamples()
  const [gain, setGain] = useState(1)
  const [picked, setPicked] = useState<number | null>(null)
  const win = useMemo(() => {
    if(picked === null) return null
    const from = Math.max(0, Math.round(((picked - 300_000 - HELI_START) / 1000) * HELI_SR))
    const to = Math.min(samples.length, Math.round(((picked + 300_000 - HELI_START) / 1000) * HELI_SR))
    return { samples: samples.subarray(from, to), end: HELI_START + (to / HELI_SR) * 1000 }
  }, [picked, samples])
  return (
    <Section title='Helicorder (own, canvas)' text='Default: last 1 h in 1-minute lines. Click a line to open ±5 min below. Gaps (NaN) are not drawn.'>
      {heli.controls}
      <label style={{ fontSize: 13 }}>gain <input type='range' min={0.2} max={5} step={0.1} value={gain} onChange={e => setGain(+e.target.value)} /> {gain}</label>
      <Helicorder startTime={heli.start} numLines={heli.numLines} lineDurationSec={heli.lineSec} samples={samples} sampleRate={HELI_SR} dataStartTime={HELI_START}
        gain={gain} pWaves={HELI_PWAVES} title='NP.KTM.00.HHZ' timeMode='UTC' height={Math.min(900, heli.numLines * 14 + 60)} onClick={setPicked} />
      {win && <SeismicGraph stationId='NP.KTM.00.HHZ' samples={win.samples} sampleRate={HELI_SR} endTime={win.end} timeWindowSec={600} timeMode='UTC' pWaves={HELI_PWAVES} displayHeight={360} />}
    </Section>
  )
}

// 6. own helicorder, live: 1 h of 1-minute lines, packets written at their time
function LiveHelicorderExample() {
  const start = useMemo(() => Math.floor(Date.now() / 60_000) * 60_000 - 50 * 60_000, [])
  const onReady = useCallback((w: HelicorderWidget) => {
    w.setData(makeTrace(start, (Date.now() - start) / 1000, 50, [], 3), 50, start)
    let t = Date.now()
    const id = setInterval(() => { w.addSamples(makeTrace(t, 1, 50, Math.random() < 0.03 ? [{ at: t, amp: 6 }] : [], t % 1e6), t); t += 1000 }, 1000)
    return () => clearInterval(id)
  }, [start])
  return (
    <Section title='Helicorder: live' text='60 lines x 1 min; widget.addSamples(samples, startTimeOfPacket) every second.'>
      <Helicorder startTime={start} numLines={60} lineDurationSec={60} sampleRate={50} theme='dark' height={600} onReady={onReady} />
    </Section>
  )
}

// 6b. historical data arriving in pieces (paged API, socket replay): plotted as each piece lands
async function* pagedHistory(start: number, minutes: number) {
  for(let m = 0; m < minutes; m++) {
    await new Promise(r => setTimeout(r, 40)) // pretend network
    const t = start + m * 60_000
    yield { network: 'NP', station: 'KTM', location: '00', channel: 'HHZ', sampleRate: SR, startTime: t, samples: makeTrace(t, 60, SR, HELI_QUAKES.filter(q => q.at >= t && q.at < t + 60_000), m) }
  }
}

function StreamingHelicorderExample() {
  const start = useMemo(() => Math.floor((NOW - 3_600_000) / 60_000) * 60_000, [])
  const [run, setRun] = useState(0)
  // a factory, not a generator object: a generator can be read once, the factory restarts on remount / reload
  const stream = useCallback(() => pagedHistory(start, 60), [start, run]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Section title='Helicorder: streamed history' text='1 h at 100 sps arriving as 60 one-minute pages. stream={() => asyncIterable}; range and title come from the first chunk, lines grow as pages land.'>
      <button onClick={() => setRun(r => r + 1)}>reload</button>
      <Helicorder stream={stream} lineDurationSec={60} timeMode='UTC' height={640} pWaves={HELI_PWAVES} downloadable />
    </Section>
  )
}

// 9. miniSEED straight in: bytes, File or URL; names come from the record headers when not passed
const IRIS_URL = (() => {
  const end = new Date(NOW - 3_600_000), start = new Date(end.valueOf() - 600_000)
  const t = (d: Date) => d.toISOString().split('.')[0]
  return `https://service.earthscope.org/fdsnws/dataselect/1/query?net=IU&sta=ANMO&loc=00&cha=BH?&start=${t(start)}&end=${t(end)}`
})()

function MseedExample() {
  // 1 h, 3 channels, written to miniSEED 3 in the browser with codes NP.KTM.00.HH?
  const generated = useMemo(() => {
    const start = NOW - 3_600_000
    return streamsToMseed3(['HHZ', 'HHN', 'HHE'].map((channel, i) => ({
      network: 'NP', station: 'KTM', location: '00', channel, sampleRate: 50, startTime: start,
      samples: makeTrace(start, 3600, 50, [{ at: NOW - 20 * 60_000, amp: 12 - i * 3 }], 50 + i),
    })))
  }, [])
  const [file, setFile] = useState<File | null>(null)
  const [useUrl, setUseUrl] = useState(false)
  return (
    <Section title='miniSEED input (v2 + v3)' text='Pass mseed={bytes | File | URL}; downloadable adds a button saving NET.STA.LOC.CHA.mseed (original records). stationId, channel, sample rate, start time and helicorder title all come from the miniSEED headers when not given.'>
      <p><b>Generated miniSEED 3</b> ({(generated.byteLength / 1024).toFixed(0)} kB): no stationId passed</p>
      <SeismicStream mseed={generated} displayHeight={300} defaultViewMode='waveform' downloadable />
      <Helicorder mseed={generated} channelCode='HHZ' lineDurationSec={60} timeMode='UTC' height={560} downloadable />
      <p style={{ marginTop: 16 }}><b>Your file</b>: <input type='file' accept='.mseed,.ms,.miniseed,.mseed3,application/vnd.fdsn.mseed' onChange={e => setFile(e.target.files?.[0] ?? null)} /></p>
      {file && <SeismicStations mseed={file} displayHeight={300} downloadable />}
      {file && <Helicorder mseed={file} lineDurationSec={60} timeMode='UTC' downloadable />}
      <p style={{ marginTop: 16 }}><b>URL</b> (EarthScope/IRIS fdsnws, miniSEED 2): <button onClick={() => setUseUrl(true)}>load</button></p>
      {useUrl && <SeismicStations mseed={IRIS_URL} displayHeight={300} defaultViewMode='waveform' downloadable />}
      {useUrl && <Helicorder mseed={IRIS_URL} channelCode='BHZ' lineDurationSec={60} timeMode='UTC' downloadable />}
    </Section>
  )
}

// styling: CSS variables for the toolbar, classNames for your own classes, colors for the canvas (per channel here)
const CHANNEL_TRACE: Record<string, string> = { HHZ: '#dc2626', HHN: '#16a34a', HHE: '#7c3aed' }

function ThemingExample() {
  const streams = useMemo(() => streamsOf(60), [])
  return (
    <Section title='Styling' text='Toolbar via CSS variables (--rsg-*), extra classes via classNames, canvas colours via colors (a function = per channel).'>
      <style>{`
        .brand { --rsg-active-bg: #16a34a; --rsg-btn-radius: 999px; --rsg-btn-border: #bbf7d0; --rsg-toolbar-bg: #f0fdf4; --rsg-row-bg: #fafafa; }
        .brand .rsg-button:hover { filter: brightness(0.95); }
        .brand .chip-active { box-shadow: 0 0 0 2px #86efac; }
      `}</style>
      <SeismicStream
        className='brand'
        classNames={{ buttonActive: 'chip-active' }}
        stationId='NP.KTM.00'
        streams={streams}
        defaultChannels={['HHZ', 'HHN', 'HHE']}
        defaultViewMode='waveform'
        displayHeight={260}
        colors={(channel) => ({ white: { trace: CHANNEL_TRACE[channel], background: '#fafafa' }, dark: { trace: CHANNEL_TRACE[channel] } })}
        downloadable
      />
    </Section>
  )
}

// colours from CSS variables: --rsg-primary (toolbar + trace), --rsg-<key> / --rsg-dark-<key> for any canvas colour.
// Put them on :root for a global default, or on any wrapper (as here). The colors prop still wins.
function CssColorsExample() {
  const streams = useMemo(() => streamsOf(100), [])
  const heliStart = Math.floor((NOW - 3_600_000) / 300_000) * 300_000
  return (
    <Section title='Colours from CSS variables' text='Toolbar and canvas share --rsg-primary. HHE overrides its trace with colors={{ white: { trace: "var(--brand-accent)" } }}. Toggle the theme: --rsg-dark-* applies in dark only.'>
      <style>{`
        /* global default would be :root { ... } */
        .css-colors {
          --brand: #7c3aed; --brand-accent: #db2777;
          --rsg-primary: var(--brand);
          --rsg-background: #faf5ff; --rsg-grid: rgba(124, 58, 237, 0.2); --rsg-frame: #ddd6fe;
          --rsg-dark-primary: #c4b5fd; --rsg-dark-background: #1e1b4b; --rsg-dark-grid: rgba(196, 181, 253, 0.25);
        }
      `}</style>
      <div className='css-colors'>
        <SeismicStream
          stationId='NP.KTM.00'
          streams={streams}
          defaultChannels={['HHZ', 'HHE']}
          defaultViewMode='waveform'
          displayHeight={240}
          colors={(channel) => channel === 'HHE' ? { white: { trace: 'var(--brand-accent)' }, dark: { trace: 'var(--brand-accent)' } } : undefined}
        />
        <Helicorder startTime={heliStart} numLines={13} lineDurationSec={300} samples={heliSamples()} sampleRate={HELI_SR} dataStartTime={HELI_START} timeMode='UTC' height={360} title='NP.KTM.00.HHZ' />
      </div>
    </Section>
  )
}

const EXAMPLES = { historical: HistoricalExample, live: LiveExample, stream: StreamExample, stations: StationsExample, zoomSync: ZoomSyncExample, helicorder: HelicorderExample, liveHelicorder: LiveHelicorderExample, heliStream: StreamingHelicorderExample, mseed: MseedExample, theming: ThemingExample, cssColors: CssColorsExample }
type Key = keyof typeof EXAMPLES

// how to use it in your app, under the live example
function Code({ code }: { code?: string }) {
  const [copied, setCopied] = useState(false)
  if(!code) return null
  const copy = () => navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  return (
    <details open className='code'>
      <summary>Usage <button type='button' onClick={(e) => { e.preventDefault(); copy() }}>{copied ? 'copied' : 'copy'}</button></summary>
      <pre><code>{code}</code></pre>
    </details>
  )
}

function App() {
  const [tab, setTab] = useState<Key>(() => (location.hash.slice(1) as Key) in EXAMPLES ? location.hash.slice(1) as Key : 'historical')
  const Example = EXAMPLES[tab]
  return (
    <main>
      <h1 style={{ fontSize: 20 }}>react-seismic-graph</h1>
      <nav>
        {(Object.keys(EXAMPLES) as Key[]).map(k => <button key={k} aria-pressed={tab === k} onClick={() => { setTab(k); location.hash = k }}>{k}</button>)}
        <a href='./vanilla.html' style={{ alignSelf: 'center', marginLeft: 8, fontSize: 13 }}>plain HTML example →</a>
      </nav>
      <Example key={tab} />
      <Code code={CODE[tab]} />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
