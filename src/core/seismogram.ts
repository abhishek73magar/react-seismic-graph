import type { StationData, StreamData } from './types'

// structural subset of seisplotjs Seismogram / SeismogramSegment, so core has no seisplotjs dependency
interface Segment { y: Float32Array | Int32Array | Float64Array; sampleRate: number; startTime: { valueOf(): number }; endTime: { valueOf(): number } }
export interface SeismogramLike {
  segments: Segment[]; sampleRate: number; startTime: { valueOf(): number }; endTime: { valueOf(): number }
  networkCode?: string | null; stationCode?: string | null; locationCode?: string | null; channelCode?: string | null
}

/**
 * Merge a (possibly gappy) Seismogram into one contiguous Float32Array.
 * seismogram.y throws 'Seismogram is not contiguous' when there are gaps, so walk segments instead.
 * gaps are filled by holding the last sample (flat line, no spike); overlaps are overwritten by the later segment.
 */
export function seismogramToContiguous(seis: SeismogramLike | null | undefined): Float32Array {
  const segs = seis?.segments;
  if(!Array.isArray(segs) || segs.length === 0) return new Float32Array(0);
  if(segs.length === 1) return Float32Array.from(segs[0].y);

  const sr = segs[0].sampleRate;
  const start = segs[0].startTime.valueOf();
  const end = segs[segs.length - 1].endTime.valueOf();
  const out = new Float32Array(Math.round(((end - start) / 1000) * sr) + 1);

  let filled = 0, last = 0;
  for(const seg of segs) {
    const offset = Math.max(0, Math.round(((seg.startTime.valueOf() - start) / 1000) * sr));
    if(offset >= out.length) break;
    if(offset > filled) out.fill(last, filled, offset);
    const y = seg.y;
    const len = Math.min(y.length, out.length - offset);
    if(len <= 0) continue;
    out.set(y.subarray(0, len), offset);
    filled = Math.max(filled, offset + len);
    last = y[len - 1];
  }
  return out;
}

/** seisplotjs Seismogram -> StreamData, codes taken from the seismogram's own metadata */
export const fromSeismogram = (seis: SeismogramLike): StreamData => ({
  channel: seis.channelCode || '?',
  network: seis.networkCode ?? undefined,
  station: seis.stationCode ?? undefined,
  location: seis.locationCode ?? undefined,
  samples: seismogramToContiguous(seis),
  sampleRate: seis.sampleRate,
  startTime: seis.startTime.valueOf(),
  endTime: seis.endTime.valueOf(),
})

/** 'NET.STA.LOC' from a stream's metadata (missing parts dropped), or fallback */
export const stationIdOf = (s: StreamData | undefined, fallback = 'unknown') =>
  [s?.network, s?.station, s?.location].filter(Boolean).join('.') || fallback

/** group streams by NET.STA.LOC into stations (miniSEED files often hold several stations) */
export function groupStations(streams: StreamData[]): StationData[] {
  const map = new Map<string, StreamData[]>()
  for(const s of streams) {
    const id = stationIdOf(s)
    map.set(id, [...(map.get(id) ?? []), s])
  }
  return [...map].map(([id, list]) => ({ id, streams: list }))
}
