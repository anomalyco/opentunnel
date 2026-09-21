/** A radial field blurred in 2D, reduced to sparse interpolation weights per stop. */
export function radialBlurKernel(samples: number, radius: number, sigma: number) {
  const spacing = radius / (samples - 1)
  return Array.from({ length: samples }, (_, i) => {
    const weights = new Map<number, number>()
    let total = 0
    for (let y = -3; y <= 3; y++) {
      for (let x = -3; x <= 3; x++) {
        const weight = Math.exp(-(x * x + y * y) / 2)
        const position = Math.min(samples - 1, Math.hypot(i * spacing + x * sigma, y * sigma) / spacing)
        const low = Math.floor(position), high = Math.min(samples - 1, low + 1)
        const fraction = position - low
        weights.set(low, (weights.get(low) ?? 0) + weight * (1 - fraction))
        weights.set(high, (weights.get(high) ?? 0) + weight * fraction)
        total += weight
      }
    }
    return [...weights].map(([index, weight]) => ({ index, weight: weight / total }))
  })
}

/** Premultiplied RGBA prevents dark fringes when alpha approaches zero. */
export function blurRadialField(source: Float32Array, kernel: ReturnType<typeof radialBlurKernel>, target: Float32Array) {
  target.fill(0)
  for (let i = 0; i < kernel.length; i++) {
    for (const { index, weight } of kernel[i]!) {
      for (let channel = 0; channel < 4; channel++) target[i * 4 + channel] += source[index * 4 + channel]! * weight
    }
  }
}
