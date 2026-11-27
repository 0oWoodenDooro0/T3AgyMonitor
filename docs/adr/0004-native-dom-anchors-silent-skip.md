---
status: accepted
---

# Strict Native-DOM Mount Anchors with Silent Skip Fallback

Each UI surface (Status Capsule, Composer Ring, Context Breakdown, Unified Timeline, Stage Progress, Overview Panel) mounts inside its corresponding native DOM region of T3 Code Desktop via Shadow DOM isolation and a dedicated `AnchorAdapter`. If a T3 Code frontend update breaks an anchor selector, that surface is silently skipped (logging a warning to DevTools console) rather than falling back to a floating overlay.

## Considered Options
- **Strict native-DOM anchors + silent skip (chosen)**: Preserves native visual integration and keeps the workspace clutter-free when a selector drifts.
- **Consolidated 3-anchor layout**: Rejected in favor of native placement for Timeline, Context Breakdown, and Stage Progress.
- **Floating fallback container on selector miss**: Rejected to avoid intrusive unanchored overlays if the Host App layout changes.

## Consequences
- Selector maintenance is isolated inside per-surface `AnchorAdapter` definitions so Host App updates require updating only the affected adapter.
- Missing surfaces degrade cleanly without throwing or breaking unaffected surfaces.
