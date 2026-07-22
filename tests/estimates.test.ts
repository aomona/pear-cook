import type { PearEnv } from "@pear-agent/cloudflare";
import { describe, expect, it } from "vitest";

import {
  readEstimateProfile,
  snapshotCompileEstimateProfile,
} from "../src/worker/estimates";

type ProfileRow = { estimate_kind: string; factor: number };
type SnapshotRow = { actor_id: string; profile_json: string };

class EstimateDb {
  readonly profiles = new Map<string, ProfileRow[]>();
  readonly snapshots = new Map<string, SnapshotRow>();

  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...input: unknown[]) => {
        values = input;
        return statement;
      },
      all: async <T>() => {
        if (!sql.includes("FROM cooking_estimate_profiles")) throw new Error("Unexpected all query");
        return { results: (this.profiles.get(String(values[0])) ?? []) as T[] };
      },
      first: async <T>() => {
        if (!sql.includes("FROM cooking_compile_estimate_snapshots")) {
          throw new Error("Unexpected first query");
        }
        return (this.snapshots.get(String(values[0])) ?? null) as T | null;
      },
      run: async () => {
        if (!sql.includes("INSERT OR IGNORE INTO cooking_compile_estimate_snapshots")) {
          throw new Error("Unexpected run query");
        }
        const [jobId, actorId, profileJson] = values.map(String);
        if (!this.snapshots.has(jobId)) {
          this.snapshots.set(jobId, { actor_id: actorId, profile_json: profileJson });
        }
        return { success: true };
      },
    };
    return statement;
  }
}

function envWith(db: EstimateDb): PearEnv {
  return { DB: db } as unknown as PearEnv;
}

describe("cooking estimate profiles", () => {
  it("maps the aggregate profile to planner keys and clamps corrupted values", async () => {
    const db = new EstimateDb();
    db.profiles.set("github:cook", [
      { estimate_kind: "overall", factor: 3 },
      { estimate_kind: "prep", factor: 0.1 },
    ]);

    await expect(readEstimateProfile(envWith(db), "github:cook")).resolves.toEqual({
      default: 2,
      prep: 0.5,
    });
  });

  it("reuses one immutable snapshot across retries and takes a fresh snapshot for a new job", async () => {
    const db = new EstimateDb();
    db.profiles.set("github:cook", [{ estimate_kind: "overall", factor: 1.2 }]);
    const env = envWith(db);

    await expect(snapshotCompileEstimateProfile(env, "job-one", "github:cook")).resolves.toEqual({
      default: 1.2,
    });
    db.profiles.set("github:cook", [{ estimate_kind: "overall", factor: 1.8 }]);
    await expect(snapshotCompileEstimateProfile(env, "job-one", "github:cook")).resolves.toEqual({
      default: 1.2,
    });
    await expect(snapshotCompileEstimateProfile(env, "job-two", "github:cook")).resolves.toEqual({
      default: 1.8,
    });
  });

  it("rejects reuse of a compile snapshot by another actor", async () => {
    const db = new EstimateDb();
    db.snapshots.set("job-one", {
      actor_id: "github:owner",
      profile_json: JSON.stringify({ default: 1 }),
    });

    await expect(
      snapshotCompileEstimateProfile(envWith(db), "job-one", "github:attacker"),
    ).rejects.toThrow("owner mismatch");
  });
});
