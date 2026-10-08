---
"opentunnel": minor
---

`route add` now takes just the target and gives the route a random 16-character name, so its URL can't be guessed (`opentunnel route add 3000`). Adding the same target again keeps that route. Use `--name api` for a readable name, or `--name @` for the tunnel hostname. The old `route add <name> <target>` form still works and prints a note.
