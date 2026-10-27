export type Samples = ArrayLike<number>
export type ViewMode = 'dual' | 'waveform' | 'spectrogram'
export type ThemeName = 'white' | 'dark'
export type YMode = 'offset' | 'raw'

/** marker drawn on waveforms: a P-wave pick (amplitude) or an earthquake (magnitude) */
export interface PWave {
  datetime: string // ISO, with Z or offset
  name?: string
  type?: string // 'P Wave' | 'Earthquake'
  magnitude?: number
  amplitude?: number
}

/** one channel of one station, as plain samples (realtime socket, FDSN, miniSEED, anything) */
export interface StreamData {
  channel: string
  samples: Samples
  sampleRate: number
  /** UTC ms (or anything Date accepts) of the first sample */
  startTime: number | string | Date
  /** UTC ms of the last sample; derived from startTime + samples / sampleRate when omitted */
  endTime?: number | string | Date
  unit?: string
  pWaves?: PWave[]
  /** FDSN codes, filled from miniSEED / seisplotjs metadata; used when no stationId/title is given */
  network?: string
  station?: string
  location?: string
  /** original miniSEED records of this channel (set by parseMseed); downloads use them as-is */
  mseedBytes?: ArrayBuffer
}

export interface StationData {
  id: string // e.g. 'NP.KTM.00'
  title?: string
  streams: StreamData[]
}
