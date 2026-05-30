import { describe, it, expect } from "vitest";
import { buildDiffText, buildMetadataText } from "../../src/pipeline/context-builder.js";
import type { PRFile } from "../../src/types.js";

function makeFile(overrides: Partial<PRFile> = {}): PRFile {
  return {
    filename: "src/app.ts",
    status: "modified",
    additions: 10,
    deletions: 5,
    changes: 15,
    patch: "@@ -1,5 +1,10 @@\n+new line\n",
    ...overrides,
  };
}

describe("buildDiffText", () => {
  it("builds diff text from files", () => {
    const files = [makeFile()];
    const text = buildDiffText(files);
    expect(text).toContain("### src/app.ts");
    expect(text).toContain("@@ -1,5 +1,10 @@");
    expect(text).toContain("+new line");
  });

  it("sorts files by change count descending", () => {
    const files = [
      makeFile({ filename: "a.ts", changes: 5 }),
      makeFile({ filename: "c.ts", changes: 100 }),
      makeFile({ filename: "b.ts", changes: 50 }),
    ];

    const text = buildDiffText(files);
    const idxA = text.indexOf("### a.ts");
    const idxB = text.indexOf("### b.ts");
    const idxC = text.indexOf("### c.ts");

    // c.ts (100 changes) should come before b.ts (50) before a.ts (5)
    expect(idxC).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxA);
  });

  it("truncates when over maxBytes", () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      makeFile({
        filename: `src/file${i}.ts`,
        patch: "x".repeat(2000),
        changes: 100 - i,
      })
    );

    const text = buildDiffText(files, 5000);
    expect(text).toContain("[Diff truncated at 5000 bytes.");
  });

  it("handles files without patch", () => {
    const files = [makeFile({ status: "added", patch: undefined, additions: 20 })];
    const text = buildDiffText(files);
    expect(text).toContain("[New file, no diff available");
    expect(text).toContain("20 lines");
  });
});

describe("buildMetadataText", () => {
  it("builds complete metadata", () => {
    const text = buildMetadataText({
      title: "Add auth",
      author: "jane",
      body: "This PR implements JWT auth.",
      baseBranch: "main",
      headBranch: "feature/auth",
      fileCount: 5,
      additions: 100,
      deletions: 30,
      commits: ["feat: add JWT middleware", "fix: handle edge case"],
    });

    expect(text).toContain("PR Title: Add auth");
    expect(text).toContain("Author: jane");
    expect(text).toContain("Branch: feature/auth → main");
    expect(text).toContain("Files: 5 changed (+100 -30)");
    expect(text).toContain("This PR implements JWT auth.");
    expect(text).toContain("feat: add JWT middleware");
    expect(text).toContain("fix: handle edge case");
  });

  it("handles null body", () => {
    const text = buildMetadataText({
      title: "Test",
      author: "user",
      body: null,
      baseBranch: "main",
      headBranch: "feature/x",
      fileCount: 1,
      additions: 5,
      deletions: 0,
      commits: [],
    });

    expect(text).toContain("PR Title: Test");
    // Should not contain "PR Description:" when body is null
    expect(text).not.toContain("PR Description:");
  });
});
