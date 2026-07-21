import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { PearEnv, PearRequestContext } from "@pear-agent/cloudflare";
import { generateText, Output } from "ai";
import { z } from "zod";

import {
  normalizedRecipeSchema,
  recipeIngredientSchema,
  recipeInstructionSchema,
  type NormalizedRecipe,
} from "../domain/domain.js";

export type RecipeEnv = PearEnv & { GEMINI_API_KEY?: string };
const COOKING_MODEL = "gemini-3.5-flash-lite";

const recipeContentSchema = z.object({
  title: z.string().trim().min(1),
  servings: z.number().int().positive().max(100),
  ingredients: z.array(recipeIngredientSchema).min(1),
  instructions: z.array(recipeInstructionSchema).min(1),
  notes: z.array(z.string().trim().min(1)),
  safetyNotes: z.array(z.string().trim().min(1)),
});

const createRecipeSchema = z.object({
  sourceId: z.string().min(1),
  sourceKind: z.enum(["ai", "url", "text"]),
  sourceInput: z.string().trim().min(1).max(20_000),
  availableIngredients: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  dietaryConstraints: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  photoNotes: z.string().trim().max(2_000).nullable().default(null),
});

const transformRecipeSchema = z.object({
  instruction: z.string().trim().min(1).max(2_000),
});

const transformationOutputSchema = z.object({
  recipe: recipeContentSchema,
  changeSummary: z.string().trim().min(1).max(500),
});

type StoredRecipeRow = {
  id: string;
  plan_artifact_id: string;
  owner_actor_id: string;
  source_id: string;
  source_kind: string;
  source_input: string;
  normalized_json: string;
  transformation_history_json: string;
  created_at: string;
  updated_at: string;
};

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function ownedPlanExists(env: RecipeEnv, planId: string, actorId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM plan_artifacts WHERE id = ? AND owner_actor_id = ? AND status = 'draft'",
  )
    .bind(planId, actorId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function readRecipeSource(
  env: RecipeEnv,
  planId: string,
  sourceId: string,
): Promise<{ content: string; mediaType: string } | null> {
  const source = await env.DB.prepare(
    "SELECT raw_object_key, media_type, status FROM plan_sources WHERE id = ? AND plan_artifact_id = ?",
  )
    .bind(sourceId, planId)
    .first<{ raw_object_key: string | null; media_type: string; status: string }>();
  if (!source?.raw_object_key || source.status !== "ready") return null;
  const object = await env.RAW_INPUTS.get(source.raw_object_key);
  if (!object) return null;
  const raw = new TextDecoder().decode(await object.arrayBuffer()).slice(0, 180_000);
  const content = source.media_type === "text/html"
    ? raw
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : raw;
  return { content, mediaType: source.media_type };
}

function parseStoredRecipe(row: StoredRecipeRow): NormalizedRecipe {
  return normalizedRecipeSchema.parse(JSON.parse(row.normalized_json));
}

async function getOwnedRecipe(
  env: RecipeEnv,
  planId: string,
  recipeId: string,
  actorId: string,
): Promise<{ row: StoredRecipeRow; recipe: NormalizedRecipe } | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM recipe_drafts WHERE id = ? AND plan_artifact_id = ? AND owner_actor_id = ?",
  )
    .bind(recipeId, planId, actorId)
    .first<StoredRecipeRow>();
  return row ? { row, recipe: parseStoredRecipe(row) } : null;
}

function recipeModel(env: RecipeEnv) {
  if (!env.GEMINI_API_KEY) return null;
  return createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY })(COOKING_MODEL);
}

async function normalizeRecipe(
  request: Request,
  env: RecipeEnv,
  planId: string,
  context: PearRequestContext,
): Promise<Response> {
  const input = createRecipeSchema.parse(await request.json());
  const source = await readRecipeSource(env, planId, input.sourceId);
  if (!source) return jsonError("Recipe source is not ready", 409);
  const model = recipeModel(env);
  if (!model) return jsonError("GEMINI_API_KEY is not configured", 503);
  const intent =
    input.sourceKind === "ai"
      ? "Create a complete, practical recipe from the user's request."
      : "Extract one complete recipe faithfully from the supplied source.";
  const { output } = await generateText({
    model,
    output: Output.object({ schema: recipeContentSchema }),
    abortSignal: request.signal,
    maxRetries: 1,
    prompt: `${intent}

Requirements:
- Return ingredient quantities that a home cook can follow.
- Split instructions into timed, concrete actions in their original order.
- Keep safety notes explicit.
- Do not combine this recipe with any other dish.
- Source kind: ${input.sourceKind}
- User input: ${input.sourceInput}
- Available ingredients: ${JSON.stringify(input.availableIngredients)}
- Dietary constraints: ${JSON.stringify(input.dietaryConstraints)}
- Notes from photos: ${input.photoNotes ?? "None"}

Source content:
${source.content}`,
  });
  if (!output) return jsonError("The model did not return a normalized recipe", 502);

  const recipeId = crypto.randomUUID();
  const recipe = normalizedRecipeSchema.parse({
    id: recipeId,
    ...output,
    sourceRefs: [{ sourceId: input.sourceId }],
    transformationHistory: [],
  });
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO recipe_drafts (id, plan_artifact_id, owner_actor_id, source_id, source_kind, source_input, normalized_json, transformation_history_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      recipeId,
      planId,
      context.actorId,
      input.sourceId,
      input.sourceKind,
      input.sourceInput,
      JSON.stringify(recipe),
      "[]",
      now,
      now,
    )
    .run();
  return Response.json({ recipe }, { status: 201 });
}

