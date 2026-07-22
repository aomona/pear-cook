import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  createAiPlanCompiler,
  createAiPlanImprover,
} from "@pear-agent/ai";
import {
  AuthorizationError,
  D1CompileRepository,
  ExecutionSessionAgent,
  createPearWorker,
  runPlanCompileJob,
  type AuthorizeFn,
  type PearEnv,
  type PlanCompileWorkflowParams,
} from "@pear-agent/cloudflare";
import { executionGoalSchema, executionPlanSchema } from "@pear-agent/core";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ZodError } from "zod";

import {
  cookingDomain,
  cookingNormalizedInputSchema,
} from "../domain/domain.js";
import { buildCookingPlan } from "../domain/plan.js";
import {
  handleAuthRequest,
  resolveAuthenticatedContext,
  type AuthEnv,
} from "./auth.js";
import { handleRecipeApi } from "./recipes.js";
import { readEstimateProfile, snapshotCompileEstimateProfile } from "./estimates.js";
import { handleFeedbackApi } from "./feedback.js";
import { handlePhotoApi } from "./photos.js";
import { createCookingReplanRuntime } from "./replan.js";

export { ExecutionSessionAgent };

type CookingEnv = PearEnv & AuthEnv;
const COOKING_MODEL = "gemini-3.5-flash-lite";
const COOKING_LIVE_MODEL = "gemini-3.1-flash-live-preview";

function createCookingCompileRuntime(env: CookingEnv, estimateProfile: Record<string, number> = {}) {
  if (!env.GEMINI_API_KEY) return undefined;
  const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });
  const model = google(COOKING_MODEL);
  return createAiPlanCompiler({
    domainVersion: cookingDomain.version,
    interpretationInstructions: cookingDomain.interpretation.instructions,
    planningInstructions: cookingDomain.planning.instructions,
    planningObjectives: cookingDomain.planning.objectives,
    interpreter: {
      async interpret(input) {
        return {
          kind: "ready",
          normalizedInput: cookingDomain.schemas.compileInput.parse(input.compileInput),
          assumptions: [],
          generation: {
            id: crypto.randomUUID(),
            stage: "interpret",
            provider: "host",
            model: "normalized-recipe-pass-through",
            promptVersion: "multi-recipe-v1",
            schemaVersion: String(cookingDomain.version),
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            attempt: 1,
            warnings: [],
            validation: { ok: true, issues: [] },
            createdAt: new Date(),
          },
        };
      },
    },
    planner: {
      async generatePlan(input) {
        return {
          plan: buildCookingPlan(
            input.goal,
            cookingDomain.schemas.normalizedInput.parse(input.normalizedInput),
            { estimateProfile },
          ),
          generation: {
            id: crypto.randomUUID(),
            stage: "plan",
            provider: "host",
            model: "synchronized-recipe-scheduler",
            promptVersion: "multi-recipe-v1",
            schemaVersion: String(cookingDomain.version),
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            attempt: 1,
            warnings: [],
            validation: { ok: true, issues: [] },
            createdAt: new Date(),
          },
        };
      },
    },
    validateCompileInput: (input) => cookingDomain.schemas.compileInput.parse(input),
    validateNormalizedInput: (input) => cookingDomain.schemas.normalizedInput.parse(input),
    async validatePlan({ plan, normalizedInput }) {
      const validation = await cookingDomain.planning.validatePlan(
        executionPlanSchema(cookingDomain.schemas.stepData).parse(plan),
        cookingDomain.schemas.normalizedInput.parse(normalizedInput),
      );
      if (!validation.valid) throw new Error(validation.issues.join("; "));
    },
  });
}

