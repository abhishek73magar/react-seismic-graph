// native miniSEED decoder vs seisplotjs on real FDSN files (Steim1, Steim2, multi-channel) + seiscomp-go float32 records
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
// seisplotjs defines web components at import time: just enough DOM for that
class Fake {}
Object.assign(globalThis, { HTMLElement: Fake, customElements: { define() {}, get() {} }, window: globalThis, document: { createElement: () => ({}) } })
const sp = await import('seisplotjs')
const { fromSeismogram } = await import('../src/core/seismogram.ts')
const { parseMseed, decodeRecords, streamsToMseed3 } = await import('../src/mseed/index.ts')

const dir = new URL('./fixtures/', import.meta.url)
const files = readdirSync(dir).filter(f => f.endsWith('.mseed'))
assert.ok(files.length >= 4, 'fixtures present')

for(const f of files) {
  const buf = readFileSync(new URL(f, dir))
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // per record: samples, start, rate, codes
  const mine = decodeRecords(new Uint8Array(ab))
  const theirs = sp.miniseed.parseDataRecords(ab)
  assert.equal(mine.length, theirs.length, `${f}: record count`)
  mine.forEach((r, i) => {
    const t = theirs[i], h = t.header
    assert.deepEqual([r.network, r.station, r.location, r.channel], [h.netCode, h.staCode, h.locCode, h.chanCode].map(s => s.trim()), `${f}#${i} codes`)
    assert.equal(r.sampleRate, h.sampleRate, `${f}#${i} rate`)
    assert.ok(Math.abs(r.startTime - h.startTime.toMillis()) < 1, `${f}#${i} start ${r.startTime} vs ${h.startTime.toMillis()}`)
    assert.deepEqual(Array.from(r.samples), Array.from(t.decompress()), `${f}#${i} samples`)
  })
  // per channel: same as the seisplotjs path parseMseed used to take
  const ours = parseMseed(ab)
  const ref = sp.miniseed.seismogramPerChannel(theirs).map(fromSeismogram)
  assert.equal(ours.length, ref.length, `${f}: channels`)
  for(const r of ref) {
    const o = ours.find(s => s.channel === r.channel && s.station === r.station)!
    assert.ok(o, `${f}: channel ${r.channel}`)
    assert.equal(o.samples.length, r.samples.length, `${f}/${r.channel} length`)
    assert.ok(Math.abs((o.startTime as number) - (r.startTime as number)) < 1, `${f}/${r.channel} start`)
    assert.deepEqual(Array.from(o.samples), Array.from(r.samples), `${f}/${r.channel} contiguous samples`)
  }
  console.log(`ok ${f}: ${mine.length} records, ${ours.map(s => `${s.channel}×${s.samples.length}`).join(' ')}`)
}

// seiscomp-go /ws frame: fixed 4096-byte v2 records, float32 big-endian, blockette 1000 at 48
const record = (start: Date, values: number[]) => {
  const b = new Uint8Array(4096), dv = new DataView(b.buffer)
  b.set(new TextEncoder().encode('000001D '), 0)
  b.set(new TextEncoder().encode('KTM  00HHZNP'), 8)
  dv.setUint16(20, start.getUTCFullYear()); dv.setUint16(22, 1); dv.setUint8(24, start.getUTCHours())
  dv.setUint8(25, start.getUTCMinutes()); dv.setUint8(26, start.getUTCSeconds()); dv.setUint16(28, 5000) // .5 s
  dv.setUint16(30, values.length); dv.setInt16(32, 100); dv.setInt16(34, 1)
  dv.setUint8(39, 1); dv.setUint16(44, 64); dv.setUint16(46, 48)
  dv.setUint16(48, 1000); dv.setUint16(50, 0); dv.setUint8(52, 4); dv.setUint8(53, 1); dv.setUint8(54, 12)
  values.forEach((v, i) => dv.setFloat32(64 + i * 4, v))
  return b
}
const t0 = new Date(Date.UTC(2024, 0, 1, 10, 0, 0))
const frame = new Uint8Array(8192)
frame.set(record(t0, [1.5, -2, 3]), 0)
frame.set(record(new Date(t0.getTime() + 30), [4, 5]), 4096) // 30 ms + .5 s offset in fract
const recs = decodeRecords(frame)
assert.deepEqual(recs.map(r => [r.station, r.channel, r.network, r.location, r.sampleRate, Array.from(r.samples)]),
  [['KTM', 'HHZ', 'NP', '00', 100, [1.5, -2, 3]], ['KTM', 'HHZ', 'NP', '00', 100, [4, 5]]])
assert.equal(recs[0].startTime, Date.UTC(2024, 0, 1, 10, 0, 0, 500))
assert.equal(new Uint8Array(frame.buffer).byteLength, 8192)

// v3 writer -> seisplotjs reads it (CRC, header, source id), and our reader round-trips it
const written = streamsToMseed3([{ network: 'NP', station: 'KTM', location: '00', channel: 'HHZ', sampleRate: 100, startTime: Date.UTC(2024, 0, 1, 0, 0, 0, 250), samples: Float32Array.from({ length: 25000 }, (_, i) => i % 97) }])
const spV3 = sp.mseed3.parseMSeed3Records(written)
assert.equal(spV3.length, 3)
spV3.forEach(r => assert.equal(r.header.crc, r.calcCrc(), 'crc matches'))
assert.equal(spV3[0].getSourceId().toString(), 'FDSN:NP_KTM_00_H_H_Z')
const back = parseMseed(written)[0]
assert.deepEqual([back.channel, back.samples.length, back.startTime], ['HHZ', 25000, Date.UTC(2024, 0, 1, 0, 0, 0, 250)])
console.log('ok seiscomp-go float32 records, miniSEED 3 writer')
