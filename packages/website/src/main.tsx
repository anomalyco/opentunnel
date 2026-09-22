import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { OpenGraphCard } from "./OpenGraphCard"
import "./fonts.css"
import "./site.css"

// Development: `/og` is the share card, which `bun run og` screenshots into public/og.png.
const page = import.meta.env.DEV && location.pathname === "/og" ? <OpenGraphCard /> : <App />

createRoot(document.getElementById("root")!).render(<StrictMode>{page}</StrictMode>)