export class PlanCompileWorkflow extends WorkflowEntrypoint<CookingEnv, PlanCompileWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<PlanCompileWorkflowParams>>, step: WorkflowStep) {
    try {
      return await step.do(
        "compile-cooking-plan",
        {
          retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
          timeout: "30 minutes",
        },
        async () => {
          const estimateProfile = await snapshotCompileEstimateProfile(
            this.env,
            event.payload.jobId,
            event.payload.context.actorId,
          );
          const runtime = createCookingCompileRuntime(this.env, estimateProfile);
          if (!runtime) throw new Error("GEMINI_API_KEY is not configured");
          const result = await runPlanCompileJob({
            env: this.env,
            params: event.payload,
            runtime,
            durableRetry: true,
          });
          return { jobId: result.job.id, status: result.job.status };
        },
      );
    } catch (error) {
      const repository = new D1CompileRepository(this.env.DB);
      const job = await repository.getJob(event.payload.jobId);
      if (job && ["queued", "running", "waiting"].includes(job.status)) {
        await repository.updateJob(job.id, {
          status: "failed",
          error: error instanceof Error ? error.message.slice(0, 4_000) : "Compile failed",
        });
      }
      throw error;
    }
  }
}

async function actorOwnsPlan(env: CookingEnv, planId: string, actorId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT owner_actor_id FROM plan_artifacts WHERE id = ?")
    .bind(planId)
    .first<{ owner_actor_id: string | null }>();
  return row?.owner_actor_id === actorId;
}

async function actorOwnsSession(
  env: CookingEnv,
  sessionId: string,
  actorId: string,
): Promise<boolean> {
  const row = await env.DB.prepare("SELECT actor_ids_json FROM execution_sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ actor_ids_json: string }>();
  if (!row) return false;
  try {
    return (JSON.parse(row.actor_ids_json) as unknown[]).includes(actorId);
  } catch {
    return false;
  }
}

function createAuthorize(env: CookingEnv): AuthorizeFn {
  return async (operation, context) => {
    if (!context.actorId.startsWith("github:") || !context.roles.includes("cook")) {
      throw new AuthorizationError("A verified GitHub cook account is required");
    }

    if (operation.type === "plan.list") {
      throw new AuthorizationError("Use the owner-scoped plan library endpoint");
    }
    if (operation.type === "plan.create") {
      if (operation.domainId !== cookingDomain.id) {
        throw new AuthorizationError("Unknown cooking domain");
      }
      return;
    }
    if ("planId" in operation) {
      if (!(await actorOwnsPlan(env, operation.planId, context.actorId))) {
        throw new AuthorizationError("Plan not found or not owned by this cook");
      }
      return;
    }
    if (operation.type === "session.create") {
      if (operation.domainId !== cookingDomain.id) {
        throw new AuthorizationError("Unknown cooking domain");
      }
      return;
    }
    if (operation.type === "replan.request" && operation.mode !== "confirm") {
      throw new AuthorizationError("Cooking replans require explicit confirmation");
    }
    if ("sessionId" in operation) {
      if (!(await actorOwnsSession(env, operation.sessionId, context.actorId))) {
        throw new AuthorizationError("Session not found or not owned by this cook");
      }
      return;
    }

    throw new AuthorizationError("Operation is not allowed");
  };
}

function createCookingWorker(env: CookingEnv) {
  const google = env.GEMINI_API_KEY
    ? createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY })
    : null;
  const replanRuntime = createCookingReplanRuntime(env);
  return createPearWorker({
    authorize: createAuthorize(env),
    resolveContext: (request) => resolveAuthenticatedContext(request, env),
    geminiLiveModel: COOKING_LIVE_MODEL,
    realtimeInstructions: cookingDomain.realtime.instructions,
    realtimeLocale: cookingDomain.realtime.defaultLocale,
    ...(replanRuntime ? { replanRuntime } : {}),
    planGenerator: {
      async generatePlan(input) {
        const estimateProfile = await readEstimateProfile(env, input.context.actorId);
        return buildCookingPlan(
          executionGoalSchema.parse(input.goal),
          cookingNormalizedInputSchema.parse(input.normalizedInput),
          { estimateProfile },
        );
      },
    },
    planLibrary: {
      createPlanImprover() {
        if (!google) return undefined;
        return createAiPlanImprover({
          model: google(COOKING_MODEL),
          stepDataSchema: cookingDomain.schemas.stepData,
          instructions: cookingDomain.planning.instructions,
        });
      },
      async validatePlanEdit({ plan, normalizedInput }) {
        const validation = await cookingDomain.planning.validatePlan(
          executionPlanSchema(cookingDomain.schemas.stepData).parse(plan),
          cookingDomain.schemas.normalizedInput.parse(normalizedInput),
        );
        if (!validation.valid) throw new Error(validation.issues.join("; "));
      },
      createCompileRuntime: () => createCookingCompileRuntime(env),
    },
  });
}

