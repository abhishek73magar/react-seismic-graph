# react-seismic-graph

Seismic plotting for the browser: a **waveform + spectrogram** canvas (Raspberry Shake DataView style), a **canvas helicorder**, and thin wrappers around **seisplotjs** (`<sp-helicorder>`, `<sp-seismograph>`). Use it from React or from plain HTML/JS.

**Live examples:** https://abhishek73magar.github.io/react-seismic-graph/ ([plain HTML version](https://abhishek73magar.github.io/react-seismic-graph/vanilla.html))

Extracted from the AlertNepal web app (`alertnepal_web_v3`, `components/Seismic`).

| Entry | What | Needs |
|---|---|---|
| `react-seismic-graph` | Framework-free core: `SpectrogramWidget`, `HelicorderWidget`, helpers | nothing |
| `react-seismic-graph/react` | React components (and re-exports the core) | `react`, `seisplotjs` |
| `react-seismic-graph/seisplotjs` | `renderSpHelicorder`, `renderSpSeismograph`, `parseMseed`, `loadMseed`, `streamsToMseed3`, `toSeismogram` | `seisplotjs` |
| `dist/seismic-graph.iife.js` | Core as one `<script>` file, global `SeismicGraph` | nothing |

## Install

```bash
npm i react-seismic-graph
# React components and seisplotjs wrappers also need:
npm i react seisplotjs
```

## Data shape

Every component takes plain samples. One channel is a `StreamData`:

```ts
interface StreamData {
  channel: string                       // 'HHZ'
  samples: ArrayLike<number>            // Float32Array, number[] ...
  sampleRate: number                    // samples per second
  startTime: number | string | Date     // time of samples[0] (UTC ms, ISO string or Date)
  endTime?: number | string | Date      // default: startTime + (n - 1) / sampleRate
  unit?: string                         // 'm/s', 'counts' ...
  pWaves?: PWave[]                      // markers for this channel
  network?: string                      // FDSN codes; filled from miniSEED / seisplotjs metadata
  station?: string
  location?: string
}

interface StationData { id: string; title?: string; streams: StreamData[] }

interface PWave { datetime: string; name?: string; type?: string; magnitude?: number; amplitude?: number }
```

Got seisplotjs `Seismogram`s (FDSN)? Convert them with `fromSeismogram`. It fills the channel and network/station/location codes from the seismogram's metadata, and holds the last sample across gaps:

```ts
import { fromSeismogram } from 'react-seismic-graph'
const stream = { ...fromSeismogram(seis), unit: 'counts' }
```

## miniSEED

Every component takes miniSEED directly through an `mseed` prop. Version 2 and 3 are both detected automatically. The prop accepts:
- raw bytes: an `ArrayBuffer` or `Uint8Array`, for example from your API
- a `File` or `Blob`, for example from `<input type="file">`
- a URL, for example an fdsnws `dataselect` query

Anything you don't pass is taken from the record headers:

| Not given | Taken from miniSEED |
|---|---|
| `stationId` | `NET.STA.LOC` |
| `channelCode` | first channel in the file (or pass one to pick it) |
| `sampleRate`, `samples`, `endTime` | the records |
| Helicorder `title`, `startTime`, `numLines` | `NET.STA.LOC.CHA`; the data's start, floored to a whole line; enough lines to cover the data |

```tsx
<SeismicGraph mseed={bytes} />                                   // first channel, names from headers
<SeismicGraph mseed={bytes} channelCode="HHN" stationId="My label" />  // pick a channel, override the name
<SeismicStream mseed={file} />                                   // every channel of the file
<SeismicStations mseed="https://service.earthscope.org/fdsnws/dataselect/1/query?net=IU&sta=ANMO&cha=BH?&start=...&end=..." />
<Helicorder mseed={bytes} channelCode="HHZ" lineDurationSec={60} />
<SpHelicorder mseed={bytes} lineDurationSec={60} />
<SpSeismograph mseed={bytes} />
```

### Download

Pass `downloadable` to show a download button. Each channel is saved as `NETWORK.STATION.LOCATION.CHANNEL.mseed`, for example `NP.KTM.00.HHZ.mseed`. An empty location stays empty, as in `IU.ANMO..BHZ.mseed`.

```tsx
<SeismicStream mseed={bytes} downloadable />        // toolbar button: one file per selected channel
<SeismicStations mseed={url} downloadable />        // a button per station
<SeismicGraph mseed={bytes} downloadable />         // the shown channel
<Helicorder mseed={file} downloadable />
```

