import { executionPlanSchema } from "@pear-agent/core";
import { z } from "zod";

import { describe, expect, it } from "vitest";

import {
  COOKING_DOMAIN_VERSION,
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
    expect(sharedServe?.after.length).toBe(2);
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
              handsOn: false,
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

    const restStep = plan.steps.find((s) => s.domainData.kind === "rest")!;
    expect(restStep.domainData.handsOn).toBe(false);
  });

  it("honors explicit handsOn:false on non-rest instructions", () => {
    const input = cookingNormalizedInputSchema.parse({
      mealTitle: "Passive prep",
      finishTogether: true,
      recipes: [
        {
          id: "passive",
          title: "Passive dish",
          servings: 2,
          ingredients: [{ name: "x", quantity: "1" }],
          instructions: [
            { title: "Marinate", instruction: "Leave to marinate.", durationSeconds: 300, equipment: [], handsOn: false },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "passive" }],
          transformationHistory: [],
        },
      ],
    });

    const plan = buildCookingPlan(buildCookingGoal(input.mealTitle), input);
    const step = plan.steps.find((s) => s.id === "passive-step-1")!;
    expect(step.domainData.handsOn).toBe(false);
    expect(step.resourceRequirements?.some((r) => r.resourceId === "cook")).toBe(false);
  });

  it("serializes hands-on steps when cook capacity is 1 and overlaps when capacity is 2", () => {
    const input = cookingNormalizedInputSchema.parse({
      mealTitle: "Parallel prep",
      finishTogether: true,
      kitchenCapacities: [],
      recipes: [
        {
          id: "a",
          title: "Dish A",
          servings: 2,
          ingredients: [{ name: "a-ing", quantity: "1" }],
          instructions: [
            { title: "Prep A", instruction: "Chop A.", durationSeconds: 300, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "a" }],
          transformationHistory: [],
        },
        {
          id: "b",
          title: "Dish B",
          servings: 2,
          ingredients: [{ name: "b-ing", quantity: "1" }],
          instructions: [
            { title: "Prep B", instruction: "Chop B.", durationSeconds: 300, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "b" }],
          transformationHistory: [],
        },
      ],
    });

    const plan1 = buildCookingPlan(buildCookingGoal(input.mealTitle), input);
    const stepA = plan1.steps.find((s) => s.id === "a-step-1")!;
    const stepB = plan1.steps.find((s) => s.id === "b-step-1")!;

    // With default cook=1, hands-on steps should not overlap in forward timeline
    const overlap1 =
      stepA.timeline!.startOffsetSeconds < stepB.timeline!.endOffsetSeconds &&
      stepB.timeline!.startOffsetSeconds < stepA.timeline!.endOffsetSeconds;
    expect(overlap1).toBe(false);

    const input2 = cookingNormalizedInputSchema.parse({
      mealTitle: "Parallel prep",
      finishTogether: true,
      kitchenCapacities: [{ id: "cook", capacity: 2 }],
      recipes: [
        {
          id: "a",
          title: "Dish A",
          servings: 2,
          ingredients: [{ name: "a-ing", quantity: "1" }],
          instructions: [
            { title: "Prep A", instruction: "Chop A.", durationSeconds: 300, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "a" }],
          transformationHistory: [],
        },
        {
          id: "b",
          title: "Dish B",
          servings: 2,
          ingredients: [{ name: "b-ing", quantity: "1" }],
          instructions: [
            { title: "Prep B", instruction: "Chop B.", durationSeconds: 300, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "b" }],
          transformationHistory: [],
        },
      ],
    });

    const plan2 = buildCookingPlan(buildCookingGoal(input2.mealTitle), input2);
    const stepA2 = plan2.steps.find((s) => s.id === "a-step-1")!;
    const stepB2 = plan2.steps.find((s) => s.id === "b-step-1")!;

    const overlap2 =
      stepA2.timeline!.startOffsetSeconds < stepB2.timeline!.endOffsetSeconds &&
      stepB2.timeline!.startOffsetSeconds < stepA2.timeline!.endOffsetSeconds;
    expect(overlap2).toBe(true);
  });

  it("allows passive wait/rest to overlap with hands-on work from another recipe", () => {
    const input = cookingNormalizedInputSchema.parse({
      mealTitle: "Passive overlap",
      finishTogether: true,
      recipes: [
        {
          id: "r1",
          title: "Rising bread",
          servings: 2,
          ingredients: [{ name: "flour", quantity: "300 g" }],
          instructions: [
            { title: "Knead", instruction: "Knead dough.", durationSeconds: 300, equipment: [] },
            { title: "Rest", instruction: "Let dough rise.", durationSeconds: 600, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "r1" }],
          transformationHistory: [],
        },
        {
          id: "r2",
          title: "Side dish",
          servings: 2,
          ingredients: [{ name: "veg", quantity: "1" }],
          instructions: [
            { title: "Prep", instruction: "Prep veg.", durationSeconds: 300, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "r2" }],
          transformationHistory: [],
        },
      ],
    });

    const plan = buildCookingPlan(buildCookingGoal(input.mealTitle), input);
    const restStep = plan.steps.find((s) => s.domainData.kind === "rest")!;
    const prepStep = plan.steps.find((s) => s.id === "r2-step-1")!;

    expect(restStep.domainData.handsOn).toBe(false);
    expect(prepStep.domainData.handsOn).toBe(true);

    // Passive rest should overlap with active prep in forward timeline
    const overlap =
      restStep.timeline!.startOffsetSeconds < prepStep.timeline!.endOffsetSeconds &&
      prepStep.timeline!.startOffsetSeconds < restStep.timeline!.endOffsetSeconds;
    expect(overlap).toBe(true);
  });

  it("produces nonnegative timeline offsets and aligned backward offsets", () => {
    const plan = buildCookingPlan(buildCookingGoal(normalizedInput.mealTitle), normalizedInput);

    for (const step of plan.steps) {
      expect(step.timeline).toBeDefined();
      expect(step.timeline!.startOffsetSeconds).toBeGreaterThanOrEqual(0);
      expect(step.timeline!.endOffsetSeconds).toBeGreaterThanOrEqual(step.timeline!.startOffsetSeconds);
      expect(step.domainData.startOffsetSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  it("emits deterministic timer definitions for timed steps", () => {
    const plan = buildCookingPlan(buildCookingGoal(normalizedInput.mealTitle), normalizedInput);

    const cookStep = plan.steps.find((s) => s.domainData.kind === "cook")!;
    const waitStep = plan.steps.find((s) => s.domainData.kind === "wait")!;

    expect(cookStep.timers).toHaveLength(1);
    expect(cookStep.timers[0].id).toBe(`${cookStep.id}-timer`);
    expect(cookStep.timers[0].autoStart).toBe(true);
    expect(cookStep.timers[0].durationSeconds).toBe(cookStep.estimatedDurationSeconds);

    expect(waitStep.timers).toHaveLength(1);
    expect(waitStep.timers[0].id).toBe(`${waitStep.id}-timer`);
  });

  it("treats common stovetop verbs as timed cooking work", () => {
    const input = cookingNormalizedInputSchema.parse({
      ...normalizedInput,
      recipes: [{
        ...normalizedInput.recipes[0],
        instructions: [{
          title: "Sauté aromatics",
          instruction: "Sauté garlic, then simmer the sauce.",
          durationSeconds: 360,
          equipment: ["skillet"],
        }],
      }],
    });
    const plan = buildCookingPlan(buildCookingGoal(input.mealTitle), input);
    const step = plan.steps.find((candidate) => candidate.domainData.recipeId === input.recipes[0].id)!;

    expect(step.domainData.kind).toBe("cook");
    expect(step.timers).toHaveLength(1);
    expect(step.timers[0].durationSeconds).toBe(360);
  });

  it("produces a JSON-safe execution plan", () => {
    const plan = buildCookingPlan(buildCookingGoal(normalizedInput.mealTitle), normalizedInput);
    expect(() => executionPlanSchema(z.unknown()).parse(plan)).not.toThrow();
  });

  it("adds post-hold steps so every recipe final step ends at the same shared finish", () => {
    const input = cookingNormalizedInputSchema.parse({
      mealTitle: "Aligned finishes",
      finishTogether: true,
      recipes: [
        {
          id: "fast",
          title: "Fast dish",
          servings: 2,
          ingredients: [{ name: "f", quantity: "1" }],
          instructions: [
            { title: "Cook fast", instruction: "Cook fast.", durationSeconds: 300, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "fast" }],
          transformationHistory: [],
        },
        {
          id: "slow",
          title: "Slow dish",
          servings: 2,
          ingredients: [{ name: "s", quantity: "1" }],
          instructions: [
            { title: "Cook slow", instruction: "Cook slow.", durationSeconds: 600, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "slow" }],
          transformationHistory: [],
        },
      ],
    });

    const plan = buildCookingPlan(buildCookingGoal(input.mealTitle), input);
    const serve = plan.steps.find((s) => s.id === "serve-all-dishes")!;

    // All recipe dependencies of serve must finish at the same time
    const finishTimes = serve.after
      .map((id) => plan.steps.find((s) => s.id === id))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => s.timeline!.endOffsetSeconds);

    expect(finishTimes.length).toBe(2);
    expect(new Set(finishTimes).size).toBe(1);
    expect(finishTimes[0]).toBeGreaterThan(0);
  });

  it("preserves provenance and confidence through planning", () => {
    const input = cookingNormalizedInputSchema.parse({
      mealTitle: "Provenance test",
      finishTogether: true,
      recipes: [
        {
          id: "prov",
          title: "Provenance dish",
          servings: 2,
          ingredients: [{ name: "x", quantity: "1" }],
          instructions: [
            { title: "Do", instruction: "Do it.", durationSeconds: 60, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "prov-src", fragment: "page 1" }],
          transformationHistory: [],
          provenance: { confidence: 0.95, extractedBy: "ai" as const, verifiedAt: "2024-01-01T00:00:00Z" },
          photoObservations: [{ sourceId: "photo-1", mediaType: "image/jpeg", description: "Raw ingredients" }],
        },
      ],
    });

    const plan = buildCookingPlan(buildCookingGoal(input.mealTitle), input);
    const recipeStep = plan.steps.find((s) => s.id === "prov-step-1")!;

    expect(recipeStep.sourceRefs).toEqual(input.recipes[0].sourceRefs);
    expect(plan.metadata).toMatchObject({
      domainId: "guided-cooking",
      domainVersion: COOKING_DOMAIN_VERSION,
    });
  });

  it("exposes localized quantities and allergens on steps", () => {
    const input = cookingNormalizedInputSchema.parse({
      mealTitle: "Localized test",
      finishTogether: true,
      recipes: [
        {
          id: "loc",
          title: "Localized dish",
          servings: 2,
          ingredients: [
            { name: "peanuts", quantity: "100 g", amount: 100, unit: "g", canonicalUnit: "gram", allergens: ["peanut"] },
            { name: "milk", quantity: "200 ml", amount: 200, unit: "ml", allergens: ["dairy"] },
          ],
          instructions: [
            { title: "Mix", instruction: "Mix peanuts and milk together.", durationSeconds: 60, equipment: ["bowl"] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "loc-src" }],
          transformationHistory: [],
        },
      ],
    });

    const plan = buildCookingPlan(buildCookingGoal(input.mealTitle), input);
    const step = plan.steps.find((s) => s.id === "loc-step-1")!;

    expect(step.domainData.ingredients).toContain("peanuts");
    expect(step.domainData.ingredients).toContain("milk");
    expect(step.domainData.allergens).toContain("peanut");
    expect(step.domainData.allergens).toContain("dairy");
    expect(step.domainData.localizedQuantity).toContain("100 g");
    expect(step.domainData.localizedQuantity).toContain("200 ml");
  });

  it("clamps estimate factors to 0.5..2.0 and snapshots them in metadata", () => {
    const goal = buildCookingGoal(normalizedInput.mealTitle);
    const plan = buildCookingPlan(goal, normalizedInput, {
      estimateProfile: { pasta: 0.2, salad: 3.0, default: 1.5 },
    });

    const meta = plan.metadata as Record<string, unknown>;
    const snapped = meta.estimateProfile as Record<string, number>;
    expect(snapped.pasta).toBe(0.5);
    expect(snapped.salad).toBe(2.0);
    expect(snapped.default).toBe(1.5);

    const pastaStep = plan.steps.find((s) => s.domainData.recipeId === "pasta")!;
    expect(pastaStep.domainData.estimateFactor).toBe(0.5);
  });

  it("parses legacy recipes without v2 fields using additive defaults", () => {
    const legacy = cookingNormalizedInputSchema.parse({
      mealTitle: "Legacy meal",
      finishTogether: true,
      recipes: [
        {
          id: "legacy",
          title: "Legacy dish",
          servings: 2,
          ingredients: [{ name: "salt", quantity: "1 tsp" }],
          instructions: [
            { title: "Cook", instruction: "Cook it.", durationSeconds: 300, equipment: ["pan"] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "legacy" }],
          transformationHistory: [],
        },
      ],
    });

    const ing = legacy.recipes[0].ingredients[0];
    expect(ing.amount).toBeUndefined();
    expect(ing.unit).toBeUndefined();
    expect(ing.allergens).toEqual([]);

    const inst = legacy.recipes[0].instructions[0];
    expect(inst.handsOn).toBeUndefined();
    expect(inst.resourceRequirements).toEqual([]);

    const plan = buildCookingPlan(buildCookingGoal(legacy.mealTitle), legacy);
    const result = cookingDomain.planning.validatePlan(plan, legacy);
    expect(result.valid).toBe(true);
  });

  it("validation detects capacity overlap in an externally-built plan", async () => {
    const input = cookingNormalizedInputSchema.parse({
      mealTitle: "Conflict test",
      finishTogether: true,
      recipes: [
        {
          id: "c1",
          title: "Conflict one",
          servings: 2,
          ingredients: [{ name: "x", quantity: "1" }],
          instructions: [
            { title: "Step", instruction: "Do it.", durationSeconds: 300, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "c1" }],
          transformationHistory: [],
        },
        {
          id: "c2",
          title: "Conflict two",
          servings: 2,
          ingredients: [{ name: "y", quantity: "1" }],
          instructions: [
            { title: "Step", instruction: "Do it.", durationSeconds: 300, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "c2" }],
          transformationHistory: [],
        },
      ],
    });

    const badPlan = buildCookingPlan(buildCookingGoal(input.mealTitle), input);
    // Force overlap by resetting timeline to identical windows on two hands-on steps
    const step1 = badPlan.steps.find((s) => s.id === "c1-step-1")!;
    const step2 = badPlan.steps.find((s) => s.id === "c2-step-1")!;
    step1.timeline = { startOffsetSeconds: 0, endOffsetSeconds: 300 };
    step2.timeline = { startOffsetSeconds: 0, endOffsetSeconds: 300 };

    const result = await cookingDomain.planning.validatePlan(badPlan, input);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("Capacity exceeded for cook"))).toBe(true);
  });

  it("validation detects misaligned recipe finishes in an externally-built plan", async () => {
    const input = cookingNormalizedInputSchema.parse({
      mealTitle: "Alignment test",
      finishTogether: true,
      recipes: [
        {
          id: "early",
          title: "Early dish",
          servings: 2,
          ingredients: [{ name: "e", quantity: "1" }],
          instructions: [
            { title: "Step", instruction: "Do it.", durationSeconds: 300, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "early" }],
          transformationHistory: [],
        },
        {
          id: "late",
          title: "Late dish",
          servings: 2,
          ingredients: [{ name: "l", quantity: "1" }],
          instructions: [
            { title: "Step", instruction: "Do it.", durationSeconds: 600, equipment: [] },
          ],
          notes: [],
          safetyNotes: [],
          sourceRefs: [{ sourceId: "late" }],
          transformationHistory: [],
        },
      ],
    });

    const badPlan = buildCookingPlan(buildCookingGoal(input.mealTitle), input);
    // Remove post-hold to create misalignment
    const holds = badPlan.steps.filter((s) => s.id.includes("-hold"));
    for (const h of holds) {
      const idx = badPlan.steps.indexOf(h);
      if (idx >= 0) badPlan.steps.splice(idx, 1);
    }
    const serve = badPlan.steps.find((s) => s.id === "serve-all-dishes")!;
    serve.after = ["early-step-1", "late-step-1"];

    const result = await cookingDomain.planning.validatePlan(badPlan, input);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("Misaligned recipe finish"))).toBe(true);
  });
});
