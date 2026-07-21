import type { ExecutionGoal, ExecutionPlan, SourceReference } from "@pear-agent/core";

import type { CookingNormalizedInput } from "./domain.js";

export function buildCookingGoal(mealTitle: string): ExecutionGoal {
  return {
    id: "serve-meal-together",
    description: `Prepare every dish in ${mealTitle} for one shared serving time`,
    successCriteria: [
      {
        id: "cook-confirms-all-dishes-ready",
        description: "The cook confirms every planned dish is safely cooked and ready to serve together",
        evaluator: { type: "human_confirmation" },
      },
    ],
    completionPolicy: "human_confirmation",
  };
}

function instructionKind(value: string): "prep" | "cook" | "rest" | "serve" {
  const lower = value.toLowerCase();
  if (
    lower.includes("serve") ||
    lower.includes("plate") ||
    lower.includes("盛り付け")
  ) {
    return "serve";
  }
  if (
    lower.includes("rest") ||
    lower.includes("cool") ||
    lower.includes("stand") ||
    lower.includes("休ませ") ||
    lower.includes("冷ます")
  ) {
    return "rest";
  }
  if (
    lower.includes("heat") ||
    lower.includes("cook") ||
    lower.includes("bake") ||
    lower.includes("boil") ||
    lower.includes("fry") ||
    lower.includes("roast") ||
    lower.includes("加熱") ||
    lower.includes("焼") ||
    lower.includes("茹") ||
    lower.includes("煮") ||
    lower.includes("炒") ||
    lower.includes("蒸")
  ) {
    return "cook";
  }
  return "prep";
}

export function buildCookingPlan(
  goal: ExecutionGoal,
  input: CookingNormalizedInput,
): ExecutionPlan<{
  recipeId: string;
  recipeTitle: string;
  kind: "wait" | "prep" | "cook" | "rest" | "serve";
  startOffsetSeconds: number;
  ingredients: string[];
  equipment: string[];
  temperature: string | null;
}> {
  const recipeDurations = input.recipes.map((recipe) =>
    recipe.instructions.reduce((total, instruction) => total + instruction.durationSeconds, 0),
  );
  const sharedDuration = Math.max(...recipeDurations);
  const steps: ExecutionPlan<{
    recipeId: string;
    recipeTitle: string;
    kind: "wait" | "prep" | "cook" | "rest" | "serve";
    startOffsetSeconds: number;
    ingredients: string[];
    equipment: string[];
    temperature: string | null;
  }>["steps"] = [];
  const finalStepIds: string[] = [];
  const sharedSourceRefs: SourceReference[] = [];

  input.recipes.forEach((recipe, recipeIndex) => {
    sharedSourceRefs.push(...recipe.sourceRefs);
    const totalDuration = recipeDurations[recipeIndex];
    const waitDuration = sharedDuration - totalDuration;
    let previousStepId: string | null = null;
    let remainingSeconds = sharedDuration;

    if (waitDuration > 0) {
      const waitStepId = `${recipe.id}-wait`;
      steps.push({
        id: waitStepId,
        label: `Wait to start ${recipe.title}`,
        summary: `Begin ${recipe.title} when this start window opens.`,
        instructions: `Wait ${Math.ceil(waitDuration / 60)} minutes so ${recipe.title} finishes with the other dishes.`,
        executor: { type: "human" },
        after: [],
        requirements: [],
        estimatedDurationSeconds: waitDuration,
        timers: [],
        sourceRefs: recipe.sourceRefs,
        domainData: {
          recipeId: recipe.id,
          recipeTitle: recipe.title,
          kind: "wait",
          startOffsetSeconds: sharedDuration,
          ingredients: [],
          equipment: [],
          temperature: null,
        },
      });
      previousStepId = waitStepId;
      remainingSeconds -= waitDuration;
    }

    recipe.instructions.forEach((instruction, instructionIndex) => {
      const stepId = `${recipe.id}-step-${instructionIndex + 1}`;
      const searchable = `${instruction.title} ${instruction.instruction}`.toLowerCase();
      const ingredients = recipe.ingredients
        .filter((ingredient) => searchable.includes(ingredient.name.toLowerCase()))
        .map((ingredient) => ingredient.name);
      steps.push({
        id: stepId,
        label: instruction.title,
        summary: `${recipe.title} · ${instruction.instruction}`,
        instructions: instruction.instruction,
        executor: { type: "human" },
        after: previousStepId ? [previousStepId] : [],
        requirements: [],
        estimatedDurationSeconds: instruction.durationSeconds,
        timers: [],
        sourceRefs: recipe.sourceRefs,
        domainData: {
          recipeId: recipe.id,
          recipeTitle: recipe.title,
          kind: instructionKind(`${instruction.title} ${instruction.instruction}`),
          startOffsetSeconds: remainingSeconds,
          ingredients,
          equipment: instruction.equipment,
          temperature: instruction.temperature,
        },
      });
      previousStepId = stepId;
      remainingSeconds -= instruction.durationSeconds;
    });

    if (previousStepId) finalStepIds.push(previousStepId);
  });

  steps.push({
    id: "serve-all-dishes",
    label: "Serve every dish",
    summary: "Bring all finished dishes to the table together.",
    instructions: "Confirm each dish is safely cooked, make final seasoning adjustments, and serve everything together.",
    executor: { type: "human" },
    after: finalStepIds,
    requirements: [],
    estimatedDurationSeconds: 60,
    timers: [],
    sourceRefs: sharedSourceRefs,
    domainData: {
      recipeId: "shared",
      recipeTitle: input.mealTitle,
      kind: "serve",
      startOffsetSeconds: 0,
      ingredients: [],
      equipment: [],
      temperature: null,
    },
  });

  return {
    id: `meal-${crypto.randomUUID()}`,
    version: 1,
    title: input.mealTitle,
    goal,
    metadata: { domainId: "guided-cooking", domainVersion: 2 },
    steps,
  };
}
