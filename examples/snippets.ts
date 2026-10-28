// copy-paste usage shown under each example; real-app shape (your API / socket), not the synthetic demo data
const STREAM_SHAPE = `// one channel = StreamData, e.g. straight from your API response:
// {
//   "channel": "HHZ",
//   "sampleRate": 100,
//   "startTime": "2024-05-01T10:00:00Z",   // or UTC ms / Date
//   "unit": "m/s",
//   "samples": [12, 15, -3, ...]            // number[] or Float32Array
// }`

export const CODE: Record<string, string> = {
  historical: `import { SeismicGraph } from 'react-seismic-graph/react'

${STREAM_SHAPE}

export function Trace({ stream }) {
  return (
    <SeismicGraph
      stationId="NP.KTM.00.HHZ"
      channelCode={stream.channel}
      unit={stream.unit}
      samples={stream.samples}          // memoize: a new array identity re-hydrates
      sampleRate={stream.sampleRate}
      endTime={Date.now()}              // time axis ends here
      timeWindowSec={600}               // visible seconds
      viewMode="dual"                   // 'dual' | 'waveform' | 'spectrogram'
      theme="white"                     // 'white' | 'dark'
      pWaves={[{ datetime: '2024-05-01T10:06:00Z', name: 'KTM', type: 'Earthquake', magnitude: 4.6 }]}
      downloadable                      // NET.STA.LOC.CHA.mseed button
    />
  )
}`,

  live: `import { useCallback } from 'react'
import { SeismicGraph, type SpectrogramWidget } from 'react-seismic-graph/react'

// socket message, e.g. { "channel": "HHZ", "samples": [..50 values..], "endTime": 1714557600500 }
export function LiveTrace({ socket }) {
  const onReady = useCallback((widget: SpectrogramWidget) => {
    const onMsg = (e: MessageEvent) => {
      const p = JSON.parse(e.data)
      widget.addSamples(p.samples, p.endTime)   // UTC ms of the packet's last sample
    }
    socket.addEventListener('message', onMsg)
    return () => socket.removeEventListener('message', onMsg)   // cleanup on unmount / rebuild
  }, [socket])

  return <SeismicGraph stationId="NP.KTM.00.HHZ" channelCode="HHZ" unit="counts" sampleRate={100} timeWindowSec={60} theme="dark" onReady={onReady} />
}`,

  stream: `import { SeismicStream } from 'react-seismic-graph/react'

// API response: all channels of one station
// [
//   { "channel": "HHZ", "sampleRate": 100, "startTime": "2024-05-01T10:00:00Z", "unit": "m/s", "samples": [...] },
//   { "channel": "HHN", ... },
//   { "channel": "HHE", ... }
// ]
export function Station({ streams }) {
  return (
    <SeismicStream
      stationId="NP.KTM.00"
      streams={streams}
      defaultChannels={['HHZ', 'HHE']}   // shown at start; toolbar picks the rest
      displayHeight={360}
      downloadable
    />
  )
}`,

  stations: `import { SeismicStations, type StationData } from 'react-seismic-graph/react'

// API response: one entry per station
// [
//   { "id": "NP.KTM.00", "title": "KTM - Kathmandu", "streams": [ { "channel": "HHZ", ... }, ... ] },
//   { "id": "NP.PKR.00", "title": "PKR - Pokhara",   "streams": [ ... ] }
// ]
export function Network({ stations }: { stations: StationData[] }) {
  // zoom sync built in: press ↻ in the toolbars (or defaultSynced to start synced)
  return <SeismicStations stations={stations} defaultViewMode="waveform" displayHeight={300} />
}`,

  zoomSync: `import { SeismicStream, ZoomSync } from 'react-seismic-graph/react'

// each station: StreamData[] from your API (different start / end times are fine, they line up on UTC)
export function SyncedStations({ ktm, pkr, brt }) {
  return (
    <ZoomSync>
      <SeismicStream stationId="NP.KTM.00" streams={ktm} defaultSynced />   {/* synced from the start */}
      <SeismicStream stationId="NP.PKR.00" streams={pkr} defaultSynced />
      <SeismicStream stationId="NP.BRT.00" streams={brt} />                 {/* ↻ to join: snaps to the shared view */}
    </ZoomSync>
  )
}

// the streams don't have to be siblings: put <ZoomSync> high up (page / layout) and any SeismicStream below it can sync`,

  helicorder: `import { Helicorder } from 'react-seismic-graph/react'

// one long channel, e.g. 24 h at 20 sps: { "channel": "HHZ", "sampleRate": 20, "startTime": 1714521600000, "samples": [...] }
export function Drum({ day, onPick }) {
  return (
    <Helicorder
      samples={day.samples}
      sampleRate={day.sampleRate}
      dataStartTime={day.startTime}     // time of samples[0]
      startTime={day.startTime}         // first line
      numLines={24}
      lineDurationSec={3600}            // 1 h per line (60 = 1 min, 600 = 10 min ...)
      title="NP.KTM.00.HHZ"
      timeMode="UTC"
      gain={1}
      onClick={(ms) => onPick(ms)}      // UTC ms of the clicked point
    />
  )
}`,

  liveHelicorder: `import { useCallback } from 'react'
import { Helicorder, type HelicorderWidget } from 'react-seismic-graph/react'

// history response + socket packets: { "samples": [...], "startTime": 1714557600000 }  (packet START time)
export function LiveDrum({ history, socket }) {
  const onReady = useCallback((w: HelicorderWidget) => {
    w.setData(history.samples, 50, history.startTime)
    const onMsg = (e: MessageEvent) => { const p = JSON.parse(e.data); w.addSamples(p.samples, p.startTime) }
    socket.addEventListener('message', onMsg)
    return () => socket.removeEventListener('message', onMsg)
  }, [history, socket])

  return <Helicorder startTime={history.startTime} numLines={60} lineDurationSec={60} sampleRate={50} theme="dark" onReady={onReady} />
}`,

  heliStream: `import { useCallback } from 'react'
import { Helicorder } from 'react-seismic-graph/react'

// paged API: each page = { "channel": "HHZ", "sampleRate": 100, "startTime": ..., "samples": [...], "network"?, "station"?, "location"? }
export function PagedDrum() {
  // a factory, not a generator: survives remounts
  const stream = useCallback(async function* () {
    for (let page = 0; page < 60; page++) {
      const res = await fetch(\`/api/history?station=KTM&channel=HHZ&page=\${page}\`)
      yield await res.json()
    }
  }, [])

  return <Helicorder stream={stream} lineDurationSec={60} timeMode="UTC" downloadable />
}`,

  mseed: `import { SeismicStream, SeismicStations, Helicorder } from 'react-seismic-graph/react'

// miniSEED v2 / v3: ArrayBuffer | Uint8Array | File | Blob | URL. Codes, rate and times come from the record headers.
<SeismicStream mseed={arrayBuffer} />                                  // every channel of one station
<SeismicStations mseed={file} downloadable />                          // a file with many stations
<SeismicStations mseed="https://service.earthscope.org/fdsnws/dataselect/1/query?net=IU&sta=ANMO&cha=BH?&start=...&end=..." />
<Helicorder mseed={url} channelCode="BHZ" lineDurationSec={60} />

// <input type="file" onChange={e => setFile(e.target.files?.[0] ?? null)} />`,

  theming: `import { SeismicStream } from 'react-seismic-graph/react'

/* toolbar: CSS variables + your own classes */
// .brand { --rsg-active-bg: #16a34a; --rsg-btn-radius: 999px; --rsg-toolbar-bg: #f0fdf4; }
// .brand .chip-active { box-shadow: 0 0 0 2px #86efac; }

const TRACE = { HHZ: '#dc2626', HHN: '#16a34a', HHE: '#7c3aed' }

<SeismicStream
  className="brand"
  classNames={{ buttonActive: 'chip-active' }}       // parts: root, toolbar, group, label, button, buttonActive, row ...
  streams={streams}
  colors={(channel) => ({ white: { trace: TRACE[channel] }, dark: { trace: TRACE[channel] } })}   // canvas, per channel
/>
// unstyled  -> no built-in inline styles at all (e.g. Tailwind via classNames)`,

  cssColors: `/* global default for every graph + helicorder (or put it on any wrapper class) */
:root {
  --rsg-primary: #7c3aed;           /* toolbar active button + trace (helicorder: first line colour) */
  --rsg-background: #faf5ff;        /* any palette key in kebab-case */
  --rsg-grid: rgba(124, 58, 237, 0.2);
  --rsg-dark-primary: #c4b5fd;      /* --rsg-dark-<key>: dark theme only */
  --rsg-dark-background: #1e1b4b;
}

// a colors value can be a variable too; the colors prop wins over CSS variables
<SeismicStream
  streams={streams}
  colors={(ch) => ch === 'HHE' ? { white: { trace: 'var(--brand-accent)' } } : undefined}
/>

// changed the variables yourself (e.g. a .dark class on <html>)? re-read them:
// onReady={(channel, widget) => { /* keep widget */ }}  ...  widget.refreshColors()`,
}