- **miniSEED input:** the file holds that channel's original records, byte for byte, in the same version (v2 or v3). Nothing is re-encoded.
- **Plain `samples` input:** the samples are written as miniSEED 3. The codes come from the stream's `network`/`station`/`location` fields. If those are missing, the name comes from `stationId`, so `stationId="NP.KTM.00"` with channel `HHZ` saves `NP.KTM.00.HHZ.mseed`.
- **No data:** the button is disabled until there is data.

Without components: `downloadMseed(stream)`, `mseedFileName(stream)`, `mseedBytesOf(stream)`. Use `<DownloadButton streams={[...]} />` to place the button yourself.

A file holding several stations is grouped by `NET.STA.LOC` in `SeismicStations`. The props re-parse whenever the input identity changes, so memoize bytes you create during render.

Without components:

```ts
import { parseMseed, loadMseed, streamsToMseed3 } from 'react-seismic-graph/seisplotjs'

const streams = parseMseed(arrayBuffer)            // StreamData[] (sync)
const fromUrl = await loadMseed(url)               // also File / Blob
const bytes = streamsToMseed3(streams)             // StreamData[] -> miniSEED 3, e.g. for a download
for await (const chunk of streamMseed(url)) { }    // progressive: StreamData[] per batch of complete records
// React: const { streams, loading, error } = useMseed(input)
```

## React

### `SeismicGraph`: waveform, spectrogram, or both

```tsx
import { SeismicGraph } from 'react-seismic-graph/react'

<SeismicGraph
  stationId="NP.KTM.00.HHZ"
  channelCode="HHZ"
  unit="m/s"
  samples={samples}            // memoize it: a new array identity re-hydrates
  sampleRate={100}
  endTime={lastSampleUtcMs}    // where the time axis ends
  timeWindowSec={600}
  viewMode="dual"              // 'dual' | 'waveform' | 'spectrogram'
  theme="white"                // 'white' | 'dark'
  timeMode="UTC"               // 'local' or an IANA zone, e.g. 'Asia/Kathmandu'
  yMode="offset"               // 'offset' (mean removed) | 'raw'
  sensitivityPreset="normal"   // spectrogram colour range: 'normal' | 'high' | 'low'
  pWaves={[{ datetime: '2024-01-01T10:00:00Z', name: 'KTM', magnitude: 4.6 }]}
  displayHeight={450}
/>
```

Mouse: the wheel zooms, dragging pans, and a double-click (or the RESET badge) returns to live.

**Live data.** `onReady` hands you the widget. Push each packet into it, and return a cleanup function if you need one:

```tsx
const onReady = useCallback((widget) => {
  const off = socket.on('packet', (p) => widget.addSamples(p.samples, p.endTimeMs))
  return () => off()          // runs on unmount or widget rebuild
}, [])

<SeismicGraph stationId="NP.KTM.00.HHZ" timeWindowSec={60} onReady={onReady} />
```

**Linked graphs.** The graph supports controlled zoom and pan through `timeWindowSec` + `onTimeWindowChange` and `panOffsetSec` + `onPanChange`.

**Flags.** Set `flags`, `flagEditable`, `onFlagAdd`, `onFlagMove` and `onFlagRemove`. Click to add a flag, drag to move it, right-click to remove it.

### `SeismicStream`: all channels of one station

```tsx
import { SeismicStream } from 'react-seismic-graph/react'

<SeismicStream
  stationId="NP.KTM.00"
  streams={[hhz, hhn, hhe]}          // StreamData[]
  pWaves={pWaves}
  live={false}                       // true: axis ends at the freshest channel and hides the first 5 s
  defaultChannels={['HHZ']}
  defaultViewMode="dual"             // also 'seisplotjs'
  timeMode="local"
/>
```

It includes a channel picker (All / each channel), a light/dark toggle, a RAW/OFFSET toggle, linked zoom/pan, and a view mode switch. All channels share one time axis.

The toolbar uses built-in Material icons drawn as inline SVG, so no icon library is needed. To swap any of them, pass your own React nodes:

```tsx
import { FaMoon, FaSun } from 'react-icons/fa'

<SeismicStream icons={{ light: <FaSun />, dark: <FaMoon /> }} ... />
// names: dual, waveform, spectrogram, seisplotjs, light, dark, link, unlink
// the built-in ones are exported too: <Icon name="spectrogram" size={20} />
```

### `SeismicStations`: several stations

```tsx
import { SeismicStations } from 'react-seismic-graph/react'

<SeismicStations
  stations={[
    { id: 'NP.KTM.00', title: 'KTM - Kathmandu', streams: ktmStreams },
    { id: 'NP.PKR.00', title: 'PKR - Pokhara', streams: pkrStreams },
  ]}
  defaultViewMode="waveform"
/>
```

