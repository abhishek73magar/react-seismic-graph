// React wrappers around seisplotjs' <sp-helicorder> / <sp-seismograph>.
// A separate entry so `react-seismic-graph/react` never pulls seisplotjs into a bundle.
export { SpHelicorder, SpSeismograph } from './SeisplotjsElements'
export type { SpHelicorderProps, SpSeismographProps } from './SeisplotjsElements'
