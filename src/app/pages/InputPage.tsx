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
import { links } from "../navigation";

const recipeListResponseSchema = z.object({ recipes: z.array(normalizedRecipeSchema) });
const recipeResponseSchema = z.object({ recipe: normalizedRecipeSchema });
const errorResponseSchema = z.object({ error: z.string() });
type InputKind = "ai" | "url" | "text";

const INPUT_KIND_DETAILS: Record<InputKind, { label: string; description: string }> = {
  ai: { label: "料理名から", description: "作りたい料理を文章で指定" },
  url: { label: "レシピURL", description: "公開されているページを取り込む" },
  text: { label: "レシピ本文", description: "材料と手順を貼り付ける" },
};
const sourceResponseSchema = z.object({ source: z.object({ id: z.string().min(1) }) });

function listValues(value: string): string[] {
  return value
    .split(/[\n,、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function errorMessage(response: Response): Promise<string> {
  const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : `Request failed (${response.status})`;
}

export function InputPage({ planId }: { planId: string }) {
  const { client } = usePearContext();
  const compiler = usePlanCompiler(planId);
  const artifact = useQuery({ queryKey: ["plan", planId], queryFn: () => client.getPlan(planId) });
  const recipes = useQuery({
    queryKey: ["recipes", planId],
    queryFn: async () => {
      const response = await fetch(`/api/plans/${encodeURIComponent(planId)}/recipes`);
      if (!response.ok) throw new Error(await errorMessage(response));
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

  const mealTitle = artifact.data?.title || "新しい献立";

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
      if (!sourceResponse.ok) throw new Error(await errorMessage(sourceResponse));
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
      if (!response.ok) throw new Error(await errorMessage(response));
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
      if (!response.ok) throw new Error(await errorMessage(response));
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
      setError(await errorMessage(response));
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
        <span className="eyebrow">1 / 3　レシピ</span>
        <h1>{mealTitle}</h1>
        <p>料理を一品ずつ追加し、材料と手順を確認してから調理順を作成します。</p>
      </header>

      {(error || compiler.error || artifact.isError) && (
        <div className="section-error" role="alert">
          <div>
            <strong>処理を完了できませんでした</strong>
            <span>{error || compiler.error?.message || artifact.error?.message}</span>
          </div>
          {recipes.isError && <Button variant="secondary" onClick={() => void recipes.refetch()}>レシピを再読み込み</Button>}
        </div>
      )}

      <div className="recipe-workspace-layout">
        <main className="recipe-main">
          <section className="workflow-section add-recipe-section" aria-labelledby="add-recipe-title">
            <div className="numbered-heading">
              <span>1</span>
              <div>
                <h2 id="add-recipe-title">レシピを追加</h2>
                <p>料理名、公開URL、手元のレシピ本文から追加できます。</p>
              </div>
            </div>

            <div className="input-kind-tabs" role="tablist" aria-label="レシピ入力方法">
              {(Object.keys(INPUT_KIND_DETAILS) as InputKind[]).map((kind) => (
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
                  <strong>{INPUT_KIND_DETAILS[kind].label}</strong>
                  <small>{INPUT_KIND_DETAILS[kind].description}</small>
                </button>
              ))}
            </div>

            <div className="field-group recipe-source-field">
              <Label htmlFor="recipe-source">
                {inputKind === "ai" ? "作りたい料理" : inputKind === "url" ? "公開レシピのURL" : "材料と手順"}
              </Label>
              <Textarea
                id="recipe-source"
                rows={inputKind === "text" ? 9 : 5}
                value={sourceInput}
                onChange={(event) => setSourceInput(event.target.value)}
                placeholder={
                  inputKind === "ai"
                    ? "例：春野菜を使った軽いパスタを4人分"
                    : inputKind === "url"
                      ? "https://example.com/recipe"
                      : "材料と手順をそのまま貼り付けてください"
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
              {adding ? "レシピを読み取っています" : inputKind === "url" ? "URLからレシピを追加" : "このレシピを追加"}
            </Button>
          </section>

          <section className="workflow-section recipe-collection" aria-labelledby="recipe-list-title">
            <div className="numbered-heading">
              <span>2</span>
              <div>
                <h2 id="recipe-list-title">材料と手順を確認</h2>
                <p>{recipes.data?.length ?? 0}品を追加済み。料理ごとに内容を確認、調整できます。</p>
              </div>
            </div>

            {recipes.isLoading && (
              <div className="list-loading" role="status">
                <LoaderCircle className="spin" />
                <span>追加したレシピを読み込んでいます</span>
              </div>
            )}
            {recipes.isError && (
              <div className="section-error" role="alert">
                <div><strong>レシピを読み込めませんでした</strong><span>{recipes.error.message}</span></div>
                <Button variant="secondary" onClick={() => void recipes.refetch()}>もう一度読み込む</Button>
              </div>
            )}
            {recipes.data?.length === 0 && (
              <div className="empty-state">
                <strong>レシピはまだありません</strong>
                <p>上の入力欄から、最初に作る料理を追加してください。</p>
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
                          <p>{recipe.servings}人分 · 材料{recipe.ingredients.length}点 · 約{totalMinutes}分</p>
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" aria-label={`${recipe.title}を削除`} onClick={() => void removeRecipe(recipe.id)}>
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
                      材料と手順
                      {expanded ? <ChevronUp /> : <ChevronDown />}
                    </button>

                    {expanded && (
                      <div className="recipe-detail-grid">
                        <div>
                          <h4>材料</h4>
                          <ul>{recipe.ingredients.map((ingredient) => <li key={`${ingredient.name}-${ingredient.quantity}`}><span>{ingredient.name}</span><strong>{ingredient.quantity}</strong></li>)}</ul>
                        </div>
                        <div>
                          <h4>手順</h4>
                          <ol>{recipe.instructions.map((instruction, instructionIndex) => <li key={`${instruction.title}-${instructionIndex}`}><span>{instructionIndex + 1}</span><div><strong>{instruction.title}</strong><p>{instruction.instruction}</p></div></li>)}</ol>
                        </div>
                      </div>
                    )}

                    {recipe.transformationHistory.length > 0 && (
                      <div className="transformation-history">
                        <strong>変更履歴</strong>
                        {recipe.transformationHistory.map((change, changeIndex) => (
                          <p key={`${change.instruction}-${changeIndex}`}>{change.summary}</p>
                        ))}
                      </div>
                    )}

                    <div className="recipe-transform-box">
                      <Label htmlFor={`transform-${recipe.id}`}>この料理を調整</Label>
                      <div className="transform-row">
                        <Input
                          id={`transform-${recipe.id}`}
                          value={transformInstructions[recipe.id] ?? ""}
                          onChange={(event) => setTransformInstructions((current) => ({ ...current, [recipe.id]: event.target.value }))}
                          placeholder="例：塩分を控えめにして、2人分に変更"
                        />
                        <Button
                          variant="secondary"
                          disabled={!transformInstructions[recipe.id]?.trim() || transformingId !== null}
                          onClick={() => void transformRecipe(recipe)}
                        >
                          {transformingId === recipe.id && <LoaderCircle className="spin" />}
                          {transformingId === recipe.id ? "変更中" : "変更を反映"}
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
                <h2 id="meal-settings-title">献立全体の条件</h2>
                <p>追加する料理と調理順の両方に反映します。</p>
              </div>
            </div>
            <div className="form-stack">
              <div className="field-group">
                <Label htmlFor="available-ingredients">使える食材 <span className="optional">任意</span></Label>
                <Textarea id="available-ingredients" rows={3} value={availableIngredients} onChange={(event) => setAvailableIngredients(event.target.value)} placeholder="春キャベツ、卵、豆腐" />
              </div>
              <div className="field-group">
                <Label htmlFor="dietary-constraints">食事制限 <span className="optional">任意</span></Label>
                <Textarea id="dietary-constraints" rows={2} value={dietaryConstraints} onChange={(event) => setDietaryConstraints(event.target.value)} placeholder="ヴィーガン、ナッツ不使用" />
              </div>
              <div className="field-group">
                <Label htmlFor="photo-notes">写真から分かったこと <span className="optional">任意</span></Label>
                <Textarea id="photo-notes" rows={2} value={photoNotes} onChange={(event) => setPhotoNotes(event.target.value)} placeholder="ほうれん草は半袋、トマトは完熟" />
              </div>
              <div className="field-group">
                <Label htmlFor="planning-notes">完成時刻や器具の条件 <span className="optional">任意</span></Label>
                <Textarea id="planning-notes" rows={3} value={planningNotes} onChange={(event) => setPlanningNotes(event.target.value)} placeholder="18時30分に食卓へ。コンロは2口。" />
              </div>
            </div>
          </section>

          <section className="compile-action" aria-labelledby="compile-title">
            <div>
              <h2 id="compile-title">調理順を作成</h2>
              <p>{recipes.data?.length ? `${recipes.data.length}品が同時に完成する順番を作成します。` : "レシピを1品以上追加すると作成できます。"}</p>
            </div>
            <Button
              size="lg"
              className="full-width"
              disabled={!recipes.data?.length || compiler.status === "loading" || transformingId !== null}
              onClick={() => void compileMeal()}
            >
              {compiler.status === "loading" ? <LoaderCircle className="spin" /> : null}
              {compiler.status === "loading" ? "調理順を作成しています" : "調理順を作成して確認へ"}
              {compiler.status !== "loading" && <ArrowRight />}
            </Button>
            <p className="approval-note">この操作ではまだ調理を開始しません。</p>
          </section>
        </aside>
      </div>

      <Button asChild variant="ghost"><a href={links.plans()}><ArrowLeft />献立一覧へ</a></Button>
    </section>
  );
}
