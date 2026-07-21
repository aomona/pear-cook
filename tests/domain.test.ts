import { describe, expect, it } from "vitest";

import {
  cookingCompileInputSchema,
  cookingDomain,
  cookingNormalizedInputSchema,
} from "../src/domain/domain";
import { buildCookingGoal, buildCookingPlan } from "../src/domain/plan";

const pastaSourceRefs = [{ sourceId: "pasta-url", fragment: "Recipe card" }];
const saladSourceRefs = [{ sourceId: "salad-text", fragment: "Pasted recipe" }];

const normalizedInput = cookingNormalizedInputSchema.parse({
  mealTitle: "Two-dish dinner",
  finishTogether: true,
  planningNotes: "One cook and two burners",
  recipes: [
    {
      id: "pasta",
      title: "Tomato pasta",
      servings: 2,
      ingredients: [
        { name: "tomatoes", quantity: "4" },
        { name: "pasta", quantity: "200 g" },
      ],
      instructions: [
        {
          title: "Cook the sauce",
          instruction: "Simmer tomatoes until glossy.",
          durationSeconds: 600,
          temperature: "medium heat",
          equipment: ["skillet"],
        },
        {
          title: "Boil pasta",
          instruction: "Boil pasta until al dente and toss with sauce.",
          durationSeconds: 600,
          equipment: ["pot"],
        },
      ],
      notes: [],
      safetyNotes: ["Keep pot handles turned inward."],
      sourceRefs: pastaSourceRefs,
      transformationHistory: [
        { instruction: "Use less salt", summary: "Reduced added salt throughout the recipe." },
      ],
    },
    {
      id: "salad",
      title: "Green salad",
      servings: 2,
      ingredients: [{ name: "lettuce", quantity: "1 head" }],
      instructions: [
        {
          title: "Toss salad",
          instruction: "Toss the lettuce with dressing.",
          durationSeconds: 300,
          equipment: ["bowl"],
        },
      ],
      notes: [],
      safetyNotes: [],
      sourceRefs: saladSourceRefs,
      transformationHistory: [],
    },
  ],
});

describe("multi-recipe cooking Domain", () => {
  it("requires one or more normalized recipes before compilation", () => {
    expect(() =>
      cookingCompileInputSchema.parse({
        mealTitle: "Empty meal",
        finishTogether: true,
        recipes: [],
      }),
    ).toThrow();
    expect(normalizedInput.recipes).toHaveLength(2);
  });

  it("rejects a combined plan that omits a recipe", async () => {
    const result = await cookingDomain.planning.validatePlan(
      {
        id: "plan",
        version: 1,
        goal: buildCookingGoal(normalizedInput.mealTitle),
        steps: [],
      },
      normalizedInput,
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("Combined cooking plan must contain steps");
    expect(result.issues).toContain("Recipe pasta has no scheduled steps");
    expect(result.issues).toContain("Recipe salad has no scheduled steps");
  });

  it("delays the shorter recipe and joins every dish at one serving step", async () => {
    const goal = buildCookingGoal(normalizedInput.mealTitle);
    const plan = buildCookingPlan(goal, normalizedInput);
    const result = await cookingDomain.planning.validatePlan(plan, normalizedInput);
    const saladWait = plan.steps.find((step) => step.id === "salad-wait");
    const sharedServe = plan.steps.find((step) => step.id === "serve-all-dishes");

    expect(result).toEqual({ valid: true, issues: [] });
    expect(goal.completionPolicy).toBe("human_confirmation");
    expect(saladWait?.estimatedDurationSeconds).toBe(900);
    expect(sharedServe?.after).toEqual(["pasta-step-2", "salad-step-1"]);
    expect(sharedServe?.sourceRefs).toEqual([...pastaSourceRefs, ...saladSourceRefs]);
  });

  it("classifies Japanese cooking, resting, and serving instructions", () => {
    const localizedInput = cookingNormalizedInputSchema.parse({
      mealTitle: "和食",
      finishTogether: true,
      recipes: [
        {
          id: "soup",
          title: "味噌汁",
          servings: 2,
          ingredients: [{ name: "豆腐", quantity: "1丁" }],
          instructions: [
            {
              title: "下ごしらえ",
              instruction: "豆腐を切る。",
              durationSeconds: 60,
              equipment: ["包丁"],
            },
            {
              title: "煮る",
              instruction: "鍋で加熱する。",
              durationSeconds: 300,
              equipment: ["鍋"],
            },
            {
              title: "休ませる",
              instruction: "火を止めて少し冷ます。",
              durationSeconds: 60,
              equipment: [],
            },
            {
              title: "盛り付け",
              instruction: "器に盛り付ける。",
              durationSeconds: 30,
              equipment: [],
            },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "soup-text" }],
          transformationHistory: [],
        },
      ],
    });

    const plan = buildCookingPlan(buildCookingGoal(localizedInput.mealTitle), localizedInput);

    expect(plan.steps.slice(0, 4).map((step) => step.domainData.kind)).toEqual([
      "prep",
      "cook",
      "rest",
      "serve",
    ]);
  });
});
