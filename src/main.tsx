import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PearProvider } from "@pear-agent/react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { AuthGate } from "./app/Auth";
import { I18nProvider } from "./app/i18n";
import { SamplePage } from "./app/pages/SamplePage";
import { pearConfig } from "./pear.config";
import "./styles.css";

function RootContent() {
  const [isSample, setIsSample] = useState(window.location.hash.replace(/^#\/?/, "").split("/")[0] === "sample");
  useEffect(() => {
    const update = () => setIsSample(window.location.hash.replace(/^#\/?/, "").split("/")[0] === "sample");
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  if (isSample) return <SamplePage />;
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        {(user) => (
          <PearProvider baseUrl={pearConfig.apiBaseUrl} getContext={() => ({ actorId: `github:${user.id}`, roles: ["cook"], claims: {} })}>
            <App />
          </PearProvider>
        )}
      </AuthGate>
    </QueryClientProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const queryClient = new QueryClient();

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <RootContent />
    </I18nProvider>
  </StrictMode>,
);
