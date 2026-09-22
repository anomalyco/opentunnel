import { useLayoutEffect, useRef, type ElementType } from "react"
import { lineText, prepare, solve } from "@kitlangton/justice"

// A paragraph set by justice: words measured once with a canvas in the element's own font, the breaks
// solved as a whole at the element's width, each line rendered on its own with the engine's word spacing.
// Letter spacing stays at zero; in a monospace only the spaces may give. Until the first pass the text is
// plain, so nothing is empty while fonts load.

const canvas = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d")

export function Justified({ text, as: Tag = "p", className }: { text: string; as?: ElementType; className?: string }) {
  const host = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const element = host.current
    if (!element || !canvas) return
    const style = getComputedStyle(element)
    let prepared: ReturnType<typeof prepare> | undefined, font = ""
    const compose = () => {
      const next = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      if (next !== font || !prepared) {
        font = next
        canvas.font = font
        prepared = prepare(text, word => canvas.measureText(word).width)
      }
      const layout = solve(prepared, element.clientWidth, { tracking: 0 })
      element.replaceChildren(...layout.lines.map(line => {
        const span = document.createElement("span")
        span.className = "justified-line"
        span.textContent = lineText(prepared!, line)
        if (line.wordSpacing) span.style.wordSpacing = `${line.wordSpacing}px`
        if (line.opening) span.style.marginLeft = `${-line.opening}px`
        return span
      }))
    }
    compose()
    void document.fonts.ready.then(compose)
    const observer = new ResizeObserver(compose)
    observer.observe(element)
    return () => { observer.disconnect(); element.textContent = text }
  }, [text])
  return <Tag ref={host} className={className}>{text}</Tag>
}
