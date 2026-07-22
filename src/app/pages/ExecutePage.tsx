import type { MaterializedExecutionState, PlanChange, TimerDefinition, VoiceTranscriptEntry } from "@pear-agent/core";
import { useExecutionSession, useRuntimeSnapshot, useVoiceSession } from "@pear-agent/react";
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  Check,
  Circle,
  Clock3,
  Contrast,
  Eye,
  EyeOff,
  GitMerge,
  LoaderCircle,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  TimerReset,
  Undo2,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { cookingStepDataSchema } from "../../domain/domain";
import { executionCopy } from "../execution-copy";
import { useI18n } from "../i18n";
import { links } from "../navigation";
import { getSafeStorageItem, setSafeStorageItem } from "../safe-storage";

type PendingCompletion = { deadline: number; idempotencyKey: string };
type Feedback = {
  recipeId: string;
  rating: number;
  difficulty: "easy" | "expected" | "hard";
  estimatedSeconds: number;
  actualSeconds: number;
  notes: string;
};
type FeedbackDraft = {
  rating: number;
  difficulty: "easy" | "expected" | "hard";
  actualMinutes: number;
  notes: string;
};
type FactType = "substitution" | "delay" | "equipment" | "doneness";
type NotificationState = "default" | "granted" | "denied" | "unsupported";

function collapseTranscript(entries: readonly VoiceTranscriptEntry[]): VoiceTranscriptEntry[] {
  const collapsed: VoiceTranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.role === "status") continue;
    const previous = collapsed.at(-1);
    if (previous?.role === entry.role) previous.text += entry.text;
    else collapsed.push({ ...entry });
  }
  return collapsed;
}

function loadPending(sessionId: string): Record<string, PendingCompletion> {
  try {
    const parsed = JSON.parse(getSafeStorageItem(`pear-cook:pending:${sessionId}`) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, PendingCompletion] => {
        const value = entry[1] as Partial<PendingCompletion>;
        return typeof value.deadline === "number" && typeof value.idempotencyKey === "string";
      }),
    );
  } catch {
    return {};
  }
}

function beep() {
  try {
    const AudioContextConstructor = window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.18, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.8);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.8);
    oscillator.addEventListener("ended", () => void context.close(), { once: true });
  } catch {
    // Audible alerts are best effort; the visible alert remains authoritative.
  }
}

function remainingSeconds(timer: { status: string; remainingSeconds: number; endsAt?: Date }, now: number) {
  if (timer.status !== "running" || !timer.endsAt) return Math.max(0, timer.remainingSeconds);
  return Math.max(0, Math.ceil((timer.endsAt.getTime() - now) / 1_000));
}

