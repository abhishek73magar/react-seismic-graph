// smallest checks for the non-drawing logic; run: pnpm test
import assert from 'node:assert/strict'

// just enough DOM for the widgets' constructors (drawing calls become no-ops)
const noop = () => {}
const ctx = new Proxy({}, { get: (_t, k) => k === 'measureText' ? () => ({ width: 10 }) : k === 'createImageData' ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : noop, set: () => true })
const makeCanvas = () => ({ width: 0, height: 0, style: {}, parentElement: { getBoundingClientRect: () => ({ width: 862 }) }, getContext: () => ctx, addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 862 }) })
Object.assign(globalThis, {
  window: { devicePixelRatio: 1, addEventListener: noop, removeEventListener: noop },
  document: { createElement: makeCanvas },
  getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0' }),
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: noop,
})

const { seismogramToContiguous } = await import('../src/core/seismogram.ts')
const { formatTime } = await import('../src/core/time.ts')
const { HelicorderWidget } = await import('../src/core/HelicorderWidget.ts')
const { RealFFT, RaspTraceWidget } = await import('../src/core/SpectrogramWidget.ts')

// gap held flat, segments placed by time
const seg = (y: number[], t: number) => ({ y: Float32Array.from(y), sampleRate: 1, startTime: t, endTime: t + (y.length - 1) * 1000 })
assert.deepEqual(Array.from(seismogramToContiguous({ segments: [seg([1, 2], 0), seg([5, 6], 4000)], sampleRate: 1, startTime: 0, endTime: 5000 })), [1, 2, 2, 2, 5, 6])

assert.equal(formatTime(Date.UTC(2024, 0, 1, 13, 5, 9), 'UTC'), '13:05:09')
assert.equal(formatTime(Date.UTC(2024, 0, 1, 0, 0, 0), 'Asia/Kathmandu', false), '05:45')

// FFT: sine at bin 16 of 256 peaks at bin 16
const fft = new RealFFT(256)
const psd = fft.forward(Array.from({ length: 256 }, (_, i) => Math.sin((2 * Math.PI * 16 * i) / 256)))
assert.equal(psd.indexOf(Math.max(...psd)), 16)

// helicorder: 4 lines x 10 s at 10 sps
const start = Date.UTC(2024, 0, 1)
const heli = new HelicorderWidget(makeCanvas() as unknown as HTMLCanvasElement, { startTime: start, numLines: 4, lineDurationSec: 10, sampleRate: 10 })
heli.addSamples(new Array(150).fill(1), start + 5000) // 5 s .. 20 s: lines 0 and 1
assert.deepEqual([...heli.dirty].sort(), [0, 1, 2, 3])
assert.equal(heli.data[49], NaN, 'before data stays empty')
assert.equal(heli.data[50], 1)
assert.equal(heli.data[199], 1)
assert.ok(Number.isNaN(heli.data[200]))
heli.addSamples([1, 2, 3], start - 100) // partly before range: only the in-range part lands
assert.equal(heli.data[0], 2)
assert.equal(heli.data[1], 3)
heli.render()
assert.equal(heli.dirty.size, 0)
assert.ok(Number.isNaN(heli.envMin[3][0]), 'empty line is a gap')
const p = heli.plot
assert.equal(heli.timeAt(p.x + p.width / 2, p.y + p.lineH * 1.5), start + 15000) // middle of line 1
assert.equal(heli.timeAt(p.x - 1, p.y + 1), null)

// consume: chunks streamed in, range starts at the first chunk (floored), lines grow as data arrives
const heli2 = new HelicorderWidget(makeCanvas() as unknown as HTMLCanvasElement, { lineDurationSec: 10, sampleRate: 100 })
async function* chunks() {
  for(let i = 0; i < 25; i++) yield { channel: 'HHZ', sampleRate: 10, startTime: start + 3000 + i * 1000, samples: new Array(10).fill(i) }
  yield { channel: 'HHN', sampleRate: 10, startTime: start, samples: [99] } // other channel: skipped
}
const res = await heli2.consume(chunks(), { autoStart: true, autoGrow: true })
assert.equal(res.total, 250)
assert.equal(heli2.startMs, start)            // 3 s floored to the 10 s line
assert.equal(heli2.sampleRate, 10)            // taken from the data
assert.equal(heli2.numLines, 3)               // 3 s .. 28 s needs lines 0..2
assert.ok(Number.isNaN(heli2.data[29]))       // before first chunk: empty
assert.equal(heli2.data[30], 0)
assert.equal(heli2.data[279], 24)
heli2.render()
assert.equal(heli2.envMin.length, 3)
assert.ok(!Number.isNaN(heli2.envMin[2][0]), 'grown line got its envelope')

// spectrogram widget: hydrate fills buffer and FFT columns, axis ends at given time
const w = new RaspTraceWidget(makeCanvas() as unknown as HTMLCanvasElement, { sampleRate: 100 })
w.hydrateHistorical(new Float32Array(1000).map((_, i) => Math.sin(i / 3)), 100, start + 10000)
assert.equal(w.buffer.length, 1000)
assert.equal(w.totalColumnsPushed, Math.floor((1000 - 256) / w.stepSamples) + 1)
assert.equal(w.lastSampleUtc, start + 10000)
w.destroy()

// grouping + ids from metadata
const { groupStations, stationIdOf } = await import('../src/core/seismogram.ts')
const mk = (network: string, station: string, channel: string) => ({ network, station, location: '00', channel, samples: [1], sampleRate: 1, startTime: 0 })
const groups = groupStations([mk('NP', 'KTM', 'HHZ'), mk('NP', 'PKR', 'HHZ'), mk('NP', 'KTM', 'HHN')])
assert.deepEqual(groups.map(g => [g.id, g.streams.map(s => s.channel)]), [['NP.KTM.00', ['HHZ', 'HHN']], ['NP.PKR.00', ['HHZ']]])
assert.equal(stationIdOf(undefined), 'unknown')

console.log('core ok')

// canvas colours from CSS variables: prop > --rsg-dark-<key> > --rsg-<key> > --rsg-primary > default; var() resolved
{
  const { resolveColors } = await import('../src/core/css.ts')
  const vars: Record<string, string> = { '--rsg-primary': '#111', '--rsg-background': '#222', '--rsg-dark-background': '#333', '--brand': '#444' }
  const saved = globalThis.getComputedStyle
  Object.assign(globalThis, { getComputedStyle: () => ({ getPropertyValue: (n: string) => vars[n] ?? '' }) })
  const el = {} as Element
  const defaults = { trace: '#000', background: '#fff', grid: '#ccc', lines: ['#a', '#b'] }
  assert.deepEqual(resolveColors(el, 'white', defaults, {}, ['trace']), { trace: '#111', background: '#222', grid: '#ccc', lines: ['#a', '#b'] })
  assert.equal(resolveColors(el, 'dark', defaults).background, '#333')
  assert.equal(resolveColors(el, 'white', defaults, { background: 'red' }).background, 'red')
  assert.equal(resolveColors(el, 'white', defaults, { grid: 'var(--brand)', trace: 'var(--nope, var(--brand))', background: 'var(--nope)' }).grid, '#444')
  assert.equal(resolveColors(el, 'white', defaults, { trace: 'var(--nope, var(--brand))' }).trace, '#444')
  assert.equal(resolveColors(el, 'white', defaults, { background: 'var(--nope)' }).background, '#fff')
  assert.equal(resolveColors(null, 'white', defaults, {}, ['trace']).trace, '#000')
  Object.assign(globalThis, { getComputedStyle: saved })
  console.log('ok resolveColors')
}
