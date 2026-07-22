import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migration1 = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
const migration2 = readFileSync(
  new URL("../migrations/0002_cooking_resilience.sql", import.meta.url),
  "utf8",
);

function insertSession(
  db: DatabaseSync,
  input: { id: string; domainId?: string; planJson: string; stateJson?: string; pendingPatch?: boolean },
) {
  const now = "2026-07-21T00:00:00.000Z";
  db.prepare(
    `INSERT INTO execution_sessions
      (id, domain_id, domain_version, status, plan_id, plan_version, goal_id,
       actor_ids_json, created_at, updated_at)
     VALUES (?, ?, 0, 'active', ?, 1, 'goal', '["github:test"]', ?, ?)`,
  ).run(input.id, input.domainId ?? "guided-cooking", `plan-${input.id}`, now, now);
  db.prepare("INSERT INTO materialized_states (session_id, state_json, updated_at) VALUES (?, ?, ?)")
    .run(input.id, input.stateJson ?? '{"stepStates":{}}', now);
  db.prepare(
    "INSERT INTO plan_versions (session_id, version, plan_json, status, created_at) VALUES (?, 1, ?, 'active', ?)",
  ).run(input.id, input.planJson, now);
  if (input.pendingPatch) {
    db.prepare(
      `INSERT INTO plan_patches
        (id, session_id, base_plan_version, cause_key, attempt_key,
         validation_domain_version, mode, status, patch_json,
         candidate_world_state_json, active_step_ids_json, created_by_actor_id,
         created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, 0, 'confirm', 'pending_confirmation', '{}', '{}', '[]',
         'github:test', ?, ?)`,
    ).run(`patch-${input.id}`, input.id, `cause-${input.id}`, `attempt-${input.id}`, now, now);
  }
}

function domainVersion(db: DatabaseSync, id: string): number {
  const row = db
    .prepare("SELECT domain_version FROM execution_sessions WHERE id = ?")
    .get(id) as { domain_version: number };
  return row.domain_version;
}

describe("cooking resilience migration", () => {
  it("backfills only parseable v2 guided-cooking sessions without pending patches", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(migration1);
    const validPlan = JSON.stringify({
      metadata: { domainId: "guided-cooking", domainVersion: 2 },
      steps: [],
    });
    insertSession(db, { id: "eligible", planJson: validPlan });
    insertSession(db, { id: "pending", planJson: validPlan, pendingPatch: true });
    insertSession(db, { id: "invalid", planJson: "not-json" });
    insertSession(db, { id: "other", domainId: "other-domain", planJson: validPlan });

    db.exec(migration2);

    expect(domainVersion(db, "eligible")).toBe(2);
    expect(domainVersion(db, "pending")).toBe(0);
    expect(domainVersion(db, "invalid")).toBe(0);
    expect(domainVersion(db, "other")).toBe(0);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cooking_%'")
        .all()
        .map((row) => (row as { name: string }).name)
        .sort(),
    ).toEqual([
      "cooking_compile_estimate_snapshots",
      "cooking_estimate_profiles",
      "cooking_feedback",
    ]);
  });

  it("enforces feedback idempotency and bounded estimate factors", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(migration1);
    db.exec(migration2);
    const now = "2026-07-21T00:00:00.000Z";
    insertSession(db, {
      id: "feedback-session",
      planJson: JSON.stringify({ metadata: { domainId: "guided-cooking", domainVersion: 2 } }),
    });
    const insertFeedback = db.prepare(
      `INSERT INTO cooking_feedback
        (id, session_id, recipe_id, actor_id, rating, difficulty, estimated_seconds,
         actual_seconds, notes, idempotency_key, created_at, updated_at)
       VALUES (?, 'feedback-session', ?, 'github:test', 5, 'expected', 60, 75, '', ?, ?, ?)`,
    );
    insertFeedback.run("one", "recipe-one", "feedback-session:recipe-one", now, now);
    expect(() =>
      insertFeedback.run("duplicate", "recipe-two", "feedback-session:recipe-one", now, now),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO cooking_estimate_profiles
            (actor_id, estimate_kind, sample_count, ratio_sum, factor, updated_at)
           VALUES ('github:test', 'overall', 1, 3, 3, ?)`,
        )
        .run(now),
    ).toThrow();
  });
});
