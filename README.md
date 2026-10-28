# react-seismic-graph

Seismic plotting for the browser: a **waveform + spectrogram** canvas (Raspberry Shake DataView style), a **canvas helicorder**, and a built-in miniSEED v2/v3 reader. No runtime dependencies (React only for the React components). Use it from React or from plain HTML/JS.

**Live examples:** https://abhishek73magar.github.io/react-seismic-graph/ ([plain HTML version](https://abhishek73magar.github.io/react-seismic-graph/vanilla.html))

Extracted from the AlertNepal web app (`alertnepal_web_v3`, `components/Seismic`).

| Entry | What | Needs |
|---|---|---|
| `react-seismic-graph` | Framework-free core: `SpectrogramWidget`, `HelicorderWidget`, miniSEED decoding, helpers | nothing |
| `react-seismic-graph/react` | React components (and re-exports the core) | `react` |
| `react-seismic-graph/mseed` | miniSEED only: `parseMseed`, `streamMseed`, `loadMseed`, `streamsToMseed3`, `decodeRecords`, downloads | nothing |
| `dist/seismic-graph.iife.js` | Core as one `<script>` file, global `SeismicGraph` | nothing |

## Install

```bash
npm i react-seismic-graph
# React components also need react:
npm i react
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

Every component takes miniSEED directly through an `mseed` prop. Version 2 and 3 are both detected automatically, and decoding is built in (no seisplotjs): int16, int32, float32, float64, Steim1 and Steim2. The prop accepts:
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
import { parseMseed, loadMseed, streamMseed, streamsToMseed3, decodeRecords } from 'react-seismic-graph/mseed'

const streams = parseMseed(arrayBuffer)            // StreamData[] (sync)
const fromUrl = await loadMseed(url)               // also File / Blob
const bytes = streamsToMseed3(streams)             // StreamData[] -> miniSEED 3, e.g. for a download
for await (const chunk of streamMseed(url)) { }    // progressive: StreamData[] per batch of complete records
const records = decodeRecords(new Uint8Array(frame)) // raw records: codes, startTime (UTC ms), sampleRate, samples
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

**Colors.** Canvas colours (trace, grid, background, tooltips, ...) come from CSS variables or the `colors` prop (see [Theming](#theming)). `colors` / `fonts` are per theme (`white` / `dark`), and any key you leave out keeps its default from `DEFAULT_COLORS` / `DEFAULT_FONTS` in `src/core/SpectrogramWidget.ts` — so a client that sends nothing gets the built-in look, and one that sends a partial palette only overrides what it specifies:

```tsx
<SeismicGraph
  colors={{ white: { trace: '#16a34a', background: '#fafafa' }, dark: { trace: '#22d3ee' } }}
  fonts={{ label: '11px monospace' }}
  ...
/>
```

Both props are reactive: passing a new object re-applies the palette/fonts on the live widget (via `widget.setPalette()` / `widget.setFonts()`) without rebuilding it. Imperatively: `widget.setPalette({ white: { trace: '#16a34a' } })`, `widget.setFonts({ label: '11px monospace' })`, or `widget.setColors('dark', { trace: '#0f0' })` to tweak just one theme at a time.

### `SeismicStream`: all channels of one station

```tsx
import { SeismicStream } from 'react-seismic-graph/react'

<SeismicStream
  stationId="NP.KTM.00"
  streams={[hhz, hhn, hhe]}          // StreamData[]
  pWaves={pWaves}
  live={false}                       // true: axis ends at the freshest channel and hides the first 5 s
  defaultChannels={['HHZ']}
  defaultViewMode="dual"             // 'dual' | 'waveform' | 'spectrogram'
  timeMode="local"
/>
```

It includes a channel picker (All / each channel), a light/dark toggle, a RAW/OFFSET toggle, linked zoom/pan, and a view mode switch (dual / waveform / spectrogram). All channels share one time axis.

**Live channels.** List the channels with no samples and pass `onReady(channel, widget)`: each graph is drawn empty and you push packets into it. Return a cleanup to unsubscribe.

```tsx
const streams = useMemo(() => ['HHZ', 'HHN', 'HHE'].map(channel => ({ channel, samples: [], sampleRate: 100, startTime: 0 })), [])
const onReady = useCallback((channel, widget) => {
  return feed.subscribe(channel, (samples, lastSampleMs) => widget.addSamples(samples, lastSampleMs))
}, [])

