---
status: accepted
---

# Dual-Mode Soft Budget and Pluggable Quota Provider

Because T3 Code Desktop's Antigravity ACP runtime does not expose local quota or rate-limit data under `~/.t3/userdata/`, the Composer Ring defaults to displaying either remaining context window capacity or a user-configured local Soft Budget (USD or tokens), while the Overview Panel shows per-model local cumulative usage. A pluggable `QuotaProvider` interface is kept in the domain layer so native provider quota can be wired in later without redesigning the UI.

## Considered Options
- **Dual-mode local degradation + `QuotaProvider` seam (chosen)**: Delivers immediate value for 2.2 and 2.6 using verified local data while staying strictly within documented local access boundaries.
- **Drop Composer Ring and per-model usage**: Rejected because context window and local spend tracking remain useful on their own.
- **Query undocumented remote Antigravity quota endpoints**: Rejected due to auth fragility and boundary constraints.

## Consequences
- Cost calculations rely on `~/.t3/userdata/usage-model-rates.json` with a bundled fallback rate table.
- UI labels distinguish local Soft Budget / cumulative usage from native provider quota.
