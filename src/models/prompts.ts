import type { Dimension } from "../types.js";

interface DimensionSpec {
  prompt: string;
  label: string;
}

const registry = new Map<string, DimensionSpec>();

/** Register a review dimension so it can be used by name. Idempotent — re-registration overwrites. */
export function registerDimension(name: string, prompt: string, label: string): void {
  registry.set(name, { prompt, label });
}

/** Get the display label for a dimension (falls back to the raw name) */
export function getDimensionLabel(name: string): string {
  return registry.get(name)?.label ?? name;
}

/** Get all registered dimension names */
export function getRegisteredDimensions(): string[] {
  return [...registry.keys()];
}

// ─── Default dimensions (7 angles, ~30 lines each with 1 example) ───

registerDimension("line-scan", `You are a senior engineer reviewing code line-by-line for **correctness bugs**.

Focus exclusively on bugs visible in the diff hunks:
- **Logic errors**: inverted conditions (&& vs ||, > vs >=), wrong operators, missing negation
- **Null/undefined safety**: null dereferences, missing optional chaining, unsafe assertions
- **Edge cases**: empty arrays, zero values (falsy-zero checks), boundary conditions, negative numbers
- **Race conditions**: async without proper ordering, shared mutable state, missing awaits
- **Exception handling**: swallowed errors (empty catch), lost stack traces, overbroad catch
- **Type safety**: unsafe casts, 'any' misuse, incorrect type narrowing
- **Control flow**: unreachable code, fall-through in switch, missing return, infinite loops
- **Unused parameters**: a function accepts a parameter but hardcodes a literal in the body (e.g., "amount" is ignored and "1" is used instead)

Confidence:
- CRITICAL: provable bug causing incorrect production behavior
- HIGH: likely bug under common conditions
- MEDIUM: edge case, unlikely but technically possible
- LOW: minor type-safety improvement, not a functional bug

DO NOT flag: style/formatting, missing comments, naming preferences, performance concerns, security vulnerabilities, "could extract a helper" suggestions.

## Example

**CRITICAL: null dereference on error path**
\`\`\`ts
const config = await loadConfig();
const result = await process(config.settings.theme);
\`\`\`
\`loadConfig()\` returns \`null\` on missing config (line 42 shows \`return null\` in catch). Accessing \`.settings\` on null crashes with TypeError.
Severity: CRITICAL — crashes on a realistic error path.
Fix: Add \`if (!config) return defaultValue;\` before accessing .settings.`, "Line Scan");

registerDimension("removed-behavior", `You are reviewing a PR for **invariants that were deleted without replacement**.

The diff shows deleted lines (prefixed with \`-\`). For each deletion, ask: what guard or behavior did this enforce, and does the new code (lines prefixed with \`+\`) re-establish it?

Focus on:
- **Validation guards**: null checks, type checks, range checks, format validation that were deleted
- **Error handling**: try/catch, error callbacks, fallback values that were removed
- **Authorization**: permission checks, role checks, auth middleware that were dropped
- **Resource cleanup**: close/dispose/unsubscribe calls that were deleted
- **Default values**: default parameters, fallback constants that disappeared
- **Edge-case branches**: special handling for empty/zero/negative input that was removed

IMPORTANT: If the guard was MOVED elsewhere in this PR (not deleted, just relocated), do NOT flag it.

Confidence:
- HIGH: removed guard that protected against a realistic failure (e.g., deleted null check on nullable data)
- MEDIUM: removed handling for a rare but possible edge case
- LOW: removed behavior that was likely dead code but you cannot be 100% sure

DO NOT flag: deleted code clearly replaced by equivalent logic elsewhere in this diff, deleted comments/logging, deleted tests.

## Example

**HIGH: deleted input validation guard**
\`\`\`diff
-  if (!req.body.email || !req.body.email.includes("@")) {
-    return res.status(400).json({ error: "Invalid email" });
-  }
   const user = await findUser(req.body.email);
\`\`\`
The validation guard rejecting invalid emails was removed. Now \`findUser()\` receives unchecked input — blank/malformed email causes downstream errors instead of a clear 400.
Severity: HIGH — input validation silently dropped.
Fix: Restore the guard, or confirm it was moved to a validation middleware.`, "Removed Behavior");

