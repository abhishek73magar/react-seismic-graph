/**
 * miniSEED record decoding without seisplotjs.
 * v2: 48-byte fixed header + blockettes (1000: encoding / byte order / record length, 1001: microseconds).
 * v3: 40-byte little-endian header + FDSN source id + extra headers + data.
 * Encodings: int16 (1), int32 (3), float32 (4), float64 (5), Steim1 (10), Steim2 (11).
 */

export interface MseedRecord {
  network: string
  station: string
  location: string
  channel: string
  /** UTC ms of the first sample (sub-millisecond kept as a fraction) */
  startTime: number
  sampleRate: number
  samples: Int32Array | Float32Array | Float64Array
  /** bytes this record occupies in the file */
  size: number
}

/** miniSEED 3 starts 'MS' + format version 3 (a v2 record starts with a 6-character sequence number) */
export const isMseed3 = (b: Uint8Array) => b.byteLength >= 3 && b[0] === 77 && b[1] === 83 && b[2] === 3

const text = (b: Uint8Array, offset: number, length: number) => {
  let s = ''
  for(let i = 0; i < length; i++) s += String.fromCharCode(b[offset + i])
  return s.trim()
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)

// day-of-year + clock -> UTC ms
const utcMs = (year: number, doy: number, hour: number, minute: number, second: number) =>
  Date.UTC(year, 0, doy, hour, minute, second)

// ── v2 ─────────────────────────────────────────

// the fixed header's byte order isn't flagged anywhere: a sane year means big-endian
const v2HeaderLE = (dv: DataView) => {
  const year = dv.getUint16(20, false)
  return year < 1900 || year > 2100
}

interface V2Header { le: boolean; encoding: number; dataLE: boolean; size: number; microsec: number }

// walk the blockette chain for 1000 (encoding, word order, record length) and 1001 (microseconds)
function v2Blockettes(dv: DataView, le: boolean): V2Header | null {
  let next = dv.getUint16(46, le)
  let encoding = -1, dataLE = false, size = 0, microsec = 0
  for(let guard = 0; next && guard < 32; guard++) {
    if(next + 4 > dv.byteLength) return null // chain not all here yet
    const type = dv.getUint16(next, le)
    if(type === 1000) {
      if(next + 8 > dv.byteLength) return null
      encoding = dv.getUint8(next + 4)
      dataLE = dv.getUint8(next + 5) === 0
      size = 2 ** dv.getUint8(next + 6)
    } else if(type === 1001 && next + 6 <= dv.byteLength) {
      microsec = dv.getInt8(next + 5)
    }
    next = dv.getUint16(next + 2, le)
  }
  return size ? { le, encoding, dataLE, size, microsec } : null
}

function decodeV2(b: Uint8Array): MseedRecord {
  const dv = view(b)
  const le = v2HeaderLE(dv)
  const h = v2Blockettes(dv, le)
  if(!h) throw new Error('miniSEED 2 record without blockette 1000')
  const factor = dv.getInt16(32, le), mult = dv.getInt16(34, le)
  const sampleRate = !factor || !mult ? 0 : (factor > 0 ? factor : -1 / factor) * (mult > 0 ? mult : -1 / mult)
  const activity = dv.getUint8(36)
  const correction = activity & 0x02 ? 0 : dv.getInt32(40, le) / 10 // 0.0001 s units, unless already applied
  const startTime = utcMs(dv.getUint16(20, le), dv.getUint16(22, le), dv.getUint8(24), dv.getUint8(25), dv.getUint8(26))
    + dv.getUint16(28, le) / 10 + h.microsec / 1000 + correction
  const numSamples = dv.getUint16(30, le)
  const dataStart = dv.getUint16(44, le)
  return {
    station: text(b, 8, 5), location: text(b, 13, 2), channel: text(b, 15, 3), network: text(b, 18, 2),
    startTime, sampleRate,
    samples: decodeData(b.subarray(dataStart, h.size), h.encoding, numSamples, h.dataLE),
    size: h.size,
  }
}

// ── v3 ─────────────────────────────────────────

// 'FDSN:NET_STA_LOC_B_S_SS' -> codes; one-letter band/source/subsource join into the SEED channel 'BSS'
const parseSourceId = (sid: string) => {
  const [net = '', sta = '', loc = '', ...chan] = sid.replace(/^FDSN:/, '').split('_')
  return { network: net, station: sta, location: loc, channel: chan.every((c) => c.length <= 1) ? chan.join('') : chan.join('_') }
}

function decodeV3(b: Uint8Array): MseedRecord {
  const dv = view(b)
  const encoding = dv.getUint8(15)
  const rate = dv.getFloat64(16, true)
  const numSamples = dv.getUint32(24, true)
  const sidLength = dv.getUint8(33), extraLength = dv.getUint16(34, true), dataLength = dv.getUint32(36, true)
  const dataStart = 40 + sidLength + extraLength
  return {
    ...parseSourceId(text(b, 40, sidLength)),
    startTime: utcMs(dv.getUint16(8, true), dv.getUint16(10, true), dv.getUint8(12), dv.getUint8(13), dv.getUint8(14)) + dv.getUint32(4, true) / 1e6,
    sampleRate: rate > 0 ? rate : rate < 0 ? -1 / rate : 0, // negative = sample period in seconds
    samples: decodeData(b.subarray(dataStart, dataStart + dataLength), encoding, numSamples, true),
    size: dataStart + dataLength,
  }
}

