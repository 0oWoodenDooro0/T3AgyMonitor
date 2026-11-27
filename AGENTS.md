# AGENTS.md

Project guidance for AI coding agents working in **T3AgyMonitor**.

## Project Overview

T3AgyMonitor is a plugin/enhancement for **T3 Code Desktop** (Electron + React) focused exclusively on the **Antigravity** provider. It provides a single-session live monitoring capsule, 10-category context breakdown, subagent/swarm unified timeline, stage progress reporting, collapsible overview panel, and an in-app update checker.

## Development Principles

- Prefer non-invasive integration (e.g., local CDP injection + read-only access to local SQLite/JSONL/transcript data under `~/.t3/userdata/` and `~/.t3/userdata/providers/antigravity/`) unless a fork or alternative architecture is explicitly chosen during design.
- Keep dependencies minimal (prefer pure Node.js ESM / built-in `node:sqlite` where practical).
- Follow TDD (vertical slices: red → green) and run code review before handing back changes.
- Update this file with build, lint, and test commands once the tech stack and project layout are finalized.
