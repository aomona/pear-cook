import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { useState } from "react";
import { usePearContext } from "@pear-agent/react";
import { z } from "zod";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { buildCookingGoal } from "../../domain/plan";
import { pearConfig } from "../../pear.config";
import { links } from "../navigation";

const planListSchema = z.object({
  plans: z.array(
    z.object({
      id: z.string(),
      domainId: z.string(),
      status: z.enum(["draft", "ready", "archived"]),
      title: z.string().nullable(),
      version: z.number(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});

export function PlansPage() {
  const { client } = usePearContext();
  const [dish, setDish] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plans = useQuery({
    queryKey: ["plans", pearConfig.domainId],
    queryFn: async () => {
      const response = await fetch("/api/plans");
      if (!response.ok) throw new Error("通信状態を確認して、もう一度読み込んでください。");
      return planListSchema.parse(await response.json()).plans;
    },
  });

  async function createDraft() {
    const mealTitle = dish.trim();
    if (!mealTitle) return;
    setCreating(true);
    setError(null);
    try {
      const artifact = await client.createPlan({
        domainId: pearConfig.domainId,
        goal: buildCookingGoal(mealTitle),
        title: mealTitle,
      });
      window.location.hash = links.input(artifact.id).slice(1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="dashboard page-enter">
      <header className="page-heading dashboard-heading">
        <div>
          <span className="eyebrow">献立</span>
          <h1>何を作りますか？</h1>
          <p>献立名を決めたら、料理をレシピURL、テキスト、料理名から追加します。</p>
        </div>
      </header>

      <form
        className="new-plan-form"
        onSubmit={(event) => {
          event.preventDefault();
          void createDraft();
        }}
      >
        <div className="field-grow">
          <Label htmlFor="dish-name">新しい献立名</Label>
          <Input
            id="dish-name"
            value={dish}
            onChange={(event) => setDish(event.target.value)}
            placeholder="例：日曜の夕食"
            autoFocus
          />
        </div>
        <Button type="submit" size="lg" disabled={creating || !dish.trim()}>
          {creating ? <span className="button-spinner" /> : <Plus aria-hidden="true" />}
          {creating ? "献立を作成しています" : "この献立を作成"}
        </Button>
      </form>
      {error && (
        <div className="inline-error" role="alert">
          <strong>献立を作成できませんでした</strong>
          <span>{error}</span>
        </div>
      )}

      <section className="plan-library" aria-labelledby="plan-library-title">
        <div className="section-heading">
          <div>
            <h2 id="plan-library-title">保存した献立</h2>
            <p>編集中の献立は続きから、承認済みの献立は調理順の確認から開きます。</p>
          </div>
        </div>

        <div aria-live="polite">
          {plans.isLoading && (
            <div className="list-loading" role="status">
              <span className="button-spinner" />
              <span>献立を読み込んでいます</span>
            </div>
          )}
          {plans.isError && (
            <div className="section-error" role="alert">
              <div><strong>献立を読み込めませんでした</strong><span>{plans.error.message}</span></div>
              <Button variant="secondary" onClick={() => void plans.refetch()}>もう一度読み込む</Button>
            </div>
          )}
          {plans.data?.length === 0 && (
            <div className="empty-state">
              <strong>保存した献立はありません</strong>
              <p>上の入力欄に献立名を入れて、最初の献立を作成してください。</p>
            </div>
          )}
          {plans.data && plans.data.length > 0 && (
            <ol className="plan-list">
              {plans.data.map((plan) => (
                <li key={plan.id}>
                  <a href={plan.status === "ready" ? links.plan(plan.id) : links.input(plan.id)}>
                    <div className="plan-list-main">
                      <Badge variant={plan.status === "ready" ? "success" : "outline"}>
                        {plan.status === "ready" ? "承認済み" : plan.status === "archived" ? "保管済み" : "編集中"}
                      </Badge>
                      <strong>{plan.title || "名称未設定の献立"}</strong>
                      <span>
                        {new Date(plan.updatedAt).toLocaleDateString("ja-JP")} 更新 · バージョン {plan.version}
                      </span>
                    </div>
                    <span className="plan-list-action">
                      {plan.status === "ready" ? "調理順を確認" : "レシピを編集"}
                      <ArrowRight aria-hidden="true" />
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </section>
  );
}
