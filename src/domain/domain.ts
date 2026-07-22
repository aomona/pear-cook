import {
  defineAiDomain,
  resourceCapacitySchema,
  sourceReferenceSchema,
} from "@pear-agent/core";
import { z } from "zod";

export const COOKING_DOMAIN_VERSION = 3;

export const recipeIngredientSchema = z.object({
  name: z.string().trim().min(1),
  quantity: z.string().trim().min(1),
  notes: z.string().trim().nullable().default(null),
  amount: z.number().positive().optional(),
  unit: z.string().trim().min(1).optional(),
  canonicalUnit: z.string().trim().min(1).optional(),
  allergens: z.array(z.string().trim().min(1)).default([]),
});

export const recipeImageSchema = z.object({
  sourceId: z.string().min(1),
  kind: z.literal("generated"),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  model: z.string().trim().min(1),
  generatedAt: z.string().datetime(),
});

export const recipeProvenanceSchema = z.object({
  confidence: z.number().min(0).max(1).default(0.8),
  extractedBy: z.enum(["ai", "user", "import"]).default("ai"),
  verifiedAt: z.string().datetime().optional(),
});

export const recipeInstructionSchema = z.object({
  title: z.string().trim().min(1),
  instruction: z.string().trim().min(1),
  durationSeconds: z.number().int().positive(),
  temperature: z.string().trim().nullable().default(null),
  equipment: z.array(z.string().trim().min(1)).default([]),
  handsOn: z.boolean().optional(),
  resourceRequirements: z
    .array(
      z.object({
        resourceId: z.string().trim().min(1),
        quantity: z.number().positive(),
      }),
    )
    .default([]),
});

export const normalizedRecipeSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  servings: z.number().int().positive().max(100),
  ingredients: z.array(recipeIngredientSchema).min(1),
  instructions: z.array(recipeInstructionSchema).min(1),
  notes: z.array(z.string().trim().min(1)).default([]),
  safetyNotes: z.array(z.string().trim().min(1)).default([]),
  sourceRefs: z.array(sourceReferenceSchema).min(1),
  transformationHistory: z
    .array(
      z.object({
        instruction: z.string().trim().min(1),
        summary: z.string().trim().min(1),
      }),
    )
    .default([]),
  images: z.array(recipeImageSchema).max(1).default([]),
  provenance: recipeProvenanceSchema.optional(),
});

export type NormalizedRecipe = z.output<typeof normalizedRecipeSchema>;

export const cookingCompileInputSchema = z.object({
  recipes: z.array(normalizedRecipeSchema).min(1).max(12),
  mealTitle: z.string().trim().min(1).max(160),
  finishTogether: z.literal(true),
  availableIngredients: z
    .array(z.string().trim().min(1).max(120))
    .max(50)
    .default([]),
  dietaryConstraints: z
    .array(z.string().trim().min(1).max(200))
    .max(20)
    .default([]),
  photoNotes: z.string().trim().max(2_000).nullable().default(null),
  planningNotes: z.string().trim().max(2_000).nullable().default(null),
  kitchenCapacities: z.array(resourceCapacitySchema).default([]),
});

export const cookingNormalizedInputSchema = cookingCompileInputSchema;
export type CookingNormalizedInput = z.output<typeof cookingNormalizedInputSchema>;

export const cookingStepDataSchema = z.object({
  recipeId: z.string().min(1),
  recipeTitle: z.string().min(1),
  kind: z.enum(["wait", "prep", "cook", "rest", "serve"]),
  startOffsetSeconds: z.number().int().nonnegative(),
  ingredients: z.array(z.string()).default([]),
  equipment: z.array(z.string()).default([]),
  temperature: z.string().nullable().default(null),
  handsOn: z.boolean().default(true),
  estimateFactor: z.number().min(0.5).max(2.0).default(1.0),
  localizedQuantity: z.string().trim().optional(),
  allergens: z.array(z.string().trim().min(1)).default([]),
});

