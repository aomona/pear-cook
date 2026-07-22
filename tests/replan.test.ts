import { describe, expect, it } from "vitest";

import type { PearEnv } from "@pear-agent/cloudflare";
import type { ExecutionPlan, StepStates } from "@pear-agent/core";

import type { ReplanGeneratorInput } from "@pear-agent/core";

import { COOKING_DOMAIN_VERSION, cookingDomain } from "../src/domain/domain";
import type { AuthEnv } from "../src/worker/auth";
import { assessCookingEvents, buildAiReplanInput, createCookingReplanRuntime } from "../src/worker/replan";

type TestEnv = PearEnv & AuthEnv;

function makePlan(steps: Array<{ id: string; recipeId: string; equipment?: string[] }>): ExecutionPlan {
  return {
    id: "plan-1",
    version: 1,
    goal: {
      id: "goal-1",
      description: "Cook",
      successCriteria: [],
      completionPolicy: "human_confirmation",
    },
    steps: steps.map((s) => ({
      id: s.id,
      executor: { type: "human" },
      after: [],
      requirements: [],
      estimatedDurationSeconds: 60,
      timers: [],
      domainData: {
        recipeId: s.recipeId,
        recipeTitle: "Test",
        kind: "prep",
        startOffsetSeconds: 0,
        equipment: s.equipment ?? [],
      },
      instructions: "Do it",
      sourceRefs: [{ sourceId: "src", fragment: "f" }],
    })),
  };
}

function makeStepStates(statuses: Record<string, string>): StepStates {
  return Object.fromEntries(
    Object.entries(statuses).map(([id, status]) => [id, { status }]),
  );
}

function makeDomainEvent(id: string, domainType: string, payload: unknown) {
  return { id, type: "domain_event", domainType, payload };
}