async function transformRecipe(
  request: Request,
  env: RecipeEnv,
  planId: string,
  recipeId: string,
  context: PearRequestContext,
): Promise<Response> {
  const stored = await getOwnedRecipe(env, planId, recipeId, context.actorId);
  if (!stored) return jsonError("Recipe not found", 404);
  const input = transformRecipeSchema.parse(await request.json());
  const model = recipeModel(env);
  if (!model) return jsonError("GEMINI_API_KEY is not configured", 503);
  const editableRecipe = recipeContentSchema.parse(stored.recipe);
  const { output } = await generateText({
    model,
    output: Output.object({ schema: transformationOutputSchema }),
    abortSignal: request.signal,
    maxRetries: 1,
    prompt: `Modify exactly one normalized recipe according to the cook's instruction.

Cook instruction: ${input.instruction}

Rules:
- Apply the instruction throughout ingredients, quantities, timing, and steps where necessary.
- Preserve the dish identity unless the cook explicitly asks otherwise.
- Preserve or strengthen food-safety guidance.
- Do not mention or modify other recipes.
- Return a concise change summary.

Current recipe:
${JSON.stringify(editableRecipe)}`,
  });
  if (!output) return jsonError("The model did not return a transformed recipe", 502);
  const history = [
    ...stored.recipe.transformationHistory,
    { instruction: input.instruction, summary: output.changeSummary },
  ];
  const recipe = normalizedRecipeSchema.parse({
    id: stored.recipe.id,
    ...output.recipe,
    sourceRefs: stored.recipe.sourceRefs,
    transformationHistory: history,
  });
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE recipe_drafts SET normalized_json = ?, transformation_history_json = ?, updated_at = ? WHERE id = ?",
  )
    .bind(JSON.stringify(recipe), JSON.stringify(history), now, recipeId)
    .run();
  return Response.json({ recipe });
}

export async function handleRecipeApi(
  request: Request,
  env: RecipeEnv,
  context: PearRequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/plans\/([^/]+)\/recipes(?:\/([^/]+))?(?:\/(transform))?$/);
  if (!match) return jsonError("Not found", 404);
  const planId = decodeURIComponent(match[1]);
  const recipeId = match[2] ? decodeURIComponent(match[2]) : null;
  const action = match[3] ?? null;

  if (!(await ownedPlanExists(env, planId, context.actorId))) {
    return jsonError("Draft plan not found or not owned by this cook", 404);
  }

  if (!recipeId && request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT * FROM recipe_drafts WHERE plan_artifact_id = ? AND owner_actor_id = ? ORDER BY created_at ASC",
    )
      .bind(planId, context.actorId)
      .all<StoredRecipeRow>();
    return Response.json({ recipes: rows.results.map(parseStoredRecipe) });
  }

  if (!recipeId && request.method === "POST") {
    return normalizeRecipe(request, env, planId, context);
  }

  if (recipeId && action === "transform" && request.method === "POST") {
    return transformRecipe(request, env, planId, recipeId, context);
  }

  if (recipeId && !action && request.method === "PUT") {
    const stored = await getOwnedRecipe(env, planId, recipeId, context.actorId);
    if (!stored) return jsonError("Recipe not found", 404);
    const editable = recipeContentSchema.parse(await request.json());
    const recipe = normalizedRecipeSchema.parse({
      id: stored.recipe.id,
      ...editable,
      sourceRefs: stored.recipe.sourceRefs,
      transformationHistory: stored.recipe.transformationHistory,
    });
    await env.DB.prepare("UPDATE recipe_drafts SET normalized_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(recipe), new Date().toISOString(), recipeId)
      .run();
    return Response.json({ recipe });
  }

  if (recipeId && !action && request.method === "DELETE") {
    const result = await env.DB.prepare(
      "DELETE FROM recipe_drafts WHERE id = ? AND plan_artifact_id = ? AND owner_actor_id = ?",
    )
      .bind(recipeId, planId, context.actorId)
      .run();
    return result.meta.changes > 0
      ? new Response(null, { status: 204 })
      : jsonError("Recipe not found", 404);
  }

  return jsonError("Method not allowed", 405);
}
