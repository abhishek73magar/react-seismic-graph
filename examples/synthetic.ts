// fake but seismic-looking data: background noise + quakes (P then stronger, lower-frequency S)
export interface FakeQuake { at: number; amp?: number } // at = UTC ms of P arrival

export function makeTrace(start: number, durationSec: number, sampleRate = 100, quakes: FakeQuake[] = [], seed = 1) {
  const n = Math.round(durationSec * sampleRate)
  const y = new Float32Array(n)
  let s = seed
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5
  for(let i = 0; i < n; i++) {
    const t = i / sampleRate
    y[i] = 0.3 * Math.sin(2 * Math.PI * 0.2 * t) + 0.15 * Math.sin(2 * Math.PI * 15 * t) + 0.4 * rand()
  }
  for(const q of quakes) {
    const amp = q.amp ?? 10
    const p0 = Math.round(((q.at - start) / 1000) * sampleRate)
    const s0 = p0 + 8 * sampleRate // S wave 8 s after P
    for(let i = Math.max(0, p0); i < Math.min(n, p0 + 90 * sampleRate); i++) {
      const tp = (i - p0) / sampleRate
      let v = amp * 0.3 * Math.exp(-tp / 6) * Math.sin(2 * Math.PI * 7 * tp) // P: weak, high frequency
      if(i >= s0) { const ts = (i - s0) / sampleRate; v += amp * Math.exp(-ts / 12) * Math.sin(2 * Math.PI * 2.5 * ts) * (1 + 0.3 * rand()) }
      y[i] += v
    }
  }
  return y
}
