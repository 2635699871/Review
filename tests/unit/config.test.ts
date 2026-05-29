import { describe, it, expect } from "vitest";
import { parsePRIdentifier } from "../../src/core/config.js";

describe("parsePRIdentifier", () => {
  it("parses URL format", () => {
    const result = parsePRIdentifier(
      "https://github.com/facebook/react/pull/42"
    );
    expect(result).toEqual({ owner: "facebook", repo: "react", number: 42 });
  });

  it("parses URL with .git suffix", () => {
    const result = parsePRIdentifier(
      "https://github.com/vercel/next.js.git/pull/100"
    );
    expect(result).toEqual({ owner: "vercel", repo: "next.js", number: 100 });
  });

  it("parses shorthand format", () => {
    const result = parsePRIdentifier("owner/repo#123");
    expect(result).toEqual({ owner: "owner", repo: "repo", number: 123 });
  });

  it("parses shorthand with hyphens", () => {
    const result = parsePRIdentifier("my-org/my-repo#42");
    expect(result).toEqual({ owner: "my-org", repo: "my-repo", number: 42 });
  });

  it("returns null for invalid input", () => {
    expect(parsePRIdentifier("not a pr")).toBeNull();
    expect(parsePRIdentifier("")).toBeNull();
  });
});