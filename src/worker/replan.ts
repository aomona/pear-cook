import { Output, generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  applyPlanPatch,
  executionPlanSchema,
  lastOperationalEventId,
  parseDomainEvent,
  type ExecutionPlan,
  type JsonValue,
  type PlanPatch,
  type ReplanAssessment,
  type ReplanGeneratorInput,
  type StepStates,
  type WorldState,
} from "@pear-agent/core";
import type { ReplanGeneratePatchInput, ReplanRuntime } from "@pear-agent/cloudflare";
import { z } from "zod";

import { COOKING_DOMAIN_VERSION, cookingDomain, cookingStepDataSchema } from "../domain/domain.js";
import type { AuthEnv } from "./auth.js";
import type { PearEnv } from "@pear-agent/cloudflare";

type CookingEnv = PearEnv & AuthEnv;

const REPLAN_MODEL = "gemini-3.5-flash-lite";

type CookingStepData = z.infer<typeof cookingStepDataSchema>;
const cookingReplanOutputSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  edits: z.array(z.object({
    stepId: z.string().min(1),
    summary: z.string().trim().min(1),
    instructions: z.string().trim().min(1),
    estimatedDurationSeconds: z.number().int().nonnegative(),
    domainData: cookingStepDataSchema,
  })).min(1),
});


type MinimalDomainEvent = {
  id: string;
  type: string;
  domainType?: string;
  payload?: unknown;
};

function getUncompletedStepIds(
  plan: ExecutionPlan,
  stepStates: StepStates,
  predicate: (step: ExecutionPlan["steps"][number]) => boolean,
): string[] {
  return plan.steps
    .filter((step) => {
      const state = stepStates[step.id];
      if (state?.status === "completed" || state?.status === "skipped") return false;
      return predicate(step);
    })
    .map((step) => step.id);
}

function getRecipeStepIds(
  plan: ExecutionPlan,
  stepStates: StepStates,
  recipeId: string,
): string[] {
  return getUncompletedStepIds(plan, stepStates, (step) => {
    const data = step.domainData as CookingStepData | undefined;
    return data?.recipeId === recipeId;
  });
}

function getEquipmentStepIds(
  plan: ExecutionPlan,
  stepStates: StepStates,
  recipeId: string,
  equipmentId: string,
): string[] {
  return getUncompletedStepIds(plan, stepStates, (step) => {
    const data = step.domainData as CookingStepData | undefined;
    return data?.recipeId === recipeId && data?.equipment?.includes(equipmentId);
  });
}

export function assessCookingEvents(input: {
  recentEvents: MinimalDomainEvent[];
  plan: ExecutionPlan;
  stepStates: StepStates;
}): ReplanAssessment {
  const causeEventIds: string[] = [];
  const directlyAffectedStepIds = new Set<string>();
  const reasons: string[] = [];

  for (const event of input.recentEvents) {
    if (event.type !== "domain_event" || !event.domainType) continue;

    let parsedEvent: z.infer<typeof cookingDomain.schemas.events> | null = null;
    try {
      parsedEvent = parseDomainEvent(cookingDomain.schemas.events, {
        domainType: event.domainType,
        payload: event.payload as JsonValue,
      });
    } catch {
      continue;
    }

    if (!parsedEvent) continue;

    const eventId = event.id;

    switch (parsedEvent.type) {
      case "ingredient_substituted": {
        const affected = getRecipeStepIds(input.plan, input.stepStates, parsedEvent.recipeId);
        if (affected.length > 0) {
          causeEventIds.push(eventId);
          for (const stepId of affected) directlyAffectedStepIds.add(stepId);
          reasons.push(
            `Ingredient substitution in recipe ${parsedEvent.recipeId} (${parsedEvent.original} → ${parsedEvent.replacement})`,
          );
        }
        break;
      }
      case "substitution_confirmed": {
        const affected = getRecipeStepIds(input.plan, input.stepStates, parsedEvent.recipeId);
        if (affected.length > 0) {
          causeEventIds.push(eventId);
          for (const stepId of affected) directlyAffectedStepIds.add(stepId);
          reasons.push(
            `Confirmed substitution in recipe ${parsedEvent.recipeId} (${parsedEvent.original} → ${parsedEvent.replacement})`,
          );
        }
        break;
      }
      case "delay_reported": {
        const affected = getRecipeStepIds(input.plan, input.stepStates, parsedEvent.recipeId);
        if (affected.length > 0) {
          causeEventIds.push(eventId);
          for (const stepId of affected) directlyAffectedStepIds.add(stepId);
          reasons.push(
            `Delay of ${parsedEvent.seconds}s reported for recipe ${parsedEvent.recipeId}${
              parsedEvent.reason ? `: ${parsedEvent.reason}` : ""
            }`,
          );
        }
        break;
      }
      case "equipment_changed": {
        const affected = getEquipmentStepIds(
          input.plan,
          input.stepStates,
          parsedEvent.recipeId,
          parsedEvent.equipmentId,
        );
        if (affected.length > 0) {
          causeEventIds.push(eventId);
          for (const stepId of affected) directlyAffectedStepIds.add(stepId);
          reasons.push(
            `Equipment ${parsedEvent.equipmentId} ${parsedEvent.action} for recipe ${parsedEvent.recipeId}`,
          );
        }
        break;
      }
      case "doneness_confirmed": {
        const affected = getRecipeStepIds(input.plan, input.stepStates, parsedEvent.recipeId);
        if (affected.length > 0) {
          causeEventIds.push(eventId);
          for (const stepId of affected) directlyAffectedStepIds.add(stepId);
          reasons.push(`Doneness confirmed for recipe ${parsedEvent.recipeId}: ${parsedEvent.note}`);
        }
        break;
      }
    }
  }

  const needsReplan = causeEventIds.length > 0;

  return {
    needsReplan,
    causeEventIds,
    directlyAffectedStepIds: Array.from(directlyAffectedStepIds),
    reason: reasons.join("; ") || "No actionable cooking events detected",
  };
}

