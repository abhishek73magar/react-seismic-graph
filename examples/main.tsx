import { StrictMode, useCallback, useMemo, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  SeismicGraph, SeismicStream, SeismicStations, Helicorder,
  fromSeismogram, streamsToMseed3, type SpectrogramWidget, type HelicorderWidget, type StreamData, type StationData, type PWave,
} from 'react-seismic-graph/react'
import { sp } from 'react-seismic-graph/seisplotjs'
import { SpHelicorder, SpSeismograph } from 'react-seismic-graph/react/seisplotjs'
import { makeTrace } from './synthetic'

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
    <Section title='SeismicStream: channels of one station' text='Pick channels, switch dual/waveform/spectrogram/seisplotjs, link zoom across channels.'>
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
    <Section title='SeismicStations: station wise' text='One titled SeismicStream per station.'>
      <SeismicStations stations={stations} pWaves={PWAVES} displayHeight={300} defaultViewMode='waveform' />
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
      <SpHelicorder stream={stream} start={start} end={start + 3_600_000} lineDurationSec={60} timeZone='UTC' style={{ marginTop: 16 }} />
    </Section>
  )
}

// 7. seisplotjs web components
function SeisplotjsExample() {
  const heli = useHeliControls()
  const stream: StreamData = useMemo(() => ({ channel: 'HHZ', unit: 'm/s', sampleRate: HELI_SR, startTime: HELI_START, samples: heliSamples() }), [])
  const recent: StreamData = useMemo(() => streamsOf(40)[0], [])
  const [clicked, setClicked] = useState('')
  return (
    <Section title='seisplotjs: SpHelicorder + SpSeismograph' text='Wrappers around <sp-helicorder> / <sp-seismograph>. Default: last 1 h in 1-minute lines.'>
      {heli.controls}
      <SpHelicorder data={stream} start={heli.start} end={NOW} lineDurationSec={heli.lineSec} pWaves={HELI_PWAVES} timeZone='UTC' onClick={ms => setClicked(new Date(ms).toISOString())} />
      <p>clicked: {clicked || '-'}</p>
      <SpSeismograph data={recent} pWaves={PWAVES} unit='m/s' channel='HHZ' style={{ height: 240 }} />
    </Section>
  )
}

// 8. real data from an FDSN server (IRIS) via seisplotjs
function FdsnExample() {
  const [state, setState] = useState<{ status: string; streams?: StreamData[] }>({ status: 'idle' })
  const load = async () => {
    setState({ status: 'loading...' })
    try {
      const end = new Date(Date.now() - 3_600_000)
      const range = sp.util.startEnd(sp.util.isoToDateTime(new Date(end.valueOf() - 600_000).toISOString()), sp.util.isoToDateTime(end.toISOString()))
      const seismograms = await new sp.fdsndataselect.DataSelectQuery()
        .networkCode('IU').stationCode('ANMO').locationCode('00').channelCode('BH?').timeRange(range).querySeismograms()
      setState({ status: `${seismograms.length} channels`, streams: seismograms.map(s => ({ ...fromSeismogram(s), unit: 'counts' })) })
    } catch (e) { setState({ status: `error: ${e}` }) }
  }
  return (
    <Section title='Real data: FDSN dataselect (IRIS IU.ANMO)' text='seisplotjs fetches miniSEED; fromSeismogram() turns each Seismogram into StreamData (gaps held flat, codes from metadata).'>
      <button onClick={load}>load last 10 min (1 h ago)</button> <span style={{ fontSize: 13 }}>{state.status}</span>
      {state.streams && <SeismicStream streams={state.streams} displayHeight={360} />}
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

const EXAMPLES = { historical: HistoricalExample, live: LiveExample, stream: StreamExample, stations: StationsExample, helicorder: HelicorderExample, liveHelicorder: LiveHelicorderExample, heliStream: StreamingHelicorderExample, seisplotjs: SeisplotjsExample, fdsn: FdsnExample, mseed: MseedExample }
type Key = keyof typeof EXAMPLES

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
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
