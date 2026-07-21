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
import { useI18n } from "../i18n";
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
  const { messages, format, formatDate } = useI18n();
  const [dish, setDish] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plans = useQuery({
    queryKey: ["plans", pearConfig.domainId],
    queryFn: async () => {
      const response = await fetch("/api/plans");
      if (!response.ok) throw new Error(messages.plans.networkError);
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
          <span className="eyebrow">{messages.plans.eyebrow}</span>
          <h1>{messages.plans.title}</h1>
          <p>{messages.plans.description}</p>
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
          <Label htmlFor="dish-name">{messages.plans.nameLabel}</Label>
          <Input
            id="dish-name"
            value={dish}
            onChange={(event) => setDish(event.target.value)}
            placeholder={messages.plans.namePlaceholder}
            autoFocus
          />
        </div>
        <Button type="submit" size="lg" disabled={creating || !dish.trim()}>
          {creating ? <span className="button-spinner" /> : <Plus aria-hidden="true" />}
          {creating ? messages.plans.creating : messages.plans.create}
        </Button>
      </form>
      {error && (
        <div className="inline-error" role="alert">
          <strong>{messages.plans.createError}</strong>
          <span>{error}</span>
        </div>
      )}

      <section className="plan-library" aria-labelledby="plan-library-title">
        <div className="section-heading">
          <div>
            <h2 id="plan-library-title">{messages.plans.savedTitle}</h2>
            <p>{messages.plans.savedDescription}</p>
          </div>
        </div>

        <div aria-live="polite">
          {plans.isLoading && (
            <div className="list-loading" role="status">
              <span className="button-spinner" />
              <span>{messages.plans.loading}</span>
            </div>
          )}
          {plans.isError && (
            <div className="section-error" role="alert">
              <div><strong>{messages.plans.loadError}</strong><span>{messages.plans.networkError}</span></div>
              <Button variant="secondary" onClick={() => void plans.refetch()}>{messages.common.retry}</Button>
            </div>
          )}
          {plans.data?.length === 0 && (
            <div className="empty-state">
              <strong>{messages.plans.emptyTitle}</strong>
              <p>{messages.plans.emptyDescription}</p>
            </div>
          )}
          {plans.data && plans.data.length > 0 && (
            <ol className="plan-list">
              {plans.data.map((plan) => (
                <li key={plan.id}>
                  <a href={plan.status === "ready" ? links.plan(plan.id) : links.input(plan.id)}>
                    <div className="plan-list-main">
                      <Badge variant={plan.status === "ready" ? "success" : "outline"}>
                        {plan.status === "ready" ? messages.plans.ready : plan.status === "archived" ? messages.plans.archived : messages.plans.draft}
                      </Badge>
                      <strong>{plan.title || messages.plans.untitled}</strong>
                      <span>
                        {format(messages.plans.updated, { date: formatDate(plan.updatedAt), version: plan.version })}
                      </span>
                    </div>
                    <span className="plan-list-action">
                      {plan.status === "ready" ? messages.plans.review : messages.plans.edit}
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