describe("assessCookingEvents", () => {
  it("returns no replan when there are no domain events", () => {
    const plan = makePlan([
      { id: "s1", recipeId: "pasta" },
      { id: "s2", recipeId: "salad" },
    ]);
    const stepStates = makeStepStates({ s1: "ready", s2: "ready" });
    const result = assessCookingEvents({ recentEvents: [], plan, stepStates });
    expect(result.needsReplan).toBe(false);
    expect(result.causeEventIds).toEqual([]);
    expect(result.directlyAffectedStepIds).toEqual([]);
    expect(result.reason).toBe("No actionable cooking events detected");
  });

  it("ignores non-domain events", () => {
    const plan = makePlan([{ id: "s1", recipeId: "pasta" }]);
    const stepStates = makeStepStates({ s1: "ready" });
    const result = assessCookingEvents({
      recentEvents: [
        { id: "e1", type: "step_started", payload: { stepId: "s1" } } as unknown as ReturnType<typeof makeDomainEvent>,
      ],
      plan,
      stepStates,
    });
    expect(result.needsReplan).toBe(false);
  });

  it("maps ingredient_substituted to uncompleted steps in the recipe", () => {
    const plan = makePlan([
      { id: "s1", recipeId: "pasta" },
      { id: "s2", recipeId: "pasta" },
      { id: "s3", recipeId: "salad" },
    ]);
    const stepStates = makeStepStates({ s1: "ready", s2: "ready", s3: "ready" });
    const result = assessCookingEvents({
      recentEvents: [
        makeDomainEvent("e1", "ingredient_substituted", {
          recipeId: "pasta",
          original: "tomatoes",
          replacement: "canned tomatoes",
        }),
      ],
      plan,
      stepStates,
    });
    expect(result.needsReplan).toBe(true);
    expect(result.causeEventIds).toEqual(["e1"]);
    expect(result.directlyAffectedStepIds).toEqual(["s1", "s2"]);
    expect(result.reason).toContain("Ingredient substitution");
  });

  it("ignores completed and skipped steps when mapping events", () => {
    const plan = makePlan([
      { id: "s1", recipeId: "pasta" },
      { id: "s2", recipeId: "pasta" },
    ]);
    const stepStates = makeStepStates({ s1: "completed", s2: "skipped" });
    const result = assessCookingEvents({
      recentEvents: [
        makeDomainEvent("e1", "ingredient_substituted", {
          recipeId: "pasta",
          original: "tomatoes",
          replacement: "canned tomatoes",
        }),
      ],
      plan,
      stepStates,
    });
    expect(result.needsReplan).toBe(false);
    expect(result.directlyAffectedStepIds).toEqual([]);
  });

  it("maps delay_reported to uncompleted steps in the recipe", () => {
    const plan = makePlan([
      { id: "s1", recipeId: "pasta" },
      { id: "s2", recipeId: "salad" },
    ]);
    const stepStates = makeStepStates({ s1: "active", s2: "ready" });
    const result = assessCookingEvents({
      recentEvents: [
        makeDomainEvent("e1", "delay_reported", {
          recipeId: "pasta",
          seconds: 300,
          reason: "distracted",
        }),
      ],
      plan,
      stepStates,
    });
    expect(result.needsReplan).toBe(true);
    expect(result.causeEventIds).toEqual(["e1"]);
    expect(result.directlyAffectedStepIds).toEqual(["s1"]);
    expect(result.reason).toContain("Delay of 300s");
  });

  it("maps equipment_changed to uncompleted steps using that equipment in the recipe", () => {
    const plan = makePlan([
      { id: "s1", recipeId: "pasta", equipment: ["skillet"] },
      { id: "s2", recipeId: "pasta", equipment: ["pot"] },
      { id: "s3", recipeId: "salad", equipment: ["skillet"] },
    ]);
    const stepStates = makeStepStates({ s1: "ready", s2: "ready", s3: "ready" });
    const result = assessCookingEvents({
      recentEvents: [
        makeDomainEvent("e1", "equipment_changed", {
          recipeId: "pasta",
          equipmentId: "skillet",
          action: "failed",
        }),
      ],
      plan,
      stepStates,
    });
    expect(result.needsReplan).toBe(true);
    expect(result.causeEventIds).toEqual(["e1"]);
    expect(result.directlyAffectedStepIds).toEqual(["s1"]);
    expect(result.reason).toContain("skillet failed");
  });

  it("does not map equipment_changed when no step uses the equipment", () => {
    const plan = makePlan([
      { id: "s1", recipeId: "pasta", equipment: ["pot"] },
    ]);
    const stepStates = makeStepStates({ s1: "ready" });
    const result = assessCookingEvents({
      recentEvents: [
        makeDomainEvent("e1", "equipment_changed", {
          recipeId: "pasta",
          equipmentId: "skillet",
          action: "added",
        }),
      ],
      plan,
      stepStates,
    });
    expect(result.needsReplan).toBe(false);
  });

  it("maps doneness_confirmed to uncompleted steps in the recipe", () => {
    const plan = makePlan([
      { id: "s1", recipeId: "pasta" },
      { id: "s2", recipeId: "salad" },
    ]);
    const stepStates = makeStepStates({ s1: "active", s2: "ready" });
    const result = assessCookingEvents({
      recentEvents: [
        makeDomainEvent("e1", "doneness_confirmed", {
          recipeId: "pasta",
          note: "perfect",
        }),
      ],
      plan,
      stepStates,
    });
    expect(result.needsReplan).toBe(true);
    expect(result.causeEventIds).toEqual(["e1"]);
    expect(result.directlyAffectedStepIds).toEqual(["s1"]);
    expect(result.reason).toContain("Doneness confirmed");
  });

  it("maps substitution_confirmed to uncompleted steps in the recipe", () => {
    const plan = makePlan([
      { id: "s1", recipeId: "pasta" },
      { id: "s2", recipeId: "salad" },
    ]);
    const stepStates = makeStepStates({ s1: "ready", s2: "ready" });
    const result = assessCookingEvents({
      recentEvents: [
        makeDomainEvent("e1", "substitution_confirmed", {
          recipeId: "pasta",
          original: "basil",
          replacement: "oregano",
          approvedBy: "cook",
        }),
      ],
      plan,
      stepStates,
    });
    expect(result.needsReplan).toBe(true);
    expect(result.causeEventIds).toEqual(["e1"]);
    expect(result.directlyAffectedStepIds).toEqual(["s1"]);
    expect(result.reason).toContain("Confirmed substitution");
  });

  it("aggregates multiple events and deduplicates affected step ids", () => {
    const plan = makePlan([
      { id: "s1", recipeId: "pasta" },
      { id: "s2", recipeId: "pasta" },
    ]);
    const stepStates = makeStepStates({ s1: "ready", s2: "ready" });
    const result = assessCookingEvents({
      recentEvents: [
        makeDomainEvent("e1", "ingredient_substituted", {
          recipeId: "pasta",
          original: "tomatoes",
          replacement: "canned tomatoes",
        }),
        makeDomainEvent("e2", "delay_reported", {
          recipeId: "pasta",
          seconds: 120,
        }),
      ],
      plan,
      stepStates,
    });
    expect(result.needsReplan).toBe(true);
    expect(result.causeEventIds).toEqual(["e1", "e2"]);
    expect(new Set(result.directlyAffectedStepIds)).toEqual(new Set(["s1", "s2"]));
    expect(result.reason).toContain("Ingredient substitution");
    expect(result.reason).toContain("Delay of 120s");
  });

  it("ignores unparseable domain events", () => {
    const plan = makePlan([{ id: "s1", recipeId: "pasta" }]);
    const stepStates = makeStepStates({ s1: "ready" });
    const result = assessCookingEvents({
      recentEvents: [
        makeDomainEvent("e1", "unknown_event_type", { recipeId: "pasta" }),
      ],
      plan,
      stepStates,
    });
    expect(result.needsReplan).toBe(false);
  });
});

