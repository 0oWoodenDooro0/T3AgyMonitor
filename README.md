# T3AgyMonitor

Non-invasive, attach-only CDP **Sidecar** and Shadow DOM monitoring overlay for **T3 Code Desktop** running on the **Antigravity** provider.

- **Zero third-party runtime dependencies** (pure Node.js ESM + built-in `node:sqlite`).
- **Read-only local data access** (`~/.t3/userdata/statev2.sqlite`, `usage-model-rates.json`, and `~/.t3/userdata/providers/antigravity/.../transcript.jsonl`).
- **No `app.asar` patching** and **no extra localhost ports** (communicates over CDP `Runtime.addBinding` / `Runtime.evaluate`).

---

## Features

Three mutually-exclusive Shadow DOM surfaces mounted into T3 Code Desktop's native header bar and styled with T3 Code's `:root` CSS theme variables:

1. **Status Capsule & Dashboard Popover**
   - Compact header pill (`model`, `context %`, `cost`, `tok/s`, `cache %` — 1 to 5 customizable slots) with mini SVG context ring, hover summary, and right-click refresh.
   - Click to open the unified dashboard: 4 KPI cards (`Output Speed`, `Context Used`, `Cache Hit`, `Session Cost`), multi-color **Context Window** segmented bar & legend, per-model usage breakdown, and collapsible `Settings` (`Metric Slots` + `Update Check`).
2. **Context Breakdown**
   - Exact 7-category token breakdown (`User Messages`, `Assistant & Thinking`, `Tool Calls`, `Tool Results`, `Subagent Notifications`, `Checkpoints`, `System & Tools Overhead` residual) with main-agent / subagent switcher.
3. **Unified Timeline**
   - Chronological merged steps across the main thread and delegated subagents/workers, grouped into collapsible turns with a turn rail, clean human-readable subagent titles, and an agent filter (`All Agents`, `Main Agent`, or any subagent).
4. **In-App Update Check**
   - Notification-only GitHub Releases checker (`auto` / `manual` / `off`) showing a version badge, Release Notes link, and copyable update command.

---

## Agent / Automated Setup Guide

Follow these steps in order to install, verify, and attach **T3AgyMonitor** on Linux.

### Prerequisites

- **Node.js** `>= 22.0.0` (built-in `node:sqlite` and `WebSocket`).
- **T3 Code Desktop** launched with `--remote-debugging-port=<port>` (default `9222`).

Verify prerequisites:

```bash
node -v
```

### Step 1: Clone & Verify Tests

```bash
git clone https://github.com/0oWoodenDooro0/T3AgyMonitor.git
cd T3AgyMonitor
npm test
```

Expected: all tests pass (`0 failed`). No `npm install` is required (zero runtime dependencies).

### Step 2: Ensure T3 Code Desktop Is Running with CDP Enabled

Check if CDP is already listening on port `9222`:

```bash
curl -sf http://127.0.0.1:9222/json/list
```

- If it returns a JSON array containing a `"type": "page"` target with `"webSocketDebuggerUrl"`, CDP is ready.
- If connection is refused, relaunch T3 Code Desktop with `--remote-debugging-port=9222`:

```bash
/opt/t3code-bin/t3code --remote-debugging-port=9222
```

> **Optional (persistent launcher on Linux):** Copy the desktop entry to `~/.local/share/applications/` and append `--remote-debugging-port=9222` to its `Exec=` line so T3 Code Desktop always starts with CDP enabled.

### Step 3: Start the Attach-Only Sidecar

Run in a terminal (or background process / user service):

```bash
node /path/to/T3AgyMonitor/src/cli.mjs --port 9222
```

Environment variable alternative:

```bash
T3_CDP_PORT=9222 node /path/to/T3AgyMonitor/src/cli.mjs
```

Expected stdout:

```text
[T3AgyMonitor] Watching CDP port 9222 (Ctrl+C to stop)...
[T3AgyMonitor] Connected to Host App on CDP port 9222
```

The Sidecar automatically reconnects with bounded backoff if T3 Code Desktop restarts, and hot-replaces stale overlay bundles automatically when the code changes (no manual `Ctrl+R` needed).

### Optional: Run as a Background `systemd --user` Service

```bash
mkdir -p ~/.config/systemd/user
cat <<EOF > ~/.config/systemd/user/t3-agy-monitor.service
[Unit]
Description=T3AgyMonitor CDP Sidecar
After=default.target

[Service]
Type=simple
ExecStart=$(command -v node) $(pwd)/src/cli.mjs --port 9222
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now t3-agy-monitor.service
systemctl --user status t3-agy-monitor.service
```

---

## Configuration & Data Paths

- **User config** (created automatically on first save):
  `~/.config/t3-agy-monitor/config.json`
  ```json
  {
    "capsuleSlots": ["model", "context", "cost", "speed", "cache"],
    "updateCheckMode": "auto"
  }
  ```
- **Read-only local data sources**:
  - `~/.t3/userdata/statev2.sqlite` (`orchestration_v2_projection_threads`, `orchestration_v2_projection_provider_threads`, `orchestration_v2_projection_subagents`, `orchestration_v2_projection_checkpoints`)
  - `~/.t3/userdata/usage-model-rates.json` (bundled fallback rates used if absent)
  - `~/.t3/userdata/providers/antigravity/<account-hash>/antigravity-acp/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`

---

## Troubleshooting

- **`Failed to attach to Host App over CDP` (`DEGRADED`)**: T3 Code Desktop is not running with `--remote-debugging-port=9222`. Verify with `curl -sf http://127.0.0.1:9222/json/list`.
- **Overlay surface missing after a T3 Code Desktop update**: Per [ADR-0004](docs/adr/0004-native-dom-anchors-silent-skip.md), missing native DOM anchors are silently skipped with a `[T3AgyMonitor]` warning in DevTools Console (`Ctrl+Shift+I`). Update the fallback selectors in `src/overlay/anchor-adapter.mjs` (`DEFAULT_SURFACE_ANCHORS`).
- **`ConfigStore` or `UpdateChecker` `DEGRADED` log on first run**: Normal when `~/.config/t3-agy-monitor/config.json` has not been saved yet or no GitHub Release tag has been published yet; both fail open safely.

---

## Architecture & References

- Domain terminology: [GLOSSARY.md](GLOSSARY.md)
- Architecture Decision Records: [docs/adr/](docs/adr/)
- Reference projects:
  - [WhiteBr1ck/agy-powertools](https://github.com/WhiteBr1ck/agy-powertools)
  - [yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor)
  - [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
