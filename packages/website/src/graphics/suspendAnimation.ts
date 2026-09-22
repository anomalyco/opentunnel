import type { AnimationPlaybackControls } from "motion/react"

export type SuspensibleAnimation = Pick<AnimationPlaybackControls, "state" | "duration" | "play" | "pause" | "stop">

/** Motion's JS pause keeps its frame driver alive. Stop that driver offscreen,
 * then recreate the same fixed keyframes and seek to the saved playback time.
 * The factory must retain its original keyframes, rather than read a new origin.
 */
export function suspendAnimation(create: () => AnimationPlaybackControls): SuspensibleAnimation {
  let controls = create()
  let elapsed = 0, paused = false, stopped = false
  return {
    get duration() { return controls.duration },
    get state() { return paused ? "paused" : !controls.duration ? "finished" : controls.state },
    pause() {
      if (stopped || paused || !controls.duration || controls.state !== "running") return
      // JSAnimation's tick exposes delay-adjusted time. pause() first captures
      // the full timeline time, so resuming preserves an unfinished delay too.
      controls.pause()
      elapsed = controls.time
      controls.stop()
      paused = true
    },
    play() {
      if (stopped || !paused) return
      paused = false
      controls = create()
      controls.time = elapsed
      controls.play()
    },
    stop() { stopped = true; paused = false; controls.stop() },
  }
}