function formatClock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function ExecutePage({ sessionId }: { sessionId: string }) {
  const actions = useExecutionSession(sessionId);
  const runtime = useRuntimeSnapshot(sessionId);
  const { locale, messages, format } = useI18n();
  const copy = executionCopy[locale];
  const voice = useVoiceSession(sessionId, { openingText: messages.execute.openingText });
  const [now, setNow] = useState(Date.now());
  const [announcement, setAnnouncement] = useState("");
  const [pending, setPending] = useState<Record<string, PendingCompletion>>(() => loadPending(sessionId));
  const [committing, setCommitting] = useState<Set<string>>(() => new Set());
  const [textSize, setTextSize] = useState(() => getSafeStorageItem("pear-cook:text-size") ?? "100");
  const [highContrast, setHighContrast] = useState(() => getSafeStorageItem("pear-cook:contrast") === "true");
  const [focusMode, setFocusMode] = useState(() => getSafeStorageItem("pear-cook:focus") === "true");
  const [notificationState, setNotificationState] = useState<NotificationState>(() => {
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission;
  });
  const [wakeLock, setWakeLock] = useState<WakeLockSentinel | null>(null);
  const [wakeUnsupported, setWakeUnsupported] = useState(false);
  const [voicePermission, setVoicePermission] = useState<PermissionState | "unknown">("unknown");
  const [factType, setFactType] = useState<FactType>("substitution");
  const [factRecipeId, setFactRecipeId] = useState("");
  const [factA, setFactA] = useState("");
  const [factB, setFactB] = useState("");
  const [replanChange, setReplanChange] = useState<PlanChange | null>(null);
  const [replanState, setReplanState] = useState<"idle" | "loading" | "pending" | "applied" | "failed">("idle");
  const [replanError, setReplanError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, FeedbackDraft>>({});
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackLoaded, setFeedbackLoaded] = useState(false);
  const [feedbackAttempt, setFeedbackAttempt] = useState(0);
  const [timerStates, setTimerStates] = useState<MaterializedExecutionState["timers"]>({});
  const autoTimerRequests = useRef(new Set<string>());
  const notificationTimeouts = useRef(new Map<string, number>());
  const notifiedTimers = useRef(new Set<string>());
  const hadVoiceConnection = useRef(false);

  const snapshot = runtime.snapshot;
  const plan = snapshot?.plan;
  const stepStates = snapshot?.stepStates ?? {};
  const timers = timerStates;

  const parsedSteps = useMemo(
    () =>
      (plan?.steps ?? []).map((step) => {
        const parsed = cookingStepDataSchema.safeParse(step.domainData);
        return {
          step,
          timing: parsed.success ? parsed.data : null,
          status: stepStates[step.id]?.status ?? "blocked",
        };
      }),
    [plan, stepStates],
  );
  const recipeOptions = useMemo(() => {
    const recipes = new Map<string, string>();
    for (const { timing } of parsedSteps) {
      if (timing && timing.recipeId !== "shared") recipes.set(timing.recipeId, timing.recipeTitle);
    }
    return [...recipes.entries()].map(([id, title]) => ({ id, title }));
  }, [parsedSteps]);
  const allFinished = parsedSteps.length > 0 && parsedSteps.every(({ status }) =>
    status === "completed" || status === "skipped",
  );

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setSafeStorageItem(`pear-cook:pending:${sessionId}`, JSON.stringify(pending));
  }, [pending, sessionId]);
  useEffect(() => setSafeStorageItem("pear-cook:text-size", textSize), [textSize]);
  useEffect(() => setSafeStorageItem("pear-cook:contrast", String(highContrast)), [highContrast]);
  useEffect(() => setSafeStorageItem("pear-cook:focus", String(focusMode)), [focusMode]);
  useEffect(() => {
    document.body.classList.toggle("focus-cooking-active", focusMode);
    return () => document.body.classList.remove("focus-cooking-active");
  }, [focusMode]);
  useEffect(() => {
    if (!focusMode) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocusMode(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [focusMode]);

  useEffect(() => {
    if (!navigator.permissions?.query) return;
    let active = true;
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((status) => {
        if (!active) return;
        setVoicePermission(status.state);
        status.addEventListener("change", () => setVoicePermission(status.state));
      })
      .catch(() => setVoicePermission("unknown"));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (["connected", "muted", "recovering"].includes(voice.status)) hadVoiceConnection.current = true;
    if (voice.status === "recovering") setAnnouncement(messages.execute.recovering);
    if (voice.status === "error") setAnnouncement(copy.voiceInterrupted);
  }, [copy.voiceInterrupted, messages.execute.recovering, voice.status]);

  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    void actions.client
      .getSession(sessionId)
      .then((state) => {
        if (!cancelled) setTimerStates(state.timers);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [actions.client, runtime.revision, sessionId, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    void actions.client
      .getLatestPlanChange(sessionId)
      .then((change) => {
        if (cancelled || !change) return;
        if (change.status === "applied" && snapshot.session.status !== "paused") {
          setReplanChange((current) => current?.patch.id === change.patch.id ? null : current);
          return;
        }
        setReplanChange(change);
        setReplanState(change.status === "applied" ? "applied" : "pending");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [actions.client, runtime.revision, sessionId, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    const startMissingTimers = async () => {
      let started = false;
      for (const { step, status } of parsedSteps) {
        if (status !== "active") continue;
        for (const definition of (step.timers ?? []) as TimerDefinition[]) {
          if (!definition.autoStart || timers[definition.id] || autoTimerRequests.current.has(definition.id)) continue;
          autoTimerRequests.current.add(definition.id);
          try {
            await actions.startTimer({
              timerId: definition.id,
              durationSeconds: definition.durationSeconds,
              idempotencyKey: `auto-timer:${step.id}:${definition.id}`,
            });
            started = true;
          } catch {
            autoTimerRequests.current.delete(definition.id);
          }
          if (cancelled) return;
        }
      }
      if (started) await runtime.refetch();
    };
    void startMissingTimers();
    return () => {
      cancelled = true;
    };
  }, [parsedSteps, timers]);

  useEffect(() => {
    for (const timeout of notificationTimeouts.current.values()) window.clearTimeout(timeout);
    notificationTimeouts.current.clear();
    if (!snapshot) return;
    for (const timer of Object.values(timers)) {
      if (timer.status !== "running" || !timer.endsAt) continue;
      const key = `${timer.id}:${timer.endsAt.toISOString()}`;
      const fire = () => {
        if (notifiedTimers.current.has(key)) return;
        notifiedTimers.current.add(key);
        beep();
        setAnnouncement(`${copy.timers}: ${copy.completed}`);
        if (notificationState === "granted") {
          new Notification(plan?.title || "PEAR Cook", { body: `${copy.timers}: ${copy.completed}`, tag: key });
        }
        void actions
          .completeTimer({ timerId: timer.id, idempotencyKey: `timer-expired:${key}` })
          .then(() => runtime.refetch())
          .catch(() => {});
      };
      const delay = timer.endsAt.getTime() - Date.now();
      if (delay <= 0) fire();
      else notificationTimeouts.current.set(timer.id, window.setTimeout(fire, delay));
    }
    return () => {
      for (const timeout of notificationTimeouts.current.values()) window.clearTimeout(timeout);
      notificationTimeouts.current.clear();
    };
  }, [copy.completed, copy.timers, notificationState, plan?.title, timers]);

  const commitStep = useCallback(
    async (stepId: string, item: PendingCompletion) => {
      if (committing.has(stepId)) return;
      setCommitting((current) => new Set(current).add(stepId));
      try {
        await actions.completeStep({ stepId, idempotencyKey: item.idempotencyKey });
        setPending((current) => {
          const next = { ...current };
          delete next[stepId];
          return next;
        });
        setAnnouncement(copy.undoCommitted);
        await runtime.refetch();
      } catch {
        setAnnouncement(copy.operationError);
      } finally {
        setCommitting((current) => {
          const next = new Set(current);
          next.delete(stepId);
          return next;
        });
      }
    },
    [actions, committing, copy.operationError, copy.undoCommitted, runtime],
  );

  useEffect(() => {
    for (const [stepId, item] of Object.entries(pending)) {
      if (item.deadline <= now && stepStates[stepId]?.status === "active") void commitStep(stepId, item);
      if (stepStates[stepId]?.status === "completed" || stepStates[stepId]?.status === "skipped") {
        setPending((current) => {
          const next = { ...current };
          delete next[stepId];
          return next;
        });
      }
    }
  }, [commitStep, now, pending, stepStates]);

  useEffect(() => {
    const flush = () => {
      for (const [stepId, item] of Object.entries(pending)) {
        if (stepStates[stepId]?.status === "active") void commitStep(stepId, item);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [commitStep, pending, stepStates]);

  useEffect(() => {
    if (!allFinished || feedbackLoaded) return;
    let cancelled = false;
    setFeedbackLoaded(true);
    setFeedbackLoading(true);
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/feedback`)
      .then(async (response) => {
        if (!response.ok) throw new Error(copy.feedbackError);
        return (await response.json()) as { feedback: Feedback[] };
      })
      .then((body) => {
        if (!cancelled) setFeedback(Object.fromEntries(body.feedback.map((item) => [item.recipeId, item])));
      })
      .catch((error) => {
        if (!cancelled) setFeedbackError(error instanceof Error ? error.message : copy.feedbackError);
      })
      .finally(() => {
        if (!cancelled) setFeedbackLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [allFinished, copy.feedbackError, feedbackAttempt, sessionId]);

  async function connectVoice() {
    voice.clearError();
    try {
      await voice.connect();
    } catch {
      setAnnouncement(copy.voiceInterrupted);
    }
  }

  async function startOrComplete(stepId: string, status: string) {
    if (status === "ready" || status === "paused") {
      await actions.startStep({ stepId, idempotencyKey: `start:${sessionId}:${stepId}:${runtime.revision}` });
      await runtime.refetch();
      return;
    }
    if (status === "active") {
      const item = { deadline: Date.now() + 5_000, idempotencyKey: `complete:${sessionId}:${stepId}` };
      setPending((current) => ({ ...current, [stepId]: item }));
      setAnnouncement(copy.undoAvailable);
    }
  }

  function undoCompletion(stepId: string) {
    setPending((current) => {
      const next = { ...current };
      delete next[stepId];
      return next;
    });
    setAnnouncement(copy.undoCancelled);
  }

  async function requestNotifications() {
    if (!("Notification" in window)) return setNotificationState("unsupported");
    setNotificationState(await Notification.requestPermission());
  }

  async function requestWakeLock() {
    if (!navigator.wakeLock) return setWakeUnsupported(true);
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      setWakeLock(sentinel);
      sentinel.addEventListener("release", () => setWakeLock(null), { once: true });
    } catch {
      setWakeUnsupported(true);
    }
  }

  async function submitFact() {
    if (!factRecipeId) return;
    setReplanState("loading");
    setReplanError(null);
    try {
      let payload: Record<string, unknown>;
      let domainType: string;
      if (factType === "substitution") {
        domainType = "ingredient_substituted";
        payload = { type: domainType, recipeId: factRecipeId, original: factA, replacement: factB };
      } else if (factType === "delay") {
        domainType = "delay_reported";
        payload = {
          type: domainType,
          recipeId: factRecipeId,
          seconds: Math.max(0, Math.round(Number(factA) * 60)),
          ...(factB.trim() ? { reason: factB.trim() } : {}),
        };
      } else if (factType === "equipment") {
        domainType = "equipment_changed";
        payload = { type: domainType, recipeId: factRecipeId, equipmentId: factA, action: factB || "failed" };
      } else {
        domainType = "doneness_confirmed";
        payload = { type: domainType, recipeId: factRecipeId, note: factA };
      }
      await actions.reportDomainEvent({
        domainType,
        payload,
        idempotencyKey: `fact:${sessionId}:${crypto.randomUUID()}`,
      });
      const result = await actions.client.requestReplan(sessionId, "confirm");
      if (result.kind === "not_needed") {
        setReplanChange(null);
        setReplanState("idle");
        setAnnouncement(copy.noAffectedSteps);
      } else {
        setReplanChange(result.planChange);
        setReplanState(result.kind === "applied" ? "applied" : result.kind === "failed" ? "failed" : "pending");
        setAnnouncement(result.kind === "applied" ? copy.replanApplied : copy.replanPending);
      }
      await runtime.refetch();
    } catch (error) {
      setReplanState("failed");
      setReplanError(error instanceof Error ? error.message : copy.replanFailed);
      setAnnouncement(copy.replanFailed);
    }
  }

  async function confirmReplan() {
    if (!replanChange) return;
    setReplanState("loading");
    setReplanError(null);
    try {
      await actions.pauseSession({ idempotencyKey: `replan:${replanChange.patch.id}:pause-session` });
      for (const stepId of replanChange.patch.affectedStepIds) {
        if (stepStates[stepId]?.status === "active") {
          await actions.pauseStep({ stepId, idempotencyKey: `replan:${replanChange.patch.id}:pause-step:${stepId}` });
        }
      }
      for (const timer of Object.values(timers)) {
        if (timer.status === "running") {
          await actions.pauseTimer({ timerId: timer.id, idempotencyKey: `replan:${replanChange.patch.id}:pause-timer:${timer.id}` });
        }
      }
      await runtime.refetch();
      let result = await actions.client.confirmPlanPatch(sessionId, replanChange.patch.id);
      if (result.kind === "pending_confirmation") {
        await runtime.refetch();
        result = await actions.client.confirmPlanPatch(sessionId, replanChange.patch.id);
      }
      setReplanChange(result.planChange);
      setReplanState(result.kind === "applied" ? "applied" : result.kind === "failed" ? "failed" : "pending");
      setAnnouncement(result.kind === "applied" ? copy.replanApplied : copy.replanPending);
      await runtime.refetch();
    } catch (error) {
      setReplanState("failed");
      setReplanError(error instanceof Error ? error.message : copy.replanFailed);
      setAnnouncement(copy.replanFailed);
    }
  }

  async function resumeAfterReplan() {
    if (!replanChange) return;
    try {
      if (snapshot?.session.status === "paused") {
        await actions.startSession({ idempotencyKey: `replan:${replanChange.patch.id}:resume-session` });
      }
      for (const stepId of replanChange.patch.affectedStepIds) {
        if (stepStates[stepId]?.status === "paused") {
          await actions.startStep({ stepId, idempotencyKey: `replan:${replanChange.patch.id}:resume-step:${stepId}` });
        }
      }
      for (const timer of Object.values(timers)) {
        if (timer.status === "paused") {
          await actions.startTimer({
            timerId: timer.id,
            durationSeconds: timer.remainingSeconds,
            idempotencyKey: `replan:${replanChange.patch.id}:resume-timer:${timer.id}`,
          });
        }
      }
      setReplanState("idle");
      setReplanChange(null);
      await runtime.refetch();
    } catch {
      setReplanError(copy.resumeError);
    }
  }

  async function submitFeedback(recipeId: string) {
    const draft = feedbackDrafts[recipeId] ?? { rating: 5, difficulty: "expected", actualMinutes: 30, notes: "" };
    setFeedbackError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipeId,
          rating: draft.rating,
          difficulty: draft.difficulty,
          actualSeconds: Math.max(60, Math.round(draft.actualMinutes * 60)),
          notes: draft.notes,
          idempotencyKey: `${sessionId}:${recipeId}`,
        }),
      });
      if (!response.ok) throw new Error(copy.feedbackError);
      const body = (await response.json()) as { feedback: Feedback };
      setFeedback((current) => ({ ...current, [recipeId]: body.feedback }));
    } catch (error) {
      setFeedbackError(error instanceof Error ? error.message : copy.feedbackError);
    }
  }

  if (runtime.error) {
    return (
      <div className="page-state error-state" role="alert">
        <strong>{format(messages.execute.loadError, { message: runtime.error.message })}</strong>
        <Button onClick={() => void runtime.refetch()}><RotateCcw />{copy.refresh}</Button>
      </div>
    );
  }
  if (runtime.status === "loading" || !snapshot || !plan) {
    return <div className="center-state"><LoaderCircle className="spin" />{messages.execute.loading}</div>;
  }

  const completedCount = Object.values(stepStates).filter(({ status }) => status === "completed").length;
  const progress = plan.steps.length ? (completedCount / plan.steps.length) * 100 : 0;
  const actionable = parsedSteps.filter(({ status }) => ["ready", "active", "paused"].includes(status));
  const active = actionable.filter(({ status }) => status === "active");
  const startable = actionable.filter(({ status }) => status !== "active");
  const nowSteps = active.length > 0 ? active : startable.slice(0, 1);
  const dependencyIds = new Set(nowSteps.map(({ step }) => step.id));
  const nextSteps = parsedSteps.filter(({ step, status }) =>
    status === "blocked" && step.after.some((id) => dependencyIds.has(id)),
  ).slice(0, 4);
  const timerDefinitions = new Map<string, TimerDefinition>(
    plan.steps.flatMap((step) =>
      ((step.timers ?? []) as TimerDefinition[]).map((timer) => [timer.id, timer] as const),
    ),
  );
  const voiceActive = ["connected", "muted", "recovering"].includes(voice.status);
  const voiceInterrupted = voice.status === "error" && hadVoiceConnection.current;
  const voiceLabels: Record<typeof voice.status, string> = {
    idle: messages.execute.disconnected,
    disconnected: messages.execute.disconnected,
    connecting: messages.execute.connecting,
    connected: messages.execute.connected,
    muted: messages.execute.muted,
    recovering: messages.execute.recovering,
    error: voiceInterrupted ? copy.voiceInterrupted : messages.execute.connectionError,
  };
  const transcript = collapseTranscript(voice.transcript).slice(-6);

  return (
    <section
      className={`cook-page live-cook-page page-enter execution-enhanced${highContrast ? " hands-contrast" : ""}${focusMode ? " focus-cooking" : ""}`}
      data-text-size={textSize}
    >
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      <header className="live-cook-header">
        <div><span className="eyebrow">{messages.execute.eyebrow}</span><h1>{plan.title || messages.execute.fallbackTitle}</h1></div>
        <div className="cook-progress" aria-label={format(messages.execute.progress, { count: Math.round(progress) })}>
          <span><strong>{completedCount}</strong> / {plan.steps.length}</span><i><b style={{ width: `${progress}%` }} /></i>
        </div>
      </header>

      <details className="execution-settings">
        <summary>{copy.settings}</summary>
        <div className="execution-settings-grid">
          <fieldset><legend>{copy.textSize}</legend>{["100", "115", "130"].map((size) => (
            <Button key={size} size="sm" variant={textSize === size ? "default" : "secondary"} onClick={() => setTextSize(size)}>{size}%</Button>
          ))}</fieldset>
          <Button variant="secondary" aria-pressed={highContrast} onClick={() => setHighContrast((value) => !value)}><Contrast />{highContrast ? copy.contrastOff : copy.contrastOn}</Button>
          <Button variant="secondary" aria-pressed={focusMode} onClick={() => setFocusMode((value) => !value)}>{focusMode ? <EyeOff /> : <Eye />}{focusMode ? copy.focusOff : copy.focusOn}</Button>
        </div>
      </details>
      {focusMode && <Button className="focus-exit" onClick={() => setFocusMode(false)}><EyeOff />{copy.focusOff}</Button>}

      <section className={`live-command-panel voice-${voice.status}`} aria-labelledby="voice-title">
        <div className="live-command-content">
          <div className="live-command-status"><Volume2 aria-hidden="true" /><div><span className="voice-guide-label">Gemini Live · {voiceLabels[voice.status]}</span><h2 id="voice-title">{messages.execute.voiceTitle}</h2><p>{copy.voiceIndependent}</p></div></div>
          <div className="voice-guide-actions">
            {!voiceActive ? <Button size="lg" onClick={() => void connectVoice()} disabled={voice.status === "connecting" || voicePermission === "denied"}><Mic />{voiceInterrupted ? copy.voiceRetry : messages.execute.startVoice}</Button> : <>
              <Button variant="secondary" onClick={() => voice.status === "muted" ? voice.unmute() : voice.mute()} disabled={voice.status === "recovering"}>{voice.status === "muted" ? <Mic /> : <MicOff />}{voice.status === "muted" ? messages.execute.unmute : messages.execute.mute}</Button>
              <Button variant="ghost" onClick={() => void voice.disconnect()}>{messages.execute.stopVoice}</Button>
            </>}
          </div>
          {voicePermission === "denied" ? <p className="form-error" role="alert">{copy.voicePermissionDenied}</p> : voicePermission === "prompt" || voicePermission === "unknown" ? <p>{copy.voicePermissionPrompt}</p> : null}
          {voice.error && <div className="inline-error" role="alert"><AlertTriangle /><span>{format(messages.execute.voiceError, { message: voice.error.message })}</span><Button variant="secondary" onClick={() => void connectVoice()}>{copy.voiceRetry}</Button></div>}
          {transcript.length > 0 && <details className="voice-history"><summary>{messages.execute.showTranscript}</summary><div className="voice-transcript" role="log">{transcript.map((entry, index) => <p key={`${entry.role}-${index}`}><strong>{entry.role === "user" ? messages.execute.user : messages.execute.assistant}</strong>{entry.text}</p>)}</div></details>}
        </div>
      </section>

      <section className="timer-workspace" aria-labelledby="timers-heading">
        <div className="action-section-heading compact"><Clock3 /><div><h2 id="timers-heading">{copy.timers}</h2><p>{Object.keys(timers).length === 0 ? copy.noTimers : null}</p></div></div>
        <div className="timer-preferences">
          {notificationState === "default" && <Button variant="secondary" onClick={() => void requestNotifications()}><Bell />{copy.notificationEnable}</Button>}
          <span>{notificationState === "granted" ? copy.notificationGranted : notificationState === "denied" ? copy.notificationDenied : notificationState === "unsupported" ? copy.notificationUnsupported : null}</span>
          {!wakeLock && !wakeUnsupported && <Button variant="secondary" onClick={() => void requestWakeLock()}><Eye />{copy.wakeEnable}</Button>}
          <span>{wakeLock ? copy.wakeActive : wakeUnsupported ? copy.wakeUnsupported : null}</span>
        </div>
        <div className="timer-grid">{Object.values(timers).map((timer) => {
          const seconds = remainingSeconds(timer, now);
          const definition = timerDefinitions.get(timer.id);
          return <article className={`timer-card timer-${timer.status}`} key={timer.id}><div><span>{timer.status === "running" ? copy.running : timer.status === "paused" ? copy.paused : copy.completed}</span><strong>{definition?.label ?? timer.id}</strong></div><time>{formatClock(seconds)}</time><div>
            {timer.status === "running" && <Button size="sm" variant="secondary" onClick={() => void actions.pauseTimer({ timerId: timer.id, idempotencyKey: `manual-pause:${timer.id}:${runtime.revision}` }).then(() => runtime.refetch())}><Pause />{copy.timerPause}</Button>}
            {timer.status === "paused" && <Button size="sm" onClick={() => void actions.startTimer({ timerId: timer.id, durationSeconds: timer.remainingSeconds, idempotencyKey: `manual-resume:${timer.id}:${runtime.revision}` }).then(() => runtime.refetch())}><Play />{copy.timerResume}</Button>}
            {timer.status === "running" && <Button size="sm" variant="ghost" onClick={() => void actions.completeTimer({ timerId: timer.id, idempotencyKey: `manual-complete:${timer.id}` }).then(() => runtime.refetch())}><Check />{copy.timerDone}</Button>}
          </div></article>;
        })}</div>
      </section>

      <section className="now-section" aria-labelledby="now-heading">
        <div className="action-section-heading"><span className="action-number">{messages.execute.current}</span><div><h2 id="now-heading">{messages.execute.nowTitle}</h2><p>{messages.execute.nowSingle}</p></div></div>
        {nowSteps.length > 0 ? <div className={`now-task-list ${nowSteps.length > 1 ? "has-multiple" : ""}`}>{nowSteps.map(({ step, timing, status }) => {
          const pendingItem = pending[step.id];
          return <article className={`now-task-card station-${status}`} key={step.id}><header><div className="station-topline"><span className="recipe-name">{timing?.recipeTitle || messages.common.finish}</span><span>{status === "active" ? messages.execute.active : messages.execute.ready}</span></div><h3>{step.label || step.id}</h3></header><div className="now-task-content"><p className="now-instruction">{step.instructions}</p><div className="station-meta"><span><Clock3 />{format(messages.common.minutes, { count: Math.ceil(step.estimatedDurationSeconds / 60) })}</span>{timing?.temperature && <span>{timing.temperature}</span>}{timing?.equipment.map((item) => <span key={item}>{item}</span>)}</div>
            {pendingItem ? <Button size="lg" variant="destructive" className="full-width" onClick={() => undoCompletion(step.id)} disabled={committing.has(step.id)}><Undo2 />{committing.has(step.id) ? copy.completing : `${copy.undo} (${Math.min(5, Math.max(0, Math.ceil((pendingItem.deadline - now) / 1000)))})`}</Button> : <Button size="lg" className="full-width" disabled={actions.status === "loading"} onClick={() => void startOrComplete(step.id, status)}>{status === "active" ? <Check /> : <Play />}{status === "active" ? messages.execute.done : messages.execute.startTask}</Button>}
          </div></article>;
        })}</div> : <div className="empty-state meal-complete-state"><h2>{messages.execute.completeTitle}</h2><p>{messages.execute.completeDescription}</p></div>}
        {actions.error && <div className="inline-error" role="alert"><AlertTriangle /><span>{actions.error.message}</span><Button onClick={() => void runtime.refetch()}>{copy.refresh}</Button></div>}
      </section>

      {!focusMode && nextSteps.length > 0 && <section className="coming-up-section" aria-labelledby="next-heading"><div className="action-section-heading compact"><GitMerge /><div><h2 id="next-heading">{messages.execute.nextTitle}</h2><p>{messages.execute.nextDescription}</p></div></div><div className="coming-up-list">{nextSteps.map(({ step, timing }) => <div className="coming-up-card" key={step.id}><span>{timing?.recipeTitle}</span><strong>{step.label}</strong><small><Clock3 />{format(messages.common.minutes, { count: Math.ceil(step.estimatedDurationSeconds / 60) })}</small></div>)}</div></section>}

      {!allFinished && <section className="replan-workspace" aria-labelledby="replan-heading">
        <div className="action-section-heading compact"><TimerReset /><div><h2 id="replan-heading">{copy.replanTitle}</h2><p>{copy.replanDescription}</p></div></div>
        <div className="replan-form">
          <label>{copy.factType}<select value={factType} onChange={(event) => { setFactType(event.target.value as FactType); setFactA(""); setFactB(""); }}><option value="substitution">{copy.substitution}</option><option value="delay">{copy.delay}</option><option value="equipment">{copy.equipment}</option><option value="doneness">{copy.doneness}</option></select></label>
          <label>{copy.recipe}<select value={factRecipeId} onChange={(event) => setFactRecipeId(event.target.value)}><option value="">—</option>{recipeOptions.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.title}</option>)}</select></label>
          {factType === "substitution" && <><label>{copy.original}<input value={factA} onChange={(event) => setFactA(event.target.value)} /></label><label>{copy.replacement}<input value={factB} onChange={(event) => setFactB(event.target.value)} /></label></>}
          {factType === "delay" && <><label>{copy.delayMinutes}<input type="number" min="0" value={factA} onChange={(event) => setFactA(event.target.value)} /></label><label>{copy.reason}<input value={factB} onChange={(event) => setFactB(event.target.value)} /></label></>}
          {factType === "equipment" && <><label>{copy.equipmentName}<input value={factA} onChange={(event) => setFactA(event.target.value)} /></label><label>{copy.equipmentAction}<select value={factB || "failed"} onChange={(event) => setFactB(event.target.value)}><option value="removed">{copy.removed}</option><option value="failed">{copy.failed}</option><option value="added">{copy.added}</option></select></label></>}
          {factType === "doneness" && <label>{copy.donenessNote}<input value={factA} onChange={(event) => setFactA(event.target.value)} /></label>}
          <Button disabled={replanState === "loading" || !factRecipeId || !factA.trim() || (factType === "substitution" && !factB.trim())} onClick={() => void submitFact()}>{replanState === "loading" ? <LoaderCircle className="spin" /> : <GitMerge />}{replanState === "loading" ? copy.proposing : copy.proposeReplan}</Button>
        </div>
        {replanChange && <div className={`replan-result replan-${replanState}`}><h3>{replanState === "applied" ? copy.replanApplied : copy.replanPending}</h3><p>{replanChange.patch.summary}</p><strong>{copy.affectedSteps}</strong><ul>{replanChange.patch.affectedStepIds.map((id) => <li key={id}>{plan.steps.find((step) => step.id === id)?.label ?? id}</li>)}</ul>{replanState === "pending" && <Button onClick={() => void confirmReplan()}>{copy.confirmReplan}</Button>}{replanState === "applied" && snapshot.session.status === "paused" && <Button onClick={() => void resumeAfterReplan()}><Play />{copy.resumeCooking}</Button>}</div>}
        {replanError && <div className="inline-error" role="alert"><AlertTriangle /><span>{replanError}</span><Button variant="secondary" onClick={() => void submitFact()}>{copy.replanRetry}</Button></div>}
      </section>}

      {!focusMode && allFinished && <section className="feedback-workspace" aria-labelledby="feedback-heading"><div className="action-section-heading compact"><Check /><div><h2 id="feedback-heading">{copy.feedbackTitle}</h2><p>{copy.feedbackDescription}</p></div></div>{feedbackLoading && <LoaderCircle className="spin" />}{recipeOptions.map((recipe) => {
        const saved = feedback[recipe.id];
        const draft = feedbackDrafts[recipe.id] ?? { rating: 5, difficulty: "expected" as const, actualMinutes: 30, notes: "" };
        if (saved) return <article className="feedback-saved" key={recipe.id}><h3>{recipe.title}</h3><strong>{copy.feedbackSaved}</strong><p>{"★".repeat(saved.rating)} · {saved.difficulty} · {Math.round(saved.actualSeconds / 60)} {copy.minutesShort}</p>{saved.notes && <p>{saved.notes}</p>}</article>;
        return <article className="feedback-form" key={recipe.id}><h3>{recipe.title}</h3><label>{copy.rating}<select value={draft.rating} onChange={(event) => setFeedbackDrafts((current) => ({ ...current, [recipe.id]: { ...draft, rating: Number(event.target.value) } }))}>{[5, 4, 3, 2, 1].map((rating) => <option key={rating} value={rating}>{rating}</option>)}</select></label><label>{copy.difficulty}<select value={draft.difficulty} onChange={(event) => setFeedbackDrafts((current) => ({ ...current, [recipe.id]: { ...draft, difficulty: event.target.value as FeedbackDraft["difficulty"] } }))}><option value="easy">{copy.easy}</option><option value="expected">{copy.expected}</option><option value="hard">{copy.hard}</option></select></label><label>{copy.actualMinutes}<input type="number" min="1" value={draft.actualMinutes} onChange={(event) => setFeedbackDrafts((current) => ({ ...current, [recipe.id]: { ...draft, actualMinutes: Number(event.target.value) } }))} /></label><label>{copy.notes}<textarea value={draft.notes} onChange={(event) => setFeedbackDrafts((current) => ({ ...current, [recipe.id]: { ...draft, notes: event.target.value } }))} /></label><Button onClick={() => void submitFeedback(recipe.id)}>{copy.submitFeedback}</Button></article>;
      })}{feedbackError && <div className="inline-error" role="alert"><span>{feedbackError}</span><Button variant="secondary" onClick={() => { setFeedbackError(null); setFeedbackLoaded(false); setFeedbackAttempt((value) => value + 1); }}>{copy.refresh}</Button></div>}</section>}

      {!focusMode && <details className="plan-drawer"><summary><span><strong>{messages.execute.overview}</strong><small>{format(messages.execute.completed, { done: completedCount, total: plan.steps.length })}</small></span></summary><ol>{parsedSteps.map(({ step, timing, status }, index) => <li key={step.id} className={status === "active" ? "run-active" : ""}><span className={`run-status run-${status}`}>{status === "completed" ? <Check /> : status === "active" ? <Play /> : <Circle />}</span><div><small>{timing?.recipeTitle}</small><strong>{index + 1}. {step.label}</strong><span>{status}</span></div></li>)}</ol></details>}
      <Button asChild variant="ghost" className="back-to-plans"><a href={links.plans()}><ArrowLeft />{messages.common.backToPlans}</a></Button>
    </section>
  );
}
