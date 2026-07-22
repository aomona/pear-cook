-- Host-owned cooking resilience state.

CREATE TABLE IF NOT EXISTS cooking_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'expected', 'hard')),
  estimated_seconds INTEGER NOT NULL CHECK (estimated_seconds > 0),
  actual_seconds INTEGER NOT NULL CHECK (actual_seconds > 0),
  notes TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id),
  UNIQUE (session_id, recipe_id),
  UNIQUE (actor_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS cooking_feedback_actor_created
  ON cooking_feedback (actor_id, created_at);

CREATE TABLE IF NOT EXISTS cooking_estimate_profiles (
  actor_id TEXT NOT NULL,
  estimate_kind TEXT NOT NULL,
  sample_count INTEGER NOT NULL CHECK (sample_count > 0),
  ratio_sum REAL NOT NULL CHECK (ratio_sum > 0),
  factor REAL NOT NULL CHECK (factor BETWEEN 0.5 AND 2.0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, estimate_kind)
);

CREATE TABLE IF NOT EXISTS cooking_compile_estimate_snapshots (
  compile_job_id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (compile_job_id) REFERENCES compile_jobs (id)
);
CREATE INDEX IF NOT EXISTS cooking_compile_estimates_actor_created
  ON cooking_compile_estimate_snapshots (actor_id, created_at);

-- Sessions created before the Replan runtime was wired were stamped version 0.
-- Only migrate recognizable, parseable guided-cooking state. Leave sessions with
-- an in-flight patch untouched because confirmation re-resolves the live version.
UPDATE execution_sessions
SET domain_version = 2,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE domain_id = 'guided-cooking'
  AND domain_version = 0
  AND EXISTS (
    SELECT 1
    FROM materialized_states AS state
    WHERE state.session_id = execution_sessions.id
      AND json_valid(state.state_json)
  )
  AND EXISTS (
    SELECT 1
    FROM plan_versions AS version
    WHERE version.session_id = execution_sessions.id
      AND version.status = 'active'
      AND json_valid(version.plan_json)
      AND json_extract(version.plan_json, '$.metadata.domainId') = 'guided-cooking'
      AND CAST(json_extract(version.plan_json, '$.metadata.domainVersion') AS INTEGER) = 2
  )
  AND NOT EXISTS (
    SELECT 1
    FROM plan_patches AS patch
    WHERE patch.session_id = execution_sessions.id
      AND patch.status IN ('suggested', 'pending_confirmation')
  );
