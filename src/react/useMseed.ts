import { useEffect, useState } from 'react'
import { loadMseed, type MseedInput } from '../mseed'
import type { StreamData } from '../core/types'

const EMPTY: StreamData[] = []

/** miniSEED (bytes / Blob / URL) -> StreamData[]; re-parses when the input identity changes */
export function useMseed(input: MseedInput | null | undefined) {
  const [state, setState] = useState<{ input: MseedInput; streams: StreamData[]; error: Error | null } | null>(null)
  useEffect(() => {
    if(!input) return
    let live = true
    loadMseed(input).then(
      streams => { if(live) setState({ input, streams, error: null }) },
      (e: unknown) => { if(live) setState({ input, streams: EMPTY, error: e instanceof Error ? e : new Error(String(e)) }) },
    )
    return () => { live = false }
  }, [input])
  // a result for an older input is never shown
  const current = input && state?.input === input ? state : null
  return { streams: current?.streams ?? EMPTY, error: current?.error ?? null, loading: !!input && !current }
}