async function ownerScopedPlanList(request: Request, env: CookingEnv): Promise<Response> {
  const context = await resolveAuthenticatedContext(request, env);
  const result = await env.DB.prepare(
    "SELECT id, domain_id, status, title, version, created_at, updated_at FROM plan_artifacts WHERE owner_actor_id = ? AND domain_id = ? ORDER BY updated_at DESC",
  )
    .bind(context.actorId, cookingDomain.id)
    .all<{
      id: string;
      domain_id: string;
      status: string;
      title: string | null;
      version: number;
      created_at: string;
      updated_at: string;
    }>();
  return Response.json({
    plans: result.results.map((plan) => ({
      id: plan.id,
      domainId: plan.domain_id,
      status: plan.status,
      title: plan.title,
      version: plan.version,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
    })),
  });
}

async function securePearRequest(request: Request, env: CookingEnv): Promise<Request | Response> {
  const context = await resolveAuthenticatedContext(request, env);
  const url = new URL(request.url);

  if (url.pathname.startsWith("/agents/")) {
    url.searchParams.set("pearContext", JSON.stringify(context));
    return new Request(url, request);
  }

  const eventMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
  if (eventMatch && request.method === "POST") {
    const body = (await request.clone().json()) as Record<string, unknown>;
    if (body.type === "domain_event") {
      const parsed = cookingDomain.schemas.events.safeParse(body.payload);
      if (!parsed.success || body.domainType !== parsed.data.type) {
        return Response.json({ error: "Invalid cooking Domain event" }, { status: 400 });
      }
    }
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    return new Request(request, {
      body: JSON.stringify({
        ...body,
        sessionId: decodeURIComponent(eventMatch[1]),
        actorId: context.actorId,
      }),
      headers,
    });
  }

  if (url.pathname === "/sessions" && request.method === "POST") {
    const body = (await request.clone().json()) as { planArtifactId?: unknown; domainId?: unknown };
    if (
      typeof body.planArtifactId !== "string" ||
      !(await actorOwnsPlan(env, body.planArtifactId, context.actorId))
    ) {
      return Response.json({ error: "Approved plan not found or not owned by this cook" }, { status: 403 });
    }
    const securedBody = JSON.stringify({ ...body, actorIds: [context.actorId] });
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    return new Request(request, { body: securedBody, headers });
  }

  return request;
}

export default {
  async fetch(request: Request, env: CookingEnv, context: ExecutionContext) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/auth/")) return await handleAuthRequest(request, env);
      if (url.pathname === "/api/plans") return await ownerScopedPlanList(request, env);
      if (url.pathname.startsWith("/api/plans/") && url.pathname.includes("/photos")) {
        const photoContext = await resolveAuthenticatedContext(request, env);
        return await handlePhotoApi(request, env, photoContext);
      }
      if (url.pathname.startsWith("/api/plans/") && url.pathname.includes("/recipes")) {
        const recipeContext = await resolveAuthenticatedContext(request, env);
        return await handleRecipeApi(request, env, recipeContext);
      }
      if (url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/feedback")) {
        const feedbackContext = await resolveAuthenticatedContext(request, env);
        return await handleFeedbackApi(request, env, feedbackContext);
      }

      if (
        url.pathname.startsWith("/plans") ||
        url.pathname.startsWith("/sessions") ||
        url.pathname.startsWith("/agents")
      ) {
        const secured = await securePearRequest(request, env);
        if (secured instanceof Response) return secured;
        return await createCookingWorker(env).fetch(secured, env, context);
      }
    } catch (error) {
      const status =
        error instanceof ZodError
          ? 400
          : error instanceof Error && "status" in error && typeof error.status === "number"
            ? error.status
            : 500;
      const message =
        error instanceof ZodError
          ? "Invalid request"
          : status < 500 && error instanceof Error
            ? error.message
            : "Request failed. Please try again.";
      return Response.json({ error: message }, { status });
    }

    return createCookingWorker(env).fetch(request, env, context);
  },
};
