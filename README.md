# T3AgyMonitor

Live session monitor overlay for **T3 Code Desktop** (Antigravity provider).

## Requirements

- Linux with **T3 Code Desktop** (`/opt/t3code-bin/t3code`)
- **Node.js `>= 22.0.0`** (no `npm install` needed)

## Install & Run

1. **Clone and verify:**
   ```bash
   git clone https://github.com/0oWoodenDooro0/T3AgyMonitor.git
   cd T3AgyMonitor
   npm test
   ```

2. **Start T3 Code Desktop with CDP enabled (port `9222`):**
   Check if CDP is already active:
   ```bash
   curl -sf http://127.0.0.1:9222/json/list
   ```
   If not active, relaunch T3 Code Desktop with:
   ```bash
   /opt/t3code-bin/t3code --remote-debugging-port=9222
   ```

3. **Start the monitor:**
   ```bash
   node src/cli.mjs --port 9222
   ```
   (Or set `T3_CDP_PORT=9222`.)
   Success output:
   ```text
   [T3AgyMonitor] Watching CDP port 9222 (Ctrl+C to stop)...
   [T3AgyMonitor] Connected to Host App on CDP port 9222
   ```

## Optional: Background Service (`systemd --user`)

```bash
mkdir -p ~/.config/systemd/user
cat <<EOF > ~/.config/systemd/user/t3-agy-monitor.service
[Unit]
Description=T3AgyMonitor
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
```

## Config

- File: `~/.config/t3-agy-monitor/config.json` (auto-created on first change from the UI)
- Keys:
  - `capsuleSlots`: array of 1–5 items from `["model", "context", "cost", "speed", "cache"]`
  - `updateCheckMode`: `"auto"` | `"manual"` | `"off"`
