# T3AgyMonitor

Live session monitoring, context analysis, and update notification for T3 Code Desktop sessions running on the Antigravity provider.

## Language

**Host App**:
The running T3 Code Desktop application instance that T3AgyMonitor attaches to and augments.
_Avoid_: Client, IDE, Electron app

**Sidecar**:
The local background process that monitors the Host App connection, reads session history, and coordinates UI state.
_Avoid_: Daemon, server, agent

**Status Capsule**:
The compact monitoring bar displaying 1–5 user-selected live session metrics, with a hover summary, click popover, and right-click refresh.
_Avoid_: Pill, badge, status widget

**Composer Ring**:
The visual progress indicator framing the Host App's composer input, representing remaining context window capacity, a Soft Budget, or active model quota.
_Avoid_: Quota border, progress bar

**Soft Budget**:
A user-defined local ceiling in USD or tokens used to track session or model spend when provider-side quota data is unavailable.
_Avoid_: Quota, rate limit, allowance

**Quota Provider**:
A pluggable source of remaining per-model quota; inactive by default until native provider quota becomes available.
_Avoid_: Billing API, rate-limit client

**Context Breakdown**:
The exact token distribution of a conversation's latest request across seven categories (`User Messages`, `Assistant & Thinking`, `Tool Calls`, `Tool Results`, `Subagent Notifications`, `Checkpoints`, and `System & Tools Overhead`), switchable between main agent and subagents.
_Avoid_: 10-category estimate, prompt breakdown

**Unified Timeline**:
The chronological, filterable merged view of historical and live steps across the main thread and its direct or nested subagents, delegated tasks, and swarm workers.
_Avoid_: Activity feed, trace log

**Stage Progress**:
A brief in-place progress summary shown during consecutive tool calls that automatically collapses into the turn's duration bar once the turn finishes.
_Avoid_: Loading spinner, toast

**Overview Panel**:
The collapsible right-side drawer displaying the current execution stage, per-step duration, and per-model local cumulative usage (or remaining quota when a Quota Provider is active).
_Avoid_: Sidebar, inspector

**Mount Anchor**:
A specific native DOM region in the Host App where an individual UI surface attaches; when absent, that surface is silently omitted rather than rendered in a floating fallback.
_Avoid_: Slot, container, hook
