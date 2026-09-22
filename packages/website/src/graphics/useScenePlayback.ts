import { useEffect, useRef, useState } from "react"
import { animate, useMotionValue, useTransform } from "motion/react"
import { suspendAnimation, type SuspensibleAnimation } from "./suspendAnimation"

// Ported from the OpenCode blog (src/graphics/useScenePlayback.ts) without the debug timeline, play gate,
// speed and rewind. One Motion clock per scene: suspended offscreen or in a hidden tab, honouring reduced
// motion by jumping to a static `after` pose.

/** Start of the cycle containing `from`. A cycle's end can land an ulp under the next multiple. */
const cycleBase = (from: number, duration: number) => Math.floor(from / duration + 1e-6) * duration

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)")

export function useScenePlayback(duration: number, { repeat = false, autoplay = false, after = duration }: {
  repeat?: boolean; autoplay?: boolean; after?: number
} = {}) {
  const [reduced, setReduced] = useState(() => reducedMotion().matches)
  const host = useRef<HTMLElement>(null), elapsed = useMotionValue(reduced ? after : 0)
  const clock = useTransform(elapsed, time => repeat ? time % duration : time)
  const animation = useRef<SuspensibleAnimation | undefined>(undefined)
  const [visible, setVisible] = useState(false), [hidden, setHidden] = useState(() => document.hidden)
  const [paused, setPaused] = useState(!autoplay), [revision, setRevision] = useState(0)
  const active = visible && !hidden && !reduced && !paused
  const running = useRef(active)
  running.current = active
  useEffect(() => {
    const media = reducedMotion()
    const preference = () => {
      animation.current?.stop()
      elapsed.jump(media.matches ? after : 0)
      setReduced(media.matches)
      setPaused(!autoplay)
      setRevision(value => value + 1)
    }
    const visibility = () => setHidden(document.hidden)
    const observer = new IntersectionObserver(([entry]) => {
      // Stop the clock immediately offscreen; only its React visibility render waits.
      if (!entry!.isIntersecting) animation.current?.pause()
      setVisible(entry!.isIntersecting)
    })
    if (host.current) observer.observe(host.current)
    media.addEventListener("change", preference)
    document.addEventListener("visibilitychange", visibility)
    return () => { observer.disconnect(); media.removeEventListener("change", preference); document.removeEventListener("visibilitychange", visibility) }
  }, [elapsed, after, autoplay])
  useEffect(() => {
    if (reduced || paused) return
    const from = elapsed.get(), base = repeat ? cycleBase(from, duration) : 0
    const until = base + duration
    if (from >= until) return
    const controls = suspendAnimation(() => animate(elapsed, [from, until], {
      duration: until - from, ease: "linear",
      onComplete: () => {
        if (repeat) setRevision(value => value + 1); else setPaused(true)
      },
    }))
    animation.current = controls
    if (!running.current) controls.pause()
    return () => controls.stop()
  }, [elapsed, duration, repeat, reduced, paused, revision])
  useEffect(() => {
    if (active) animation.current?.play()
    else animation.current?.pause()
  }, [active])
  /** Development: pose the scene at a time and hold it there. */
  const seek = (time: number) => {
    animation.current?.stop()
    elapsed.jump(Math.max(0, Math.min(duration, time)))
    setPaused(true)
    setRevision(value => value + 1)
  }
  return { host, elapsed, clock, reduced, active, seek }
}
