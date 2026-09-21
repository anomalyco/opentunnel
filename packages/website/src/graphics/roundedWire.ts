type Point = { x: number; y: number }

/** Round orthogonal bends while preserving the exact socket positions. */
export function roundedWire(points: readonly Point[], radius = 12) {
  const first = points[0]
  let path = `M${first.x} ${first.y}`
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1], corner = points[index], after = points[index + 1]
    const incoming = Math.hypot(corner.x - before.x, corner.y - before.y)
    const outgoing = Math.hypot(after.x - corner.x, after.y - corner.y)
    if (!incoming || !outgoing) continue
    const bend = Math.min(radius, incoming / 2, outgoing / 2)
    const enter = { x: corner.x + (before.x - corner.x) * bend / incoming, y: corner.y + (before.y - corner.y) * bend / incoming }
    const exit = { x: corner.x + (after.x - corner.x) * bend / outgoing, y: corner.y + (after.y - corner.y) * bend / outgoing }
    path += `L${enter.x} ${enter.y}Q${corner.x} ${corner.y} ${exit.x} ${exit.y}`
  }
  const last = points[points.length - 1]
  return `${path}L${last.x} ${last.y}`
}