It accepts every `SeismicStream` prop except `stationId` and `streams`.

### `Helicorder`: our own canvas helicorder

Each line covers `lineDurationSec`. For example, a 1-hour window drawn as 1-minute lines is `numLines={60} lineDurationSec={60}`, and a full day drawn as 1-hour lines is the default `24 × 3600`.

The time axis under the plot switches to seconds when lines are 2 minutes or shorter. When rows get thin, only every k-th line gets a time label.

```tsx
import { Helicorder } from 'react-seismic-graph/react'

<Helicorder
  startTime="2024-01-01T00:00:00Z"   // first line; default: today 00:00 UTC
  numLines={24}
  lineDurationSec={3600}
  samples={daySamples}
  sampleRate={100}
  dataStartTime={firstSampleUtc}     // default: startTime
  gain={1}                           // 1 = a typical line peaks at 1/4 of its row
  clip                               // clip to ±1 row
  timeMode="UTC"
  theme="white"
  title="NP.KTM.00.HHZ"
  pWaves={pWaves}
  onClick={(ms) => openWindow(ms - 300_000, ms + 300_000)}
/>
```

- Missing data is stored as `NaN` and drawn as a gap.
- Each line has its own mean removed.
- One large event does not flatten the rest of the day, because the scale comes from the median line.

**Streamed history.** If historical data arrives in pieces, for example a paged API, a socket replay or a large miniSEED download, pass it as `stream`. Each piece is plotted at its own time as it lands:

```tsx
// any async iterable of StreamData (or StreamData[]) works; pass a factory so remounts can restart it
const stream = useCallback(async function* () {
  for (let page = 0; page < 60; page++) {
    const res = await fetch(`/api/history?station=KTM&channel=HHZ&page=${page}`)
    yield await res.json()          // { channel, sampleRate, startTime, samples, network?, station?, location? }
  }
}, [])

<Helicorder stream={stream} lineDurationSec={60} downloadable />
<SpHelicorder stream={stream} start={start} end={end} lineDurationSec={60} />
```

How it behaves:
- Without `startTime`, the range starts at the first piece, floored to a whole line.
- Without `numLines`, lines are added as data arrives.
- The title comes from the first piece's codes.
- A "Loading… N samples" line is shown until the source ends. An error message is shown if it fails.
- Gaps between pieces stay empty.
- Pieces of other channels, or with another sample rate, are skipped.
- The download button turns on when loading finishes. It saves all received records as one `NET.STA.LOC.CHA.mseed`.

`mseed={url | File | bytes}` uses the same path. Records are parsed as the bytes arrive: from the fetch body, from `Blob.stream()`, or from 1 MB slices of in-memory bytes with a pause between slices so the page can redraw.

`SpHelicorder` redraws at most every 500 ms, because seisplotjs redraws the whole drum on each update.

**Live helicorder.** `onReady` returns the widget. Call `widget.addSamples(samples, packetStartTime)` for each packet, and each packet lands at its own time.

### seisplotjs components

```tsx
import { SpHelicorder, SpSeismograph } from 'react-seismic-graph/react'

<SpHelicorder data={seismograms /* or StreamData */} start={dayStart} end={dayEnd} lineDurationSec={3600} timeZone="UTC" pWaves={pWaves} onClick={(ms) => ...} />
// lineDurationSec: 3600 = 1 h per line (default), 60 = 1 min per line, 600 = 10 min ...
<SpSeismograph data={[hhz, hhn]} unit="m/s" channel="HHZ" pWaves={pWaves} style={{ height: 240 }} />
```

Both accept a `configure(config)` callback, so you can set any other seisplotjs config field.

## Plain HTML / vanilla JS

You can load it as an ES module:

```html
<div><canvas id="graph"></canvas></div>   <!-- canvas sizes to its parent's width -->
<div><canvas id="heli"></canvas></div>

<script type="module">
  import { SpectrogramWidget, HelicorderWidget } from 'https://cdn.jsdelivr.net/npm/react-seismic-graph/dist/index.js'

  const graph = new SpectrogramWidget(document.getElementById('graph'), {
    stationId: 'NP.KTM.00.HHZ', channel: 'HHZ', unit: 'm/s',
    sampleRate: 100, timeWindowSec: 120, viewMode: 'dual', theme: 'dark', timeMode: 'UTC',
  })
  graph.hydrateHistorical(samples, 100, lastSampleUtcMs)  // history
  graph.addSamples(packet, packetEndUtcMs)                // live, per packet
  graph.setViewMode('spectrogram')                        // setTheme, setTimeWindow, setPWaves, setYMode ...
  // graph.destroy() when removing it

  const heli = new HelicorderWidget(document.getElementById('heli'), {
    startTime: Date.UTC(2024, 0, 1), numLines: 24, lineDurationSec: 3600, sampleRate: 100,
    onClick: (ms) => console.log(new Date(ms)),
  })
  heli.setData(daySamples, 100, Date.UTC(2024, 0, 1))
  heli.addSamples(packet, packetStartUtcMs)
  // streamed history: any async iterable of StreamData; with seisplotjs: streamMseed(url | file | bytes)
  await heli.consume(pages, { autoStart: true, autoGrow: true, onChunk: (c, total) => {} })
</script>
```

