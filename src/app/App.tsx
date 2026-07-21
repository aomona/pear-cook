import { ChefHat, LogOut } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { pearConfig } from "../pear.config";
import { useAuth } from "./Auth";
import { links, useRoute } from "./navigation";
import { ExecutePage } from "./pages/ExecutePage";
import { InputPage } from "./pages/InputPage";
import { PlanPage } from "./pages/PlanPage";
import { PlansPage } from "./pages/PlansPage";

const phaseLabels = ["レシピ", "調理順の確認", "調理"];

function UserAvatar({ name, avatarUrl }: { name: string; avatarUrl: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (!avatarUrl || imageFailed) return <span className="avatar-fallback" aria-hidden="true">{name[0]}</span>;
  return <img src={avatarUrl} alt="" onError={() => setImageFailed(true)} />;
}

export function App() {
  const route = useRoute();
  const { user, signOut } = useAuth();
  const activePhase = route.page === "input" ? 0 : route.page === "plan" ? 1 : route.page === "execute" ? 2 : -1;

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href={links.plans()} aria-label={`${pearConfig.appName} home`}>
          <ChefHat className="brand-icon" aria-hidden="true" />
          <span>{pearConfig.appName}</span>
        </a>
        <div className="header-user">
          <UserAvatar name={user.name} avatarUrl={user.avatarUrl} />
          <span className="user-name">{user.name}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="ログアウト"
            onClick={() => void signOut()}
          >
            <LogOut aria-hidden="true" />
          </Button>
        </div>
      </header>

      {activePhase >= 0 && (
        <nav className="phase-nav" aria-label="Cooking plan progress">
          {phaseLabels.map((label, index) => (
            <span key={label} className={index <= activePhase ? "phase-active" : ""} aria-current={index === activePhase ? "step" : undefined}>
              <span>{index + 1}</span>{label}
            </span>
          ))}
        </nav>
      )}

      <main className="main-content">
        {route.page === "plans" && <PlansPage />}
        {route.page === "input" && <InputPage planId={route.planId} />}
        {route.page === "plan" && <PlanPage planId={route.planId} />}
        {route.page === "execute" && <ExecutePage sessionId={route.sessionId} />}
      </main>
    </div>
  );
}
