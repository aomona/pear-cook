# PEAR Cook

A guided cooking app built on PEAR Agent. A signed-in cook can provide a dish request, available ingredients, dietary constraints, an optional public recipe URL, and optional notes from a photo. PEAR compiles those sources into a provenance-backed draft. Ingredients and instructions remain editable until the cook explicitly approves the plan and starts a durable Execution Session.

## Local setup

```bash
pnpm install
cp .env.example .env
cp .dev.vars.example .dev.vars
pnpm dev
```

Set these Worker-only values in `.dev.vars`:

- `GEMINI_API_KEY` for recipe interpretation, plan compilation, and server-minted Gemini Live voice sessions;
- `SESSION_SECRET`, with at least 32 random characters;
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from a GitHub OAuth App;
- `GITHUB_CALLBACK_URL=http://localhost:5173/auth/github/callback` for local development.

`PEAR_LOCAL_DEV_AUTH=true` enables the localhost-only **Use local cook** button. Never set it on a deployed Worker. Production has no allow-all authorization path and denies unauthenticated requests before D1, R2, or AI work.

## Runtime shape

- GitHub OAuth sessions are signed, HTTP-only, and resolved server-side. Browser-provided PEAR context is never treated as identity proof.
- Plan and session access is checked against the authenticated GitHub actor. `/api/plans` is owner-scoped; the unscoped PEAR list route is denied.
- Recipe URLs and brief text become durable PEAR sources. Gemini interpretation and planning run only in the Worker.
- HTTP snapshots remain authoritative. Agent WebSockets carry invalidation pulses after their context is replaced with the verified session principal.
- Execution voice guidance reads the current HTTP snapshot, can invoke PEAR's authorized cooking tools, and is ephemeral: muting or disconnecting voice never stops the durable Execution Session.
- A draft Plan Artifact becomes `ready` only from the review action. Session creation checks ownership and rewrites actor IDs from the authenticated principal.

## Verification and deployment

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm db:migrate:remote
pnpm deploy
```

Before deployment, create the production D1 database and R2 bucket, replace their IDs in `wrangler.jsonc`, install `GEMINI_API_KEY`, `SESSION_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` with Wrangler secrets, and register the production GitHub callback URL.
