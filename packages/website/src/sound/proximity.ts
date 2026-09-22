type Bounds = { left: number; top: number; width: number; height: number }

/** Full gain when the source fits in view, or fills the view if it is larger.
 * Smoothstep gives a quiet arrival/departure rather than a visibility switch. */
export function soundProximity(source: Bounds, viewport: Bounds) {
  if (source.width <= 0 || source.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 0
  const overlap = (start: number, size: number, viewStart: number, viewSize: number) =>
    Math.max(0, Math.min(start + size, viewStart + viewSize) - Math.max(start, viewStart)) / Math.min(size, viewSize)
  const visible = Math.min(1, overlap(source.left, source.width, viewport.left, viewport.width)
    * overlap(source.top, source.height, viewport.top, viewport.height))
  return visible * visible * (3 - 2 * visible)
}