describe("createCookingReplanRuntime", () => {
  it("returns undefined when GEMINI_API_KEY is missing", () => {
    const env = { GEMINI_API_KEY: "" } as unknown as TestEnv;
    const runtime = createCookingReplanRuntime(env);
    expect(runtime).toBeUndefined();
  });

  it("returns a runtime when GEMINI_API_KEY is present", () => {
    const env = { GEMINI_API_KEY: "test-key" } as unknown as TestEnv;
    const runtime = createCookingReplanRuntime(env);
    expect(runtime).toBeDefined();
    expect(typeof runtime!.resolveConfiguration).toBe("function");
    expect(typeof runtime!.generator.assess).toBe("function");
    expect(typeof runtime!.generator.generatePatch).toBe("function");
  });

  it("resolves configuration only for guided-cooking domain", () => {
    const env = { GEMINI_API_KEY: "test-key" } as unknown as TestEnv;
    const runtime = createCookingReplanRuntime(env)!;
    const config = runtime.resolveConfiguration("guided-cooking");
    expect(config.domainVersion).toBe(COOKING_DOMAIN_VERSION);
    expect(config.defaultMode).toBe("confirm");
    expect(config.capabilityPolicies).toEqual([]);
    expect(config.stepDataSchema).toBe(cookingDomain.schemas.stepData);
  });

  it("throws for unsupported domains", () => {
    const env = { GEMINI_API_KEY: "test-key" } as unknown as TestEnv;
    const runtime = createCookingReplanRuntime(env)!;
    expect(() => runtime.resolveConfiguration("other-domain")).toThrow("Unsupported domain");
  });
});

describe("buildAiReplanInput", () => {
  it("forwards AbortSignal to the AI generator input", () => {
    const controller = new AbortController();
    const signal = controller.signal;

    const plan = makePlan([{ id: "s1", recipeId: "pasta" }]);
    const stepStates = makeStepStates({ s1: "ready" });

    const input = {
      domainId: "guided-cooking",
      instructions: "update steps",
      plan,
      normalizedInput: {},
      assessment: {
        needsReplan: true,
        causeEventIds: ["e1"],
        directlyAffectedStepIds: ["s1"],
        reason: "test",
      },
      affectedStepIds: ["s1"],
      mode: "confirm" as const,
      recentEvents: [
        makeDomainEvent("e1", "delay_reported", { recipeId: "pasta", seconds: 120 }),
      ],
      stepStates,
      worldState: {
        facts: {},
        resources: [],
        observations: [],
        activeConstraints: [],
        updatedAt: new Date(),
      },
      goal: {
        id: "g1",
        description: "Cook",
        successCriteria: [],
        completionPolicy: "human_confirmation" as const,
      },
      sessionId: "sess-1",
      context: { actorId: "github:1", roles: ["cook"] },
      signal,
    } as unknown as Parameters<typeof buildAiReplanInput>[0];

    const result: ReplanGeneratorInput = buildAiReplanInput(input);
    expect(result.signal).toBe(signal);
    expect(result.domainId).toBe("guided-cooking");
    expect(result.baseLastEventId).toBe("e1");
    expect(result.causeRefs).toEqual([{ type: "runtime_event", eventId: "e1" }]);
  });

  it("works without an AbortSignal", () => {
    const plan = makePlan([{ id: "s1", recipeId: "pasta" }]);
    const stepStates = makeStepStates({ s1: "ready" });

    const input = {
      domainId: "guided-cooking",
      instructions: "update steps",
      plan,
      normalizedInput: {},
      assessment: {
        needsReplan: true,
        causeEventIds: ["e1"],
        directlyAffectedStepIds: ["s1"],
        reason: "test",
      },
      affectedStepIds: ["s1"],
      mode: "confirm" as const,
      recentEvents: [
        makeDomainEvent("e1", "delay_reported", { recipeId: "pasta", seconds: 120 }),
      ],
      stepStates,
      worldState: {
        facts: {},
        resources: [],
        observations: [],
        activeConstraints: [],
        updatedAt: new Date(),
      },
      goal: {
        id: "g1",
        description: "Cook",
        successCriteria: [],
        completionPolicy: "human_confirmation" as const,
      },
      sessionId: "sess-1",
      context: { actorId: "github:1", roles: ["cook"] },
    } as unknown as Parameters<typeof buildAiReplanInput>[0];

    const result = buildAiReplanInput(input);
    expect(result.signal).toBeUndefined();
  });
});