<SeismicStream stationId="NP.KTM.00" streams={streams} live onReady={onReady} />
```

**Flags.** `flags` (each with a `channel_code`), `flagEditable`, `onFlagAdd(ms, channel)`, `onFlagMove`, `onFlagRemove`: every graph shows its own channel's flags.

The toolbar uses built-in Material icons drawn as inline SVG, so no icon library is needed. To swap any of them, pass your own React nodes:

```tsx
import { FaMoon, FaSun } from 'react-icons/fa'

<SeismicStream icons={{ light: <FaSun />, dark: <FaMoon /> }} ... />
// names: dual, waveform, spectrogram, light, dark, link, unlink, download, realtime, close
// the built-in ones are exported too: <Icon name="spectrogram" size={20} />
```

**Realtime toggle and close button.** Both are opt-in and controlled by the parent — the component never starts/stops a feed or closes itself on its own:

```tsx
<SeismicStream
  // shown only when both are given; each returns the state it actually ended up in (true = enabled)
  onRealtimeEnable={() => { startFeed(); return true }}
  onRealtimeDisable={() => { stopFeed(); return false }}
  onClose={() => setVisible(false)}   // shows a close (X) button; omit the prop to hide it
  ...
/>
```

**Styling.** `colors` and `fonts` are forwarded to every channel's `SeismicGraph` (canvas colours, see above); `colors` can also be a function so each channel gets its own palette:

```tsx
<SeismicStream colors={(channel) => ({ white: { trace: CHANNEL_COLOR[channel] } })} ... />
```

The toolbar (channel picker, theme/offset/link/view buttons, rows, station headers) is a separate concern from canvas colours, and can be restyled three ways, without touching the component:

1. **CSS variables** — no props needed, just a class on an ancestor (or `className` on `SeismicStream`/`SeismicStations`):
   ```css
   .brand { --rsg-active-bg: #16a34a; --rsg-btn-radius: 999px; --rsg-toolbar-bg: #f0fdf4; --rsg-row-bg: #fafafa; }
   ```
2. **`classNames`** — add your own class per part, on top of the fixed `rsg-*` classes (`rsg-root`, `rsg-toolbar`, `rsg-button`, `rsg-button[aria-pressed="true"]`, `rsg-row`, ...):
   ```tsx
   <SeismicStream classNames={{ buttonActive: 'chip-active', row: 'my-row' }} ... />
   ```
   Parts: `root`, `toolbar`, `group`, `label`, `button`, `buttonActive`, `row`, `empty`, `station`, `stationHeader`.
3. **`unstyled`** — drops every built-in inline style (the `rsg-*` classes are still applied), so you style everything yourself, e.g. with Tailwind:
   ```tsx
   <SeismicStream unstyled classNames={{ toolbar: 'flex justify-between p-2' }} ... />
   ```

`STYLES` and the `ClassNames`/`StylePart` types are exported from `react-seismic-graph/react` if you want to read or reuse the defaults.

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

### Zoom sync across stations

Each station's toolbar gets a sync button (↻) when it sits inside a `ZoomSync` — `SeismicStations` adds one itself. Synced stations share one zoom/pan: wheel-zoom or drag any of them and the rest follow, lined up on UTC time even when their data starts or ends at different times. Turning sync on for a station that was zoomed on its own snaps it to the shared view; turning it off keeps the current view, so nothing jumps. Double-click resets the shared view. The channel link button inside one station works as before (only linked channels follow the sync).

```tsx
import { SeismicStream, ZoomSync } from 'react-seismic-graph/react'

<ZoomSync>
  <SeismicStream stationId="NP.KTM.00" streams={ktm} defaultSynced />   {/* starts synced */}
  <SeismicStream stationId="NP.PKR.00" streams={pkr} defaultSynced />
  <SeismicStream stationId="NP.BRT.00" streams={brt} />                 {/* joins on click */}
</ZoomSync>

<SeismicStations stations={stations} defaultSynced />   // every station synced from the start
```

`ZoomSync` can wrap anything: the streams don't have to be siblings. Nested `SeismicStations` inside a `ZoomSync` join the outer group.

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

**Channel picker and date select.** Pass `channels` to show a channel button per entry in the toolbar heading; the active one is found by matching `channelCode` against each entry's `channel_code`. Pass `onDateChange` to also show a date input. Neither prop changes `channelCode` / `startTime` itself — the component is controlled, so you re-render with the new value:

```tsx
<Helicorder
  channelCode={channelCode}
  channels={[
    { channel_code: 'HHZ', unit: 'm/s', gain: 1, azimuth: 0, dip: -90, depth: 0 },
    { channel_code: 'HHN', unit: 'm/s', gain: 1, azimuth: 0, dip: 0, depth: 0 },
  ]}
  onChannelChange={(channel) => setChannelCode(channel.channel_code)} // full Channel info, not just the code
  startTime={day}
  onDateChange={(ms) => setDay(ms)}                                  // UTC midnight of the picked day
/>
```

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

**Live helicorder.** `onReady` returns the widget. Call `widget.addSamples(samples, packetStartTime)` for each packet, and each packet lands at its own time.

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
  // streamed history: any async iterable of StreamData, e.g. streamMseed(url | file | bytes)
  await heli.consume(pages, { autoStart: true, autoGrow: true, onChunk: (c, total) => {} })
</script>
```

You can also use a classic script tag. This build contains the core only:

```html
<script src="https://cdn.jsdelivr.net/npm/react-seismic-graph/dist/seismic-graph.iife.js"></script>
<script>
  const graph = new SeismicGraph.SpectrogramWidget(canvas, { sampleRate: 100 })
</script>
```

## Theming

**CSS variables.** Both canvases read CSS custom properties from the canvas (inherited, so set them on `:root` for a global default or on any wrapper):

```css
:root {
  --rsg-primary: #16a34a;          /* toolbar active button + waveform trace (helicorder: first line colour) */
  --rsg-background: #fafafa;       /* any palette key in kebab-case: --rsg-grid, --rsg-tooltip-bg, --rsg-p-wave-line ... */
  --rsg-dark-primary: #4ade80;     /* --rsg-dark-<key>: dark theme only, else --rsg-<key> applies to both */
  --rsg-dark-background: #052e16;
}
```

Order per key: `colors` prop > `--rsg-dark-<key>` (dark theme) > `--rsg-<key>` > `--rsg-primary` (trace, tooltip) > built-in default. A `colors` value may itself be a variable: `colors={{ white: { trace: 'var(--brand, #0284c7)' } }}`. Variables are read on mount, theme change, resize and `setPalette`/`setColors`; after changing them yourself (e.g. a CSS dark-mode class), call `widget.refreshColors()`.

**Per-theme overrides in JS:**

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
| `stations` | `SeismicStations`: station-wise, with the built-in zoom sync |
| `zoomSync` | `ZoomSync` around three `SeismicStream`s with different time ranges; two start synced, one joins on click |
| `helicorder` | Own `Helicorder`, default last 1 h in 1-min lines (window and line length pickers); clicking a line opens ±5 min in `SeismicGraph` |
| `liveHelicorder` | `Helicorder` with 60 × 1-min lines, live |
| `heliStream` | 1 h of history arriving as 60 one-minute pages: `Helicorder` with `stream`, loading progress, download |
| `mseed` | `mseed` prop with in-browser miniSEED 3 bytes, your own file, and an fdsnws URL (miniSEED 2); names from headers |
| `cssColors` | Canvas + toolbar colours from CSS variables (`--rsg-primary`, `--rsg-dark-*`), one channel via `var()` in `colors` |
| `vanilla.html` | Core widgets in plain HTML, no React, colours from CSS variables |

The examples use synthetic data (`examples/synthetic.ts`); the `mseed` example can load real data from an fdsnws URL.

## Develop

```bash
pnpm test        # core logic checks (node, no browser); decoder compared with seisplotjs (devDependency, test only) on real FDSN files in test/fixtures
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
