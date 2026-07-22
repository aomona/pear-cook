import type { PearEnv, PearRequestContext } from "@pear-agent/cloudflare";
import { z } from "zod";

export type FeedbackEnv = PearEnv;

const feedbackInputSchema = z.object({
  recipeId: z.string().trim().min(1).max(200),
  rating: z.number().int().min(1).max(5),
  difficulty: z.enum(["easy", "expected", "hard"]),
  actualSeconds: z.number().int().positive().max(7 * 24 * 60 * 60),
  notes: z.string().trim().max(2_000).default(""),
  idempotencyKey: z.string().trim().min(1).max(300),
});

const storedPlanSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      estimatedDurationSeconds: z.number().int().nonnegative(),
      domainData: z.object({ recipeId: z.string() }).passthrough(),
    }),
  ),
});

const storedStateSchema = z.object({
  stepStates: z.record(z.string(), z.object({ status: z.string() }).passthrough()),
});

type SessionFeedbackContext = {
  status: string;
  actor_ids_json: string;
  state_json: string;
  plan_json: string;
};

type FeedbackRow = {
  id: string;
  session_id: string;
  recipe_id: string;
  actor_id: string;
  rating: number;
  difficulty: "easy" | "expected" | "hard";
  estimated_seconds: number;
  actual_seconds: number;
  notes: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
};

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function toFeedback(row: FeedbackRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    recipeId: row.recipe_id,
    rating: row.rating,
    difficulty: row.difficulty,
    estimatedSeconds: row.estimated_seconds,
    actualSeconds: row.actual_seconds,
    notes: row.notes,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadOwnedCompletedSession(
  env: FeedbackEnv,
  sessionId: string,
  actorId: string,
): Promise<{ plan: z.infer<typeof storedPlanSchema>; state: z.infer<typeof storedStateSchema> } | null> {
  const row = await env.DB.prepare(
    `SELECT session.status, session.actor_ids_json, state.state_json, version.plan_json
     FROM execution_sessions AS session
     JOIN materialized_states AS state ON state.session_id = session.id
     JOIN plan_versions AS version ON version.session_id = session.id AND version.status = 'active'
     WHERE session.id = ?`,
  )
    .bind(sessionId)
    .first<SessionFeedbackContext>();
  if (!row) return null;

  let actors: unknown;
  try {
    actors = JSON.parse(row.actor_ids_json);
  } catch {
    return null;
  }
  if (!Array.isArray(actors) || !actors.includes(actorId)) return null;

  const plan = storedPlanSchema.safeParse(JSON.parse(row.plan_json));
  const state = storedStateSchema.safeParse(JSON.parse(row.state_json));
  if (!plan.success || !state.success) return null;
  const finished = plan.data.steps.every((step) => {
    const status = state.data.stepStates[step.id]?.status;
    return status === "completed" || status === "skipped";
  });
  if (row.status !== "completed" && !finished) return null;
  return { plan: plan.data, state: state.data };
}

async function listFeedback(
  env: FeedbackEnv,
  sessionId: string,
  context: PearRequestContext,
): Promise<Response> {
  const session = await loadOwnedCompletedSession(env, sessionId, context.actorId);
  if (!session) return jsonError("Completed cooking session not found", 404);
  const rows = await env.DB.prepare(
    "SELECT * FROM cooking_feedback WHERE session_id = ? AND actor_id = ? ORDER BY created_at ASC",
  )
    .bind(sessionId, context.actorId)
    .all<FeedbackRow>();
  return Response.json({ feedback: rows.results.map(toFeedback) });
}

async function createFeedback(
  request: Request,
  env: FeedbackEnv,
  sessionId: string,
  context: PearRequestContext,
): Promise<Response> {
  const session = await loadOwnedCompletedSession(env, sessionId, context.actorId);
  if (!session) return jsonError("Completed cooking session not found", 404);
  const input = feedbackInputSchema.parse(await request.json());
  if (input.idempotencyKey !== `${sessionId}:${input.recipeId}`) {
    return jsonError("Invalid feedback idempotency key", 400);
  }

  const recipeSteps = session.plan.steps.filter(
    (step) => step.domainData.recipeId === input.recipeId,
  );
  if (recipeSteps.length === 0) return jsonError("Recipe is not part of this session", 400);
  const estimatedSeconds = Math.max(
    1,
    recipeSteps.reduce((total, step) => total + step.estimatedDurationSeconds, 0),
  );
  const ratio = Math.min(2, Math.max(0.5, input.actualSeconds / estimatedSeconds));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const insertFeedback = env.DB.prepare(
    `INSERT INTO cooking_feedback
      (id, session_id, recipe_id, actor_id, rating, difficulty, estimated_seconds,
       actual_seconds, notes, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    sessionId,
    input.recipeId,
    context.actorId,
    input.rating,
    input.difficulty,
    estimatedSeconds,
    input.actualSeconds,
    input.notes,
    input.idempotencyKey,
    now,
    now,
  );
  const updateProfile = env.DB.prepare(
    `INSERT INTO cooking_estimate_profiles
      (actor_id, estimate_kind, sample_count, ratio_sum, factor, updated_at)
     VALUES (?, 'overall', 1, ?, ?, ?)
     ON CONFLICT(actor_id, estimate_kind) DO UPDATE SET
       sample_count = sample_count + 1,
       ratio_sum = ratio_sum + excluded.ratio_sum,
       factor = MIN(2.0, MAX(0.5,
         (ratio_sum + excluded.ratio_sum) / (sample_count + 1)
       )),
       updated_at = excluded.updated_at`,
  ).bind(context.actorId, ratio, ratio, now);

  try {
    await env.DB.batch([insertFeedback, updateProfile]);
  } catch (error) {
    const existing = await env.DB.prepare(
      "SELECT * FROM cooking_feedback WHERE actor_id = ? AND idempotency_key = ?",
    )
      .bind(context.actorId, input.idempotencyKey)
      .first<FeedbackRow>();
    if (existing) return Response.json({ feedback: toFeedback(existing) });
    if (error instanceof Error && /unique|constraint/i.test(error.message)) {
      return jsonError("Feedback has already been submitted for this recipe", 409);
    }
    throw error;
  }

  const created = await env.DB.prepare("SELECT * FROM cooking_feedback WHERE id = ?")
    .bind(id)
    .first<FeedbackRow>();
  if (!created) throw new Error("Feedback was persisted but could not be read");
  return Response.json({ feedback: toFeedback(created) }, { status: 201 });
}

export async function handleFeedbackApi(
  request: Request,
  env: FeedbackEnv,
  context: PearRequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/feedback$/);
  if (!match) return jsonError("Not found", 404);
  const sessionId = decodeURIComponent(match[1]);
  if (request.method === "GET") return listFeedback(env, sessionId, context);
  if (request.method === "POST") return createFeedback(request, env, sessionId, context);
  return jsonError("Method not allowed", 405);
}