export function buildAiReplanInput(
  input: ReplanGeneratePatchInput & { signal?: AbortSignal },
): ReplanGeneratorInput {
  return {
    domainId: input.domainId,
    instructions: input.instructions,
    plan: input.plan,
    normalizedInput: input.normalizedInput,
    assessment: input.assessment as unknown,
    affectedStepIds: input.affectedStepIds,
    causeRefs: input.assessment.causeEventIds.map((eventId) => ({
      type: "runtime_event" as const,
      eventId,
    })),
    baseLastEventId: lastOperationalEventId(input.recentEvents),
    context: input.context,
    signal: input.signal,
  };
}

export function createCookingReplanRuntime(env: CookingEnv): ReplanRuntime | undefined {
  if (!env.GEMINI_API_KEY) return undefined;

  const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });


  return {
    generator: {
      async assess(input) {
        return assessCookingEvents({
          recentEvents: input.recentEvents,
          plan: input.plan,
          stepStates: input.stepStates,
        });
      },
      async generatePatch(input: ReplanGeneratePatchInput): Promise<PlanPatch> {
        const affectedSteps = input.plan.steps.filter((step) => input.affectedStepIds.includes(step.id));
        const { output } = await generateText({
          model: google(REPLAN_MODEL),
          output: Output.object({ schema: cookingReplanOutputSchema }),
          maxRetries: 2,
          prompt: [
            "Propose a bounded cooking-plan edit for the reported runtime fact.",
            input.instructions,
            "Return one edit for each affected future step that must change. Use only the exact stepId values supplied below.",
            "Preserve dependencies, timers, executors, provenance, and immutable identifiers; the host retains those fields.",
            `Assessment: ${JSON.stringify(input.assessment)}`,
            `Affected steps: ${JSON.stringify(affectedSteps.map((step) => ({
              id: step.id,
              label: step.label,
              summary: step.summary,
              instructions: step.instructions,
              estimatedDurationSeconds: step.estimatedDurationSeconds,
              domainData: step.domainData,
            })))}`,
          ].join("\n"),
        });
        const seenStepIds = new Set<string>();
        const operations: PlanPatch["operations"] = output.edits.map((edit) => {
          if (seenStepIds.has(edit.stepId) || !input.affectedStepIds.includes(edit.stepId)) {
            throw new Error(`AI replan returned an unknown or duplicate step: ${edit.stepId}`);
          }
          seenStepIds.add(edit.stepId);
          const current = input.plan.steps.find((step) => step.id === edit.stepId);
          if (!current) throw new Error(`AI replan returned an unknown step: ${edit.stepId}`);
          return {
            type: "update_step" as const,
            stepId: edit.stepId,
            step: {
              ...current,
              summary: edit.summary,
              instructions: edit.instructions,
              estimatedDurationSeconds: edit.estimatedDurationSeconds,
              domainData: edit.domainData,
            },
          };
        });
        const patch: PlanPatch = {
          id: `patch-${crypto.randomUUID()}`,
          basePlanId: input.plan.id,
          basePlanVersion: input.plan.version,
          baseLastEventId: lastOperationalEventId(input.recentEvents),
          causeEventIds: input.assessment.causeEventIds,
          causeRefs: input.assessment.causeEventIds.map((eventId) => ({ type: "runtime_event", eventId })),
          affectedStepIds: input.affectedStepIds,
          operations,
          summary: output.summary,
        };

        // Validate proposal: apply patch and run cooking-domain semantic checks
        const appliedEventIds = input.recentEvents.map((e) => e.id);
        const currentLastEventId = lastOperationalEventId(input.recentEvents);

        const patchResult = applyPlanPatch({
          plan: input.plan,
          stepStates: input.stepStates,
          worldState: input.worldState,
          appliedEventIds,
          currentLastEventId,
          patch,
          phase: "proposal",
          reconcileWorldState: cookingDomain.replanning.reconcileWorldState as (
            plan: ExecutionPlan,
            worldState: WorldState,
          ) => WorldState,
          stepDataSchema: cookingDomain.schemas.stepData,
        });

        const normalizedInput = cookingDomain.schemas.normalizedInput.parse(input.normalizedInput);
        const candidatePlan = executionPlanSchema(cookingDomain.schemas.stepData).parse(
          patchResult.plan,
        );
        const validation = await cookingDomain.planning.validatePlan(candidatePlan, normalizedInput);
        if (!validation.valid) {
          throw new Error(
            `Replan candidate failed semantic validation: ${validation.issues.join("; ")}`,
          );
        }

        return patch;
      },
    },
    resolveConfiguration(domainId) {
      if (domainId !== cookingDomain.id) {
        throw new Error(`Unsupported domain for replan: ${domainId}`);
      }
      return {
        instructions: cookingDomain.replanning.instructions,
        domainVersion: COOKING_DOMAIN_VERSION,
        defaultMode: "confirm",
        stepDataSchema: cookingDomain.schemas.stepData,
        capabilityPolicies: [],
        reconcileWorldState: cookingDomain.replanning.reconcileWorldState as (
          plan: ExecutionPlan,
          worldState: WorldState,
        ) => WorldState,
      };
    },
  };
}
