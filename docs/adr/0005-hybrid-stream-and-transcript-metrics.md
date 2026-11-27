---
status: accepted
---

# Hybrid In-Page Stream Observation and Transcript Metrics

Because Antigravity's `transcript.jsonl` records only completed `PLANNER_RESPONSE` steps without streaming chunk timestamps, T3AgyMonitor measures real-time TTFT and live `tok/s` by observing active streaming updates inside T3 Code Desktop's renderer, and falls back to transcript-derived step averages (`output_tokens` over step duration, with TTFT shown as `—`) for historical steps or mid-turn attaches.

## Considered Options
- **In-page stream observation + transcript fallback (chosen)**: Delivers accurate live TTFT and `tok/s` while retaining full historical metrics from disk.
- **Transcript-only post-step averages**: Rejected because it cannot measure TTFT or real-time generation speed during a turn.

## Consequences
- Live metrics are owned by the renderer observer and reconciled with authoritative token counts once `PLANNER_RESPONSE` lands in `transcript.jsonl`.