export const cookingDomain = defineAiDomain({
  id: "guided-cooking",
  version: COOKING_DOMAIN_VERSION,
  schemas: {
    compileInput: cookingCompileInputSchema,
    normalizedInput: cookingNormalizedInputSchema,
    stepData: cookingStepDataSchema,
    worldState: z.object({
      substitutions: z.record(z.string(), z.string()).default({}),
      donenessNotes: z.array(z.string()).default([]),
      sharedFinishAt: z.string().nullable().default(null),
      delaySeconds: z.number().int().nonnegative().default(0),
      activeEquipment: z.array(z.string()).default([]),
    }),
    events: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("ingredient_substituted"),
        recipeId: z.string().min(1),
        original: z.string().min(1),
        replacement: z.string().min(1),
      }),
      z.object({
        type: z.literal("doneness_confirmed"),
        recipeId: z.string().min(1),
        note: z.string().min(1),
      }),
      z.object({
        type: z.literal("delay_reported"),
        recipeId: z.string().min(1),
        seconds: z.number().int().nonnegative(),
        reason: z.string().trim().min(1).optional(),
      }),
      z.object({
        type: z.literal("equipment_changed"),
        recipeId: z.string().min(1),
        equipmentId: z.string().min(1),
        action: z.enum(["added", "removed", "failed"]),
      }),
      z.object({
        type: z.literal("substitution_confirmed"),
        recipeId: z.string().min(1),
        original: z.string().min(1),
        replacement: z.string().min(1),
        approvedBy: z.enum(["cook", "ai"]).default("cook"),
      }),
      z.object({
        type: z.literal("doneness_feedback"),
        recipeId: z.string().min(1),
        rating: z.number().int().min(1).max(5),
        difficulty: z.enum(["easy", "moderate", "hard"]).optional(),
        estimatedSeconds: z.number().int().positive().optional(),
        actualSeconds: z.number().int().positive().optional(),
        notes: z.string().trim().max(2_000).optional(),
      }),
      z.object({
        type: z.literal("cook_feedback"),
        recipeId: z.string().min(1),
        rating: z.number().int().min(1).max(5),
        notes: z.string().trim().max(2_000).optional(),
      }),
    ]),
  },
  interpretation: {
    instructions:
      "The compile input already contains independently normalized and user-refined recipes. Preserve every recipe, its sourceRefs, ingredients, instructions, transformation history, safety notes, photo observations, provenance, and structured quantities exactly unless planning requires a non-semantic formatting change. Never undo a per-recipe user transformation.",
  },
  planning: {
    instructions:
      "Combine every normalized recipe into one executable kitchen DAG that makes all dishes ready at the same shared finish line. Schedule backward from serving time. Preserve instruction order within each recipe, but parallelize independent work across recipes. Account for equipment conflicts and hands-on conflicts; do not place two steps in parallel when one cook cannot safely perform both. Add explicit wait/rest steps where a shorter recipe must start later. Every step domainData must identify recipeId, recipeTitle, kind, and startOffsetSeconds (seconds before the shared finish when the step should start). Cite the matching recipe sourceRefs on every step. End with one shared serving step that depends on every recipe's final step.",
    objectives: [
      "Make all dishes finish together without avoidable holding time",
      "Keep one cook's concurrent workload safe and realistic",
      "Preserve each refined recipe and its provenance",
      "Expose timing, temperature, equipment, hands-on status, and recipe ownership on every step",
    ],
    validatePlan(plan, normalizedInput) {
      const recipeIds = new Set(normalizedInput.recipes.map((recipe) => recipe.id));
      const coveredRecipeIds = new Set<string>();
      const issues = plan.steps.flatMap((step) => {
        const stepIssues: string[] = [];
        if (!step.sourceRefs?.length) {
          stepIssues.push(`Step ${step.id} has no source provenance`);
        }
        if (!step.instructions?.trim()) {
          stepIssues.push(`Step ${step.id} has no instructions`);
        }
        const parsed = cookingStepDataSchema.safeParse(step.domainData);
        if (!parsed.success) {
          stepIssues.push(`Step ${step.id} has invalid cooking timing data`);
        } else {
          if (parsed.data.startOffsetSeconds < 0) {
            stepIssues.push(`Step ${step.id} has negative startOffsetSeconds`);
          }
          if (parsed.data.recipeId !== "shared") {
            coveredRecipeIds.add(parsed.data.recipeId);
            if (!recipeIds.has(parsed.data.recipeId)) {
              stepIssues.push(`Step ${step.id} references an unknown recipe`);
            }
          }
        }
        if (step.timeline && step.timeline.endOffsetSeconds < step.timeline.startOffsetSeconds) {
          stepIssues.push(`Step ${step.id} has negative timeline window`);
        }
        const rr = step.resourceRequirements ?? [];
        for (const req of rr) {
          if (req.quantity <= 0) {
            stepIssues.push(`Step ${step.id} has invalid resource requirement quantity`);
          }
        }
        return stepIssues;
      });
      for (const recipeId of recipeIds) {
        if (!coveredRecipeIds.has(recipeId)) {
          issues.push(`Recipe ${recipeId} has no scheduled steps`);
        }
      }

      // Capacity conflict detection
      const capacityMap = new Map<string, number>();
      for (const c of normalizedInput.kitchenCapacities) capacityMap.set(c.id, c.capacity);
      capacityMap.set("cook", 1);
      type CapEvent = { time: number; resourceId: string; delta: number };
      const capEvents: CapEvent[] = [];
      for (const step of plan.steps) {
        if (!step.timeline) continue;
        const start = step.timeline.startOffsetSeconds;
        const end = step.timeline.endOffsetSeconds;
        const reqs = step.resourceRequirements ?? [];
        for (const req of reqs) {
          capEvents.push({ time: start, resourceId: req.resourceId, delta: req.quantity });
          capEvents.push({ time: end, resourceId: req.resourceId, delta: -req.quantity });
        }
      }
      capEvents.sort((a, b) => a.time - b.time || a.delta - b.delta);
      const usage = new Map<string, number>();
      for (const ev of capEvents) {
        const current = (usage.get(ev.resourceId) ?? 0) + ev.delta;
        usage.set(ev.resourceId, current);
        const cap = capacityMap.get(ev.resourceId) ?? Infinity;
        if (current > cap) {
          issues.push(`Capacity exceeded for ${ev.resourceId} at ${ev.time}s`);
        }
      }

      // Finish alignment check
      const serveStep = plan.steps.find((s) => s.id === "serve-all-dishes");
      if (serveStep) {
        const finishTimes: number[] = [];
        for (const afterId of serveStep.after) {
          const dep = plan.steps.find((s) => s.id === afterId);
          if (dep?.timeline) {
            finishTimes.push(dep.timeline.endOffsetSeconds);
          }
        }
        if (finishTimes.length > 1) {
          const maxFinish = Math.max(...finishTimes);
          for (const ft of finishTimes) {
            if (ft < maxFinish) {
              issues.push(`Misaligned recipe finish at ${ft}s vs shared ${maxFinish}s`);
            }
          }
        }
      }

      return {
        valid: plan.steps.length > 0 && issues.length === 0,
        issues: plan.steps.length > 0 ? issues : ["Combined cooking plan must contain steps", ...issues],
      };
    },
  },
  replanning: {
    instructions:
      "Change only future steps affected by a substitution, delay, equipment conflict, or doneness fact. Recalculate the affected recipes against the shared finish line. Never rewrite completed or skipped steps, and require confirmation before changing an active step. Return only the requested PlanPatch schema. Every operation must be exactly { type: 'add_step', step }, { type: 'update_step', stepId, step }, or { type: 'remove_step', stepId }. For update_step, copy the complete existing step and change only the necessary fields. Never emit op, update, or value fields, and never use a partial step.",
    defaultMode: "confirm",
    reconcileWorldState(_plan, worldState) {
      return worldState;
    },
  },
  realtime: {
    instructions:
      "Speak in concise, natural Japanese while the cook works hands-free. Start by reading the authoritative runtime snapshot and name the dish before every instruction. Guide all active recipes against one shared finish line, surface only simultaneous tasks that are safe for one cook, and repeat temperatures, equipment, timers, and hands-on status. Ask for explicit confirmation before starting or completing a step, and require the cook to confirm doneness rather than inferring it from elapsed time. If the cook reports an ingredient substitution, delay, safety concern, or changed equipment, record the Domain event before proposing a confirmed replan. Never treat voice disconnect as stopping execution.",
    defaultLocale: "ja-JP",
  },
  capabilities: [],
  completionPolicy: "human_confirmation",
});
