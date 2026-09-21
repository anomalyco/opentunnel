import { useEffect, useRef, useState } from "react"
import { animate, useMotionValue, useTransform } from "motion/react"
import { suspendAnimation, type SuspensibleAnimation } from "./suspendAnimation"
import { sceneWakeQueue } from "./sceneWakeQueue"

// Ported from the OpenCode blog (src/graphics/useScenePlayback.ts) without the
// debug timeline, play gate and compiled rewind segments. One Motion clock per
// scene: suspended offscreen or in a hidden tab, honouring reduced motion by
// jumping to a static `after` pose.

/** Shared by animated UI actors; the scene decides whether time may advance. */
export type SceneActivity = { active: boolean; reduced: boolean }

/** Start of the cycle containing `from`. A cycle's end can land an ulp under the next multiple. */
const cycleBase = (from: number, duration: number) => Math.floor(from / duration + 1e-6) * duration

export function useScenePlayback(duration: number, { repeat = false, autoplay = false, after = duration, leadIn = 0 }: {
  repeat?: boolean; autoplay?: boolean; after?: number; leadIn?: number
} = {}) {
  const host = useRef<HTMLElement>(null), elapsed = useMotionValue(0)
  const clock = useTransform(elapsed, time => repeat ? time % duration : time)
  const animation = useRef<SuspensibleAnimation | undefined>(undefined)
  const [visible, setVisible] = useState(false), [hidden, setHidden] = useState(false)
  const [reduced, setReduced] = useState(false), [paused, setPaused] = useState(!autoplay), [revision, setRevision] = useState(0)
  const active = visible && !hidden && !reduced && !paused
  const running = useRef(active)
  running.current = active
  const [speed, setSpeed] = useState(1)
  const currentSpeed = useRef(speed); currentSpeed.current = speed
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)")
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
      sceneWakeQueue.defer(host, () => {
        setVisible(entry!.isIntersecting)
        if (entry!.isIntersecting && running.current) animation.current?.play()
      })
    })
    if (host.current) observer.observe(host.current)
    preference(); visibility()
    media.addEventListener("change", preference)
    document.addEventListener("visibilitychange", visibility)
    return () => { sceneWakeQueue.cancel(host); observer.disconnect(); media.removeEventListener("change", preference); document.removeEventListener("visibilitychange", visibility) }
  }, [elapsed, after, autoplay])
  useEffect(() => {
    if (reduced || paused) return
    const from = elapsed.get(), base = repeat ? cycleBase(from, duration) : 0
    const until = base + duration
    if (from >= until) return
    const controls = suspendAnimation(() => animate(elapsed, [from, until], {
      duration: until - from, ease: "linear",
      delay: from === 0 ? leadIn : 0,
      onComplete: () => {
        if (repeat) setRevision(value => value + 1); else setPaused(true)
      },
    }))
    animation.current = controls
    controls.speed = currentSpeed.current
    if (!running.current) controls.pause()
    return () => controls.stop()
  }, [elapsed, duration, repeat, reduced, paused, revision, leadIn])
  useEffect(() => {
    if (active) animation.current?.play()
    else animation.current?.pause()
  }, [active])
  useEffect(() => { if (animation.current) animation.current.speed = speed }, [speed])
  const seek = (time: number, { play = false }: { play?: boolean } = {}) => {
    animation.current?.stop()
    elapsed.jump(Math.max(0, Math.min(duration, time)))
    setPaused(!play)
    setRevision(value => value + 1)
  }
  const replay = () => {
    if (reduced) { seek(elapsed.get() === after ? 0 : after); return }
    animation.current?.stop()
    elapsed.jump(0)
    setPaused(false)
    setRevision(value => value + 1)
  }
  const toggle = () => {
    if (reduced || (!repeat && elapsed.get() >= duration)) replay()
    else setPaused(value => !value)
  }
  return { host, elapsed, clock, reduced, active, playing: !paused && !reduced, seek, replay, toggle, speed, setSpeed }
}