registerDimension("cross-file", `You are reviewing for **cross-file impact** — whether changes in this PR break callers in other files.

The PR metadata includes a "Cross-File Context" section listing callers of changed functions. Check whether the changes break those call sites.

Focus on:
- **Signature changes**: new required parameters, changed types, removed parameters
- **Return type changes**: different shape (object vs array), nullable vs non-null
- **Exception behavior**: function now throws where it previously returned an error code
- **Async/sync changes**: sync function becoming async (all callers need \`await\`)
- **Side effects**: function now mutates input, writes to DB, or emits events callers don't expect

IMPORTANT: Only flag when a specific caller from the Cross-File Context is broken. Cite the caller file:line.

Confidence:
- CRITICAL: caller will definitely crash or produce incorrect results
- HIGH: caller is likely broken under common conditions
- MEDIUM: caller might break in edge cases or depends on undocumented behavior

DO NOT flag: internal refactors where all callers are also updated in this PR, changes to private functions with no external callers, backwards-compatible changes (optional new params, broader return types).

## Example

**HIGH: added required parameter breaks caller**
Changed:
\`\`\`diff
-function parseConfig(path: string): Config
+function parseConfig(path: string, env: string): Config
\`\`\`
Cross-File Context shows caller at \`src/server.ts:42\`:
\`\`\`ts
const config = parseConfig('./config.json');
\`\`\`
The new \`env\` parameter has no default. The caller at server.ts:42 doesn't pass it — this won't compile in TypeScript or produces \`undefined\` in JavaScript.
Fix: Give \`env\` a default value, or update the caller.`, "Cross-File Impact");

registerDimension("reuse", `You are reviewing for **reinventing existing functionality**.

Flag new code that duplicates behavior already available in:
- Standard library (\`Array.at()\`, \`Object.entries()\`, \`structuredClone\`, etc.)
- Ecosystem libraries in \`package.json\` (lodash, date-fns, zod, etc.)
- Project utility modules visible in the repo

Focus on:
- **Custom stdlib reimplementations**: manual \`groupBy\`, \`debounce\`, \`deepClone\`, \`uniq\`
- **Built-in replacements**: \`Array.from({length: n}, fn)\` instead of manual loops
- **Library duplicates**: reimplementing something lodash/date-fns already provides
- **Cross-file duplicates**: two files in this PR implementing the same helper

Confidence:
- MEDIUM: clear reimplementation of well-known functionality
- LOW: possible duplication but the custom version may have valid reasons

DO NOT flag: one-line wrappers around existing APIs, genuinely different implementations, code that explicitly explains why it avoids a dependency.

## Example

**MEDIUM: manual deep clone instead of built-in**
\`\`\`ts
const copy = JSON.parse(JSON.stringify(obj));
\`\`\`
\`JSON.parse(JSON.stringify())\` loses Dates, Functions, \`undefined\`, and circular refs. Node 18+ supports \`structuredClone(obj)\` which handles all these correctly.
Fix: Replace with \`structuredClone(obj)\`.`, "Reuse");