You can also use a classic script tag. This build contains the core only, with no seisplotjs:

```html
<script src="https://cdn.jsdelivr.net/npm/react-seismic-graph/dist/seismic-graph.iife.js"></script>
<script>
  const graph = new SeismicGraph.SpectrogramWidget(canvas, { sampleRate: 100 })
</script>
```

To use the seisplotjs web components from plain JS, import from `react-seismic-graph/seisplotjs`. Your bundler or import map must be able to resolve `seisplotjs`:

```js
import { renderSpHelicorder, renderSpSeismograph } from 'react-seismic-graph/seisplotjs'
renderSpSeismograph(document.querySelector('sp-seismograph'), streamData, { unit: 'm/s' })
const off = renderSpHelicorder(document.querySelector('sp-helicorder'), seismograms, { start, end, onClick: (ms) => {} })
```

## Theming

Both widgets accept per-theme colour overrides:

```ts
new SpectrogramWidget(canvas, { colors: { white: { trace: '#16a34a' }, dark: { background: '#0b1020' } }, fonts: { label: '11px monospace' } })
widget.setColors('dark', { trace: '#0f0' })
// React: <SeismicGraph colors={...} fonts={...} />, <Helicorder colors={{ white: { lineColors: ['#000', '#c00'] } }} />
```

The full key lists are exported as `DEFAULT_COLORS` / `DEFAULT_FONTS` (spectrogram) and `HELI_COLORS` (helicorder).

## Examples

```bash
pnpm i
pnpm dev        # http://localhost:7000: React examples + /vanilla.html
pnpm build:examples   # static site in site/, deployed to GitHub Pages on every push to main
```

| Example | Shows |
|---|---|
| `historical` | `SeismicGraph` with view/theme switch |
| `live` | `SeismicGraph` fed through `onReady` + `addSamples` |
| `stream` | `SeismicStream`: 3 channels of one station |
| `stations` | `SeismicStations`: station-wise |
| `helicorder` | Own `Helicorder`, default last 1 h in 1-min lines (window and line length pickers); clicking a line opens ±5 min in `SeismicGraph` |
| `liveHelicorder` | `Helicorder` with 60 × 1-min lines, live |
| `heliStream` | 1 h of history arriving as 60 one-minute pages: `Helicorder` + `SpHelicorder` with `stream`, loading progress, download |
| `seisplotjs` | `SpHelicorder` (default last 1 h in 1-min lines) + `SpSeismograph` |
| `fdsn` | Real data from IRIS (IU.ANMO) via seisplotjs `DataSelectQuery` |
| `mseed` | `mseed` prop with in-browser miniSEED 3 bytes, your own file, and an fdsnws URL (miniSEED 2); names from headers |
| `vanilla.html` | Core widgets + seisplotjs in plain HTML, no React |

The examples use synthetic data (`examples/synthetic.ts`); the `fdsn` example loads real data.

## Develop

```bash
pnpm test        # core logic checks (node, no browser)
pnpm typecheck
pnpm build       # dist/: ESM + CJS per entry, IIFE core, .d.ts
```

## Publish

**From GitHub Actions (recommended).** `.github/workflows/publish.yml` publishes when a `v*` tag is pushed. It uses npm Trusted Publishing, so no npm token is stored in GitHub. `.github/workflows/ci.yml` runs test, typecheck and build on every push to `main` and on every pull request.

```bash
npm version patch          # bumps package.json and creates tag v0.1.1
git push --follow-tags     # the workflow checks tag == version, runs the checks, publishes
```

**By hand:**

`prepublishOnly` runs `test`, `typecheck` and `build` automatically before every `npm publish`, so a broken build never ships.

```bash
npm login
npm version patch       # or minor / major
pnpm release:dry        # full check + build, shows the tarball, uploads nothing
pnpm release            # npm publish --access public
```
