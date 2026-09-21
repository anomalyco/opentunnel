import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { OpenGraphCard } from "./OpenGraphCard"
import { ComponentsPage } from "./components/ComponentsPage"
import "./fonts.css"
import "./site.css"

// `/og` is the share card, screenshotted at build time by scripts/build-og.ts; `/components` the workshop (development).
const page = location.pathname === "/og" ? <OpenGraphCard /> : import.meta.env.DEV && location.pathname === "/components" ? <ComponentsPage /> : <App />

createRoot(document.getElementById("root")!).render(<StrictMode>{page}</StrictMode>)
