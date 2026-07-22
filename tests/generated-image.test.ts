import { beforeEach, describe, expect, it, vi } from "vitest";

const googleGenerateContent = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: googleGenerateContent };
  },
  Modality: { IMAGE: "IMAGE" },
}));

import type { PearRequestContext } from "@pear-agent/cloudflare";

import { normalizedRecipeSchema } from "../src/domain/domain";
import { handleRecipeApi, type RecipeEnv } from "../src/worker/recipes";

function pngBase64(): string {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return btoa(String.fromCharCode(...bytes));
}

describe("generated recipe image route", () => {
  beforeEach(() => googleGenerateContent.mockReset());

  it("persists validated Google AI image bytes and returns the updated recipe", async () => {
    const recipe = normalizedRecipeSchema.parse({
      id: "recipe-1",
      title: "Tomato pasta",
      servings: 2,
      ingredients: [{ name: "tomato", quantity: "2" }],
      instructions: [
        {
          title: "Serve",
          instruction: "Plate the pasta.",
          durationSeconds: 60,
        },
      ],
      sourceRefs: [{ sourceId: "source-1" }],
    });
    googleGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: pngBase64(), mimeType: "image/png" } }],
          },
        },
      ],
    });

    const batched: Array<Array<{ sql: string; args: unknown[] }>> = [];
    const puts: Array<{ key: string; value: ArrayBuffer; options: unknown }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          args: [] as unknown[],
          sql,
          bind(...args: unknown[]) {
            statement.args = args;
            return statement;
          },
          async first() {
            if (sql.includes("FROM plan_artifacts")) return { id: "plan-1" };
            if (sql.includes("FROM recipe_drafts")) {
              return {
                id: recipe.id,
                plan_artifact_id: "plan-1",
                owner_actor_id: "actor-1",
                source_id: "source-1",
                source_kind: "ai",
                source_input: "tomato pasta",
                normalized_json: JSON.stringify(recipe),
                transformation_history_json: "[]",
                created_at: "2026-07-21T00:00:00.000Z",
                updated_at: "2026-07-21T00:00:00.000Z",
              };
            }
            return null;
          },
        };
        return statement;
      },
      async batch(statements: Array<{ sql: string; args: unknown[] }>) {
        batched.push(statements);
        return [];
      },
    };
    const rawInputs = {
      async put(key: string, value: ArrayBuffer, options: unknown) {
        puts.push({ key, value, options });
      },
      async delete() {},
    };
    const env = {
      DB: db,
      RAW_INPUTS: rawInputs,
      GEMINI_API_KEY: "test-key",
    } as unknown as RecipeEnv;
    const context = {
      actorId: "actor-1",
      roles: ["developer"],
    } as PearRequestContext;

    const response = await handleRecipeApi(
      new Request("https://example.test/api/plans/plan-1/recipes/recipe-1/image", {
        method: "POST",
      }),
      env,
      context,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { recipe: typeof recipe };
    expect(body.recipe.images).toEqual([
      expect.objectContaining({
        kind: "generated",
        mediaType: "image/png",
        model: "gemini-3.1-flash-image-preview",
      }),
    ]);
    expect(googleGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-3.1-flash-image-preview",
        config: expect.objectContaining({ responseModalities: ["IMAGE"] }),
      }),
    );
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toContain("generated-images/plan-1/recipe-1/");
    expect(new Uint8Array(puts[0]?.value ?? new ArrayBuffer(0)).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(2);
    const persistedRecipeUpdate = batched[0]?.find((statement) =>
      statement.sql.includes("UPDATE recipe_drafts"),
    );
    expect(persistedRecipeUpdate).toBeDefined();
    const persistedRecipe = normalizedRecipeSchema.parse(
      JSON.parse(String(persistedRecipeUpdate?.args[0])),
    );
    expect(persistedRecipe.images).toEqual(body.recipe.images);
  });
});
