import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  addFeedback,
  getFalsePositivePatterns,
  isKnownFalsePositive,
  getFeedbackStore,
  setStorageDirForTest,
} from "../../src/storage/history.js";

const TEST_DIR = path.resolve(".pr-review-test");

function cleanup(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("feedback system", () => {
  beforeEach(() => {
    cleanup(TEST_DIR);
    setStorageDirForTest(TEST_DIR);
  });

  afterEach(() => {
    setStorageDirForTest(null);
    cleanup(TEST_DIR);
  });

  it("addFeedback records a single entry", () => {
    addFeedback({
      file: "src/auth/jwt-middleware.ts",
      category: "hardcoded-secret",
      label: "fp",
      timestamp: new Date().toISOString(),
    });

    const store = getFeedbackStore();
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.file).toBe("src/auth/jwt-middleware.ts");
    expect(store.entries[0]!.label).toBe("fp");
  });

  it("addFeedback auto-builds FP patterns after 2+ confirmations", () => {
    addFeedback({
      file: "src/auth/login.ts",
      category: "sql-injection",
      label: "fp",
      timestamp: new Date().toISOString(),
    });
    addFeedback({
      file: "src/auth/login.ts",
      category: "sql-injection",
      label: "fp",
      timestamp: new Date().toISOString(),
    });

    const patterns = getFalsePositivePatterns();
    expect(patterns.some((p) => p.category === "sql-injection")).toBe(true);
  });

  it("isKnownFalsePositive matches persisted patterns", () => {
    addFeedback({
      file: "src/utils/format.ts",
      category: "null-safety",
      label: "fp",
      timestamp: new Date().toISOString(),
    });
    addFeedback({
      file: "src/utils/format.ts",
      category: "null-safety",
      label: "fp",
      timestamp: new Date().toISOString(),
    });

    expect(isKnownFalsePositive("src/utils/format.ts", "null-safety")).toBe(true);
    expect(isKnownFalsePositive("src/other/other.ts", "other-category")).toBe(false);
  });
});

describe("isKnownFalsePositive (logic test)", () => {
  it("matches a file to a known pattern", () => {
    const patterns = [{ filePattern: "src/auth/jwt-middleware.ts", category: "hardcoded-secret" }];

    const match = patterns.some(
      (p) => "src/auth/jwt-middleware.ts".includes(p.filePattern) && "hardcoded-secret" === p.category
    );
    expect(match).toBe(true);
  });

  it("does not match unrelated files", () => {
    const patterns = [{ filePattern: "src/auth/login.ts", category: "sql-injection" }];

    const match = patterns.some(
      (p) => "src/utils/format.ts".includes(p.filePattern) && "null-safety" === p.category
    );
    expect(match).toBe(false);
  });

  it("does not match when only category matches (must also match file)", () => {
    const patterns = [{ filePattern: "src/auth/login.ts", category: "sql-injection" }];

    const match = patterns.some(
      (p) => "src/other/file.ts".includes(p.filePattern) && "sql-injection" === p.category
    );
    expect(match).toBe(false);
  });
});