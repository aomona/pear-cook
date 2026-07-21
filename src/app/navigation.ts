import { useEffect, useState } from "react";

export type Route =
  | { page: "plans" }
  | { page: "input"; planId: string }
  | { page: "plan"; planId: string }
  | { page: "execute"; sessionId: string };

function readRoute(): Route {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "plans" && parts[1] && parts[2] === "input") {
    return { page: "input", planId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === "plans" && parts[1] && parts[2] === "review") {
    return { page: "plan", planId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === "sessions" && parts[1]) {
    return { page: "execute", sessionId: decodeURIComponent(parts[1]) };
  }
  return { page: "plans" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

export const links = {
  plans: () => "#/plans",
  input: (planId: string) => `#/plans/${encodeURIComponent(planId)}/input`,
  plan: (planId: string) => `#/plans/${encodeURIComponent(planId)}/review`,
  execute: (sessionId: string) => `#/sessions/${encodeURIComponent(sessionId)}`,
};
