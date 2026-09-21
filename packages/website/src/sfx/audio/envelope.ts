/** A broad, zero-slope swell for longer gestures; short recipes keep their attack. */
export function smoothEnvelope(attack: number, decay: number, peak: number, samples = 257) {
  const duration = attack + decay
  return Float32Array.from({ length: samples }, (_, index) => {
    const time = duration * index / (samples - 1)
    const phase = time <= attack ? time / attack : 1 - (time - attack) / decay
    const t = Math.max(0, Math.min(1, phase))
    return peak * (.5 - .5 * Math.cos(Math.PI * t))
  })
}
