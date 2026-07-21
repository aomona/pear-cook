import { GitBranch, LoaderCircle } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { z } from "zod";

import { Button } from "../components/ui/button";

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
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/auth/session")
      .then(async (response) => {
        if (response.status === 401) return null;
        if (!response.ok) throw new Error("Could not verify your sign-in");
        return authResponseSchema.parse(await response.json()).user;
      })
      .then(setUser)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthState | null>(
    () =>
      user
        ? {
            user,
            async signOut() {
              const response = await fetch("/auth/logout", { method: "POST" });
              if (!response.ok) throw new Error("Could not sign out");
              setUser(null);
            },
          }
        : null,
    [user],
  );

  if (loading) {
    return (
      <div className="auth-screen" role="status">
        <LoaderCircle className="spin" aria-hidden="true" />
        <span>調理データを読み込んでいます</span>
      </div>
    );
  }

  if (!user || !value) {
    const localDevelopment = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    return (
      <main className="login-page">
        <section className="login-panel" aria-labelledby="login-title">
          <div className="brand-lockup">
            <span>PEAR Cook</span>
          </div>
          <h1 id="login-title">レシピから調理手順を作成</h1>
          <p>
            レシピを追加して内容を確認すると、複数の料理が同時に完成する順番へ整理されます。
          </p>
          <div className="login-actions">
            <Button asChild size="lg">
              <a href="/auth/github?returnTo=/">
                <GitBranch aria-hidden="true" />
                GitHubでログイン
              </a>
            </Button>
            {localDevelopment && (
              <Button
                variant="secondary"
                onClick={() => {
                  setError(null);
                  void fetch("/auth/local", { method: "POST" })
                    .then(async (response) => {
                      if (!response.ok) throw new Error("ローカルログインは無効です");
                      const body = authResponseSchema.parse(await response.json());
                      setUser(body.user);
                    })
                    .catch((caught) =>
                      setError(caught instanceof Error ? caught.message : String(caught)),
                    );
                }}
              >
                ローカル環境で確認
              </Button>
            )}
          </div>
          {error && (
            <div className="inline-error" role="alert">
              <strong>ログイン状態を確認できませんでした</strong>
              <span>{error}</span>
            </div>
          )}
          <p className="login-footnote">献立と調理セッションはログインしたアカウントにのみ保存されます。</p>
        </section>
      </main>
    );
  }

  return <AuthContext.Provider value={value}>{children(user)}</AuthContext.Provider>;
}
