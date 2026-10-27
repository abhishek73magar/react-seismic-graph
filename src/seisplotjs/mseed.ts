import * as sp from 'seisplotjs'
import { fromSeismogram } from '../core/seismogram'
import { toMs } from '../core/time'
import type { StreamData } from '../core/types'

/** raw miniSEED bytes, a File/Blob, or a URL (e.g. an fdsnws/dataselect query) */
export type MseedInput = ArrayBuffer | ArrayBufferView | Blob | string

const toArrayBuffer = (b: ArrayBuffer | ArrayBufferView): ArrayBufferLike =>
  b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)

/** miniSEED v2 or v3 bytes -> one StreamData per channel, with network/station/location/channel from the records */
export function parseMseed(bytes: ArrayBuffer | ArrayBufferView): StreamData[] {
  const buf = toArrayBuffer(bytes)
  if(buf.byteLength === 0) return []
  // records sit back to back (that is how seisplotjs walks them), so record i spans [offset, offset + size)
  const raw = new Map<string, Uint8Array[]>()
  const keep = (key: string, offset: number, size: number) => raw.set(key, [...(raw.get(key) ?? []), new Uint8Array(buf, offset, size)])
  let seismograms: sp.seismogram.Seismogram[]
  let offset = 0
  if(isMseed3(buf)) {
    const records = sp.mseed3.parseMSeed3Records(buf)
    for(const r of records) {
      const n = r.getSourceId().asNslc()
      keep(codesKey(n.networkCode, n.stationCode, n.locationCode, n.channelCode), offset, r.getSize())
      offset += r.getSize()
    }
    seismograms = sp.mseed3.seismogramPerChannel(records)
  } else {
    const records = sp.miniseed.parseDataRecords(buf)
    for(const r of records) {
      const h = r.header
      keep(codesKey(h.netCode, h.staCode, h.locCode, h.chanCode), offset, h.recordSize)
      offset += h.recordSize
    }
    seismograms = sp.miniseed.seismogramPerChannel(records)
  }
  return seismograms.map(seis => {
    const s = fromSeismogram(seis)
    const parts = raw.get(codesKey(s.network, s.station, s.location, s.channel))
    return parts ? { ...s, mseedBytes: concat(parts) } : s
  })
}

// miniSEED 3 starts 'MS' + format version 3 (a v2 record starts with a 6-digit ASCII sequence number).
// not sp.mseed3.mightBeMSeed3Records: it rejects records starting in hour 00, i.e. every midnight-aligned day file
const isMseed3 = (buf: ArrayBufferLike) => {
  const b = new Uint8Array(buf, 0, Math.min(3, buf.byteLength))
  return b[0] === 77 && b[1] === 83 && b[2] === 3
}

const codesKey = (...codes: (string | null | undefined)[]) => codes.map(c => (c ?? '').trim()).join('.')

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for(const p of parts) { out.set(p, at); at += p.byteLength }
  return out.buffer
}

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

/**
 * Size of the miniSEED record at the start of `b`, or 0 when more bytes are needed to tell.
 * v3: fixed 40-byte header + identifier + extra headers + data. v2: from the header's blockette 1000.
 */
function recordSize(b: Uint8Array, v3: boolean): number {
  if(v3) {
    if(b.byteLength < 40) return 0
    const dv = new DataView(b.buffer, b.byteOffset, 40)
    return 40 + dv.getUint8(33) + dv.getUint16(34, true) + dv.getUint32(36, true)
  }
  if(b.byteLength < 64) return 0
  try {
    return sp.miniseed.parseSingleDataRecordHeader(new DataView(b.buffer, b.byteOffset, b.byteLength)).recordSize
  } catch(e) {
    if(b.byteLength < 8192) return 0 // blockettes not all here yet
    throw e
  }
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
  const all = new Uint8Array(toArrayBuffer(input as ArrayBuffer | ArrayBufferView))
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
    v3 ??= joined.byteLength >= 3 ? isMseed3(joined.buffer) : null
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

/** StreamData -> miniSEED 3 bytes (for downloads, round trips). Missing codes become XX / XXXX / '' */
export function streamsToMseed3(streams: StreamData[]): ArrayBuffer {
  const records = streams.filter(s => s.samples.length > 0).flatMap(s => {
    const sid = sp.fdsnsourceid.FDSNSourceId.fromNslc(s.network || 'XX', s.station || 'XXXX', s.location || '', s.channel)
    const start = sp.util.isoToDateTime(new Date(toMs(s.startTime)).toISOString())
    return sp.mseed3.toMSeed3(sp.seismogram.Seismogram.fromContiguousData(Float32Array.from(s.samples), s.sampleRate, start, sid))
  })
  const sizes = records.map(r => r.calcSize())
  const out = new ArrayBuffer(sizes.reduce((a, b) => a + b, 0))
  let offset = 0
  records.forEach((r, i) => { r.save(new DataView(out, offset, sizes[i])); offset += sizes[i] })
  return out
}
