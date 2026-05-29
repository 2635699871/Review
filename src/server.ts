import express from "express";
import type { Request, Response } from "express";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runReview } from "./core/orchestrator.js";
import { buildConfig } from "./core/config.js";
import {
  saveToHistory,
  saveResult,
  listHistory,
  getSavedResult,
  addFeedback,
  getFeedbackStore,
} from "./storage/history.js";
import type { ReviewConfig, ReviewProgress, ProviderType } from "./types.js";
import { getProvider, PROVIDER_REGISTRY } from "./models/provider-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

export function createApp() {
  const app = express();
  app.use(express.json());

  // Serve static frontend
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  // ─── Review endpoint (SSE stream) ─────────────────────
  app.post("/api/review", async (req: Request, res: Response) => {
    const {pr, deep, output, dimensions, maxFiles,provider, apiKey, apiBaseUrl, modelOverride, githubToken,
    } = req.body as Record<string, unknown>;

    if (!pr || typeof pr !== "string") {
      res.status(400).json({ error: "Missing 'pr' field (PR identifier)" });
      return;
    }

    // Setup SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    function send(event: string, data: unknown) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    let config: ReviewConfig;
    try {
      config = {
        ...buildConfig({
          pr,
          deep: deep === true || deep === "true",
          output: (typeof output === "string" ? output : "all") as ReviewConfig["output"],
          dimensions: typeof dimensions === "string" ? dimensions : undefined,
          maxFiles: maxFiles != null ? String(maxFiles) : undefined,verbose: false,
        }),
        provider: (typeof provider === "string" ? provider : "anthropic") as ProviderType,
        apiKey: typeof apiKey === "string" ? apiKey : undefined,
        apiBaseUrl: typeof apiBaseUrl === "string" ? apiBaseUrl : undefined,
        modelOverride: typeof modelOverride === "string" ? modelOverride : undefined,
        githubToken: typeof githubToken === "string" ? githubToken : undefined,
      };
    } catch (err) {
      send("error", { message: err instanceof Error ? err.message : String(err) });
      res.end();
      return;
    }

    config.onProgress = (p: ReviewProgress) => send("progress", p);

    try {
      const result = await runReview(config);

      if (!result) {
        send("error", { message: "Review failed — could not fetch PR data" });
        res.end();
        return;
      }

      // Persist
      saveResult(result);
      saveToHistory(pr, result);

      send("done", { result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send("error", { message: msg });
    }

    res.end();
  });

  // ─── History ───────────────────────────────────────────
  app.get("/api/history", (_req: Request, res: Response) => {
    res.json(listHistory());
  });

  app.get("/api/history/:owner/:repo/:number", (req: Request, res: Response) => {
    const { owner, repo, number } = req.params as Record<string, string>;
    if (!owner || !repo || !number) {
      res.status(400).json({ error: "Missing path parameters" });
      return;
    }
    const result = getSavedResult(owner, repo, parseInt(number, 10));
    if (!result) {
      res.status(404).json({ error: "Review not found" });
      return;
    }
    res.json(result);
  });

  // ─── Feedback ──────────────────────────────────────────
  app.post("/api/feedback", (req: Request, res: Response) => {
    const { file, category, label } = req.body as Record<string, unknown>;

    if (!file || !category || !label) {
      res.status(400).json({ error: "Missing required fields: file, category, label" });
      return;
    }

    if (!["fp", "fn", "tp"].includes(label as string)) {
      res.status(400).json({ error: "label must be 'fp', 'fn', or 'tp'" });
      return;
    }

    addFeedback({
      file: file as string,
      category: category as string,
      label: label as "fp" | "fn" | "tp",
      timestamp: new Date().toISOString(),
    });

    res.json({ ok: true });
  });

  app.get("/api/feedback", (_req: Request, res: Response) => {
    res.json(getFeedbackStore());
  });

  // ─── Providers ──────────────────────────────────────────
  app.get("/api/providers", (_req: Request, res: Response) => {
    res.json(PROVIDER_REGISTRY.map((p) => ({
      id: p.id,
      label: p.label,
      defaultModel: p.defaultModel,
      baseUrl: p.baseUrl,
      apiKeyPrefix: p.apiKeyPrefix,
      website: p.website,
    })));
  });

  // ─── Config ────────────────────────────────────────────
  app.get("/api/config", (req: Request, res: Response) => {
    const providerId = typeof req.query.provider === "string" ? req.query.provider : "anthropic";
    const entry = getProvider(providerId);
    const envVal = entry ? (process.env[entry.envKeyName] ?? "") : "";
    res.json({
      apiKey: envVal ? "***" + envVal.slice(-6) : "",
      githubToken: process.env.GITHUB_TOKEN ? "***" + process.env.GITHUB_TOKEN.slice(-6) : "",
    });
  });

  // Fallback to index.html for SPA routing
  app.get("*", (_req: Request, res: Response) => {
    const indexPath = path.join(publicDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send("Not found");
    }
  });

  return app;
}

// Direct start
const PORT = parseInt(process.env.PORT || "3300", 10);

if (process.argv[1] && import.meta.url.endsWith(process.argv[1]!.replace(/\\/g, "/"))) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`PR Review Assistant → http://localhost:${PORT}`);
  });
}
