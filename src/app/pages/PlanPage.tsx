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
import { links } from "../navigation";

export function PlanPage({ planId }: { planId: string }) {
  const { client } = usePearContext();
  const { user } = useAuth();
  const session = useExecutionSession();
  const artifact = useQuery({ queryKey: ["plan", planId], queryFn: () => client.getPlan(planId) });
  const [reviewed, setReviewed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  }

  if (artifact.isLoading) return <div className="center-state" role="status"><LoaderCircle className="spin" />調理順を読み込んでいます</div>;
  if (artifact.isError) return (
    <div className="page-state" role="alert">
      <strong>この献立を開けませんでした</strong>
      <p>アクセス権限または通信状態を確認して、もう一度お試しください。</p>
      <div><Button variant="secondary" onClick={() => void artifact.refetch()}>もう一度読み込む</Button><Button asChild variant="ghost"><a href={links.plans()}>献立一覧へ</a></Button></div>
    </div>
  );
  if (!artifact.data) return <div className="page-state"><strong>献立が見つかりません</strong><p>削除されたか、アクセスできない献立です。</p><Button asChild><a href={links.plans()}>献立一覧へ戻る</a></Button></div>;

  const normalized = cookingNormalizedInputSchema.safeParse(artifact.data.normalizedInput);
  if (!normalized.success) {
    return (
      <div className="page-state">
        <strong>調理順がまだ作成されていません</strong>
        <p>レシピ画面で料理を追加し、「調理順を作成して確認へ」を選んでください。</p>
        <Button asChild><a href={links.input(planId)}>レシピ画面へ戻る</a></Button>
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
        <span className="eyebrow">2 / 3　調理順の確認</span>
        <h1>{normalized.data.mealTitle}</h1>
        <p>開始時刻と並行作業を確認してください。承認するまで調理セッションは作成されません。</p>
        <div className="plan-summary-line">
          <span><strong>{normalized.data.recipes.length}</strong>品</span>
          <span>最初の作業は完成の<strong>{Math.ceil(maxOffset / 60)}</strong>分前</span>
          <span>全<strong>{scheduledSteps.length}</strong>工程</span>
        </div>
      </header>

      <section className="finish-line" aria-labelledby="finish-line-title">
        <span>T−0</span>
        <div>
          <h2 id="finish-line-title">すべての料理を同時に食卓へ</h2>
          <p>T−10なら、完成予定の10分前に始める作業です。</p>
        </div>
      </section>

      {scheduledSteps.length === 0 ? (
        <div className="empty-state">
          <strong>確認できる工程がありません</strong>
          <p>レシピ画面へ戻り、調理順を作り直してください。</p>
          <Button asChild><a href={links.input(planId)}>レシピ画面へ戻る</a></Button>
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
                    <p>{recipe.servings}人分 · {laneSteps.length}工程</p>
                  </div>
                  {recipe.transformationHistory.length > 0 && <span className="plain-status">調整済み</span>}
                </header>
                <ol>
                  {laneSteps.map(({ step, timing }) => {
                    const isWait = timing.kind === "wait";
                    return (
                      <li key={step.id} className={`timing-step timing-${timing.kind}`}>
                        <div className="timing-marker"><strong>T−{Math.ceil(timing.startOffsetSeconds / 60)}</strong><span>分</span></div>
                        <div className="timing-step-body">
                          <div className="timing-step-topline">
                            <span>{isWait ? "待機" : timing.kind === "serve" ? "仕上げ" : "調理"}</span>
                            <span><Clock3 />約{Math.ceil(step.estimatedDurationSeconds / 60)}分</span>
                          </div>
                          <h3>{isWait ? `${recipe.title}はまだ始めない` : step.label || step.id}</h3>
                          <p>
                            {isWait
                              ? `ほかの料理を先に進め、約${Math.ceil(step.estimatedDurationSeconds / 60)}分後に始めます。`
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
            <h2>すべての料理を仕上げる</h2>
            <p>{step.instructions}</p>
          </div>
        </section>
      ))}

      <section className="approval-panel" aria-labelledby="approval-title">
        <div className="approval-copy">
          <span className="plain-status">承認が必要です</span>
          <h2 id="approval-title">この調理順で始めますか？</h2>
          <p>変更が必要な場合はレシピ画面へ戻って調整し、もう一度調理順を作成してください。</p>
        </div>
        <Label className="approval-check">
          <Checkbox checked={reviewed} onCheckedChange={(checked) => setReviewed(checked === true)} />
          <span>料理、開始時刻、並行作業を確認しました。</span>
        </Label>
        <div className="approval-actions">
          <Button asChild variant="secondary"><a href={links.input(planId)}><ArrowLeft />レシピを調整</a></Button>
          <Button size="lg" disabled={!reviewed || starting} onClick={() => void approveAndStart()}>
            {starting ? <LoaderCircle className="spin" /> : <Play />}
            {starting ? "調理セッションを開始しています" : "承認して調理を開始"}
          </Button>
        </div>
      </section>

      {error && (
        <div className="inline-error" role="alert">
          <strong>調理を開始できませんでした</strong>
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}
