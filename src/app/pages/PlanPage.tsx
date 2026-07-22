import { useQuery } from "@tanstack/react-query";
import { useExecutionSession, usePearContext } from "@pear-agent/react";
import {
  ArrowLeft,
  Clock3,
  LoaderCircle,
  Play,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Label } from "../../components/ui/label";
import { cookingNormalizedInputSchema, cookingStepDataSchema } from "../../domain/domain";
import { useAuth } from "../Auth";
import { useI18n } from "../i18n";
import { links } from "../navigation";

const jaUnits: Record<string, string> = {
  g: "g", gram: "g", grams: "g", kg: "kg", kilogram: "kg", kilograms: "kg",
  ml: "ml", milliliter: "ml", milliliters: "ml", l: "L", liter: "L", liters: "L",
  tsp: "小さじ", teaspoon: "小さじ", teaspoons: "小さじ", tbsp: "大さじ", tablespoon: "大さじ", tablespoons: "大さじ",
  cup: "カップ", cups: "カップ", piece: "個", pieces: "個", clove: "片", cloves: "片",
  can: "缶", cans: "缶", package: "袋", packages: "袋", pinch: "ひとつまみ",
};

const jaAllergens: Record<string, string> = {
  milk: "乳", dairy: "乳", egg: "卵", eggs: "卵", fish: "魚", shellfish: "甲殻類",
  peanut: "落花生", peanuts: "落花生", nuts: "木の実", "tree nuts": "木の実",
  wheat: "小麦", soy: "大豆", soybean: "大豆", sesame: "ごま",
};

function localizeUnit(unit: string | undefined, locale: "ja" | "en") {
  if (!unit || locale === "en") return unit ?? "";
  return jaUnits[unit.trim().toLowerCase()] ?? unit;
}

function localizeAllergen(allergen: string, locale: "ja" | "en") {
  if (locale === "en") return allergen;
  return jaAllergens[allergen.trim().toLowerCase()] ?? allergen;
}