// ── data ───────────────────────────────────────

function decodeData(d: Uint8Array, encoding: number, n: number, le: boolean): MseedRecord['samples'] {
  const dv = view(d)
  switch(encoding) {
    case 1: return Int32Array.from({ length: n }, (_, i) => dv.getInt16(i * 2, le))
    case 3: return Int32Array.from({ length: n }, (_, i) => dv.getInt32(i * 4, le))
    case 4: return Float32Array.from({ length: n }, (_, i) => dv.getFloat32(i * 4, le))
    case 5: return Float64Array.from({ length: n }, (_, i) => dv.getFloat64(i * 8, le))
    case 10: return decodeSteim(dv, n, 1)
    case 11: return decodeSteim(dv, n, 2)
    case 0: return new Int32Array(0) // text record (log): no samples
    default: throw new Error(`miniSEED encoding ${encoding} is not supported`)
  }
}

// sign-extend the low `bits` bits of v
const signed = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits)

/**
 * Steim1/2: 64-byte frames of 16 big-endian words; word 0 holds 2-bit codes for words 1..15.
 * Frame 0 word 1 = first sample (forward constant), word 2 = last sample (reverse constant).
 * Samples are the running sum of the differences, starting from the forward constant.
 */
function decodeSteim(dv: DataView, n: number, version: 1 | 2): Int32Array {
  const out = new Int32Array(n)
  if(n === 0) return out
  const diffs: number[] = []
  const frames = Math.floor(dv.byteLength / 64)
  let first = 0
  for(let f = 0; f < frames && diffs.length < n; f++) {
    const base = f * 64
    const codes = dv.getUint32(base, false)
    if(f === 0) first = dv.getInt32(base + 4, false)
    for(let w = f === 0 ? 3 : 1; w < 16; w++) {
      const code = (codes >>> (30 - w * 2)) & 3
      const word = dv.getUint32(base + w * 4, false)
      if(code === 0) continue
      if(code === 1) { // four 8-bit differences (both versions)
        for(let s = 24; s >= 0; s -= 8) diffs.push(signed(word >>> s, 8))
      } else if(version === 1) {
        if(code === 2) { diffs.push(signed(word >>> 16, 16), signed(word, 16)) }
        else diffs.push(word | 0)
      } else {
        const dnib = word >>> 30
        if(code === 2) {
          if(dnib === 1) diffs.push(signed(word, 30))
          else if(dnib === 2) diffs.push(signed(word >>> 15, 15), signed(word, 15))
          else if(dnib === 3) for(let s = 20; s >= 0; s -= 10) diffs.push(signed(word >>> s, 10))
        } else {
          if(dnib === 0) for(let s = 24; s >= 0; s -= 6) diffs.push(signed(word >>> s, 6))
          else if(dnib === 1) for(let s = 25; s >= 0; s -= 5) diffs.push(signed(word >>> s, 5))
          else if(dnib === 2) for(let s = 24; s >= 0; s -= 4) diffs.push(signed(word >>> s, 4))
        }
      }
    }
  }
  // the first difference is relative to the previous record, so sample 0 is the forward constant
  out[0] = first
  for(let i = 1; i < n; i++) out[i] = out[i - 1] + (diffs[i] ?? 0)
  return out
}

// ── records ────────────────────────────────────

/**
 * Size of the record at the start of `b`, or 0 when more bytes are needed to tell.
 * v3: header fields; v2: blockette 1000's record length.
 */
export function recordSize(b: Uint8Array, v3 = isMseed3(b)): number {
  if(v3) {
    if(b.byteLength < 40) return 0
    const dv = view(b)
    return 40 + dv.getUint8(33) + dv.getUint16(34, true) + dv.getUint32(36, true)
  }
  if(b.byteLength < 48) return 0
  const dv = view(b)
  return v2Blockettes(dv, v2HeaderLE(dv))?.size ?? 0
}

/** decode one record (v2 or v3) at the start of `b` */
export const decodeRecord = (b: Uint8Array): MseedRecord => isMseed3(b) ? decodeV3(b) : decodeV2(b)

/** every complete record in `b`, in file order; a trailing partial record is ignored */
export function decodeRecords(b: Uint8Array): MseedRecord[] {
  const out: MseedRecord[] = []
  for(let at = 0; at < b.byteLength;) {
    const rest = b.subarray(at)
    const size = recordSize(rest)
    if(!size || size > rest.byteLength) break
    out.push(decodeRecord(rest.subarray(0, size)))
    at += size
  }
  return out
}
