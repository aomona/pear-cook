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
import { useI18n } from "../i18n";
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
  const { locale, messages, format } = useI18n();
  const runtime = useRuntimeSnapshot(sessionId);
  const voice = useVoiceSession(sessionId, {
    openingText: messages.execute.openingText,
  });

  const voiceActive = ["connected", "muted", "recovering"].includes(voice.status);
  const voiceStatusLabel: Record<typeof voice.status, string> = {
    idle: messages.execute.disconnected,
    disconnected: messages.execute.disconnected,
    connecting: messages.execute.connecting,
    connected: messages.execute.connected,
    muted: messages.execute.muted,
    recovering: messages.execute.recovering,
    error: messages.execute.connectionError,
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
    return <div className="center-state"><LoaderCircle className="spin" />{messages.execute.loading}</div>;
  }
  if (runtime.error) return <p className="form-error">{format(messages.execute.loadError, { message: runtime.error.message })}</p>;

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
          <span className="eyebrow">{messages.execute.eyebrow}</span>
          <h1>{plan.title || messages.execute.fallbackTitle}</h1>
        </div>
        <div className="cook-progress" aria-label={format(messages.execute.progress, { count: Math.round(progress) })}>
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
                  ? latestAssistantMessage?.text || messages.execute.prompt
                  : messages.execute.voiceTitle}
              </h2>
              <p>
                {voiceActive
                  ? messages.execute.voiceActiveDescription
                  : messages.execute.voiceDescription}
              </p>
            </div>
          </div>
          <div className="voice-guide-actions">
            {!voiceActive && voice.status !== "connecting" ? (
              <Button size="lg" className="start-live-button" onClick={() => void connectVoice()}>
                <Mic />{messages.execute.startVoice}
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
                  {voice.status === "muted" ? messages.execute.unmute : messages.execute.mute}
                </Button>
                <Button
                  size="lg"
                  variant="ghost"
                  disabled={voice.status === "connecting"}
                  onClick={() => void voice.disconnect()}
                >
                  <PhoneOff />{messages.execute.stopVoice}
                </Button>
              </>
            )}
          </div>
          {voice.status === "connecting" && (
            <div className="voice-connecting"><LoaderCircle className="spin" />{messages.execute.voiceConnecting}</div>
          )}
          {voice.error && (
            <p className="form-error voice-error" role="alert">
              {format(messages.execute.voiceError, { message: voice.error.message })}
            </p>
          )}
          {recentTranscript.length > 0 && (
            <details className="voice-history">
              <summary>{messages.execute.showTranscript}</summary>
              <div className="voice-transcript" role="log" aria-live="polite" aria-label={messages.execute.transcriptLabel}>
                {recentTranscript.map((entry, index) => (
                  <p key={`${entry.role}-${index}`} className={`voice-line voice-line-${entry.role}`}>
                    <strong>{entry.role === "user" ? messages.execute.user : entry.role === "assistant" ? messages.execute.assistant : messages.execute.tool}</strong>
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
          <span className="action-number">{messages.execute.current}</span>
          <div>
            <h2 id="now-heading">{messages.execute.nowTitle}</h2>
            <p>{nowSteps.length > 1 ? format(messages.execute.nowMultiple, { count: nowSteps.length }) : messages.execute.nowSingle}</p>
          </div>
        </div>

        {nowSteps.length > 0 ? (
          <div className={`now-task-list ${nowSteps.length > 1 ? "has-multiple" : ""}`}>
            {nowSteps.map(({ step, timing, status }, index) => (
              <article className={`now-task-card station-${status}`} key={step.id}>
                <header>
                  <div className="station-topline">
                    <span className="recipe-name">{timing?.recipeTitle || messages.common.finish}</span>
                    <span>{status === "active" ? messages.execute.active : messages.execute.ready}</span>
                  </div>
                  <span className="now-task-index">{String(index + 1).padStart(2, "0")}</span>
                  <h3>{timing?.kind === "wait" ? format(messages.execute.waitTitle, { title: timing.recipeTitle }) : step.label || step.id}</h3>
                </header>
                <div className="now-task-content">
                  <p className="now-instruction">
                    {timing?.kind === "wait"
                      ? format(messages.execute.waitInstruction, { count: Math.ceil(step.estimatedDurationSeconds / 60) })
                      : step.instructions}
                  </p>
                  <div className="station-meta">
                    <span><Clock3 />{format(messages.common.minutes, { count: Math.ceil(step.estimatedDurationSeconds / 60) })}</span>
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
                    {status === "active" ? timing?.kind === "wait" ? messages.execute.waitDone : messages.execute.done : messages.execute.startTask}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state meal-complete-state">
            <h2>{messages.execute.completeTitle}</h2>
            <p>{messages.execute.completeDescription}</p>
          </div>
        )}
        {actions.error && <div className="inline-error" role="alert"><strong>{messages.execute.updateError}</strong><span>{actions.error.message}</span><Button variant="secondary" onClick={() => void runtime.refetch()}>{messages.execute.reloadState}</Button></div>}
      </section>

      {(nextSteps.length > 0 || parallelSteps.length > 0 || waitingSteps.some(({ step }) => !nowSteps.some(({ step: current }) => current.id === step.id))) && (
        <section className="coming-up-section" aria-labelledby="next-heading">
          <div className="action-section-heading compact">
            <span className="action-number">{messages.execute.next}</span>
            <div>
              <h2 id="next-heading">{messages.execute.nextTitle}</h2>
              <p>{messages.execute.nextDescription}</p>
            </div>
          </div>
          <div className="coming-up-list">
            {nextSteps.map(({ step, timing }) => (
              <div className="coming-up-card" key={step.id}>
                <span>{timing?.recipeTitle || messages.common.finish}</span>
                <strong>{step.label || step.id}</strong>
                <small><Clock3 />{format(messages.common.minutes, { count: Math.ceil(step.estimatedDurationSeconds / 60) })}</small>
              </div>
            ))}
            {waitingSteps
              .filter(({ step }) => !nowSteps.some(({ step: current }) => current.id === step.id))
              .map(({ step, timing }) => (
                <div className="waiting-option" key={step.id}>
                  <Clock3 />
                  <div>
                    <span>{messages.execute.waitNow}</span>
                    <strong>{format(messages.execute.startsAfter, { title: timing?.recipeTitle || messages.common.finish, count: Math.ceil(step.estimatedDurationSeconds / 60) })}</strong>
                  </div>
                </div>
              ))}
            {parallelSteps.length > 0 && (
              <div className="parallel-option">
                <GitMerge />
                <div>
                  <span>{messages.execute.parallel}</span>
                  <strong>{parallelSteps.map(({ step }) => step.label || step.id).join(locale === "ja" ? "・" : ", ")}</strong>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      <details className="plan-drawer">
        <summary>
          <span><strong>{messages.execute.overview}</strong><small>{format(messages.execute.completed, { done: completed, total: plan.steps.length })}</small></span>
          <button
            type="button"
            className="drawer-refresh"
            aria-label={messages.execute.refresh}
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
                <small>{timing?.recipeTitle || messages.common.finish}</small>
                <strong>{index + 1}. {step.label || step.id}</strong>
                <span>
                  {status === "completed" ? messages.execute.statusCompleted : status === "active" ? messages.execute.statusActive : status === "ready" ? messages.execute.statusReady : messages.execute.statusLater}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </details>

      <Button asChild variant="ghost" className="back-to-plans"><a href={links.plans()}><ArrowLeft />{messages.common.backToPlans}</a></Button>
    </section>
  );
}
