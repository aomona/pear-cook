import { ChefHat, LogOut } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { pearConfig } from "../pear.config";
import { useAuth } from "./Auth";
import { useI18n } from "./i18n";
import { LanguageSelector } from "./LanguageSelector";
import { links, useRoute } from "./navigation";
import { ExecutePage } from "./pages/ExecutePage";
import { InputPage } from "./pages/InputPage";
import { PlanPage } from "./pages/PlanPage";
import { PlansPage } from "./pages/PlansPage";


function UserAvatar({ name, avatarUrl }: { name: string; avatarUrl: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (!avatarUrl || imageFailed) return <span className="avatar-fallback" aria-hidden="true">{name[0]}</span>;
  return <img src={avatarUrl} alt="" onError={() => setImageFailed(true)} />;
}

export function App() {
  const route = useRoute();
  const { user, signOut } = useAuth();
  const { messages } = useI18n();
  const phaseLabels = [
    messages.common.phaseRecipe,
    messages.common.phaseReview,
    messages.common.phaseCook,
  ];
  const activePhase = route.page === "input" ? 0 : route.page === "plan" ? 1 : route.page === "execute" ? 2 : -1;

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href={links.plans()} aria-label={`${pearConfig.appName} ${messages.common.home}`}>
          <ChefHat className="brand-icon" aria-hidden="true" />
          <span>{pearConfig.appName}</span>
        </a>
        <div className="header-user">
          <LanguageSelector compact />
          <UserAvatar name={user.name} avatarUrl={user.avatarUrl} />
          <span className="user-name">{user.name}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={messages.common.signOut}
            onClick={() => void signOut()}
          >
            <LogOut aria-hidden="true" />
          </Button>
        </div>
      </header>

      {activePhase >= 0 && (
        <nav className="phase-nav" aria-label={messages.common.progress}>
          {phaseLabels.map((label, index) => (
            <span key={label} className={index <= activePhase ? "phase-active" : ""} aria-current={index === activePhase ? "step" : undefined}>
              <span>{index + 1}</span>{label}
            </span>
          ))}
        </nav>
      )}

      <div className="main-content">
        {route.page === "plans" && <PlansPage />}
        {route.page === "input" && <InputPage planId={route.planId} />}
        {route.page === "plan" && <PlanPage planId={route.planId} />}
        {route.page === "execute" && <ExecutePage sessionId={route.sessionId} />}
      </div>
    </div>
  );
}
