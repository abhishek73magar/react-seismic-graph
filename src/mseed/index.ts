/**
 * miniSEED v2/v3 in and out, no seisplotjs: parse to StreamData, stream records as they download,
 * write StreamData as miniSEED 3, and download helpers.
 */
import { seismogramToContiguous } from '../core/seismogram'
import { toMs } from '../core/time'
import type { StreamData } from '../core/types'
import { decodeRecords, isMseed3, recordSize, type MseedRecord } from './decode'

export { decodeRecord, decodeRecords, isMseed3, recordSize } from './decode'
export type { MseedRecord } from './decode'

/** raw miniSEED bytes, a File/Blob, or a URL (e.g. an fdsnws/dataselect query) */
export type MseedInput = ArrayBuffer | ArrayBufferView | Blob | string

const toBytes = (b: ArrayBuffer | ArrayBufferView) =>
  b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

const codesKey = (...codes: (string | null | undefined)[]) => codes.map(c => (c ?? '').trim()).join('.')

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for(const p of parts) { out.set(p, at); at += p.byteLength }
  return out.buffer
}

/**
 * miniSEED v2 or v3 bytes -> one StreamData per channel (network/station/location/channel from the records).
 * Records of a channel are joined in time order; gaps hold the last sample, as before with seisplotjs.
 * `mseedBytes` keeps that channel's original records, byte for byte.
 */
export function parseMseed(bytes: ArrayBuffer | ArrayBufferView): StreamData[] {
  const b = toBytes(bytes)
  if(b.byteLength === 0) return []
  const channels = new Map<string, { records: MseedRecord[]; raw: Uint8Array[] }>()
  let at = 0
  for(const r of decodeRecords(b)) {
    const key = codesKey(r.network, r.station, r.location, r.channel)
    const entry = channels.get(key) ?? { records: [], raw: [] }
    entry.raw.push(b.subarray(at, at + r.size))
    if(r.samples.length > 0 && r.sampleRate > 0) entry.records.push(r)
    channels.set(key, entry)
    at += r.size
  }
  const out: StreamData[] = []
  for(const { records, raw } of channels.values()) {
    if(records.length === 0) continue
    records.sort((a, z) => a.startTime - z.startTime)
    const sampleRate = records[0].sampleRate
    const segments = records.map((r) => ({
      y: r.samples, sampleRate,
      startTime: r.startTime,
      endTime: r.startTime + ((r.samples.length - 1) / sampleRate) * 1000,
    }))
    const first = records[0], last = segments[segments.length - 1]
    out.push({
      channel: first.channel, network: first.network, station: first.station, location: first.location,
      sampleRate,
      samples: seismogramToContiguous({ segments, sampleRate, startTime: segments[0].startTime, endTime: last.endTime }),
      startTime: segments[0].startTime,
      endTime: last.endTime,
      mseedBytes: concat(raw),
    })
  }
  return out
}

/** bytes of an MseedInput as they arrive: fetch body / Blob stream, or 1 MB slices of in-memory bytes */
async function* byteChunks(input: MseedInput, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  let body: ReadableStream<Uint8Array> | null = null
  if(typeof input === 'string') {
    const res = await fetch(input, { signal })
    if(res.status === 204) return // fdsnws: no data
    if(!res.ok) throw new Error(`miniSEED fetch failed: ${res.status} ${res.statusText}`)
    if(!res.body) { yield new Uint8Array(await res.arrayBuffer()); return }
    body = res.body
  } else if(typeof Blob !== 'undefined' && input instanceof Blob) {
    body = input.stream()
  }
  if(body) {
    const reader = body.getReader()
    try {
      for(;;) {
        const { done, value } = await reader.read()
        if(done) return
        yield value
      }
    } finally { reader.releaseLock() }
  }
  const all = toBytes(input as ArrayBuffer | ArrayBufferView)
  const SLICE = 1 << 20
  for(let at = 0; at < all.byteLength; at += SLICE) {
    if(signal?.aborted) return
    yield all.subarray(at, at + SLICE)
    await new Promise(r => setTimeout(r, 0)) // let the page paint between slices
  }
}

/**
 * Parse miniSEED progressively: yields the complete records of each arriving piece as StreamData
 * (one per channel per piece, with its own mseedBytes). Plot them as they come, e.g. widget.consume(streamMseed(url)).
 */
export async function* streamMseed(input: MseedInput, opts: { signal?: AbortSignal } = {}): AsyncGenerator<StreamData[]> {
  let pending = new Uint8Array(0)
  let v3: boolean | null = null
  for await (const piece of byteChunks(input, opts.signal)) {
    const joined = new Uint8Array(pending.byteLength + piece.byteLength)
    joined.set(pending); joined.set(piece, pending.byteLength)
    v3 ??= joined.byteLength >= 3 ? isMseed3(joined) : null
    if(v3 === null) { pending = joined; continue }
    let used = 0
    for(let size; (size = recordSize(joined.subarray(used), v3)) && used + size <= joined.byteLength;) used += size
    pending = joined.slice(used)
    if(used > 0) yield parseMseed(joined.subarray(0, used))
  }
  if(pending.byteLength > 0) throw new Error(`miniSEED ends with ${pending.byteLength} bytes of an incomplete record`)
}

