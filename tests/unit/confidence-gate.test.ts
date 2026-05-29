import { describe, it, expect } from "vitest";
import { gateFinding, gateFindings } from "../../src/core/confidence-gate.js";
import type { Finding } from "../../src/types.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "MEDIUM",
    dimension: "correctness",
    file: "src/app.ts",
    line: 42,
    category: "null-safety",
    issue: "Potential null dereference when user is not logged in",
    fix: "Add null check: if (!user) return null;",
    confidence: 0.85,
    ...overrides,
  };
}

describe("gateFinding", () => {
  it("passes a well-formed finding", () => {
    const result = gateFinding(makeFinding());
    expect(result.passed).toBe(true);
    expect(result.downgraded).toBe(false);
  });

  it("rejects findings with no file reference", () => {
    const result = gateFinding(makeFinding({ file: "" }));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("ile");
  });

  it("rejects findings with vague issue descriptions", () => {
    const result = gateFinding(
      makeFinding({
        issue: "Consider improving this code",
        fix: "Refactor it",
      })
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Vague");
  });

  it("rejects findings with vague fix suggestions", () => {
    const result = gateFinding(
      makeFinding({
        issue: "Error handling could be improved",
        fix: "Consider adding try/catch",
      })
    );
    expect(result.passed).toBe(false);
  });

  it("downgrades CRITICAL severity without security/exploit evidence", () => {
    const result = gateFinding(
      makeFinding({
        severity: "CRITICAL",
        issue: "This naming convention is inconsistent",
        fix: "Rename to follow project conventions",
      })
    );
    expect(result.passed).toBe(true);
    expect(result.downgraded).toBe(true);
    expect(result.reason).toContain("inflated");
  });

  it("keeps genuine CRITICAL findings", () => {
    const result = gateFinding(
      makeFinding({
        severity: "CRITICAL",
        issue: "SQL injection vulnerability in user input concatenation",
        fix: "Use parameterized queries",
      })
    );
    expect(result.passed).toBe(true);
    expect(result.downgraded).toBe(false);
  });

  it("downgrades HIGH findings with speculative language", () => {
    const result = gateFinding(
      makeFinding({
        severity: "HIGH",
        issue: "This could be a problem in some edge cases",
        fix: "Add validation for edge cases",
        confidence: 0.7,
      })
    );
    expect(result.passed).toBe(true);
    expect(result.downgraded).toBe(true);
  });
});

describe("gateFindings", () => {
  it("filters and reports stats", () => {
    const findings: Finding[] = [
      makeFinding(), // Good
      makeFinding({ issue: "Consider improving", fix: "Refactor", file: "" }), // Bad
      makeFinding({ severity: "CRITICAL", issue: "Naming convention" }), // Downgraded
    ];

    const { kept, dropped, downgraded } = gateFindings(findings);

    expect(kept).toHaveLength(2); // 1 good + 1 downgraded
    expect(dropped).toBe(1);
    expect(downgraded).toBe(1);
  });
});