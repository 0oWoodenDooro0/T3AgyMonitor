# AGENTS.md

T3AgyMonitor targets **T3 Code Desktop** (Electron + React) and the **Antigravity** provider only. See [README.md](README.md) for feature scope.

## Architectural Constraints

- Prefer non-invasive integration (local CDP injection + read-only access to local SQLite/JSONL/transcript data under `~/.t3/userdata/` and `~/.t3/userdata/providers/antigravity/`) unless a fork or alternative architecture is explicitly chosen during design.
- Keep dependencies minimal (prefer pure Node.js ESM and built-in `node:sqlite` where practical).