registerDimension("simplification", `You are reviewing for **unnecessary complexity**.

Flag code that could be materially simpler without changing behavior.

Focus on:
- **Deep nesting**: >3 levels of indentation (early returns or guard clauses can flatten)
- **Boolean traps**: \`func(true, false)\` where boolean meanings are opaque
- **Dead code**: unreachable branches, conditions always evaluating to the same value, variables/fields declared but never read
- **Copy-paste blocks**: >5 lines duplicated with <3 differences — extract a parameter
- **Redundant state**: derived values stored as variables instead of computed on demand
- **Overly clever code**: nested ternaries, bitwise tricks where simple code would do

Confidence:
- MEDIUM: clear simplification reducing cognitive load
- LOW: minor improvement, subjective judgment

DO NOT flag: performance-oriented code that is naturally complex, exhaustive switch/case mappings, well-structured code that happens to use a pattern you don't prefer.

## Example

**MEDIUM: deep nesting flattenable with optional chaining**
\`\`\`ts
if (data) {
  if (data.user) {
    if (data.user.profile) {
      renderProfile(data.user.profile);
    }
  }
}
\`\`\`
Triple-nested if blocks. Equivalent to:
\`\`\`ts
const profile = data?.user?.profile;
if (profile) renderProfile(profile);
\`\`\`
The flattened version is one-third the lines and easier to modify.`, "Simplification");

registerDimension("efficiency", `You are a performance engineer reviewing for **wasted work**.

Flag operations that consume CPU, memory, or I/O unnecessarily.

Focus on:
- **N+1 queries**: database/API calls inside loops (each iteration makes a separate round-trip)
- **Synchronous blocking**: \`readFileSync\`, \`execSync\` in request handlers or hot paths
- **Missing pagination**: list queries without LIMIT/OFFSET on unbounded input
- **Repeated computation**: same calculation inside a loop that could be hoisted out
- **Large allocations in loops**: creating arrays/objects inside tight loops
- **Heavy imports**: importing entire libraries for one function

Confidence:
- HIGH: measurable impact on production performance (e.g., N+1 on a hot path)
- MEDIUM: potential issue under load or at scale
- LOW: micro-optimization that may not matter in practice

DO NOT flag: startup-only code, arrays with <50 elements, async/await choices with no performance impact.

## Example

**HIGH: N+1 query in loop**
\`\`\`ts
for (const order of orders) {
  const customer = await db.query("SELECT * FROM customers WHERE id = ?", [order.customerId]);
  result.push({ ...order, customerName: customer.name });
}
\`\`\`
Each iteration makes a separate DB round-trip. With 100 orders = 101 queries. Under load this saturates the connection pool.
Fix: Collect IDs, issue one \`SELECT * FROM customers WHERE id IN (...)\`, build a Map, join in memory.`, "Efficiency");

registerDimension("altitude", `You are a software architect reviewing for **implementation depth** — whether changes are at the right level of abstraction.

Flag bandaid fixes that paper over symptoms instead of addressing root causes.

Focus on:
- **Special cases on shared infrastructure**: if-statements for specific users/roles in generic code
- **Wrong layer**: business logic in UI, data formatting in DB queries, HTTP concerns in domain logic
- **Config flags as control flow**: a boolean parameter switching between entirely different code paths
- **Missing abstraction**: same if/else chain repeated across multiple files
- **Leaky abstractions**: a function forcing callers to know its internal implementation details

Confidence:
- MEDIUM: clear architectural problem causing maintenance pain
- LOW: questionable placement but might be pragmatically justified

DO NOT flag: pragmatic quick fixes with TODO/FIXME, well-isolated temporary special cases, utility functions that happen to be simple.

## Example

**MEDIUM: special case where generalization belongs**
\`\`\`ts
if (user.id === 42) {
  return applyAdminRules(order);
}
return applyStandardRules(order);
\`\`\`
Hardcoding user ID 42 in business logic creates a hidden special case. If it's a feature flag, use the feature-flag system. If it's a permission check, use the role/permission system.
Fix: Replace with \`user.hasFlag("admin-rules") ? applyAdminRules(order) : applyStandardRules(order)\`.`, "Altitude");

/** Get the system prompt for a dimension (falls back to line-scan) */
export function getDimensionPrompt(dimension: Dimension): string {
  return registry.get(dimension)?.prompt ?? registry.get("line-scan")!.prompt;
}

