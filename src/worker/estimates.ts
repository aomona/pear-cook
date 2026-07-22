import type { PearEnv } from "@pear-agent/cloudflare";
import { z } from "zod";

const estimateProfileSchema = z.record(z.string(), z.number().finite());

export type EstimateProfile = Record<string, number>;

type EstimateRow = {
  estimate_kind: string;
  factor: number;
};

type SnapshotRow = {
  actor_id: string;
  profile_json: string;
};

function clampFactor(value: number): number {
  return Math.min(2, Math.max(0.5, value));
}

function parseSnapshot(value: string): EstimateProfile {
  const parsed = estimateProfileSchema.parse(JSON.parse(value));
  return Object.fromEntries(
    Object.entries(parsed).map(([key, factor]) => [key, clampFactor(factor)]),
  );
}

export async function readEstimateProfile(
  env: PearEnv,
  actorId: string,
): Promise<EstimateProfile> {
  const rows = await env.DB.prepare(
    "SELECT estimate_kind, factor FROM cooking_estimate_profiles WHERE actor_id = ?",
  )
    .bind(actorId)
    .all<EstimateRow>();
  const profile: EstimateProfile = {};
  for (const row of rows.results) {
    const key = row.estimate_kind === "overall" ? "default" : row.estimate_kind;
    profile[key] = clampFactor(row.factor);
  }
  return profile;
}

export async function snapshotCompileEstimateProfile(
  env: PearEnv,
  compileJobId: string,
  actorId: string,
): Promise<EstimateProfile> {
  const existing = await env.DB.prepare(
    "SELECT actor_id, profile_json FROM cooking_compile_estimate_snapshots WHERE compile_job_id = ?",
  )
    .bind(compileJobId)
    .first<SnapshotRow>();
  if (existing) {
    if (existing.actor_id !== actorId) throw new Error("Compile estimate snapshot owner mismatch");
    return parseSnapshot(existing.profile_json);
  }

  const profile = await readEstimateProfile(env, actorId);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO cooking_compile_estimate_snapshots
      (compile_job_id, actor_id, profile_json, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(compileJobId, actorId, JSON.stringify(profile), now)
    .run();

  const stored = await env.DB.prepare(
    "SELECT actor_id, profile_json FROM cooking_compile_estimate_snapshots WHERE compile_job_id = ?",
  )
    .bind(compileJobId)
    .first<SnapshotRow>();
  if (!stored || stored.actor_id !== actorId) {
    throw new Error("Compile estimate snapshot could not be persisted");
  }
  return parseSnapshot(stored.profile_json);
}
