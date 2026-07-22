import { describe, expect, it } from "vitest";

import { sanitizeReturnTo } from "../src/worker/redirect";

describe("OAuth return path validation", () => {
  it("preserves same-origin application paths", () => {
    expect(sanitizeReturnTo("/plans/meal-1/review?from=login#approval")).toBe(
      "/plans/meal-1/review?from=login#approval",
    );
  });

  it.each([
    null,
    "",
    "plans",
    "https://evil.example",
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "/plans\\evil.example",
    "/.//evil.com",
    "/..//evil.com",
    "/./../..//evil.com",
  ])("falls back to the app root for unsafe return target %j", (returnTo) => {
    expect(sanitizeReturnTo(returnTo)).toBe("/");
  });
});