export function PlanPage({ planId }: { planId: string }) {
  const { client } = usePearContext();
  const { user } = useAuth();
  const { locale, messages, format } = useI18n();
  const session = useExecutionSession();
  const artifact = useQuery({ queryKey: ["plan", planId], queryFn: () => client.getPlan(planId) });
  const [reviewed, setReviewed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<{ action: "start" | "edit"; detail: string } | null>(null);

  async function approveAndStart() {
    if (!artifact.data || !reviewed) return;
    setStarting(true);
    setError(null);
    try {
      await client.updatePlan(planId, { status: "ready" });
      const created = await session.create({
        domainId: artifact.data.domainId,
        actorIds: [`github:${user.id}`],
        planArtifactId: planId,
      });
      await session.startSession();
      window.location.hash = links.execute(created.sessionId).slice(1);
    } catch (caught) {
      setError({ action: "start", detail: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setStarting(false);
    }
  }

  async function reopenForEditing() {
    if (!artifact.data || editing) return;
    if (artifact.data.status !== "ready") {
      window.location.hash = links.input(planId).slice(1);
      return;
    }
    setEditing(true);
    setError(null);
    try {
      await client.updatePlan(planId, { status: "draft" });
      window.location.hash = links.input(planId).slice(1);
    } catch (caught) {
      setError({ action: "edit", detail: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setEditing(false);
    }
  }

  if (artifact.isLoading) return <div className="center-state" role="status"><LoaderCircle className="spin" />{messages.review.loading}</div>;
  if (artifact.isError) return (
    <div className="page-state" role="alert">
      <strong>{messages.review.loadError}</strong>
      <p>{messages.review.loadErrorDescription}</p>
      <div><Button variant="secondary" onClick={() => void artifact.refetch()}>{messages.common.retry}</Button><Button asChild variant="ghost"><a href={links.plans()}>{messages.common.backToPlans}</a></Button></div>
    </div>
  );
  if (!artifact.data) return <div className="page-state"><strong>{messages.review.notFound}</strong><p>{messages.review.notFoundDescription}</p><Button asChild><a href={links.plans()}>{messages.review.backToPlans}</a></Button></div>;

  const normalized = cookingNormalizedInputSchema.safeParse(artifact.data.normalizedInput);
  if (!normalized.success) {
    return (
      <div className="page-state">
        <strong>{messages.review.missingPlan}</strong>
        <p>{messages.review.missingPlanDescription}</p>
        <Button asChild><a href={links.input(planId)}>{messages.review.backToRecipe}</a></Button>
      </div>
    );
  }

  const scheduledSteps = artifact.data.currentPlan.steps.flatMap((step) => {
    const parsed = cookingStepDataSchema.safeParse(step.domainData);
    return parsed.success ? [{ step, timing: parsed.data }] : [];
  });
  const maxOffset = Math.max(...scheduledSteps.map(({ timing }) => timing.startOffsetSeconds), 0);
  const sharedSteps = scheduledSteps.filter(({ timing }) => timing.recipeId === "shared");

  return (
    <section className="flow-page synchronized-review page-enter">
      <header className="page-heading review-heading">
        <span className="eyebrow">{messages.review.eyebrow}</span>
        <h1>{normalized.data.mealTitle}</h1>
        <p>{messages.review.description}</p>
        <div className="plan-summary-line">
          <span><strong>{normalized.data.recipes.length}</strong> {messages.common.dishUnit}</span>
          <span>{format(messages.review.firstTask, { count: Math.ceil(maxOffset / 60) })}</span>
          <span>{format(messages.review.totalSteps, { count: scheduledSteps.length })}</span>
        </div>
      </header>

      <section className="finish-line" aria-labelledby="finish-line-title">
        <span>T−0</span>
        <div>
          <h2 id="finish-line-title">{messages.review.finishTitle}</h2>
          <p>{messages.review.finishDescription}</p>
        </div>
      </section>

      {scheduledSteps.length === 0 ? (
        <div className="empty-state">
          <strong>{messages.review.noSteps}</strong>
          <p>{messages.review.noStepsDescription}</p>
          <Button asChild><a href={links.input(planId)}>{messages.review.backToRecipe}</a></Button>
        </div>
      ) : (
        <div className="recipe-lanes">
          {normalized.data.recipes.map((recipe) => {
            const laneSteps = scheduledSteps
              .filter(({ timing }) => timing.recipeId === recipe.id)
              .sort((left, right) => right.timing.startOffsetSeconds - left.timing.startOffsetSeconds);
            return (
              <section className="recipe-lane" key={recipe.id}>
                <header>
                  <div>
                    <h2>{recipe.title}</h2>
                    <p>{format(messages.review.recipeSummary, {
                      servings: format(messages.common.servings, { count: recipe.servings }),
                      steps: format(messages.common.steps, { count: laneSteps.length }),
                    })}</p>
                  </div>
                  {recipe.transformationHistory.length > 0 && <span className="plain-status">{messages.review.adjusted}</span>}
                </header>
                {(recipe.provenance || recipe.images.length > 0) && <div className="recipe-evidence">
                  {recipe.provenance && <span className="plain-status">{messages.review.provenanceLabel}: {recipe.provenance.extractedBy} · {format(messages.review.confidenceLabel, { percent: Math.round(recipe.provenance.confidence * 100) })}</span>}
                  {recipe.images.map((image) => <figure key={image.sourceId}><img src={`/api/plans/${encodeURIComponent(planId)}/photos/${encodeURIComponent(image.sourceId)}`} alt={format(messages.input.generatedImageAlt, { title: recipe.title })} /><figcaption><strong>{messages.input.generatedImageLabel}</strong> · {messages.input.generatedImageDisclosure}</figcaption></figure>)}
                </div>}
                <ul className="review-ingredients">{recipe.ingredients.map((ingredient, index) => <li key={`${ingredient.name}-${index}`}><span>{ingredient.name}</span><strong>{ingredient.amount != null ? `${ingredient.amount} ${localizeUnit(ingredient.unit || ingredient.canonicalUnit, locale)}` : ingredient.quantity}</strong>{ingredient.allergens.length > 0 && <span className="allergen-chip">{ingredient.allergens.map((allergen) => localizeAllergen(allergen, locale)).join(", ")}</span>}</li>)}</ul>
                <ol>
                  {laneSteps.map(({ step, timing }) => {
                    const isWait = timing.kind === "wait";
                    return (
                      <li key={step.id} className={`timing-step timing-${timing.kind}`}>
                        <div className="timing-marker"><strong>T−{Math.ceil(timing.startOffsetSeconds / 60)}</strong><span>{messages.common.minuteUnit}</span></div>
                        <div className="timing-step-body">
                          <div className="timing-step-topline">
                            <span>{isWait ? messages.review.wait : timing.kind === "serve" ? messages.review.serve : messages.review.cook}</span>
                            <span><Clock3 />{format(messages.common.minutes, { count: Math.ceil(step.estimatedDurationSeconds / 60) })}</span>
                          </div>
                          <h3>{isWait ? format(messages.review.waitTitle, { title: recipe.title }) : step.label || step.id}</h3>
                          <p>
                            {isWait
                              ? format(messages.review.waitDescription, { count: Math.ceil(step.estimatedDurationSeconds / 60) })
                              : step.instructions}
                          </p>
                          {(timing.temperature || timing.equipment.length > 0) && (
                            <div className="timing-details">
                              {timing.temperature && <span>{timing.temperature}</span>}
                              {timing.equipment.map((equipment) => <span key={equipment}>{equipment}</span>)}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
        </div>
      )}

      {sharedSteps.map(({ step }) => (
        <section className="shared-serve" key={step.id}>
          <span>T−0</span>
          <div>
            <h2>{messages.review.finishAll}</h2>
            <p>{step.instructions}</p>
          </div>
        </section>
      ))}

      <section className="approval-panel" aria-labelledby="approval-title">
        <div className="approval-copy">
          <span className="plain-status">{messages.review.approvalRequired}</span>
          <h2 id="approval-title">{messages.review.approvalTitle}</h2>
          <p>{messages.review.approvalDescription}</p>
        </div>
        <Label className="approval-check">
          <Checkbox checked={reviewed} onCheckedChange={(checked) => setReviewed(checked === true)} />
          <span>{messages.review.approvalCheck}</span>
        </Label>
        <div className="approval-actions">
          <Button variant="secondary" disabled={editing || starting} onClick={() => void reopenForEditing()}>
            {editing ? <LoaderCircle className="spin" /> : <ArrowLeft />}
            {editing ? messages.review.reopening : messages.review.adjustRecipes}
          </Button>
          <Button size="lg" disabled={!reviewed || starting || editing} onClick={() => void approveAndStart()}>
            {starting ? <LoaderCircle className="spin" /> : <Play />}
            {starting ? messages.review.starting : messages.review.start}
          </Button>
        </div>
      </section>

      {error && (
        <div className="inline-error" role="alert">
          <strong>{error.action === "edit" ? messages.review.editError : messages.review.startError}</strong>
          <span>{error.detail}</span>
        </div>
      )}
    </section>
  );
}
