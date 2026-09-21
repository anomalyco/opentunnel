// Micrographics: the small marks of a printed sheet, in the page's inks. A tick ruler, a crosshair
// (registration mark), and a Code 39 barcode that really encodes its text.

/** Ticks across a width, every `step` px, a taller one every fifth. */
export function Ruler({ className }: { className?: string }) {
  const step = 8, count = 400
  const d = Array.from({ length: count }, (_, i) => `M${i * step + .5} 0v${i % 5 === 0 ? 10 : 5}`).join("")
  return <svg className={className} viewBox={`0 0 ${count * step} 10`} preserveAspectRatio="xMinYMin slice" aria-hidden="true"><path d={d} /></svg>
}

/** A registration mark: circle and cross. */
export function Crosshair({ className, size = 14 }: { className?: string; size?: number }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1} aria-hidden="true">
    <circle cx={7} cy={7} r={4.5} /><path d="M7 0v14M0 7h14" />
  </svg>
}

// Code 39: nine elements per character (five bars, four spaces), wide = 1, narrow = 0; a narrow space between characters.
const code39: Record<string, string> = {
  "0": "000110100", "1": "100100001", "2": "001100001", "3": "101100000", "4": "000110001", "5": "100110000", "6": "001110000", "7": "000100101", "8": "100100100", "9": "001100100",
  A: "100001001", B: "001001001", C: "101001000", D: "000011001", E: "100011000", F: "001011000", G: "000001101", H: "100001100", I: "001001100", J: "000011100",
  K: "100000011", L: "001000011", M: "101000010", N: "000010011", O: "100010010", P: "001010010", Q: "000000111", R: "100000110", S: "001000110", T: "000010110",
  U: "110000001", V: "011000001", W: "111000000", X: "010010001", Y: "110010000", Z: "011010000", "-": "010000101", ".": "110000100", " ": "011000100", "*": "010010100",
}
export function Barcode({ text, className, height = 22 }: { text: string; className?: string; height?: number }) {
  const narrow = 1, wide = 2.6
  const bars: { x: number; w: number }[] = []
  let x = 0
  for (const char of `*${text.toUpperCase()}*`) {
    const pattern = code39[char] ?? code39[" "]!
    for (let i = 0; i < 9; i++) {
      const w = pattern[i] === "1" ? wide : narrow
      if (i % 2 === 0) bars.push({ x, w })
      x += w
    }
    x += narrow
  }
  return <svg className={className} viewBox={`0 0 ${x} ${height}`} height={height} width={x * 1.1} preserveAspectRatio="none" role="img" aria-label={text}>
    {bars.map((bar, i) => <rect key={i} x={bar.x} y={0} width={bar.w} height={height} fill="currentColor" />)}
  </svg>
}
