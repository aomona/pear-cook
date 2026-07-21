import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PearProvider } from "@pear-agent/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { AuthGate } from "./app/Auth";
import { I18nProvider } from "./app/i18n";
import { pearConfig } from "./pear.config";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const queryClient = new QueryClient();

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          {(user) => (
            <PearProvider
              baseUrl={pearConfig.apiBaseUrl}
              getContext={() => ({ actorId: `github:${user.id}`, roles: ["cook"], claims: {} })}
            >
              <App />
            </PearProvider>
          )}
        </AuthGate>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
