import { createApp } from "./server.js";
import { exec } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const PORT = parseInt(process.env.PORT || "3300", 10);

// When bundled with pkg, public/ is next to the .exe
// When running via tsx, public/ is relative to project root
const exeDir = path.dirname(process.execPath);
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
