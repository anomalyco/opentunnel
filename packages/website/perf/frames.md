# Frame pacing

## Goal
The landing page animates all the time (the diagram, the print). It must hold 60 Hz in Safari, which
rasterises SVG filters and strokes in software far more expensively than Chromium.

## Benchmark
```sh
bunx vite preview --port 4191            # the built site; WebKit stalls on the Vite dev server
bun run bench:frames -- --url http://127.0.0.1:4191/
bun run bench:frames -- --url http://127.0.0.1:4191/ --css "main { filter: none !important }"   # test one hypothesis
```
`scripts/bench-frames.ts`: headless WebKit at 1280×800 and 390×844, the diagram centred, requestAnimationFrame
intervals sampled for 4 s; 1 warmup + 7 runs; median of medians. Headless WebKit has no GPU, so absolute numbers
are pessimistic; rankings hold.

Primary metric: `laptop_frame_median_ms`, `phone_frame_median_ms`. Secondary: `*_p95_ms`, `*_dropped_share`.

## Results (2026-09-22)
| change | laptop | phone | decision |
| --- | --- | --- | --- |
| baseline (`main { filter: url(#ink) }`, dashed trail) | 762 | 129 | |
| ink filter off the column, kept on the mark, caption and headings | 63 | 55 | keep |
| trail bands as short polylines; only changed bands written, cold bands hidden | 19 | 17 | keep |
| grain overlay off | 61 → 61 | | noise, keep the grain |
| CardGlow off | 61 → 60 | | noise |
| splatter off | 61 → 60 | | noise |
| WebGL canvases hidden | 61 → 158 | | invalid (layout changed); GL is not the cost |

## Dead ends and notes
- A displacement filter on the whole column is a software re-rasterisation of the page on every frame
  anything inside it animates. Filters belong on small, still elements.
- 256 full-length `<path>`s each showing one dash are stroked 256 times per leg per frame; polylines of the
  band's own stretch cost nothing.
- The Vite dev server itself does not finish loading in headless WebKit within 30 s; benchmark the build.
