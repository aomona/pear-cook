---
name: pear-agent
description: >
  Build or extend execution-support applications with PEAR Agent. Use when a
  project needs natural-language sources compiled into reviewable plans, the
  durable Plan → Execute → Assess → Replan loop, Cloudflare persistence, React
  hooks, voice, continuation, or partial replanning.
license: MIT
metadata:
  author: aomona
  version: "0.1.0-beta.2"
---

# Build with PEAR Agent

PEAR Agent turns source material into a validated plan, then runs a durable **Plan → Execute → Assess → Replan** loop. The host application owns its Domain, UI, identity, authorization, and provider configuration. PEAR owns portable contracts and runtime behavior.

## Choose the path

- **New application:** scaffold the Minimal Starter. This is the preferred path.
- **Existing application:** integrate the four public packages without copying the reference app.
- **Runtime contribution:** this skill is not the repository-maintainer workflow. Follow the repository's own agent instructions instead.

Read [references/app-workflow.md](references/app-workflow.md) before editing. Then load only the references needed for the requested slice:

| Work                                        | Reference                                                  |
| ------------------------------------------- | ---------------------------------------------------------- |
| Domain schemas, AI interpretation, planning | [references/domain-and-ai.md](references/domain-and-ai.md) |
| Worker, D1, R2, Agents, authorization       | [references/cloudflare.md](references/cloudflare.md)       |
| Provider, clients, hooks, four-page flow    | [references/react.md](references/react.md)                 |
| Local checks and deployment                 | [references/verification.md](references/verification.md)   |

## Required sequence

1. Inspect the host stack, package manager, existing auth, and Cloudflare configuration.
2. Name the Domain boundary: compile input, normalized input, step data, world-state facts, and Domain events.
3. Prefer `pnpm dlx create-pear-agent@beta <app>` for a new app. For an existing app, add only the packages and bindings its requested flow needs.
4. Configure AI and secrets on the Worker only. Never expose `GEMINI_API_KEY` to browser code.
5. Connect React through `PearProvider`; keep HTTP snapshots as the source of truth and WebSockets as invalidation pulses.
6. Exercise Sources → Interpret → Clarify? → Plan → Review → Execute before adding voice, continuation, or replan.
7. Run the host project's typecheck, lint, format check, tests, and a real local smoke path.

## Non-negotiable contracts

- `@pear-agent/core` stays environment-independent. Never import Cloudflare, React, Gemini, or the AI SDK into Domain contracts.
- State changes use typed Runtime Events. LLM or tool output never mutates execution state directly.
- D1 event append and materialized-state update remain atomic and idempotent.
- HTTP snapshots are authoritative. Agent WebSockets only signal that clients should refetch.
- Execution Session is durable work state. Voice Session is an ephemeral connection; disconnecting voice does not stop execution.
- Replanning changes only the affected subgraph. Completed and skipped steps are immutable; active-step changes require pause and human confirmation.
- Authorization is host-injected and fail-closed. Reject unauthorized work before D1, R2, or AI calls.
- Do not paste a fixed finished application over the host. Edit the Domain, host wiring, and UI seams deliberately.

## Public packages

| Package                  | Responsibility                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `@pear-agent/core`       | Zod contracts, Plan DAG, Runtime Events, reducers, snapshots, continuation, voice, replan validation |
| `@pear-agent/ai`         | Provider-neutral structured interpretation, planning, editing, and replanning through the AI SDK     |
| `@pear-agent/cloudflare` | Hono routes, Agents/Durable Objects, D1, R2, Workflows, voice and replan adapters                    |
| `@pear-agent/react`      | Typed clients, provider, session channel, and hooks without a fixed UI kit                           |

## Completion evidence

Do not report completion from compilation alone. Show:

- the generated or integrated app starts locally;
- a source can reach a reviewable plan, or the specific requested slice is exercised end to end;
- secrets stay server-side and authorization is not silently permissive in production;
- the project's own verification commands pass.

Full documentation: https://pear-agent.aomona.me/
