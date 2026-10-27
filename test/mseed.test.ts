// miniSEED round trip through seisplotjs: written v3 bytes parse back with samples + codes
import assert from 'node:assert/strict'
// seisplotjs defines web components at import time: just enough DOM for that
class Fake {}
Object.assign(globalThis, { HTMLElement: Fake, customElements: { define() {}, get() {} }, window: globalThis, document: { createElement: () => ({}) } })
const { parseMseed, streamsToMseed3, mseedFileName, mseedBytesOf, streamMseed } = await import('../src/seisplotjs/mseed.ts')

const start = Date.UTC(2024, 0, 1, 10)
const samples = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i / 10) * 100)
const bytes = streamsToMseed3([
  { network: 'NP', station: 'KTM', location: '00', channel: 'HHZ', sampleRate: 100, startTime: start, samples },
  { network: 'NP', station: 'PKR', location: '', channel: 'HHN', sampleRate: 50, startTime: start, samples: samples.subarray(0, 100) },
])
const streams = parseMseed(bytes)
assert.equal(streams.length, 2)
const z = streams.find(s => s.channel === 'HHZ')!
assert.deepEqual([z.network, z.station, z.location, z.sampleRate, z.startTime], ['NP', 'KTM', '00', 100, start])
assert.equal(z.samples.length, 5000)
assert.ok(Math.abs(z.samples[1234] - samples[1234]) < 1e-3)
assert.equal(streams.find(s => s.channel === 'HHN')!.station, 'PKR')
assert.deepEqual(parseMseed(new Uint8Array(0)), [])

// each channel keeps its own original records: together they are the whole file, alone they parse to that channel only
const zBytes = new Uint8Array(z.mseedBytes!)
assert.equal(streams.reduce((n, s) => n + s.mseedBytes!.byteLength, 0), bytes.byteLength)
const zOnly = parseMseed(zBytes)
assert.deepEqual(zOnly.map(s => s.channel), ['HHZ'])
assert.equal(zOnly[0].samples.length, 5000)
assert.equal(mseedBytesOf(z), z.mseedBytes) // original records, not re-encoded

// file names: NET.STA.LOC.CHA.mseed, empty location kept, fallback id for code-less streams
assert.equal(mseedFileName(z), 'NP.KTM.00.HHZ.mseed')
assert.equal(mseedFileName(streams.find(s => s.channel === 'HHN')!), 'NP.PKR..HHN.mseed')
const plain = { channel: 'HHE', samples: [1, 2, 3], sampleRate: 100, startTime: start }
assert.equal(mseedFileName(plain, 'NP.KTM.00'), 'NP.KTM.00.HHE.mseed')
assert.equal(mseedFileName(plain, 'NP.KTM.00.HHE'), 'NP.KTM.00.HHE.mseed')
assert.equal(mseedFileName(plain), 'unknown.HHE.mseed')
assert.equal(parseMseed(mseedBytesOf(plain))[0].samples.length, 3) // code-less samples written as miniSEED 3

// day files start at 00:00 UTC; seisplotjs' own v3 check rejects hour 0
const midnight = parseMseed(streamsToMseed3([{ network: 'NP', station: 'KTM', location: '00', channel: 'HHZ', sampleRate: 100, startTime: Date.UTC(2024, 0, 2), samples: samples.subarray(0, 500) }]))
assert.equal(midnight[0].startTime, Date.UTC(2024, 0, 2))

// progressive parse: 50 one-second records served in 777-byte pieces, so records straddle pieces
const secs = Array.from({ length: 50 }, (_, i) => ({ network: 'NP', station: 'KTM', location: '00', channel: 'HHZ', sampleRate: 100, startTime: start + i * 1000, samples: samples.subarray(i * 100, i * 100 + 100) }))
const file = new Uint8Array(streamsToMseed3(secs))
const serve = (bytes: Uint8Array) => {
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(c) { for(let at = 0; at < bytes.byteLength; at += 777) c.enqueue(bytes.slice(at, at + 777)); c.close() },
  }))) as typeof fetch
}
serve(file)
const batches: number[] = []
let got = 0, prevStart = -Infinity, rawBytes = 0
for await (const batch of streamMseed('https://example/x')) {
  batches.push(batch.length)
  for(const c of batch) {
    assert.ok((c.startTime as number) > prevStart, 'chunks arrive in time order')
    prevStart = c.startTime as number
    got += c.samples.length
    rawBytes += c.mseedBytes!.byteLength
  }
}
assert.equal(got, 5000)
assert.equal(rawBytes, file.byteLength)
assert.ok(batches.length > 10, `plotted progressively, not once at the end (${batches.length} batches)`)
serve(file.subarray(0, file.byteLength - 10))
await assert.rejects(async () => { for await (const _ of streamMseed('https://example/x')) { /* drain */ } }, /incomplete record/)

assert.equal(streamsToMseed3([{ channel: 'HHZ', sampleRate: 100, startTime: start, samples: [] }]).byteLength, 0) // empty streams skipped

console.log('mseed ok')
