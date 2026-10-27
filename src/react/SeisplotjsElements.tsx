import { useEffect, useRef, useState, type CSSProperties } from 'react'
import * as sp from 'seisplotjs'
import type { ChunkSource } from '../core/HelicorderWidget'
import { useMseed } from './useMseed'
import { streamMseed, type MseedInput } from '../mseed'
import { toSeismogram, renderSpHelicorder, renderSpSeismograph, type SeismogramInput, type SpHelicorderOptions, type SpSeismographOptions } from '../seisplotjs'

// custom elements are created imperatively: no JSX IntrinsicElements typing needed in the consumer's app
function useElement<T extends HTMLElement>(tag: string) {
  const host = useRef<HTMLDivElement>(null)
  const el = useRef<T | null>(null)
  if(!el.current && typeof document !== 'undefined') el.current = document.createElement(tag) as T
  useEffect(() => {
    const h = host.current, e = el.current
    if(!h || !e) return
    e.style.display = 'block'
    e.style.width = '100%'
    e.style.height = '100%'
    h.appendChild(e)
    return () => { e.remove() }
  }, [])
  return { host, el }
}

export interface SpSeismographProps extends SpSeismographOptions {
  data?: SeismogramInput | null
  /** miniSEED v2/v3 bytes, File/Blob or URL; used when `data` is not given */
  mseed?: MseedInput | null
  className?: string
  style?: CSSProperties
}

/** seisplotjs <sp-seismograph>: one or more seismograms, wheel zoom, markers */
export function SpSeismograph({ data: dataProp, mseed, pWaves, channel, unit, lineColors, wheelZoom, configure, className, style }: SpSeismographProps) {
  const { host, el } = useElement<sp.seismograph.Seismograph>('sp-seismograph')
  const { streams } = useMseed(mseed)
  const data = dataProp ?? (streams.length ? streams : null)
  useEffect(() => {
    if(el.current && data) renderSpSeismograph(el.current, data, { pWaves, channel, unit, lineColors, wheelZoom, configure })
  }, [el, data, pWaves, channel, unit, lineColors, wheelZoom, configure])
  return <div ref={host} className={className} style={{ height: 300, width: '100%', ...style }} />
}

export interface SpHelicorderProps extends SpHelicorderOptions {
  data?: SeismogramInput | null
  /** miniSEED v2/v3 bytes, File/Blob or URL; streamed in when `data` is not given */
  mseed?: MseedInput | null
  /** chunk source (or a factory for one), drawn as chunks arrive; see Helicorder's `stream` */
  stream?: ChunkSource | (() => ChunkSource) | null
  /** channel to take from `mseed` / `stream` (default: the first seen) */
  channelCode?: string
  className?: string
  style?: CSSProperties
}

/** seisplotjs <sp-helicorder>: one line per hour of start..end, click gives the time */
export function SpHelicorder({ data: dataProp, mseed, stream, channelCode, start, end, lineDurationSec, pWaves, timeZone, lineColors, onClick, configure, className, style }: SpHelicorderProps) {
  const { host, el } = useElement<sp.helicorder.Helicorder>('sp-helicorder')
  const streamed = useStreamedSeismogram(dataProp ? null : stream ?? mseed ?? null, channelCode)
  const data = dataProp ?? streamed
  const clickRef = useRef(onClick)
  useEffect(() => { clickRef.current = onClick })
  useEffect(() => {
    if(!el.current || !data) return
    return renderSpHelicorder(el.current, data, { start, end, lineDurationSec, pWaves, timeZone, lineColors, configure, onClick: (ms) => clickRef.current?.(ms) })
  }, [el, data, start, end, lineDurationSec, pWaves, timeZone, lineColors, configure])
  return <div ref={host} className={className} style={{ width: '100%', cursor: 'pointer', ...style }} />
}

/**
 * chunks -> one growing seisplotjs Seismogram for a single channel (all channels on one drum would interleave).
 * seisplotjs redraws the whole helicorder per update, so updates are batched to at most one per 500 ms.
 */
function useStreamedSeismogram(input: MseedInput | ChunkSource | (() => ChunkSource) | null, channelCode?: string) {
  const [seis, setSeis] = useState<sp.seismogram.Seismogram | null>(null)
  useEffect(() => {
    if(!input) return
    setSeis(null) // never show the previous input's data under the new one
    const ctrl = new AbortController()
    const isSource = typeof input === 'function' || (typeof input === 'object' && Symbol.asyncIterator in input)
    const source = typeof input === 'function' ? input() : isSource ? input as ChunkSource : streamMseed(input as MseedInput, { signal: ctrl.signal })
    const segments: sp.seismogramsegment.SeismogramSegment[] = []
    let channel = channelCode
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => { timer = undefined; if(segments.length && !ctrl.signal.aborted) setSeis(new sp.seismogram.Seismogram([...segments])) }
    ;(async () => {
      for await (const batch of source) {
        if(ctrl.signal.aborted) return
        for(const chunk of Array.isArray(batch) ? batch : [batch]) {
          if((channel ??= chunk.channel) !== chunk.channel || !chunk.samples.length) continue
          segments.push(...toSeismogram(chunk).segments)
        }
        timer ??= setTimeout(flush, 500)
      }
      clearTimeout(timer)
      flush()
    })().catch(e => { if(!ctrl.signal.aborted) console.error('SpHelicorder stream failed', e) })
    return () => { ctrl.abort(); clearTimeout(timer) }
  }, [input, channelCode])
  return input ? seis : null
}
