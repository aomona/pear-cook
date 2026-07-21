# Application workflow

## Greenfield: use the Minimal Starter

```bash
pnpm dlx create-pear-agent@beta my-agent
cd my-agent
pnpm install
cp .env.example .env
cp .dev.vars.example .dev.vars
pnpm dev
```

Add `GEMINI_API_KEY` only to `.dev.vars`. The generated project includes Cloudflare Worker wiring, D1 and R2 bindings, an Agent Durable Object, a compile Workflow, React, and four editable pages.

Start application-specific work in:

```text
src/
├── app/pages/       # plan list, source input, plan review, execution
├── domain/          # schemas, Domain definition, deterministic fallback plan
└── pear.config.ts   # app name, Domain id, actor/context and API origin
```

Do not edit copied Runtime internals: the starter consumes published packages. Do not copy `examples/outing-agent` unless the user explicitly asks for the reference example.

## Existing application: integrate by boundary

Before adding dependencies, inspect:

1. client framework and routing;
2. server/Worker entry point;
3. authentication and authorization context;
4. current Cloudflare bindings and migrations;
5. where Domain schemas and provider configuration belong.

Install the public beta packages needed by the flow. A complete Cloudflare + React host commonly needs:

```bash
pnpm add @pear-agent/core@beta @pear-agent/ai@beta @pear-agent/cloudflare@beta @pear-agent/react@beta
pnpm add ai @ai-sdk/google zod react agents
pnpm add -D wrangler @cloudflare/workers-types
```

Respect the host's existing versions and package manager. Check each package's peer dependency diagnostics instead of forcing duplicate versions.

## Build in vertical slices

1. **Domain:** parse compile input and define normalized input, step data, world-state facts, events, planning policy, and replan policy.
2. **Worker:** inject authorization and Domain-aware AI adapters into `createPearWorker`; bind D1, R2, the ExecutionSessionAgent, and compile Workflow.
3. **Plan flow:** upload/add sources, compile, answer clarification if required, review, and mark a plan ready.
4. **Execution:** create an Execution Session from the ready Plan Artifact and render its HTTP Snapshot.
5. **Realtime:** enable Agent WebSocket invalidation after HTTP hydration works.
6. **Extensions:** add partial replan, continuation, then voice only when the core flow is proven.

## Scope rules

- Keep Domain-specific fields out of Core envelopes. Store Domain state under `WorldState.facts`.
- Keep UI choices in the host. `@pear-agent/react` intentionally does not provide a UI kit.
- Use the generated migration baseline for a generated project. For an existing database, adopt PEAR migrations deliberately; never duplicate or hand-edit schema SQL without comparing the package migration contract.
- Replace permissive local authorization before deployment.
