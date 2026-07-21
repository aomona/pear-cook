# Cloudflare host

## Runtime shape

```text
Hono HTTP
  → host context + authorize(operation, context)
  → Domain and AI adapters
  → ExecutionSessionAgent serializes session mutation
  → atomic D1 event + materialized-state update
  → WebSocket invalidation pulse
```

D1 is the durable source of truth. R2 stores source bytes. Agent/Durable Object storage is not a second state model.

## Worker entry point

Use `createPearWorker()` rather than the HTTP-only `createPearApp()` when React realtime invalidation is enabled. Export `ExecutionSessionAgent`, export the compile Workflow class when bound, and return the Worker's fetch handler.

Inject:

- `authorize`: fail-closed host authorization;
- plan/compile adapters built from the Domain and Worker environment;
- optional replan, voice, and source adapters only when the requested flow needs them.

Factory adapters that receive the current Worker environment take precedence over static adapters. Use factories for anything that needs bindings or secrets.

## Required bindings

A standard generated app binds:

- `DB`: D1 database;
- `RAW_INPUTS`: R2 bucket;
- `ExecutionSessionAgent`: SQLite Durable Object / Agent namespace;
- `PLAN_COMPILE_WORKFLOW`: Workflow for durable compilation;
- `GEMINI_API_KEY`: Worker secret when Gemini-backed compile or voice is enabled.

Use the migration paths in the generated starter/package. Apply local migrations before running the flow, and production migrations before deploy.

## Authorization order

Authorization must happen before durable reads that expose data and before writes, R2 operations, or AI calls. The host maps its authenticated principal into `PearRequestContext`; PEAR does not provide built-in tenancy or auth.

Do not deploy `allowAllAuthorize`. It is acceptable only behind an explicit local-development flag. Production defaults must deny.

## State mutation

- Send typed Runtime Events to the Agent path.
- Serialize session read-modify-write through `ExecutionSessionAgent`.
- Preserve event `id` and `idempotencyKey` semantics.
- Append the event and update materialized state atomically.
- Broadcast only invalidation metadata; clients fetch the authoritative HTTP Snapshot.

## Sources and compilation

Store source metadata and checksums in D1; store file/raw bytes in R2. Compilation is a durable sequence:

```text
source → interpret → clarification? → synthesize → validate → versioned Plan Artifact
```

Cancellation must reach AI calls through `AbortSignal`. Retrying a failed/cancelled compile creates controlled durable work; it must not silently overwrite the prior ready artifact.

## Extensions

Add these after the base plan/execution flow works:

- **Partial replan:** host resolves Domain configuration and world-state reconciliation; PEAR validates affected-subgraph changes.
- **Continuation:** persist a checkpoint, claim resume atomically, complete or return a failed resume to `wake_pending`.
- **Voice:** mint ephemeral tokens on the Worker; keep the provider API key server-side; a Voice Lease is separate from Execution Session lifecycle.
