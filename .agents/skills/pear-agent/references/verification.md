# Verification and deployment

## Local setup

Generated applications use Node.js 20+ and pnpm. Typical setup:

```bash
pnpm install
cp .env.example .env
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

Add `GEMINI_API_KEY` to `.dev.vars` only when exercising AI or voice. Do not put it in `VITE_*` variables.

## Evidence path

For a complete application, exercise the actual path rather than stopping at a test command:

1. open the plans page;
2. create a draft artifact;
3. add source text or a file;
4. compile and answer a clarification if one appears;
5. review the generated DAG and source provenance;
6. mark the artifact ready;
7. create an Execution Session;
8. complete one step and observe a revision pulse followed by a fresh HTTP Snapshot.

If only one slice changed, exercise that boundary end to end and state what was not tested.

## Project checks

Use the generated/host scripts. A standard gate is:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

Do not call real AI providers from deterministic CI. Inject fake structured generators/providers in tests.

## Pre-deploy checks

- production authorization is configured and fail-closed;
- D1, R2, Durable Object, and Workflow bindings match Worker types;
- all required migrations are applied to the production D1 database;
- secrets are installed with Wrangler and absent from client bundles;
- `VITE_PEAR_API_URL` points to the intended Worker when frontend and API origins differ;
- WebSocket origin/routing works through `createPearWorker()`;
- the deployed `/health` endpoint responds before exercising authenticated routes.

Then deploy with the host's script, commonly:

```bash
pnpm db:migrate:remote
pnpm deploy
```

Confirm the deployed source-to-session path. A successful static frontend deploy alone does not prove D1, R2, Workflow, Agent, or authorization wiring.
