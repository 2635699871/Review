import { describe, it, expect } from "vitest";
import {
  PROVIDER_REGISTRY,
  getProvider,
  getApiFormat,
  getDefaultModel,
  getDefaultBaseUrl,
} from "../../src/models/provider-registry.js";

describe("PROVIDER_REGISTRY integrity", () => {
  it("contains at least 16 providers", () => {
    expect(PROVIDER_REGISTRY.length).toBeGreaterThanOrEqual(16);
  });

  it("every provider has all required fields", () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(p.id, `${p.id}: missing id`).toBeTruthy();
      expect(p.label, `${p.id}: missing label`).toBeTruthy();
      expect(p.envKeyName, `${p.id}: missing envKeyName`).toBeTruthy();
      expect(["anthropic", "openai-compatible"], `${p.id}: invalid apiFormat`).toContain(p.apiFormat);
      // baseUrl and defaultModel can be empty for "custom" provider
      if (p.id !== "custom") {
        expect(p.baseUrl, `${p.id}: missing baseUrl`).toBeTruthy();
        expect(p.defaultModel, `${p.id}: missing defaultModel`).toBeTruthy();
      }
    }
  });

  it("every provider id is unique", () => {
    const ids = PROVIDER_REGISTRY.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("anthropic is the only provider with apiFormat 'anthropic'", () => {
    const anthropicFormats = PROVIDER_REGISTRY.filter((p) => p.apiFormat === "anthropic");
    expect(anthropicFormats).toHaveLength(1);
    expect(anthropicFormats[0]!.id).toBe("anthropic");
  });

  it("custom provider has empty baseUrl and defaultModel", () => {
    const custom = PROVIDER_REGISTRY.find((p) => p.id === "custom");
    expect(custom).toBeDefined();
    expect(custom!.baseUrl).toBe("");
    expect(custom!.defaultModel).toBe("");
  });
});

describe("getProvider", () => {
  it("returns the correct provider by id", () => {
    const p = getProvider("groq");
    expect(p).toBeDefined();
    expect(p!.id).toBe("groq");
    expect(p!.defaultModel).toBe("llama-3.3-70b-versatile");
  });

  it("returns undefined for nonexistent id", () => {
    expect(getProvider("nonexistent")).toBeUndefined();
  });
});

describe("getApiFormat", () => {
  it("returns 'anthropic' for anthropic", () => {
    expect(getApiFormat("anthropic")).toBe("anthropic");
  });

  it("returns 'openai-compatible' for all other providers", () => {
    expect(getApiFormat("openai")).toBe("openai-compatible");
    expect(getApiFormat("deepseek")).toBe("openai-compatible");
    expect(getApiFormat("gemini")).toBe("openai-compatible");
    expect(getApiFormat("groq")).toBe("openai-compatible");
    expect(getApiFormat("mistral")).toBe("openai-compatible");
    expect(getApiFormat("cohere")).toBe("openai-compatible");
    expect(getApiFormat("perplexity")).toBe("openai-compatible");
    expect(getApiFormat("moonshot")).toBe("openai-compatible");
    expect(getApiFormat("custom")).toBe("openai-compatible");
  });

  it("defaults to 'openai-compatible' for unknown ids", () => {
    expect(getApiFormat("unknown-provider")).toBe("openai-compatible");
  });
});

describe("getDefaultModel", () => {
  it("returns the default model for known providers", () => {
    expect(getDefaultModel("anthropic")).toBe("claude-sonnet-4-20250514");
    expect(getDefaultModel("deepseek")).toBe("deepseek-chat");
    expect(getDefaultModel("gemini")).toBe("gemini-2.5-flash");
  });

  it("returns empty string for unknown providers", () => {
    expect(getDefaultModel("unknown")).toBe("");
  });
});

describe("getDefaultBaseUrl", () => {
  it("returns the base URL for known providers", () => {
    expect(getDefaultBaseUrl("anthropic")).toBe("https://api.anthropic.com");
    expect(getDefaultBaseUrl("openai")).toBe("https://api.openai.com/v1");
    expect(getDefaultBaseUrl("perplexity")).toBe("https://api.perplexity.ai");
  });

  it("returns empty string for unknown providers", () => {
    expect(getDefaultBaseUrl("unknown")).toBe("");
  });
});
