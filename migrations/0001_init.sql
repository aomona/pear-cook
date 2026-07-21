-- PEAR Runtime v0.1 development baseline.
-- Development databases from the pre AI-native schema must be recreated.

CREATE TABLE execution_sessions (
  id TEXT PRIMARY KEY NOT NULL, domain_id TEXT NOT NULL, domain_version INTEGER NOT NULL,
  status TEXT NOT NULL, plan_id TEXT NOT NULL, plan_version INTEGER NOT NULL,
  goal_id TEXT NOT NULL, actor_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE materialized_states (
  session_id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);
CREATE TABLE runtime_events (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  event_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);
CREATE UNIQUE INDEX runtime_events_session_idempotency ON runtime_events (session_id, idempotency_key);
CREATE INDEX runtime_events_session_occurred ON runtime_events (session_id, occurred_at);
CREATE TABLE raw_inputs (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
  content_type TEXT, byte_size INTEGER NOT NULL, checksum_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by_actor_id TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);
CREATE INDEX raw_inputs_session ON raw_inputs (session_id);
CREATE TABLE normalized_inputs (
  session_id TEXT PRIMARY KEY NOT NULL, payload_json TEXT NOT NULL, revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);
CREATE TABLE voice_leases (
  session_id TEXT PRIMARY KEY NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL,
  status TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  provider_resume_handle TEXT, updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);
CREATE TABLE execution_continuations (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL,
  wake_condition_json TEXT NOT NULL, suspended_reason TEXT NOT NULL, resume_directive TEXT NOT NULL,
  checkpoint_plan_version_id TEXT NOT NULL, checkpoint_last_event_id TEXT,
  checkpoint_snapshot_json TEXT NOT NULL, provider_resume_handle TEXT, scheduler_id TEXT,
  resuming_actor_id TEXT, resume_attempt_id TEXT, resume_claimed_at TEXT, transition_token TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);
CREATE INDEX execution_continuations_session_status ON execution_continuations (session_id, status);
CREATE TABLE plan_versions (
  session_id TEXT NOT NULL, version INTEGER NOT NULL, plan_json TEXT NOT NULL, patch_id TEXT,
  status TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id), UNIQUE (session_id, version)
);
CREATE INDEX plan_versions_session_status ON plan_versions (session_id, status);
CREATE UNIQUE INDEX plan_versions_one_active ON plan_versions (session_id) WHERE status = 'active';
CREATE TABLE plan_patches (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, base_plan_version INTEGER NOT NULL,
  cause_key TEXT NOT NULL, attempt_key TEXT NOT NULL, validation_domain_version INTEGER NOT NULL,
  normalized_input_revision INTEGER, target_plan_version INTEGER, mode TEXT NOT NULL,
  status TEXT NOT NULL, patch_json TEXT NOT NULL, candidate_world_state_json TEXT NOT NULL,
  failure_reason TEXT, active_step_ids_json TEXT NOT NULL, transition_token TEXT,
  created_by_actor_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES execution_sessions (id)
);
CREATE INDEX plan_patches_session_created ON plan_patches (session_id, created_at);
CREATE UNIQUE INDEX plan_patches_session_attempt ON plan_patches (session_id, attempt_key);
CREATE UNIQUE INDEX plan_patches_session_successful_cause ON plan_patches (session_id, cause_key)
  WHERE status IN ('suggested', 'pending_confirmation', 'applied');

