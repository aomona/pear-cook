# React application

`@pear-agent/react` provides typed clients and hooks, not a component library. Keep routing, visuals, forms, and product-specific interaction in the host.

## Provider

```tsx
import { PearProvider } from "@pear-agent/react";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <PearProvider
      baseUrl={import.meta.env.VITE_PEAR_API_URL || window.location.origin}
      getContext={() => ({ actorId: currentUser.id, roles: currentUser.roles, claims: {} })}
    >
      {children}
    </PearProvider>
  );
}
```

`getContext()` must reflect the host's authenticated principal. The Worker still authorizes every operation; client context is not proof of identity by itself.

## Four-page flow

Build the first usable application as four explicit surfaces:

1. **Plans:** list Plan Artifacts and their draft/ready state.
2. **Sources/Input:** create an artifact, add text/URL/file sources, start compilation, answer clarifications.
3. **Review:** show the generated DAG, provenance, validation state, edits, and version history; mark the artifact ready.
4. **Execute:** create/bind an Execution Session, show ready/blocked/current steps, and emit typed user actions.

Keep the Plan Artifact lifecycle separate from the Execution Session lifecycle. Reviewing a plan is not executing it.

## Session data flow

```text
HTTP Snapshot ──authoritative──▶ React state
Agent WebSocket ──revision pulse──▶ refetch HTTP Snapshot
```

Use `createPearWorker()` on the server for the Agent WebSocket route. Set `realtime={false}` only for HTTP-only tools/tests.

Primary hooks:

- `useExecutionSession()` — create or bind a session; typed step, timer, and event actions;
- `useRuntimeSnapshot(sessionId)` — hydrate and refetch the authoritative snapshot;
- `useContinuation(sessionId)` — suspend/resume lifecycle;
- `useVoiceSession(sessionId)` — Voice Lease, ephemeral token, browser media, and tool bridge.

Snapshot and continuation hooks share one channel for the same session/client. Do not open a second custom WebSocket beside them.

## UI states that must be explicit

- first HTTP hydration vs reconnecting;
- compile queued/running/clarification/failed/cancelled/completed;
- draft vs ready Plan Artifact;
- ready vs blocked vs active vs completed/skipped step;
- pending/confirmed/rejected/applied Plan Patch;
- voice disconnected/connecting/connected/interrupted/error.

Errors should name the failed action and next recovery step. Never replace a failed authoritative read with stale optimistic state without labeling it.

## Voice and replan boundaries

Voice disconnect is not execution stop. Flush/persist resume handles before disconnect or suspend when available. Replan UI must show the proposed diff and why confirmation is required; do not diff whole plans client-side when `latestPlanChange` already provides the validated operation list.
