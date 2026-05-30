import { describe, it, expect } from "vitest";
import { aggregate, determineVerdict, countBySeverity } from "../../src/pipeline/aggregator.js";
import type { Finding } from "../../src/types.js";

function makeF(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "MEDIUM",
    dimension: "line-scan",
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

  it("downgrades vague findings instead of dropping them", () => {
    const findings: Finding[] = [
      makeF({ issue: "Consider improving this", fix: "Refactor" }),
    ];

    const result = aggregate(findings);

    // Vague findings are now downgraded (kept with lowered severity), not dropped
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe("LOW");
    expect(result.downgraded).toBe(1);
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

describe("cross-dimension deduplication", () => {
  it("merges findings with the same code quote at different lines", () => {
    const findings: Finding[] = [
      makeF({ dimension: "line-scan", line: 40, category: "logic-error", issue: "or should be and", codeQuote: 'if cfg["base_url"] or cfg["api_key"]:' }),
      makeF({ dimension: "altitude", line: 79, category: "missing-abstraction", issue: "Boolean operator error", codeQuote: 'if cfg["base_url"] or cfg["api_key"]:' }),
    ];

    const result = aggregate(findings);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.dimension).toContain("line-scan");
    expect(result.findings[0]!.dimension).toContain("altitude");
  });

  it("merges findings with similar code quotes (one is substring)", () => {
    const quote = 'if _user_quotas.get(ip, {}).get("remaining", 0) > 0:';
    const findings: Finding[] = [
      makeF({ dimension: "line-scan", line: 85, category: "race-condition", issue: "non-atomic quota", codeQuote: quote }),
      makeF({ dimension: "altitude", line: 93, category: "missing-abstraction", issue: "race in quota", codeQuote: quote + '\n  new_remaining = _user_quotas[ip]["remaining"] - 1' }),
    ];

    const result = aggregate(findings);

    expect(result.findings).toHaveLength(1);
  });

  it("does NOT merge different bugs with different code quotes at nearby lines", () => {
    const findings: Finding[] = [
      makeF({ dimension: "line-scan", line: 40, issue: "or should be and", codeQuote: "cfg['base_url'] or cfg['api_key']" }),
      makeF({ dimension: "altitude", line: 41, issue: "different bug about something else", codeQuote: "completely_different_code()" }),
    ];

    const result = aggregate(findings);

    expect(result.findings).toHaveLength(2);
  });

  it("merges findings within 5-line proximity with similar text", () => {
    const findings: Finding[] = [
      makeF({ dimension: "line-scan", line: 166, category: "missing-parameter", issue: "HTTP request in health_check has no timeout, hangs indefinitely." }),
      makeF({ dimension: "altitude", line: 164, category: "missing-abstraction", issue: "HTTP request in health_check has no timeout, blocks indefinitely." }),
    ];

    const result = aggregate(findings);

    expect(result.findings).toHaveLength(1);
  });
});