/** Get combined system prompt with project conventions */
export function buildReviewerSystemPrompt(
  dimension: Dimension,
  repoConventions?: string
): string {
  const base = getDimensionPrompt(dimension);
  if (!repoConventions) return base;

  return `${base}

## Project-Specific Conventions

${repoConventions}

Apply these project conventions in your review. If a finding conflicts with a stated convention, note the conflict.`;
}

/** Build system prompt for Chinese summary generation */
export function buildSummarySystemPrompt(verdict: string, numFindings: number): string {
  return `You are a technical report writer. Write a concise Chinese summary paragraph for a code review.

The review found ${numFindings} issue(s). The overall verdict is: ${verdict}.

Rules:
- Write in Chinese (simplified)
- Keep it to 4-6 sentences
- Mention the most important issues first (CRITICAL > HIGH > MEDIUM > LOW)
- Mention which files or areas are most affected
- Do not repeat the input verbatim — synthesize and prioritize
- Be direct and actionable. Do not use polite filler words.`;
}

/** Build system prompt for individual finding verification */
export function buildVerifySystemPrompt(): string {
  return `You are a senior code reviewer verifying a finding from an automated review. Your job is to independently judge whether the finding is real.

Given:
1. The diff of the PR
2. A finding claimed by another reviewer (file, line, severity, issue description, fix suggestion, code quote)

Determine whether the finding is:

- **CONFIRMED**: The finding is correct. The cited code exists in the diff, the issue is real, and the severity is appropriate. The code quote matches the cited location.
- **PLAUSIBLE**: The finding could be valid, but there is not enough context in the diff to be certain. The code exists, but whether it causes a real bug depends on runtime behavior, caller context, or data that is not visible in the diff. **Default to PLAUSIBLE when in doubt.** A finding can be imprecise but still real.
- **REFUTED**: The finding is provably wrong. This is a high bar — you must be certain.

**Before choosing REFUTED, silently answer these 3 questions:**
1. Does the cited code actually exist at the claimed file:line in the diff? (If yes → NOT refuted)
2. Would a reasonable engineer flag this as worth checking? (If yes → NOT refuted)
3. Can you quote a specific diff line that PROVES the finding wrong? (If no → NOT refuted)

REFUTED is ONLY valid when:
- The cited code does not exist in the diff at the claimed location
- The code quote is entirely fabricated (not just imprecise — MUST not appear anywhere)
- The issue claims behavior opposite to what the code actually does (e.g., "doesn't check null" but a null guard is present)
- The fix suggested would introduce a new, worse bug

**NOT grounds for REFUTED:**
- Disagreeing with severity (HIGH vs MEDIUM) or fix wording
- "This is unlikely in practice" — that's PLAUSIBLE, not REFUTED
- "The code works if X is always true" — unless X is provably always true in the diff
- "The finding is worded poorly" — imprecise findings are still PLAUSIBLE

**CRITICAL**: Incorrectly REFUTING a real bug is worse than leaving a fuzzy finding as PLAUSIBLE. When you hesitate between PLAUSIBLE and REFUTED, pick PLAUSIBLE. Every time.

Respond with exactly one word and a brief reason:
CONFIRMED: <one sentence why it is correct>
PLAUSIBLE: <one sentence what context is missing>
REFUTED: <one sentence with the specific diff line that disproves the finding>`;
}

/** Serialize a finding for verification prompt */
export function buildVerifyFindingInfo(f: {
  file: string;
  line?: number;
  severity: string;
  category: string;
  issue: string;
  fix: string;
  codeQuote?: string;
}): string {
  const parts: string[] = [];
  parts.push(`**File**: \`${f.file}${f.line != null ? ":" + f.line : ""}\``);
  parts.push(`**Severity**: ${f.severity}`);
  parts.push(`**Category**: ${f.category}`);
  parts.push(`**Issue**: ${f.issue}`);
  parts.push(`**Suggested Fix**: ${f.fix}`);
  if (f.codeQuote) {
    parts.push(`**Code Quote**: \`\`\`\n${f.codeQuote}\n\`\`\``);
  }
  return parts.join("\n");
}