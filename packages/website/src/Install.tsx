import { useEffect, useState } from "react"

const command = "bun install -g opentunnel"

/** The one line that matters above the fold: shown as a prompt, copied on click. */
export function Install() {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true) } catch { /* selection fallback: the text is selectable */ }
  }
  return <div className="install">
    <code className="install-command"><span aria-hidden="true">$ </span>{command}</code>
    <button type="button" className="install-copy" onClick={copy} aria-live="polite">{copied ? "copied" : "copy"}</button>
  </div>
}
