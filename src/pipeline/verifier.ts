import type { Finding, PRFile } from "../types.js";

/**
 * Verify each finding against the diff to ground confidence in real evidence.
 *
 * Two checks:
 * 1. Does the finding's file exist in the PR?
 * 2. Does the code_quote text actually appear in the diff?
 *
 * Confidence is adjusted up/down based on these signals, producing a
 * dynamic confidence score instead of the flat 0.75 default.
 */
export function verifyFindings(
  findings: Finding[],
  diffText: string,
  files: PRFile[]
): Finding[] {
  const fileNames = new Set(files.map((f) => f.filename));

  return findings.map((f) => {
    let confidence = f.confidence;

    // Check 1: file existence
    if (f.file && !fileNames.has(f.file)) {
      confidence -= 0.15;
    }

    // Check 2: code_quote grounding
    if (f.codeQuote) {
      const quote = f.codeQuote.trim();
      const quoteLines = quote
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (quoteLines.length > 0) {
        const matchCount = quoteLines.filter((line) => diffText.includes(line)).length;
        if (matchCount === quoteLines.length) {
          confidence += 0.10;
        } else if (matchCount > 0) {
          confidence += 0.08;
        } else {
          confidence -= 0.05;
        }
      }
    }

    return {
      ...f,
      confidence: clamp(confidence),
    };
  });
}

function clamp(v: number): number {
  return Math.round(Math.max(0.1, Math.min(1.0, v)) * 100) / 100;
}
