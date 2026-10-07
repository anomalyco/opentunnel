---
"opentunnel": patch
---

On macOS, fall back to a plain background process when no one is logged in at the console (for example over SSH), instead of failing to start the launchd service.
