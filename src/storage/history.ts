import type { ReviewResult, FindingFeedback, FeedbackLabel, FeedbackStore } from "../types.js";
import * as fs from "node:fs";
import * as path from "node:path";

const STORAGE_DIR = ".pr-review";
const HISTORY_FILE = "history.json";
const FEEDBACK_FILE = "feedback.json";

let _storageOverride: string | null = null;

/** Override storage directory — for use in tests only. Pass null to reset. */
export function setStorageDirForTest(dir: string | null): void {
  _storageOverride = dir;
}

interface HistoryEntry {
  id: string;
  prIdentifier: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  verdict: string;
  findingsCount: number;
  reviewedAt: string;
}

interface HistoryStore {
  entries: HistoryEntry[];
}

function ensureDir(): string {
  const dir = path.resolve(_storageOverride ?? STORAGE_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ─── History ────────────────────────────────────────────────

function loadHistory(): HistoryStore {
  const dir = ensureDir();
  const filepath = path.join(dir, HISTORY_FILE);
  if (!fs.existsSync(filepath)) {
    return { entries: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return { entries: [] };
  }
}

function saveHistoryStore(store: HistoryStore): void {
  const dir = ensureDir();
  const filepath = path.join(dir, HISTORY_FILE);
  fs.writeFileSync(filepath, JSON.stringify(store, null, 2), "utf-8");
}

export function saveToHistory(
  prIdentifier: string,
  result: ReviewResult
): HistoryEntry {
  const store = loadHistory();
  const entry: HistoryEntry = {
    id: `${result.pr.owner}/${result.pr.repo}#${result.pr.number}-${Date.now()}`,
    prIdentifier,
    owner: result.pr.owner,
    repo: result.pr.repo,
    number: result.pr.number,
    title: result.pr.title,
    verdict: result.verdict,
    findingsCount: result.findings.length,
    reviewedAt: result.reviewedAt,
  };

  store.entries = store.entries.filter(
    (e) => !(e.owner === entry.owner && e.repo === entry.repo && e.number === entry.number)
  );
  store.entries.unshift(entry);

  if (store.entries.length > 100) {
    store.entries = store.entries.slice(0, 100);
  }

  saveHistoryStore(store);
  return entry;
}

export function listHistory(): HistoryEntry[] {
  return loadHistory().entries;
}

// ─── Saved Results ──────────────────────────────────────────

export function getSavedResult(owner: string, repo: string, number: number): ReviewResult | null {
  const dir = ensureDir();
  const filepath = path.join(dir, `pr-${owner}-${repo}-${number}-result.json`);
  if (!fs.existsSync(filepath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

export function saveResult(result: ReviewResult): void {
  const dir = ensureDir();
  const filepath = path.join(dir, `pr-${result.pr.owner}-${result.pr.repo}-${result.pr.number}-result.json`);
  fs.writeFileSync(filepath, JSON.stringify(result, null, 2), "utf-8");
}

// ─── Feedback (false-positive/false-negative learning) ───────

function loadFeedback(): FeedbackStore {
  const dir = ensureDir();
  const filepath = path.join(dir, FEEDBACK_FILE);
  if (!fs.existsSync(filepath)) {
    return { entries: [], falsePositivePatterns: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return { entries: [], falsePositivePatterns: [] };
  }
}

function saveFeedbackStore(store: FeedbackStore): void {
  const dir = ensureDir();
  const filepath = path.join(dir, FEEDBACK_FILE);
  fs.writeFileSync(filepath, JSON.stringify(store, null, 2), "utf-8");
}

/** Record user feedback on a finding */
export function addFeedback(entry: FindingFeedback): void {
  const store = loadFeedback();
  const isDuplicate = store.entries.some(
    (e) => e.file === entry.file && e.category === entry.category && e.label === entry.label && e.timestamp === entry.timestamp
  );
  if (!isDuplicate) {
    store.entries.push(entry);
  }

  // If marked as false positive twice for the same category, add to known FP patterns
  if (entry.label === "fp") {
    const fpCount = store.entries.filter(
      (e) => e.label === "fp" && e.category === entry.category && e.file.includes(entry.file.split("/").pop() ?? "")
    ).length;
    if (fpCount >= 2) {
      const alreadyKnown = store.falsePositivePatterns.some(
        (p) => p.category === entry.category && p.filePattern === entry.file
      );
      if (!alreadyKnown) {
        store.falsePositivePatterns.push({
          filePattern: entry.file,
          category: entry.category,
        });
      }
    }
  }

  saveFeedbackStore(store);
}

/** Load known false positive patterns to suppress in future reviews */
export function getFalsePositivePatterns(): Array<{ filePattern: string; category: string }> {
  return loadFeedback().falsePositivePatterns;
}

/** Check if a finding matches a known false positive pattern */
export function isKnownFalsePositive(file: string, category: string): boolean {
  const patterns = loadFeedback().falsePositivePatterns;
  return patterns.some(
    (p) => file.includes(p.filePattern) && category === p.category
  );
}

/** Get all feedback entries for analysis */
export function getFeedbackStore(): FeedbackStore {
  return loadFeedback();
}