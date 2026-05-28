import type { PRFile } from "../types.js";

/** Map file extensions to programming languages */
const EXTENSION_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript (React)",
  ".js": "JavaScript",
  ".jsx": "JavaScript (React)",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".c": "C",
  ".cpp": "C++",
  ".cc": "C++",
  ".cs": "C#",
  ".rb": "Ruby",
  ".php": "PHP",
  ".dart": "Dart",
  ".scala": "Scala",
  ".r": "R",
  ".sql": "SQL",
  ".sh": "Shell",
  ".bash": "Bash",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".json": "JSON",
  ".toml": "TOML",
  ".graphql": "GraphQL",
  ".proto": "Protobuf",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".astro": "Astro",
  ".css": "CSS",
  ".scss": "SCSS",
  ".less": "Less",
  ".html": "HTML",
  ".md": "Markdown",
  ".mdx": "MDX",
};

/** Detect the primary programming language of a PR */
export function detectLanguages(files: PRFile[]): string[] {
  const counts = new Map<string, number>();

  for (const file of files) {
    const ext = file.filename.includes(".")
      ? "." + file.filename.split(".").pop()!
      : "";
    const lang = EXTENSION_MAP[ext];
    if (lang) {
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  }

  // Sort by frequency, return top languages
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lang]) => lang);
}

/** Get a human-readable language summary */
export function languageSummary(files: PRFile[]): string {
  const langs = detectLanguages(files);
  if (langs.length === 0) return "unknown";
  return langs.join(", ");
}
