import { GitBranch, LoaderCircle } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { z } from "zod";

import { Button } from "../components/ui/button";
import { useI18n } from "./i18n";
import { LanguageSelector } from "./LanguageSelector";

const authUserSchema = z.object({
  id: z.string(),
  login: z.string(),
  name: z.string(),
  avatarUrl: z.string(),
});

const authResponseSchema = z.object({ user: authUserSchema });

export type AuthUser = z.infer<typeof authUserSchema>;

type AuthState = {
  user: AuthUser;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthGate");
  return value;
}

export function AuthGate({ children }: { children: (user: AuthUser) => ReactNode }) {
  const { messages } = useI18n();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/auth/session")
      .then(async (response) => {
        if (response.status === 401) return null;
        if (!response.ok) throw new Error(messages.auth.verifyError);
        return authResponseSchema.parse(await response.json()).user;
      })
      .then(setUser)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }, [messages.auth.verifyError]);

  const value = useMemo<AuthState | null>(
    () =>
      user
        ? {
            user,
            async signOut() {
              const response = await fetch("/auth/logout", { method: "POST" });
              if (!response.ok) throw new Error(messages.auth.signOutError);
              setUser(null);
            },
          }
        : null,
    [messages.auth.signOutError, user],
  );

  if (loading) {
    return (
      <div className="auth-screen" role="status">
        <LoaderCircle className="spin" aria-hidden="true" />
        <span>{messages.auth.loading}</span>
      </div>
    );
  }

  if (!user || !value) {
    const localDevelopment = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    return (
      <main className="login-page">
        <section className="login-panel" aria-labelledby="login-title">
          <div className="login-toolbar">
            <div className="brand-lockup">
              <span>PEAR Cook</span>
            </div>
            <LanguageSelector />
          </div>
          <h1 id="login-title">{messages.auth.title}</h1>
          <p>{messages.auth.description}</p>
          <div className="login-actions">
            <Button asChild size="lg">
              <a href="/auth/github?returnTo=/">
                <GitBranch aria-hidden="true" />
                {messages.auth.github}
              </a>
            </Button>
            {localDevelopment && (
              <Button
                variant="secondary"
                onClick={() => {
                  setError(null);
                  void fetch("/auth/local", { method: "POST" })
                    .then(async (response) => {
                      if (!response.ok) throw new Error(messages.auth.localDisabled);
                      const body = authResponseSchema.parse(await response.json());
                      setUser(body.user);
                    })
                    .catch((caught) =>
                      setError(caught instanceof Error ? caught.message : String(caught)),
                    );
                }}
              >
                {messages.auth.local}
              </Button>
            )}
          </div>
          {error && (
            <div className="inline-error" role="alert">
              <strong>{messages.auth.errorTitle}</strong>
              <span>{error}</span>
            </div>
          )}
          <p className="login-footnote">{messages.auth.footnote}</p>
        </section>
      </main>
    );
  }

  return <AuthContext.Provider value={value}>{children(user)}</AuthContext.Provider>;
}
