import type {
  ExecutionGoal,
  ExecutionPlan,
  ResourceCapacity,
  ResourceRequirement,
  SourceReference,
  TimerDefinition,
} from "@pear-agent/core";
import { schedulePlan } from "@pear-agent/core";

import { COOKING_DOMAIN_VERSION, type CookingNormalizedInput } from "./domain.js";

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
    lower.includes("sauté") ||
    lower.includes("saute") ||
    lower.includes("simmer") ||
    lower.includes("sear") ||
    lower.includes("grill") ||
    lower.includes("broil") ||
    lower.includes("poach") ||
    lower.includes("steam") ||
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

function clampEstimateProfile(
  profile?: Record<string, number>,
): Record<string, number> {
  if (!profile) return {};
  const clamped: Record<string, number> = {};
  for (const [key, value] of Object.entries(profile)) {
    clamped[key] = Math.min(2.0, Math.max(0.5, value));
  }
  return clamped;
}

function applyFactor(duration: number, factor: number): number {
  return Math.max(1, Math.ceil(duration * Math.min(2.0, Math.max(0.5, factor))));
}

export type BuildCookingPlanOptions = {
  estimateProfile?: Record<string, number>;
};

export function buildCookingPlan(
  goal: ExecutionGoal,
  input: CookingNormalizedInput,
  options?: BuildCookingPlanOptions,
): ExecutionPlan<{
  recipeId: string;
  recipeTitle: string;
  kind: "wait" | "prep" | "cook" | "rest" | "serve";
  startOffsetSeconds: number;
  ingredients: string[];
  equipment: string[];
  temperature: string | null;
  handsOn: boolean;
  estimateFactor: number;
  localizedQuantity?: string;
  allergens: string[];
}> {
  const estimateProfile = clampEstimateProfile(options?.estimateProfile);
  const steps: ExecutionPlan<{
    recipeId: string;
    recipeTitle: string;
    kind: "wait" | "prep" | "cook" | "rest" | "serve";
    startOffsetSeconds: number;
    ingredients: string[];
    equipment: string[];
    temperature: string | null;
    handsOn: boolean;
    estimateFactor: number;
    localizedQuantity?: string;
    allergens: string[];
  }>["steps"] = [];

  const finalStepIds: string[] = [];
  const sharedSourceRefs: SourceReference[] = [];

  let sharedFinish = 0;
  for (const recipe of input.recipes) {
    const factor = estimateProfile[recipe.id] ?? estimateProfile.default ?? 1.0;
    const recipeDuration = recipe.instructions.reduce(
      (sum, inst) => sum + applyFactor(inst.durationSeconds, factor),
      0,
    );
    sharedFinish = Math.max(sharedFinish, recipeDuration);
  }

  for (const recipe of input.recipes) {
    const factor = estimateProfile[recipe.id] ?? estimateProfile.default ?? 1.0;
    const totalDuration = recipe.instructions.reduce(
      (sum, inst) => sum + applyFactor(inst.durationSeconds, factor),
      0,
    );
    const waitDuration = sharedFinish - totalDuration;

    sharedSourceRefs.push(...recipe.sourceRefs);

    let previousStepId: string | null = null;

    if (waitDuration > 0) {
      const waitStepId = `${recipe.id}-wait`;
      const waitTimers: TimerDefinition[] = [
        {
          id: `${waitStepId}-timer`,
          label: `Wait to start ${recipe.title}`,
          durationSeconds: waitDuration,
          autoStart: true,
          linkedStepId: waitStepId,
        },
      ];
      steps.push({
        id: waitStepId,
        label: `Wait to start ${recipe.title}`,
        summary: `Begin ${recipe.title} when this start window opens.`,
        instructions: `Wait ${Math.ceil(waitDuration / 60)} minutes so ${recipe.title} finishes with the other dishes.`,
        executor: { type: "human" },
        after: [],
        requirements: [],
        estimatedDurationSeconds: waitDuration,
        timers: waitTimers,
        sourceRefs: recipe.sourceRefs,
        domainData: {
          recipeId: recipe.id,
          recipeTitle: recipe.title,
          kind: "wait",
          startOffsetSeconds: sharedFinish,
          ingredients: [],
          equipment: [],
          temperature: null,
          handsOn: false,
          estimateFactor: factor,
          allergens: [],
        },
      });
      previousStepId = waitStepId;
    }

    for (let instructionIndex = 0; instructionIndex < recipe.instructions.length; instructionIndex++) {
      const instruction = recipe.instructions[instructionIndex];
      const stepId = `${recipe.id}-step-${instructionIndex + 1}`;
      const duration = applyFactor(instruction.durationSeconds, factor);
      const kind = instructionKind(`${instruction.title} ${instruction.instruction}`);
      const handsOn = instruction.handsOn ?? (kind !== "rest");
      const searchable = `${instruction.title} ${instruction.instruction}`.toLowerCase();
      const ingredients = recipe.ingredients
        .filter((ingredient) => searchable.includes(ingredient.name.toLowerCase()))
        .map((ingredient) => ingredient.name);
      const allergens = recipe.ingredients
        .filter((ingredient) => searchable.includes(ingredient.name.toLowerCase()))
        .flatMap((ingredient) => ingredient.allergens);

      const localizedQuantity = recipe.ingredients
        .filter((ingredient) => searchable.includes(ingredient.name.toLowerCase()))
        .map((ingredient) =>
          ingredient.amount && ingredient.unit
            ? `${ingredient.amount} ${ingredient.unit}`
            : ingredient.quantity,
        )
        .join(", ") || undefined;

      const resourceRequirements: ResourceRequirement[] = [];
      if (handsOn) {
        resourceRequirements.push({ resourceId: "cook", quantity: 1 });
      }
      for (const eq of instruction.equipment) {
        resourceRequirements.push({ resourceId: eq, quantity: 1 });
      }
      for (const rr of instruction.resourceRequirements) {
        resourceRequirements.push(rr);
      }

      const timers: TimerDefinition[] = [];
      if (kind === "cook" || kind === "rest") {
        timers.push({
          id: `${stepId}-timer`,
          label: `${instruction.title} timer`,
          durationSeconds: duration,
          autoStart: true,
          linkedStepId: stepId,
        });
      }

      steps.push({
        id: stepId,
        label: instruction.title,
        summary: `${recipe.title} \u00b7 ${instruction.instruction}`,
        instructions: instruction.instruction,
        executor: { type: "human" },
        after: previousStepId ? [previousStepId] : [],
        requirements: [],
        resourceRequirements,
        estimatedDurationSeconds: duration,
        timers,
        sourceRefs: recipe.sourceRefs,
        domainData: {
          recipeId: recipe.id,
          recipeTitle: recipe.title,
          kind,
          startOffsetSeconds: 0,
          ingredients,
          equipment: instruction.equipment,
          temperature: instruction.temperature,
          handsOn,
          estimateFactor: factor,
          ...(localizedQuantity ? { localizedQuantity } : {}),
          allergens,
        },
      });
      previousStepId = stepId;
    }

    if (previousStepId) finalStepIds.push(previousStepId);
  }

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
      handsOn: true,
      estimateFactor: 1.0,
      allergens: [],
    },
  });

  const plan: ExecutionPlan<{
    recipeId: string;
    recipeTitle: string;
    kind: "wait" | "prep" | "cook" | "rest" | "serve";
    startOffsetSeconds: number;
    ingredients: string[];
    equipment: string[];
    temperature: string | null;
    handsOn: boolean;
    estimateFactor: number;
    localizedQuantity?: string;
    allergens: string[];
  }> = {
    id: `meal-${crypto.randomUUID()}`,
    version: 1,
    title: input.mealTitle,
    goal,
    metadata: {
      domainId: "guided-cooking",
      domainVersion: COOKING_DOMAIN_VERSION,
      estimateProfile,
      sharedFinishSeconds: sharedFinish,
    },
    steps,
  };

  const capacities: ResourceCapacity[] = [
    { id: "cook", capacity: 1 },
    ...input.kitchenCapacities,
  ];
  const capacityMap = new Map<string, ResourceCapacity>();
  for (const c of capacities) capacityMap.set(c.id, c);
  const dedupedCapacities = Array.from(capacityMap.values());

  // First pass: resolve capacity conflicts forward
  const firstPass = schedulePlan(plan, {
    capacities: dedupedCapacities,
    resolveCapacity: true,
  });

  // Compute actual finish time for each recipe
  const recipeFinishTimes = new Map<string, number>();
  for (const recipe of input.recipes) {
    const lastStepId = `${recipe.id}-step-${recipe.instructions.length}`;
    const lastStep = firstPass.plan.steps.find((s) => s.id === lastStepId);
    if (lastStep?.timeline) {
      recipeFinishTimes.set(recipe.id, lastStep.timeline.endOffsetSeconds);
    }
  }

  const maxFinish = Math.max(...recipeFinishTimes.values(), 0);

  // Insert deterministic post-hold steps so every recipe ends at maxFinish
  const serveStep = firstPass.plan.steps.find((s) => s.id === "serve-all-dishes")!;
  const updatedAfter: string[] = [];

  for (const recipe of input.recipes) {
    const finish = recipeFinishTimes.get(recipe.id) ?? 0;
    const gap = maxFinish - finish;
    const lastStepId = `${recipe.id}-step-${recipe.instructions.length}`;

    if (gap > 0) {
      const holdId = `${recipe.id}-hold`;
      const holdTimers: TimerDefinition[] = [
        {
          id: `${holdId}-timer`,
          label: `Hold ${recipe.title}`,
          durationSeconds: gap,
          autoStart: true,
          linkedStepId: holdId,
        },
      ];
      const holdStep = {
        id: holdId,
        label: `Hold ${recipe.title}`,
        summary: `Keep ${recipe.title} ready until serving.`,
        instructions: `Wait ${Math.ceil(gap / 60)} minutes before serving ${recipe.title}.`,
        executor: { type: "human" } as const,
        after: [lastStepId],
        requirements: [],
        estimatedDurationSeconds: gap,
        timers: holdTimers,
        sourceRefs: recipe.sourceRefs,
        domainData: {
          recipeId: recipe.id,
          recipeTitle: recipe.title,
          kind: "wait" as const,
          startOffsetSeconds: 0,
          ingredients: [],
          equipment: [],
          temperature: null,
          handsOn: false,
          estimateFactor: 1.0,
          allergens: [],
        },
      };
      const lastIndex = firstPass.plan.steps.findIndex((s) => s.id === lastStepId);
      firstPass.plan.steps.splice(lastIndex + 1, 0, holdStep);
      updatedAfter.push(holdId);
    } else {
      updatedAfter.push(lastStepId);
    }
  }

  serveStep.after = updatedAfter;

  // Second pass: schedule holds and serve deterministically
  const secondPass = schedulePlan(firstPass.plan, {
    capacities: dedupedCapacities,
    resolveCapacity: true,
  });

  const finalPlan = secondPass.plan;
  const finalFinishTime = Math.max(
    ...finalPlan.steps
      .filter((s) => s.id !== "serve-all-dishes")
      .map((s) => (s.timeline ? s.timeline.endOffsetSeconds : s.estimatedDurationSeconds)),
  );

  for (const step of finalPlan.steps) {
    if (step.timeline) {
      const backwardStart = finalFinishTime - step.timeline.startOffsetSeconds;
      (step.domainData as { startOffsetSeconds: number }).startOffsetSeconds = Math.max(
        0,
        Math.round(backwardStart),
      );
    }
  }

  return finalPlan;
}
