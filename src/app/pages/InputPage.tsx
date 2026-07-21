import { useQuery } from "@tanstack/react-query";
import { usePlanCompiler, usePearContext } from "@pear-agent/react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { normalizedRecipeSchema, type NormalizedRecipe } from "../../domain/domain";
import { formatMessage, useI18n } from "../i18n";
import { links } from "../navigation";

const recipeListResponseSchema = z.object({ recipes: z.array(normalizedRecipeSchema) });
const recipeResponseSchema = z.object({ recipe: normalizedRecipeSchema });
const errorResponseSchema = z.object({ error: z.string() });
type InputKind = "ai" | "url" | "text";

const sourceResponseSchema = z.object({ source: z.object({ id: z.string().min(1) }) });

function listValues(value: string): string[] {
  return value
    .split(/[\n,、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : formatMessage(fallback, { status: response.status });
}

export function InputPage({ planId }: { planId: string }) {
  const { client } = usePearContext();
  const { messages, format } = useI18n();
  const inputKindDetails: Record<InputKind, { label: string; description: string }> = {
    ai: { label: messages.input.aiLabel, description: messages.input.aiDescription },
    url: { label: messages.input.urlLabel, description: messages.input.urlDescription },
    text: { label: messages.input.textLabel, description: messages.input.textDescription },
  };
  const compiler = usePlanCompiler(planId);
  const artifact = useQuery({ queryKey: ["plan", planId], queryFn: () => client.getPlan(planId) });
  const recipes = useQuery({
    queryKey: ["recipes", planId],
    queryFn: async () => {
      const response = await fetch(`/api/plans/${encodeURIComponent(planId)}/recipes`);
      if (!response.ok) throw new Error(await errorMessage(response, messages.common.requestFailed));
      return recipeListResponseSchema.parse(await response.json()).recipes;
    },
  });
  const [inputKind, setInputKind] = useState<InputKind>("ai");
  const [sourceInput, setSourceInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [planningNotes, setPlanningNotes] = useState("");
  const [availableIngredients, setAvailableIngredients] = useState("");
  const [dietaryConstraints, setDietaryConstraints] = useState("");
  const [photoNotes, setPhotoNotes] = useState("");
  const [transformInstructions, setTransformInstructions] = useState<Record<string, string>>({});
  const [transformingId, setTransformingId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Record<string, true>>({});
  const [error, setError] = useState<string | null>(null);

  const mealTitle = artifact.data?.title || messages.input.newMeal;

  async function addRecipe() {
    const cleanInput = sourceInput.trim();
    if (!cleanInput) return;
    setAdding(true);
    setError(null);
    try {
      const sourceResponse = await fetch(`/plans/${encodeURIComponent(planId)}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          inputKind === "url"
            ? { kind: "url", url: cleanInput, label: "Recipe URL" }
            : {
                kind: "text",
                label: inputKind === "ai" ? "AI recipe request" : "Recipe text",
                content: cleanInput,
              },
        ),
      });
      if (!sourceResponse.ok) throw new Error(await errorMessage(sourceResponse, messages.common.requestFailed));
      const sourceId = sourceResponseSchema.parse(await sourceResponse.json()).source.id;
      const response = await fetch(`/api/plans/${encodeURIComponent(planId)}/recipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId,
          sourceKind: inputKind,
          sourceInput: cleanInput,
          availableIngredients: listValues(availableIngredients),
          dietaryConstraints: listValues(dietaryConstraints),
          photoNotes: photoNotes.trim() || null,
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response, messages.common.requestFailed));
      const recipe = recipeResponseSchema.parse(await response.json()).recipe;
      await recipes.refetch();
      setExpandedIds((current) => ({ ...current, [recipe.id]: true }));
      setSourceInput("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAdding(false);
    }
  }

  async function transformRecipe(recipe: NormalizedRecipe) {
    const instruction = transformInstructions[recipe.id]?.trim();
    if (!instruction) return;
    setTransformingId(recipe.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/plans/${encodeURIComponent(planId)}/recipes/${encodeURIComponent(recipe.id)}/transform`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ instruction }),
        },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages.common.requestFailed));
      recipeResponseSchema.parse(await response.json());
      setTransformInstructions((current) => ({ ...current, [recipe.id]: "" }));
      await recipes.refetch();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTransformingId(null);
    }
  }

  async function removeRecipe(recipeId: string) {
    setError(null);
    const response = await fetch(
      `/api/plans/${encodeURIComponent(planId)}/recipes/${encodeURIComponent(recipeId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      setError(await errorMessage(response, messages.common.requestFailed));
      return;
    }
    await recipes.refetch();
  }

  async function compileMeal() {
    if (!recipes.data?.length || !artifact.data) return;
    setError(null);
    try {
      const result = await compiler.compile({
        recipes: recipes.data,
        mealTitle,
        finishTogether: true,
        availableIngredients: listValues(availableIngredients),
        dietaryConstraints: listValues(dietaryConstraints),
        photoNotes: photoNotes.trim() || null,
        planningNotes: planningNotes.trim() || null,
      });
      if (result.artifact) window.location.hash = links.plan(planId).slice(1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="flow-page recipe-workspace page-enter">
      <header className="page-heading">
        <span className="eyebrow">{messages.input.eyebrow}</span>
        <h1>{mealTitle}</h1>
        <p>{messages.input.description}</p>
      </header>

      {(error || compiler.error || artifact.isError) && (
        <div className="section-error" role="alert">
          <div>
            <strong>{messages.input.processError}</strong>
            <span>{error || compiler.error?.message || artifact.error?.message}</span>
          </div>
          {recipes.isError && <Button variant="secondary" onClick={() => void recipes.refetch()}>{messages.input.reloadRecipes}</Button>}
        </div>
      )}

      <div className="recipe-workspace-layout">
        <main className="recipe-main">
          <section className="workflow-section add-recipe-section" aria-labelledby="add-recipe-title">
            <div className="numbered-heading">
              <span>1</span>
              <div>
                <h2 id="add-recipe-title">{messages.input.addTitle}</h2>
                <p>{messages.input.addDescription}</p>
              </div>
            </div>

            <div className="input-kind-tabs" role="tablist" aria-label={messages.input.inputMethods}>
              {(Object.keys(inputKindDetails) as InputKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={inputKind === kind}
                  onClick={() => {
                    setInputKind(kind);
                    setSourceInput("");
                  }}
                >
                  <strong>{inputKindDetails[kind].label}</strong>
                  <small>{inputKindDetails[kind].description}</small>
                </button>
              ))}
            </div>

            <div className="field-group recipe-source-field">
              <Label htmlFor="recipe-source">
                {inputKind === "ai" ? messages.input.dishLabel : inputKind === "url" ? messages.input.urlFieldLabel : messages.input.textFieldLabel}
              </Label>
              <Textarea
                id="recipe-source"
                rows={inputKind === "text" ? 9 : 5}
                value={sourceInput}
                onChange={(event) => setSourceInput(event.target.value)}
                placeholder={
                  inputKind === "ai"
                    ? messages.input.dishPlaceholder
                    : inputKind === "url"
                      ? "https://example.com/recipe"
                      : messages.input.textPlaceholder
                }
              />
            </div>

            <Button
              size="lg"
              variant={recipes.data?.length ? "secondary" : "default"}
              disabled={adding || !sourceInput.trim()}
              onClick={() => void addRecipe()}
            >
              {adding ? <LoaderCircle className="spin" /> : <Plus />}
              {adding ? messages.input.reading : inputKind === "url" ? messages.input.addFromUrl : messages.input.addRecipe}
            </Button>
          </section>

          <section className="workflow-section recipe-collection" aria-labelledby="recipe-list-title">
            <div className="numbered-heading">
              <span>2</span>
              <div>
                <h2 id="recipe-list-title">{messages.input.reviewTitle}</h2>
                <p>{format(messages.input.reviewDescription, { count: recipes.data?.length ?? 0 })}</p>
              </div>
            </div>

            {recipes.isLoading && (
              <div className="list-loading" role="status">
                <LoaderCircle className="spin" />
                <span>{messages.input.loading}</span>
              </div>
            )}
            {recipes.isError && (
              <div className="section-error" role="alert">
                <div><strong>{messages.input.loadError}</strong><span>{recipes.error.message}</span></div>
                <Button variant="secondary" onClick={() => void recipes.refetch()}>{messages.common.retry}</Button>
              </div>
            )}
            {recipes.data?.length === 0 && (
              <div className="empty-state">
                <strong>{messages.input.emptyTitle}</strong>
                <p>{messages.input.emptyDescription}</p>
              </div>
            )}

            <div className="normalized-recipe-list">
              {recipes.data?.map((recipe, index) => {
                const expanded = Boolean(expandedIds[recipe.id]);
                const totalMinutes = Math.ceil(
                  recipe.instructions.reduce((total, instruction) => total + instruction.durationSeconds, 0) / 60,
                );
                return (
                  <article className="recipe-item" key={recipe.id}>
                    <header>
                      <div className="recipe-item-title">
                        <span>{index + 1}</span>
                        <div>
                          <h3>{recipe.title}</h3>
                          <p>{format(messages.input.recipeSummary, {
                            servings: format(messages.common.servings, { count: recipe.servings }),
                            ingredients: format(messages.common.ingredients, { count: recipe.ingredients.length }),
                            minutes: format(messages.common.minutes, { count: totalMinutes }),
                          })}</p>
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" aria-label={format(messages.input.removeRecipe, { title: recipe.title })} onClick={() => void removeRecipe(recipe.id)}>
                        <Trash2 />
                      </Button>
                    </header>

                    <button
                      type="button"
                      className="recipe-detail-toggle"
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedIds((current) => {
                          if (current[recipe.id]) {
                            const next = { ...current };
                            delete next[recipe.id];
                            return next;
                          }
                          return { ...current, [recipe.id]: true };
                        })
                      }
                    >
                      {messages.input.details}
                      {expanded ? <ChevronUp /> : <ChevronDown />}
                    </button>

                    {expanded && (
                      <div className="recipe-detail-grid">
                        <div>
                          <h4>{messages.input.ingredientTitle}</h4>
                          <ul>{recipe.ingredients.map((ingredient) => <li key={`${ingredient.name}-${ingredient.quantity}`}><span>{ingredient.name}</span><strong>{ingredient.quantity}</strong></li>)}</ul>
                        </div>
                        <div>
                          <h4>{messages.input.instructionTitle}</h4>
                          <ol>{recipe.instructions.map((instruction, instructionIndex) => <li key={`${instruction.title}-${instructionIndex}`}><span>{instructionIndex + 1}</span><div><strong>{instruction.title}</strong><p>{instruction.instruction}</p></div></li>)}</ol>
                        </div>
                      </div>
                    )}

                    {recipe.transformationHistory.length > 0 && (
                      <div className="transformation-history">
                        <strong>{messages.input.history}</strong>
                        {recipe.transformationHistory.map((change, changeIndex) => (
                          <p key={`${change.instruction}-${changeIndex}`}>{change.summary}</p>
                        ))}
                      </div>
                    )}

                    <div className="recipe-transform-box">
                      <Label htmlFor={`transform-${recipe.id}`}>{messages.input.adjustLabel}</Label>
                      <div className="transform-row">
                        <Input
                          id={`transform-${recipe.id}`}
                          value={transformInstructions[recipe.id] ?? ""}
                          onChange={(event) => setTransformInstructions((current) => ({ ...current, [recipe.id]: event.target.value }))}
                          placeholder={messages.input.adjustPlaceholder}
                        />
                        <Button
                          variant="secondary"
                          disabled={!transformInstructions[recipe.id]?.trim() || transformingId !== null}
                          onClick={() => void transformRecipe(recipe)}
                        >
                          {transformingId === recipe.id && <LoaderCircle className="spin" />}
                          {transformingId === recipe.id ? messages.input.changing : messages.input.applyChange}
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </main>

        <aside className="meal-settings">
          <section className="workflow-section" aria-labelledby="meal-settings-title">
            <div className="numbered-heading">
              <span>3</span>
              <div>
                <h2 id="meal-settings-title">{messages.input.settingsTitle}</h2>
                <p>{messages.input.settingsDescription}</p>
              </div>
            </div>
            <div className="form-stack">
              <div className="field-group">
                <Label htmlFor="available-ingredients">{messages.input.availableIngredients} <span className="optional">{messages.common.optional}</span></Label>
                <Textarea id="available-ingredients" rows={3} value={availableIngredients} onChange={(event) => setAvailableIngredients(event.target.value)} placeholder={messages.input.availablePlaceholder} />
              </div>
              <div className="field-group">
                <Label htmlFor="dietary-constraints">{messages.input.dietaryConstraints} <span className="optional">{messages.common.optional}</span></Label>
                <Textarea id="dietary-constraints" rows={2} value={dietaryConstraints} onChange={(event) => setDietaryConstraints(event.target.value)} placeholder={messages.input.dietaryPlaceholder} />
              </div>
              <div className="field-group">
                <Label htmlFor="photo-notes">{messages.input.photoNotes} <span className="optional">{messages.common.optional}</span></Label>
                <Textarea id="photo-notes" rows={2} value={photoNotes} onChange={(event) => setPhotoNotes(event.target.value)} placeholder={messages.input.photoPlaceholder} />
              </div>
              <div className="field-group">
                <Label htmlFor="planning-notes">{messages.input.planningNotes} <span className="optional">{messages.common.optional}</span></Label>
                <Textarea id="planning-notes" rows={3} value={planningNotes} onChange={(event) => setPlanningNotes(event.target.value)} placeholder={messages.input.planningPlaceholder} />
              </div>
            </div>
          </section>

          <section className="compile-action" aria-labelledby="compile-title">
            <div>
              <h2 id="compile-title">{messages.input.compileTitle}</h2>
              <p>{recipes.data?.length ? format(messages.input.compileReady, { count: recipes.data.length }) : messages.input.compileEmpty}</p>
            </div>
            <Button
              size="lg"
              className="full-width"
              disabled={!recipes.data?.length || compiler.status === "loading" || transformingId !== null}
              onClick={() => void compileMeal()}
            >
              {compiler.status === "loading" ? <LoaderCircle className="spin" /> : null}
              {compiler.status === "loading" ? messages.input.compiling : messages.input.compile}
              {compiler.status !== "loading" && <ArrowRight />}
            </Button>
            <p className="approval-note">{messages.input.compileNote}</p>
          </section>
        </aside>
      </div>

      <Button asChild variant="ghost"><a href={links.plans()}><ArrowLeft />{messages.common.backToPlans}</a></Button>
    </section>
  );
}
