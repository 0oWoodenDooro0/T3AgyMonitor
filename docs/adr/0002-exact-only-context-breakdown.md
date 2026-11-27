---
status: accepted
---

# Exact-Only Context Breakdown with Residual Overhead Bucket

Context Breakdown reports only exact token categories derivable from `transcript.jsonl` and `statev2.sqlite`—`User Messages`, `Assistant & Thinking`, `Tool Calls`, `Tool Results`, `Subagent Notifications`, and `Checkpoints`—and attributes the remaining difference against `input_tokens` to a single `System & Tools Overhead` bucket. Local file heuristic estimation for System Prompt, User Rules, Skills, and MCP Tools is explicitly excluded.

## Considered Options
- **Exact 7-category model with residual overhead (chosen)**: Matches Antigravity ACP's actual transcript schema without fabricating splits for unlogged system/rules/skills/MCP payloads.
- **Hybrid 10-category model with local file estimation**: Rejected because reading local rule/skill files cannot account for dynamic harness prompts or MCP tool schemas accurately and mixes exact and guessed numbers.

## Consequences
- Every non-residual bucket is auditable directly against local transcript and SQLite records.
- If Antigravity ACP later logs per-section prompt token counts, additional exact categories can be split out of `System & Tools Overhead` without changing the exact-only invariant.
