import { describe, it, expect } from "vitest";
import { aggregate, determineVerdict, countBySeverity } from "../../src/pipeline/aggregator.js";
import type { Finding } from "../../src/types.js";

function makeF(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "MEDIUM",
    dimension: "correctness",
    file: "src/app.ts",
    line: 42,
    category: "test",
    issue: "A specific bug",
    fix: "Change X to Y",
    confidence: 0.85,
    ...overrides,
  };
}

describe("aggregate", () => {
  it("ranks findings by severity", () => {
    const findings: Finding[] = [
      makeF({ severity: "LOW", file: "a.ts" }),
      makeF({
        severity: "CRITICAL",
        file: "b.ts",
        issue: "SQL injection vulnerability via unescaped user input",
        fix: "Use parameterized queries with pg-pool",
      }),
      makeF({ severity: "MEDIUM", file: "c.ts" }),
      makeF({ severity: "HIGH", file: "d.ts" }),
    ];

    const result = aggregate(findings);

    expect(result.findings[0]!.severity).toBe("CRITICAL");
    expect(result.findings[1]!.severity).toBe("HIGH");
    expect(result.findings[2]!.severity).toBe("MEDIUM");
    expect(result.findings[3]!.severity).toBe("LOW");
  });

  it("deduplicates identical findings", () => {
    const findings: Finding[] = [
      makeF({ file: "a.ts", line: 10, issue: "Null check missing" }),
      makeF({ file: "a.ts", line: 10, issue: "Null check missing" }),
    ];

    const result = aggregate(findings);

    expect(result.findings).toHaveLength(1);
  });

  it("filters out vague findings", () => {
    const findings: Finding[] = [
      makeF({ issue: "Consider improving this", fix: "Refactor" }),
    ];

    const result = aggregate(findings);

    expect(result.findings).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });
});

describe("determineVerdict", () => {
  it("BLOCKs on CRITICAL findings", () => {
    expect(
      determineVerdict([makeF({ severity: "CRITICAL" })])
    ).toBe("BLOCK");
  });

  it("REQUEST_CHANGES on HIGH findings", () => {
    expect(determineVerdict([makeF({ severity: "HIGH" })])).toBe(
      "REQUEST_CHANGES"
    );
  });

  it("COMMENTs on only MEDIUM/LOW findings", () => {
    expect(
      determineVerdict([makeF({ severity: "MEDIUM" }), makeF({ severity: "LOW" })])
    ).toBe("COMMENT");
  });

  it("COMMENTs on empty findings", () => {
    expect(determineVerdict([])).toBe("COMMENT");
  });
});

describe("countBySeverity", () => {
  it("counts correctly", () => {
    const findings: Finding[] = [
      makeF({ severity: "CRITICAL" }),
      makeF({ severity: "CRITICAL" }),
      makeF({ severity: "HIGH" }),
      makeF({ severity: "MEDIUM" }),
      makeF({ severity: "MEDIUM" }),
      makeF({ severity: "MEDIUM" }),
      makeF({ severity: "LOW" }),
    ];

    const counts = countBySeverity(findings);

    expect(counts.CRITICAL).toBe(2);
    expect(counts.HIGH).toBe(1);
    expect(counts.MEDIUM).toBe(3);
    expect(counts.LOW).toBe(1);
  });
});