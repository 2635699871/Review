# AI PR Review Assistant

AI-powered Pull Request review tool that helps developers improve PR review efficiency and quality. Specify a GitHub PR, and the system automatically fetches changes, performs intelligent multi-dimensional analysis, and generates actionable review findings.

## Features

- **PR Change Summary** — Auto-generated overview of what the PR changes
- **Risk Code Identification** — Flags high-risk files (auth, payment, database) for deeper scrutiny
- **Multi-Dimensional Review** — 4 parallel review dimensions covering:
  - **Correctness** — Logic errors, null safety, edge cases, race conditions
  - **Security** — Injection, XSS, hardcoded secrets, auth gaps, OWASP checks
  - **Performance** — N+1 queries, sync blocking, missing pagination, memory patterns
  - **Maintainability** — Dead code, magic numbers, deep nesting, naming issues
- **Confidence Gate** — 4-question pre-report filter that drops vague/unverified findings
- **Signal-to-Noise Control** — Targets >60% actionable rate, trims low-signal findings
- **Smart Filtering** — Excludes lockfiles, generated code, binaries, vendor directories
- **Multiple Outputs** — Terminal (rich), Markdown report, GitHub PR review (COMMENT mode)

## Quick Start

```bash
# Install
cd pr-review-assistant
npm install

# Set your API key
export ANTHROPIC_API_KEY="sk-ant-..."

# For private repos, set a GitHub token
export GITHUB_TOKEN="ghp_..."

# Run a review
npx tsx src/index.ts owner/repo#123
npx tsx src/index.ts https://github.com/owner/repo/pull/42
```

## Usage

```
pr-review <pr> [options]

Arguments:
  pr    GitHub PR identifier: owner/repo#123 or URL

Options:
  -d, --deep            Deep review with repo-level context
  -o, --output <mode>   Output: terminal, markdown, github, or all (default: all)
  --dimensions <list>   Dimensions: correctness,security,performance,maintainability
  --max-files <n>       Max files to review (default: 50)
  -v, --verbose         Verbose logging
```

### Examples

```bash
# Basic review
npx tsx src/index.ts facebook/react#28421

# Security-focused review only
npx tsx src/index.ts owner/repo#42 --dimensions security,correctness

# Deep review with full context
npx tsx src/index.ts owner/repo#42 --deep --verbose

# Large PR — limit scope
npx tsx src/index.ts owner/repo#42 --max-files 20 --dimensions correctness
```

## Output

### Terminal

```
============================================================
  PR Review: #42 — Add user authentication middleware
============================================================
 Repo:  owner/repo
 Author: jane-dev
 Branch: feature/auth -> main
 State:  open | CI: all pass
 Files: 8 changed (+342 -56) | 6 finding(s)
============================================================

  !! CRITICAL (1) — must fix before merge

  [CRITICAL] JWT secret defaults to hardcoded value
  File: src/auth/jwt-middleware.ts:15
  Fix: Remove the default. Throw if JWT_SECRET is unset.

  Verdict: BLOCK — 1 CRITICAL issue must be resolved
============================================================
```

### Markdown

Full reports saved to `.pr-review/pr-{number}-review.md` with findings table, dimension coverage, and file analysis summary.

## How It Works

### Review Pipeline

```
User Input → [Phase 1: Fetch] → [Phase 2: Filter] → [Phase 3: Review] → [Phase 4: Aggregate] → [Phase 5: Report]
```

1. **Fetch** — Parallel GitHub API calls for PR metadata, files, commits, CI status
2. **Filter** — Excludes lockfiles, generated code, binaries; categorizes files
3. **Review** — Each dimension runs as an independent Claude API call with specialized system prompts
4. **Aggregate** — Dedup, confidence gate (4-question filter), severity ranking
5. **Report** — Terminal output + Markdown artifact + optional GitHub PR review

### Design Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| **Model** | Claude Sonnet 4 + thinking mode | 200K context window, prompt caching (90% cost savings across dimensions), thinking mode reduces false positives |
| **Review mode** | COMMENT only | AI must never auto-approve PRs; human always has final say |
| **Context** | Progressive 3-level | Diff hunks by default → full files for high-risk → repo conventions with `--deep` |
| **Dimensions** | 4 parallel | Correctness, Security, Performance, Maintainability — covers 80%+ of review value |
| **Confidence** | 4-question gate | Proven pattern from ECC code-reviewer; directly addresses signal-to-noise |
| **Cost** | ~$1-3 per review | Sonnet cheaper than Opus; prompt caching amortizes diff across dimensions |

### Context Strategy

| Level | Content | Token Cost | When |
|-------|---------|------------|------|
| 0 | PR metadata + commits | ~2K | Always |
| 1 | Unified diff hunks | ~20-80K | Default review |
| 2 | Full file at head revision | Variable | High-risk files |
| 3 | CLAUDE.md + conventions | High | `--deep` flag |

Token budget scales with PR size:
- ≤5 files → full file review
- ≤20 files → diff + escalation
- ≤50 files → diff-only
- >50 files → reduced dimensions, warning

### Future Extensions

1. **Plugin System** — Community-contributed language/domain-specific dimensions
2. **Incremental Re-Review** — Only re-review changed files on PR update
3. **Review History DB** — SQLite storage for trend analysis and false positive learning
4. **Local Checkout Mode** — Clone PR branch and run real tests/type-checking
5. **Custom Rule Engine** — `.pr-review/rules/` for project-specific conventions
6. **GitHub Action** — CI integration, triggered on pull_request events
7. **Multi-Provider** — Support for GPT-4, Gemini, local models (Ollama)

## Project Structure

```
src/
  index.ts              # CLI entry point
  cli.ts                # Commander setup
  types.ts              # Shared TypeScript types
  core/
    config.ts           # Configuration loading
    orchestrator.ts     # 5-phase pipeline conductor
    confidence-gate.ts  # 4-question signal/noise filter
  pipeline/
    fetcher.ts          # GitHub PR data fetching
    context-builder.ts  # Progressive context assembly
    aggregator.ts       # Dedup + rank + confidence filter
  models/
    claude-client.ts    # Anthropic SDK wrapper + prompt caching
    prompts.ts          # Pluggable dimension registry + system prompts
    provider-router.ts  # Multi-provider LLM client (Anthropic, OpenAI, DeepSeek)
  output/
    terminal.ts         # Rich terminal formatting
    markdown.ts         # .pr-review/pr-N-review.md + GitHub review
  utils/
    file-filter.ts      # Exclude lockfiles/generated/vendor
    language-detect.ts  # Language identification
    token-budget.ts     # Budget allocation + large-PR warning
tests/
  unit/
    config.test.ts
    file-filter.test.ts
    confidence-gate.test.ts
    aggregator.test.ts
```

## License

MIT