CREATE TABLE plan_artifacts (
  id TEXT PRIMARY KEY NOT NULL, domain_id TEXT NOT NULL, status TEXT NOT NULL, title TEXT,
  goal_json TEXT NOT NULL, current_plan_json TEXT NOT NULL, version INTEGER NOT NULL,
  normalized_input_json TEXT, owner_actor_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX plan_artifacts_domain_status ON plan_artifacts (domain_id, status);
CREATE INDEX plan_artifacts_updated ON plan_artifacts (updated_at);
CREATE TABLE plan_artifact_versions (
  artifact_id TEXT NOT NULL, version INTEGER NOT NULL, plan_json TEXT NOT NULL,
  parent_version INTEGER, change_reason TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES plan_artifacts (id), UNIQUE (artifact_id, version)
);
CREATE INDEX plan_artifact_versions_artifact ON plan_artifact_versions (artifact_id, version);

CREATE TABLE plan_sources (
  id TEXT PRIMARY KEY NOT NULL, plan_artifact_id TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, label TEXT NOT NULL, media_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL, source_url TEXT, raw_object_key TEXT, extracted_object_key TEXT,
  created_by_actor_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (plan_artifact_id) REFERENCES plan_artifacts (id)
);
CREATE INDEX plan_sources_artifact_created ON plan_sources (plan_artifact_id, created_at);
CREATE INDEX plan_sources_artifact_status ON plan_sources (plan_artifact_id, status);
CREATE TABLE compile_jobs (
  id TEXT PRIMARY KEY NOT NULL, plan_artifact_id TEXT NOT NULL, workflow_instance_id TEXT,
  phase TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL, model_calls INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (plan_artifact_id) REFERENCES plan_artifacts (id)
);
CREATE INDEX compile_jobs_artifact_created ON compile_jobs (plan_artifact_id, created_at);
CREATE INDEX compile_jobs_status ON compile_jobs (status, updated_at);
CREATE UNIQUE INDEX compile_jobs_one_active ON compile_jobs (plan_artifact_id)
  WHERE status IN ('queued', 'running', 'waiting');
CREATE TABLE interpretation_artifacts (
  id TEXT PRIMARY KEY NOT NULL, plan_artifact_id TEXT NOT NULL, compile_job_id TEXT NOT NULL,
  revision INTEGER NOT NULL, normalized_input_json TEXT NOT NULL, assumptions_json TEXT NOT NULL,
  generation_json TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (plan_artifact_id) REFERENCES plan_artifacts (id),
  FOREIGN KEY (compile_job_id) REFERENCES compile_jobs (id), UNIQUE (plan_artifact_id, revision)
);
CREATE INDEX interpretations_job ON interpretation_artifacts (compile_job_id);
CREATE TABLE clarification_requests (
  id TEXT PRIMARY KEY NOT NULL, plan_artifact_id TEXT NOT NULL, compile_job_id TEXT NOT NULL,
  status TEXT NOT NULL, questions_json TEXT NOT NULL, answers_json TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, answered_at TEXT,
  FOREIGN KEY (plan_artifact_id) REFERENCES plan_artifacts (id),
  FOREIGN KEY (compile_job_id) REFERENCES compile_jobs (id)
);
CREATE INDEX clarifications_artifact_status ON clarification_requests (plan_artifact_id, status);
CREATE INDEX clarifications_job ON clarification_requests (compile_job_id);
CREATE TABLE generation_records (
  id TEXT PRIMARY KEY NOT NULL, plan_artifact_id TEXT NOT NULL, compile_job_id TEXT NOT NULL,
  stage TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (plan_artifact_id) REFERENCES plan_artifacts (id),
  FOREIGN KEY (compile_job_id) REFERENCES compile_jobs (id)
);
CREATE INDEX generation_records_artifact_created ON generation_records (plan_artifact_id, created_at);

CREATE TABLE plan_edit_proposals (
  id TEXT PRIMARY KEY NOT NULL, plan_artifact_id TEXT NOT NULL, base_version INTEGER NOT NULL,
  request TEXT NOT NULL, candidate_plan_json TEXT NOT NULL, diff_json TEXT NOT NULL,
  status TEXT NOT NULL, created_by_actor_id TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT,
  FOREIGN KEY (plan_artifact_id) REFERENCES plan_artifacts (id)
);
CREATE INDEX plan_edit_proposals_artifact_created ON plan_edit_proposals (plan_artifact_id, created_at);

CREATE TABLE recipe_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  plan_artifact_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_input TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  transformation_history_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (plan_artifact_id) REFERENCES plan_artifacts (id),
  FOREIGN KEY (source_id) REFERENCES plan_sources (id)
);
CREATE INDEX recipe_drafts_plan_created ON recipe_drafts (plan_artifact_id, created_at);
CREATE INDEX recipe_drafts_owner ON recipe_drafts (owner_actor_id, updated_at);
