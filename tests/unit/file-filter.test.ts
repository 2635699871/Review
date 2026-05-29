import { describe, it, expect } from "vitest";
import { shouldExclude, categorizeFile, isHighRisk, filterFiles } from "../../src/utils/file-filter.js";
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

describe("shouldExclude", () => {
  it("excludes lockfiles", () => {
    expect(shouldExclude(makeFile({ filename: "package-lock.json" })).excluded).toBe(true);
    expect(shouldExclude(makeFile({ filename: "yarn.lock" })).excluded).toBe(true);
    expect(shouldExclude(makeFile({ filename: "Cargo.lock" })).excluded).toBe(true);
  });

  it("excludes generated files", () => {
    expect(shouldExclude(makeFile({ filename: "types.generated.ts" })).excluded).toBe(true);
    expect(shouldExclude(makeFile({ filename: "data.pb.go" })).excluded).toBe(true);
  });

  it("excludes vendor directories", () => {
    expect(shouldExclude(makeFile({ filename: "vendor/lib.go" })).excluded).toBe(true);
    expect(shouldExclude(makeFile({ filename: "node_modules/foo/index.js" })).excluded).toBe(true);
  });

  it("excludes removed files", () => {
    expect(shouldExclude(makeFile({ status: "removed", patch: undefined })).excluded).toBe(true);
  });

  it("excludes binary/image files", () => {
    expect(shouldExclude(makeFile({ filename: "logo.png", patch: undefined })).excluded).toBe(true);
    expect(shouldExclude(makeFile({ filename: "app.jpg" })).excluded).toBe(true);
    expect(shouldExclude(makeFile({ filename: "font.woff2" })).excluded).toBe(true);
  });

  it("excludes minified files", () => {
    expect(shouldExclude(makeFile({ filename: "bundle.min.js" })).excluded).toBe(true);
  });

  it("keeps normal source files", () => {
    expect(shouldExclude(makeFile({ filename: "src/app.ts" })).excluded).toBe(false);
    expect(shouldExclude(makeFile({ filename: "lib/util.py" })).excluded).toBe(false);
  });

  it("keeps added files even without patch", () => {
    const result = shouldExclude(makeFile({ status: "added", patch: undefined }));
    expect(result.excluded).toBe(false);
  });
});

describe("categorizeFile", () => {
  it("categorizes test files", () => {
    expect(categorizeFile(makeFile({ filename: "app.test.ts" }))).toBe("test");
    expect(categorizeFile(makeFile({ filename: "tests/util.test.js" }))).toBe("test");
    expect(categorizeFile(makeFile({ filename: "spec/models_spec.rb" }))).toBe("test");
    expect(categorizeFile(makeFile({ filename: "test_main.py" }))).toBe("test");
  });

  it("categorizes config files", () => {
    expect(categorizeFile(makeFile({ filename: "tsconfig.json" }))).toBe("config");
    expect(categorizeFile(makeFile({ filename: ".eslintrc.js" }))).toBe("config");
    expect(categorizeFile(makeFile({ filename: "Dockerfile" }))).toBe("config");
    expect(categorizeFile(makeFile({ filename: "docker-compose.yml" }))).toBe("config");
  });

  it("categorizes doc files", () => {
    expect(categorizeFile(makeFile({ filename: "README.md" }))).toBe("doc");
    expect(categorizeFile(makeFile({ filename: "docs/guide.md" }))).toBe("doc");
    expect(categorizeFile(makeFile({ filename: "CONTRIBUTING.md" }))).toBe("doc");
  });

  it("defaults to source for code files", () => {
    expect(categorizeFile(makeFile({ filename: "src/app.ts" }))).toBe("source");
    expect(categorizeFile(makeFile({ filename: "main.py" }))).toBe("source");
  });
});

describe("isHighRisk", () => {
  it("flags auth/payment/security paths", () => {
    expect(isHighRisk("src/auth/login.ts")).toBe(true);
    expect(isHighRisk("lib/payment/stripe.ts")).toBe(true);
    expect(isHighRisk("app/admin/users.ts")).toBe(true);
    expect(isHighRisk("api/database/query.ts")).toBe(true);
    expect(isHighRisk("utils/encrypt.ts")).toBe(true);
    expect(isHighRisk("middleware/token-auth.ts")).toBe(true);
  });

  it("does not flag normal paths", () => {
    expect(isHighRisk("src/components/Button.tsx")).toBe(false);
    expect(isHighRisk("utils/format.ts")).toBe(false);
  });
});

describe("filterFiles", () => {
  it("filters and categorizes a mixed file list", () => {
    const files: PRFile[] = [
      makeFile({ filename: "src/app.ts" }),
      makeFile({ filename: "tests/app.test.ts" }),
      makeFile({ filename: "package-lock.json", patch: undefined }),
      makeFile({ filename: "logo.png", patch: undefined }),
      makeFile({ filename: "src/auth/login.ts" }),
      makeFile({ filename: "README.md" }),
    ];

    const result = filterFiles(files);

    expect(result.filtered).toHaveLength(4);
    expect(result.excluded).toHaveLength(2);
    expect(result.byType.source).toHaveLength(2);
    expect(result.byType.test).toHaveLength(1);
    expect(result.byType.doc).toHaveLength(1);
    expect(result.highRisk).toHaveLength(1);
    expect(result.highRisk[0]!.filename).toBe("src/auth/login.ts");
  });

  it("enforces max files limit", () => {
    const files: PRFile[] = Array.from({ length: 10 }, (_, i) =>
      makeFile({ filename: `src/file${i}.ts` })
    );

    const result = filterFiles(files, { maxFiles: 5 });

    expect(result.filtered).toHaveLength(5);
    expect(result.excluded).toHaveLength(5);
  });
});