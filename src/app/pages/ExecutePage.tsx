import type { VoiceTranscriptEntry } from "@pear-agent/core";
import { useExecutionSession, useRuntimeSnapshot, useVoiceSession } from "@pear-agent/react";
import {
  ArrowLeft,
  Check,
  Circle,
  Clock3,
  GitMerge,
  AudioLines,
  LoaderCircle,
  Mic,
  MicOff,
  PhoneOff,
  Play,
  RotateCcw,
} from "lucide-react";

import { Button } from "../../components/ui/button";
import { cookingStepDataSchema } from "../../domain/domain";
import { links } from "../navigation";

function collapseTranscript(entries: readonly VoiceTranscriptEntry[]): VoiceTranscriptEntry[] {
  const collapsed: VoiceTranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.role === "status") continue;
    const previous = collapsed.at(-1);
    if (previous?.role === entry.role) {
      previous.text += entry.text;
    } else {
      collapsed.push({ ...entry });
    }
  }
  return collapsed;
}
function latestAssistantEntry(entries: readonly VoiceTranscriptEntry[]): VoiceTranscriptEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.role === "assistant") return entries[index];
  }
  return undefined;
}


export function ExecutePage({ sessionId }: { sessionId: string }) {
  const actions = useExecutionSession(sessionId);
  const runtime = useRuntimeSnapshot(sessionId);
  const voice = useVoiceSession(sessionId, {
    openingText: "現在の調理状況を確認して、次に行う作業を料理名から短く案内してください。",
  });

  const voiceActive = ["connected", "muted", "recovering"].includes(voice.status);
  const voiceStatusLabel: Record<typeof voice.status, string> = {
    idle: "未接続",
    disconnected: "未接続",
    connecting: "接続中",
    connected: "会話中",
    muted: "ミュート中",
    recovering: "再接続中",
    error: "接続エラー",
  };
  const recentTranscript = collapseTranscript(voice.transcript).slice(-6);

  async function connectVoice() {
    voice.clearError();
    try {
      await voice.connect();
    } catch {
      // The hook exposes the actionable connection error.
    }
  }


  async function updateStep(stepId: string, status: string) {
    if (status === "ready" || status === "paused") await actions.startStep({ stepId });
    else if (status === "active") await actions.completeStep({ stepId });
    await runtime.refetch();
  }

  if (runtime.status === "loading" || !runtime.snapshot) {
    return <div className="center-state"><LoaderCircle className="spin" />全レシピの進行を準備しています…</div>;
  }
  if (runtime.error) return <p className="form-error">調理セッションを読み込めませんでした: {runtime.error.message}</p>;

  const { plan, stepStates } = runtime.snapshot;
  const completed = Object.values(stepStates).filter(({ status }) => status === "completed").length;
  const progress = plan.steps.length ? (completed / plan.steps.length) * 100 : 0;
  const parsedSteps = plan.steps.map((step) => {
    const parsed = cookingStepDataSchema.safeParse(step.domainData);
    return { step, timing: parsed.success ? parsed.data : null, status: stepStates[step.id]?.status ?? "blocked" };
  });
  const actionableSteps = parsedSteps
    .filter(({ status }) => ["ready", "active", "paused"].includes(status))
    .sort((left, right) => {
      if (left.status === "active" && right.status !== "active") return -1;
      if (right.status === "active" && left.status !== "active") return 1;
      return (right.timing?.startOffsetSeconds ?? 0) - (left.timing?.startOffsetSeconds ?? 0);
    });
  const activeSteps = actionableSteps.filter(({ status }) => status === "active");
  const activeWorkSteps = activeSteps.filter(({ timing }) => timing?.kind !== "wait");
  const waitingSteps = activeSteps.filter(({ timing }) => timing?.kind === "wait");
  const startableSteps = actionableSteps.filter(({ status, timing }) => status !== "active" && timing?.kind !== "wait");
  const nowSteps = activeWorkSteps.length > 0
    ? activeWorkSteps
    : startableSteps.length > 0
      ? startableSteps.slice(0, 1)
      : waitingSteps.slice(0, 1);
  const dependencyStepIds = new Set((activeSteps.length > 0 ? activeSteps : nowSteps).map(({ step }) => step.id));
  const parallelSteps = activeSteps.length > 0 ? startableSteps : startableSteps.slice(1);
  const nextSteps = parsedSteps
    .filter(({ step, status }) => status === "blocked" && step.after.some((dependency) => dependencyStepIds.has(dependency)))
    .slice(0, 3);
  const latestAssistantMessage = latestAssistantEntry(recentTranscript);

  return (
    <section className="cook-page live-cook-page page-enter">
      <header className="live-cook-header">
        <div>
          <span className="eyebrow">3 / 3　調理中</span>
          <h1>{plan.title || "同時調理プラン"}</h1>
        </div>
        <div className="cook-progress" aria-label={`${Math.round(progress)} percent complete`}>
          <span><strong>{completed}</strong> / {plan.steps.length}</span>
          <i><b style={{ width: `${progress}%` }} /></i>
        </div>
      </header>

      <section className={`live-command-panel voice-${voice.status}`} aria-labelledby="live-guidance-title">
        <div className="live-command-content">
          <div className="live-command-status">
            <AudioLines className="live-status-icon" aria-hidden="true" />
            <div>
              <div className="voice-guide-label">
                Gemini Live
                <span className="voice-status"><i />{voiceStatusLabel[voice.status]}</span>
              </div>
              <h2 id="live-guidance-title">
                {voiceActive
                  ? latestAssistantMessage?.text || "話しかけてください。いまの状況から次の一手を案内します。"
                  : "音声ガイドと一緒に調理を始める"}
              </h2>
              <p>
                {voiceActive
                  ? "「次は？」「タイマーをかけて」「終わった」と、そのまま話せます。"
                  : "最初に一度だけマイクを接続します。以降は画面を触らなくても進められます。"}
              </p>
            </div>
          </div>
          <div className="voice-guide-actions">
            {!voiceActive && voice.status !== "connecting" ? (
              <Button size="lg" className="start-live-button" onClick={() => void connectVoice()}>
                <Mic />Gemini Liveを開始
              </Button>
            ) : (
              <>
                <Button
                  size="lg"
                  variant="secondary"
                  disabled={voice.status === "connecting" || voice.status === "recovering"}
                  onClick={() => voice.status === "muted" ? voice.unmute() : voice.mute()}
                >
                  {voice.status === "muted" ? <Mic /> : <MicOff />}
                  {voice.status === "muted" ? "マイクを再開" : "ミュート"}
                </Button>
                <Button
                  size="lg"
                  variant="ghost"
                  disabled={voice.status === "connecting"}
                  onClick={() => void voice.disconnect()}
                >
                  <PhoneOff />音声だけ終了
                </Button>
              </>
            )}
          </div>
          {voice.status === "connecting" && (
            <div className="voice-connecting"><LoaderCircle className="spin" />現在の調理状況をGeminiに渡しています…</div>
          )}
          {voice.error && (
            <p className="form-error voice-error" role="alert">
              音声ガイドを開始できませんでした: {voice.error.message}
            </p>
          )}
          {recentTranscript.length > 0 && (
            <details className="voice-history">
              <summary>会話履歴を見る</summary>
              <div className="voice-transcript" role="log" aria-live="polite" aria-label="音声会話">
                {recentTranscript.map((entry, index) => (
                  <p key={`${entry.role}-${index}`} className={`voice-line voice-line-${entry.role}`}>
                    <strong>{entry.role === "user" ? "あなた" : entry.role === "assistant" ? "Gemini" : "操作"}</strong>
                    <span>{entry.text}</span>
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      </section>

      <section className="now-section" aria-labelledby="now-heading">
        <div className="action-section-heading">
          <span className="action-number">現在</span>
          <div>
            <h2 id="now-heading">いまやること</h2>
            <p>{nowSteps.length > 1 ? `${nowSteps.length}つの作業が進行中です` : "この作業だけ見れば大丈夫です"}</p>
          </div>
        </div>

        {nowSteps.length > 0 ? (
          <div className={`now-task-list ${nowSteps.length > 1 ? "has-multiple" : ""}`}>
            {nowSteps.map(({ step, timing, status }, index) => (
              <article className={`now-task-card station-${status}`} key={step.id}>
                <header>
                  <div className="station-topline">
                    <span className="recipe-name">{timing?.recipeTitle || "仕上げ"}</span>
                    <span>{status === "active" ? "進行中" : "開始できます"}</span>
                  </div>
                  <span className="now-task-index">{String(index + 1).padStart(2, "0")}</span>
                  <h3>{timing?.kind === "wait" ? `${timing.recipeTitle}はまだ始めない` : step.label || step.id}</h3>
                </header>
                <div className="now-task-content">
                  <p className="now-instruction">
                    {timing?.kind === "wait"
                      ? `あと約${Math.ceil(step.estimatedDurationSeconds / 60)}分待ってから始めます。いまはほかの料理を進めてください。`
                      : step.instructions}
                  </p>
                  <div className="station-meta">
                    <span><Clock3 />約{Math.ceil(step.estimatedDurationSeconds / 60)}分</span>
                    {timing?.temperature && <span>{timing.temperature}</span>}
                    {timing?.equipment.map((equipment) => <span key={equipment}>{equipment}</span>)}
                  </div>
                  <Button
                    size="lg"
                    variant={voiceActive ? "default" : "secondary"}
                    className="now-action-button full-width"
                    disabled={actions.status === "loading"}
                    onClick={() => void updateStep(step.id, status)}
                  >
                    {actions.status === "loading" ? <LoaderCircle className="spin" /> : status === "active" ? <Check /> : <Play />}
                    {status === "active" ? timing?.kind === "wait" ? "待ち時間が終わった" : "できた" : "この作業を始める"}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state meal-complete-state">
            <h2>すべての料理が完成しました</h2>
            <p>火の通りと味を確認し、温かいうちに食卓へ運びましょう。</p>
          </div>
        )}
        {actions.error && <div className="inline-error" role="alert"><strong>進行状況を更新できませんでした</strong><span>{actions.error.message}</span><Button variant="secondary" onClick={() => void runtime.refetch()}>現在の状態を再読み込み</Button></div>}
      </section>

      {(nextSteps.length > 0 || parallelSteps.length > 0 || waitingSteps.some(({ step }) => !nowSteps.some(({ step: current }) => current.id === step.id))) && (
        <section className="coming-up-section" aria-labelledby="next-heading">
          <div className="action-section-heading compact">
            <span className="action-number">次</span>
            <div>
              <h2 id="next-heading">この次</h2>
              <p>いまは読むだけ。まだ始めなくて大丈夫です。</p>
            </div>
          </div>
          <div className="coming-up-list">
            {nextSteps.map(({ step, timing }) => (
              <div className="coming-up-card" key={step.id}>
                <span>{timing?.recipeTitle || "仕上げ"}</span>
                <strong>{step.label || step.id}</strong>
                <small><Clock3 />約{Math.ceil(step.estimatedDurationSeconds / 60)}分</small>
              </div>
            ))}
            {waitingSteps
              .filter(({ step }) => !nowSteps.some(({ step: current }) => current.id === step.id))
              .map(({ step, timing }) => (
                <div className="waiting-option" key={step.id}>
                  <Clock3 />
                  <div>
                    <span>いまは待つ</span>
                    <strong>{timing?.recipeTitle}は約{Math.ceil(step.estimatedDurationSeconds / 60)}分後から</strong>
                  </div>
                </div>
              ))}
            {parallelSteps.length > 0 && (
              <div className="parallel-option">
                <GitMerge />
                <div>
                  <span>余裕があれば同時に</span>
                  <strong>{parallelSteps.map(({ step }) => step.label || step.id).join("・")}</strong>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      <details className="plan-drawer">
        <summary>
          <span><strong>全体の流れ</strong><small>{completed} / {plan.steps.length} 完了</small></span>
          <button
            type="button"
            className="drawer-refresh"
            aria-label="最新の進行状況を取得"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void runtime.refetch();
            }}
          >
            <RotateCcw />
          </button>
        </summary>
        <ol>
          {parsedSteps.map(({ step, timing, status }, index) => (
            <li key={step.id} className={status === "active" ? "run-active" : ""}>
              <span className={`run-status run-${status}`}>
                {status === "completed" ? <Check /> : status === "active" ? <Play /> : <Circle />}
              </span>
              <div>
                <small>{timing?.recipeTitle || "仕上げ"}</small>
                <strong>{index + 1}. {step.label || step.id}</strong>
                <span>
                  {status === "completed" ? "完了" : status === "active" ? "進行中" : status === "ready" ? "開始可能" : "このあと"}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </details>

      <Button asChild variant="ghost" className="back-to-plans"><a href={links.plans()}><ArrowLeft />献立一覧へ</a></Button>
    </section>
  );
}
