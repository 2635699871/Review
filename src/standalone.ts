import { createApp } from "./server.js";
import { exec } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline";

const exeDir = path.dirname(process.execPath);

// Load .env from the same directory as the exe
const envPath = path.resolve(exeDir, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const PORT = parseInt(process.env.PORT || "3300", 10);

// When bundled with pkg/sea, public/ is next to the .exe
const publicDir = path.resolve(exeDir, "public");

// Verify public/ exists, fallback for development
if (!fs.existsSync(path.join(publicDir, "index.html"))) {
  console.error("Error: public/ folder not found next to the executable.");
  console.error("Expected: " + publicDir);
  process.exit(1);
}

const app = createApp(publicDir);
app.listen(PORT, "0.0.0.0", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`PR Review Assistant → ${url}`);
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${cmd} ${url}`);
});
