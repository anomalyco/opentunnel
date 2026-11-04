---
"@opentunnel/client": patch
---

The SDK reads the API URL from `OPENTUNNEL_API` when no `api` option is passed, like the CLI, so apps built on it can be pointed at a self-hosted server (#63).
