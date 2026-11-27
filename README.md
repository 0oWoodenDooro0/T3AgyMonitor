# T3AgyMonitor

Live session monitor capsule, context breakdown, and in-app update checker plugin for **T3 Code Desktop** (targeting the **Antigravity** provider).

## Planned Scope

1. **Live Monitoring Capsule & Context Analysis (Single Session)**
   - **2.1 Live Status Capsule** (titlebar / composer): customizable 1–5 metric slots (`tok/s`, TTFT, context window usage, cache hit rate, step/session USD cost, ring progress gauge).
   - **2.2 Composer Quota Ring / Border**: remaining model quota indicator around the composer input.
   - **2.3 10-Category Context Breakdown**: breakdown of latest request tokens across System Prompt, User Rules, Skills, MCP Tools, System Tools, User messages, Assistant replies, Tool results, Subagent notifications, and Checkpoints (with main-agent / subagent switcher).
   - **2.4 Main Agent / Subagent / Swarm Unified Timeline**: chronological merged view, turn rail, inline running task expansion, per-agent filter.
   - **2.5 Stage Progress Reporting & Auto-Collapse**: brief progress updates during consecutive tool calls, auto-collapsing into the top duration bar when the turn completes.
   - **2.6 Collapsible Right Overview Panel**: current execution stage, per-step duration, and per-model remaining quota.
2. **In-App Update Checker**
   - **6.2 In-App Update Check**: manual / auto / off update check with version badge notification.

## Target Environment

- **Host**: T3 Code Desktop (Electron + React)
- **Provider**: Antigravity only
- **Reference Projects**:
  - [WhiteBr1ck/agy-powertools](https://github.com/WhiteBr1ck/agy-powertools)
  - [yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor)
  - [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
