---
status: accepted
---

# Attach-Only CDP Sidecar with Built-In Bridge

T3AgyMonitor runs as a non-invasive, long-running Node.js sidecar that auto-reconnects to T3 Code Desktop over Chrome DevTools Protocol (`--remote-debugging-port`, default `9222`), and communicates with injected Shadow DOM surfaces via CDP `Runtime.addBinding` and `Runtime.evaluate`. Users launch T3 Code Desktop with the debugging flag themselves; T3AgyMonitor does not patch `app.asar`, fork upstream `t3code`, or overwrite desktop launchers.

## Considered Options
- **Attach-only CDP sidecar + CDP binding bridge (chosen)**: Zero `app.asar` modification, no extra localhost port, immune to Electron renderer CSP restrictions, survives Host App restarts via auto-reconnect.
- **CDP sidecar + `.desktop` launcher wrapper**: Rejected to keep installation non-invasive and leave Host App launch control with the user.
- **Localhost WebSocket server for UI IPC**: Rejected due to extra port management and potential Electron `connect-src` CSP blocks.
- **Upstream fork / `app.asar` patch**: Rejected due to high maintenance cost across T3 Code updates.

## Consequences
- Users must start T3 Code Desktop with `--remote-debugging-port=<port>` for T3AgyMonitor to attach.
- All UI-to-sidecar actions and sidecar-to-UI state pushes flow over the single CDP WebSocket connection.
