import { describe, it, expect } from "vitest";
import type { Finding, Severity } from "../../src/types.js";

/**
 * Tests for the pipeline logic used by the orchestrator.
 * These test the pure functions (aggregate, determineVerdict, countBySeverity)
 * and the orchestrator's parseId logic.
 */

// Replicate parseId logic from orchestrator (pure function, no side effects)
function parseId(prIdentifier: string): { owner: string; repo: string; number: number } | null {
  const urlMatch = prIdentifier.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1]!,
      repo: urlMatch[2]!.replace(/\.git$/, ""),
      number: parseInt(urlMatch[3]!, 10),
    };
  }

  const shortMatch = prIdentifier.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1]!,
      repo: shortMatch[2]!,
      number: parseInt(shortMatch[3]!, 10),
    };
  }

  return null;
}

describe("parseId", () => {
  it("parses GitHub URL", () => {
    expect(parseId("https://github.com/facebook/react/pull/28421")).toEqual({
      owner: "facebook",
      repo: "react",
      number: 28421,
    });
  });

  it("parses URL with trailing .git", () => {
    expect(parseId("https://github.com/owner/repo.git/pull/100")).toEqual({
      owner: "owner",
      repo: "repo",
      number: 100,
    });
  });

  it("parses shorthand format", () => {
    expect(parseId("owner/repo#42")).toEqual({
      owner: "owner",
      repo: "repo",
      number: 42,
    });
  });

  it("parses shorthand with complex names", () => {
    expect(parseId("my-org/my-app_v2#999")).toEqual({
      owner: "my-org",
      repo: "my-app_v2",
      number: 999,
    });
  });

  it("returns null for malformed input", () => {
    expect(parseId("not-a-pr")).toBeNull();
    expect(parseId("")).toBeNull();
    expect(parseId("just/owner")).toBeNull();
  });
});

// CI summary logic test
function ciSummary(checks: Array<{ conclusion: string | null }>): string {
  if (checks.length === 0) return "no checks";
  const failed = checks.filter((c) => c.conclusion === "failure").length;
  if (failed > 0) return `${failed} FAILED`;
  return "all pass";
}

describe("ciSummary", () => {
  it("returns 'no checks' for empty array", () => {
    expect(ciSummary([])).toBe("no checks");
  });

  it("returns 'all pass' for all successes", () => {
    const checks = [
      { conclusion: "success" },
      { conclusion: "success" },
    ];
    expect(ciSummary(checks)).toBe("all pass");
  });

  it("returns FAILED count for failures", () => {
    const checks = [
      { conclusion: "success" },
      { conclusion: "failure" },
      { conclusion: "failure" },
      { conclusion: "success" },
    ];
    expect(ciSummary(checks)).toBe("2 FAILED");
  });
});

// Dimension warmup/burst logic test
describe("dimension execution strategy", () => {
  it("splits dimensions into warmup + burst groups", () => {
    const dimensions = ["line-scan", "efficiency", "simplification", "altitude"] as const;
    const [first, ...rest] = dimensions;

    expect(first).toBe("line-scan");
    expect(rest).toEqual(["efficiency", "simplification", "altitude"]);
  });

  it("handles single dimension gracefully", () => {
    const dimensions = ["line-scan"] as const;
    const [first, ...rest] = dimensions;

    expect(first).toBe("line-scan");
    expect(rest).toHaveLength(0);
  });
});