/** parseMseed for any MseedInput (fetches URLs, reads Blobs) */
export async function loadMseed(input: MseedInput, init?: RequestInit): Promise<StreamData[]> {
  if(typeof input === 'string') {
    const res = await fetch(input, init)
    if(res.status === 204) return [] // fdsnws: no data
    if(!res.ok) throw new Error(`miniSEED fetch failed: ${res.status} ${res.statusText}`)
    return parseMseed(await res.arrayBuffer())
  }
  if(typeof Blob !== 'undefined' && input instanceof Blob) return parseMseed(await input.arrayBuffer())
  return parseMseed(input as ArrayBuffer | ArrayBufferView)
}

// ── writing (miniSEED 3, float32) ─────────────

// CRC-32C (Castagnoli), the checksum miniSEED 3 uses
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for(let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32c = (b: Uint8Array) => {
  let c = 0xffffffff
  for(let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// SEED channel 'HHZ' -> source id parts 'H_H_Z'; anything else is used as is
const sourceId = (s: StreamData) => {
  const chan = s.channel.length === 3 ? s.channel.split('').join('_') : s.channel
  return `FDSN:${s.network || 'XX'}_${s.station || 'XXXX'}_${s.location || ''}_${chan}`
}

const RECORD_SAMPLES = 10000 // per written record, so files stay readable by tools with record size limits

function mseed3Record(s: StreamData, samples: ArrayLike<number>, startMs: number): Uint8Array {
  const sid = new TextEncoder().encode(sourceId(s))
  const size = 40 + sid.length + samples.length * 4
  const b = new Uint8Array(size)
  const dv = new DataView(b.buffer)
  const t = new Date(Math.floor(startMs))
  const doy = Math.floor((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000) + 1
  b.set([77, 83, 3], 0)                                 // 'MS', version 3
  dv.setUint32(4, Math.round((startMs - Math.floor(startMs / 1000) * 1000) * 1e6), true) // nanoseconds
  dv.setUint16(8, t.getUTCFullYear(), true)
  dv.setUint16(10, doy, true)
  dv.setUint8(12, t.getUTCHours()); dv.setUint8(13, t.getUTCMinutes()); dv.setUint8(14, t.getUTCSeconds())
  dv.setUint8(15, 4)                                    // float32
  dv.setFloat64(16, s.sampleRate, true)
  dv.setUint32(24, samples.length, true)
  dv.setUint8(32, 1)                                    // publication version
  dv.setUint8(33, sid.length)
  dv.setUint16(34, 0, true)                             // no extra headers
  dv.setUint32(36, samples.length * 4, true)
  b.set(sid, 40)
  for(let i = 0; i < samples.length; i++) dv.setFloat32(40 + sid.length + i * 4, samples[i], true)
  dv.setUint32(28, crc32c(b), true)                     // CRC over the record with this field zero
  return b
}

/** StreamData -> miniSEED 3 bytes (for downloads, round trips). Missing codes become XX / XXXX / '' */
export function streamsToMseed3(streams: StreamData[]): ArrayBuffer {
  const parts: Uint8Array[] = []
  for(const s of streams) {
    const start = toMs(s.startTime)
    for(let at = 0; at < s.samples.length; at += RECORD_SAMPLES) {
      const chunk = Array.prototype.slice.call(s.samples, at, at + RECORD_SAMPLES) as number[]
      parts.push(mseed3Record(s, chunk, start + (at / s.sampleRate) * 1000))
    }
  }
  return concat(parts)
}

// ── downloads ──────────────────────────────────

/**
 * download file name NET.STA.LOC.CHA.mseed from the stream's codes (empty location stays empty: IU.ANMO..BHZ);
 * streams without codes use fallbackId ('NP.KTM.00' or 'NP.KTM.00.HHZ') + channel
 */
export function mseedFileName(s: StreamData, fallbackId = 'unknown') {
  if(s.network || s.station) return `${codesKey(s.network, s.station, s.location, s.channel)}.mseed`
  const id = fallbackId || 'unknown'
  return `${id.endsWith(`.${s.channel}`) ? id : `${id}.${s.channel}`}.mseed`
}

/** bytes to download for one stream: its original records, or the samples written as miniSEED 3 */
export const mseedBytesOf = (s: StreamData) => s.mseedBytes ?? streamsToMseed3([s])

/** save one stream as NET.STA.LOC.CHA.mseed in the browser */
export function downloadMseed(s: StreamData, fallbackId?: string) {
  const url = URL.createObjectURL(new Blob([mseedBytesOf(s)], { type: 'application/vnd.fdsn.mseed' }))
  const a = document.createElement('a')
  a.href = url
  a.download = mseedFileName(s, fallbackId)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
