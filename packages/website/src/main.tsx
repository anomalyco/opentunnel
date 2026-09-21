import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { OpenGraphCard } from "./OpenGraphCard"
import "./fonts.css"
import "./site.css"

// `/og` is the share card, screenshotted at build time by scripts/build-og.ts.
const page = location.pathname === "/og" ? <OpenGraphCard /> : <App />

createRoot(document.getElementById("root")!).render(<StrictMode>{page}</StrictMode>)
