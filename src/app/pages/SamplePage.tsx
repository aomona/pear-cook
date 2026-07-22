import { Check, ChefHat, Clock3, LogIn, Play, RotateCcw } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { useI18n } from "../i18n";
import { links } from "../navigation";

export function SamplePage() {
  const { messages, format } = useI18n();
  const [currentStep, setCurrentStep] = useState(0);
  const steps = [
    { time: "T−20", kind: messages.review.handsOn, instruction: messages.sample.stepPrep },
    { time: "T−08", kind: messages.review.passive, instruction: messages.sample.stepCook },
    { time: "T−00", kind: messages.review.serve, instruction: messages.sample.stepServe },
  ];
  const complete = currentStep >= steps.length;

  return (
    <main className="sample-page page-enter" aria-labelledby="sample-title">
      <header className="sample-hero">
        <ChefHat aria-hidden="true" />
        <span className="eyebrow">{messages.sample.sampleLabel}</span>
        <h1 id="sample-title">{messages.sample.title}</h1>
        <p>{messages.sample.description}</p>
        <Button asChild size="lg"><a href="/auth/github?returnTo=/"><LogIn aria-hidden="true" />{messages.sample.signIn}</a></Button>
      </header>
      <section className="sample-card" aria-labelledby="sample-recipe-title">
        <div className="sample-card-heading"><div><span className="plain-status">T−20</span><h2 id="sample-recipe-title">{messages.sample.recipeTitle}</h2><p>{messages.sample.recipeDescription}</p></div><span><Clock3 aria-hidden="true" />{format(messages.common.minutes, { count: 20 })}</span></div>
        <div className="sample-progress" role="status">{format(messages.sample.progress, { current: Math.min(currentStep + 1, steps.length), total: steps.length })}</div>
        <ol className="sample-steps">
          {steps.map((step, index) => (
            <li key={step.time} className={index === currentStep ? "sample-step-active" : index < currentStep ? "sample-step-complete" : ""}>
              <strong>{index < currentStep ? <Check aria-label={messages.execute.statusCompleted} /> : step.time}</strong>
              <span>{step.kind}</span>
              <p>{step.instruction}</p>
            </li>
          ))}
        </ol>
        {complete ? (
          <div className="sample-complete"><strong><Check />{messages.sample.sampleComplete}</strong><Button variant="secondary" onClick={() => setCurrentStep(0)}><RotateCcw />{messages.sample.resetSample}</Button></div>
        ) : (
          <Button size="lg" className="full-width" onClick={() => setCurrentStep((step) => step + 1)}><Play />{currentStep === 0 ? messages.sample.tryStep : currentStep === steps.length - 1 ? messages.sample.finishSample : messages.sample.nextStep}</Button>
        )}
      </section>
      <Button asChild variant="ghost"><a href={links.plans()}>{messages.sample.openApp}</a></Button>
    </main>
  );
}
