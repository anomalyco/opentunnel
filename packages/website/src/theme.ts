// Two ways to print the page. `paper`: black page, red paper, ivory light. `mono`: one ink on
// charcoal, the whole page a duotone of its own luminance, like a single-colour screen print.
export type Theme = "paper" | "mono"

export const monoInks = { bg: "#181617", ink: "#d48ea6" }

/** Dev only: `?theme=mono` prints the page in one ink. */
export const theme: Theme = import.meta.env.DEV && new URLSearchParams(location.search).get("theme") === "mono" ? "mono" : "paper"

const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
/** Per-channel transfer tables mapping luminance 0→bg, 1→ink. */
export const monoTables = [0, 1, 2].map(i => `${channel(monoInks.bg, i)} ${channel(monoInks.ink, i)}`)
