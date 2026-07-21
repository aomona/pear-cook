# Domain and AI compilation

## Define the boundary first

Use `defineAiDomain()` for Sources → Interpret → Clarify? → Plan. Define Zod schemas for every external or generated boundary:

```ts
import { defineAiDomain, sourceReferenceSchema } from "@pear-agent/core";
import { z } from "zod";

export const domain = defineAiDomain({
  id: "my-domain",
  version: 1,
  schemas: {
    compileInput: z.object({ request: z.string().trim().min(1) }),
    normalizedInput: z.object({
      title: z.string().min(1),
      tasks: z.array(
        z.object({
          title: z.string().min(1),
          sourceRefs: z.array(sourceReferenceSchema).min(1),
        }),
      ),
    }),
    stepData: z.object({ task: z.string().min(1) }),
    worldState: z.object({ notes: z.array(z.string()) }),
    events: z.discriminatedUnion("type", [
      z.object({ type: z.literal("constraint_changed"), note: z.string().min(1) }),
    ]),
  },
  interpretation: {
    instructions: "Extract a concise task model and preserve source provenance.",
  },
  planning: {
    instructions: "Create an executable DAG and parallelize independent work.",
    objectives: ["Make the next action obvious", "Respect constraints"],
    validatePlan(plan) {
      const issues = plan.steps.flatMap((step) =>
        step.sourceRefs?.length ? [] : [`Step ${step.id} needs source provenance`],
      );
      return { valid: plan.steps.length > 0 && issues.length === 0, issues };
    },
  },
  replanning: {
    instructions: "Update only work affected by new facts.",
    defaultMode: "confirm",
    reconcileWorldState(_plan, worldState) {
      return worldState;
    },
  },
  capabilities: [],
  completionPolicy: "automatic",
});
```

Use the Domain schema's output types. Parse AI, HTTP, persistence, and Domain boundaries; do not cast untrusted values.

## Compose the compiler on the Worker

`@pear-agent/ai` is provider-neutral at its public boundary. Create the provider model in Worker code, then compose interpreter and planner adapters into `createAiPlanCompiler()`.

The compiler contract requires:

- `domainVersion`;
- interpretation instructions;
- planning instructions and objectives;
- a `SourceInterpreter`;
- an AI Plan Generator;
- validators for compile input, normalized input, and the final Plan when applicable.

Pass `AbortSignal` through compile work. Keep retries, model calls, and token budgets bounded. Return failures; never invent a deterministic AI fallback after provider failure.

## Provenance and clarifications

Every generated claim that drives a step should retain `sourceRefs`. Ask a clarification only when an ambiguity materially changes execution. A clarification is durable compile state: persist the question, accept an answer through the Worker route, then resume compilation.

## Plan validation

Before a Plan Artifact becomes ready, validate:

- unique step IDs and a cycle-free DAG;
- referenced dependencies and capabilities;
- Domain `stepData`;
- source provenance required by the Domain;
- goal/objective alignment;
- Domain policy and authorization.

Generated output is a proposal until these deterministic checks pass.
