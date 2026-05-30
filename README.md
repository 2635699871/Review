# AI PR Review Assistant

AI-powered Pull Request review tool that helps developers improve PR review efficiency and quality. Specify a GitHub PR, and the system automatically fetches changes, performs intelligent multi-dimensional analysis, and generates actionable review findings — with Chinese brief review support.

## Features

- **Multi-Dimensional Review** — 4 parallel review dimensions:
  - **Correctness** — Logic errors, null safety, edge cases, race conditions
  - **Security** — Injection, XSS, hardcoded secrets, auth gaps, OWASP checks
  - **Performance** — N+1 queries, sync blocking, missing pagination, memory patterns
  - **Maintainability** — Dead code, magic numbers, deep nesting, naming issues
- **Chinese Brief Review** — Per-finding Chinese one-line assessment (zhBrief) generated at near-zero cost via LLM prompt injection; overall Chinese summary paragraph (zhSummary) via lightweight LLM call
- **Smart Filtering** — Built-in exclusion of lockfiles, generated code, binaries, vendor directories; plus custom glob exclusion patterns (`--exclude "*.generated.*,src/vendor/**"`)
- **Confidence Gate** — 4-question pre-report filter that drops vague/unverified findings
- **Signal-to-Noise Control** — Targets >60% actionable rate, trims low-signal findings
- **Multi-Provider Support** — Anthropic (Sonnet 4 + thinking + prompt caching), OpenAI, DeepSeek, Gemini, Groq, and any OpenAI-compatible API
- **Multiple Interfaces** — CLI, Web UI (Express + SSE streaming), and direct GitHub PR review submission
- **Multiple Outputs** — Terminal (rich), Markdown report, GitHub PR review (COMMENT mode)

## Quick Start

```bash
# Install
cd pr-review-assistant
npm install

# Set your API key (any supported provider)
export ANTHROPIC_API_KEY="sk-ant-..."

# For private repos, set a GitHub token
export GITHUB_TOKEN="ghp_..."

# Run a review
npx tsx src/index.ts owner/repo#123
npx tsx src/index.ts https://github.com/owner/repo/pull/42
```

### Web UI

```bash
# Start the web server
npm start
# or
npx tsx src/server.ts

# Open http://localhost:3300
```

## Usage

```
pr-review <pr> [options]

Arguments:
  pr                     GitHub PR identifier: owner/repo#123 or URL

Options:
  -d, --deep             Deep review with repo-level context
  -o, --output <mode>    Output: terminal, markdown, github, or all (default: all)
  --dimensions <list>    Dimensions: correctness,security,performance,maintainability
  --max-files <n>        Max files to review (default: 50)
  --provider <id>        LLM provider: anthropic, openai, deepseek, gemini, groq
  --model <name>         Override the default model for the selected provider
  --exclude <patterns>   Additional glob patterns to exclude (comma-separated)
  -v, --verbose          Verbose logging
```

### Examples

```bash
# Basic review
npx tsx src/index.ts facebook/react#28421

# Security-focused review with OpenAI
npx tsx src/index.ts owner/repo#42 --provider openai --dimensions security,correctness

# Deep review with full context
npx tsx src/index.ts owner/repo#42 --deep --verbose

# Exclude generated files and vendor directories
npx tsx src/index.ts owner/repo#42 --exclude "*.generated.*,src/vendor/**"

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
  简评:    JWT密钥使用硬编码默认值，存在严重安全隐患

  Verdict: BLOCK — 1 CRITICAL issue must be resolved
============================================================
```

### Markdown

Full reports saved to `.pr-review/pr-{number}-review.md` with findings table, dimension coverage, Chinese summary section, and file analysis summary.

## How It Works

### Review Pipeline

```
User Input → [Phase 1: Fetch] → [Phase 2: Filter] → [Phase 3: Review] → [Phase 4: Aggregate] → [Phase 4.5: Chinese Summary] → [Phase 5: Report]
```

1. **Fetch** — Parallel GitHub API calls for PR metadata, files, commits, CI status
2. **Filter** — Excludes lockfiles, generated code, binaries, vendor directories; applies custom glob exclusion patterns
3. **Review** — Each dimension runs as an independent LLM call with specialized system prompts; warmup-then-parallel strategy for prompt caching (90% cost savings)
4. **Aggregate** — Dedup, confidence gate (4-question filter), severity ranking
5. **Chinese Summary** — Lightweight LLM call (max_tokens: 512, no thinking) generates 4-6 sentence Chinese summary from ranked findings
6. **Report** — Terminal output + Markdown artifact + optional GitHub PR review

### Design Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| **Model** | Claude Sonnet 4 + thinking mode | 200K context window, prompt caching (90% cost savings across dimensions), thinking mode reduces false positives |
| **Review mode** | COMMENT only | AI must never auto-approve PRs; human always has final say |
| **Context** | Progressive 3-level | Diff hunks by default → full files for high-risk → repo conventions with `--deep` |
| **Dimensions** | 4 parallel | Correctness, Security, Performance, Maintainability — covers 80%+ of review value |
| **Confidence** | 4-question gate | Proven pattern from ECC code-reviewer; directly addresses signal-to-noise |
| **Chinese review** | Hybrid (prompt injection + lightweight call) | zhBrief via LLM prompt at near-zero cost; zhSummary via small separate call |
| **Cost** | ~$1-3 per review | Sonnet cheaper than Opus; prompt caching amortizes diff across dimensions |

## Project Structure

```
src/
  index.ts              # CLI entry point
  cli.ts                # Commander setup
  server.ts             # Express + SSE web server
  types.ts              # Shared TypeScript types
  core/
    config.ts           # Configuration loading
    orchestrator.ts     # 6-phase pipeline conductor
    confidence-gate.ts  # 4-question signal/noise filter
  pipeline/
    fetcher.ts          # GitHub PR data fetching
    context-builder.ts  # Progressive context assembly
    aggregator.ts       # Dedup + rank + confidence filter
  models/
    claude-client.ts    # Anthropic SDK wrapper + prompt caching
    prompts.ts          # Dimension system prompts + Chinese summary prompt
    provider-registry.ts    # Multi-provider registry and config
    provider-router.ts      # Unified LLM client (Anthropic, OpenAI, etc.)
  output/
    terminal.ts         # Rich terminal formatting
    markdown.ts         # .pr-review/pr-N-review.md + GitHub review
  storage/
    history.ts          # Review history + feedback persistence
  utils/
    file-filter.ts      # File exclusion (built-in + custom glob)
    language-detect.ts  # Language identification
    token-budget.ts     # Budget allocation + large-PR warning
public/
  index.html            # Web UI (SSE streaming, history, settings)
tests/
  unit/                 # Unit tests
  integration/          # Pipeline integration tests
  fixtures/             # Test data
```

## Supported Providers

| Provider | Default Model | API Key Env |
|----------|--------------|-------------|
| Anthropic | claude-sonnet-4-20250514 | `ANTHROPIC_API_KEY` |
| OpenAI | gpt-4o | `OPENAI_API_KEY` |
| DeepSeek | deepseek-chat | `DEEPSEEK_API_KEY` |
| Gemini | gemini-2.5-pro | `GEMINI_API_KEY` |
| Groq | llama-4-maverick-17b | `GROQ_API_KEY` |

Custom OpenAI-compatible endpoints supported via `--provider` with `--api-base-url` and `--model`.

## Dependencies

### Runtime

| Package | Purpose | Why |
|---------|---------|-----|
| `@anthropic-ai/sdk` | Anthropic Claude API client | Native SDK for prompt caching + thinking mode support |
| `chalk` | Terminal color output | Rich formatting for review findings display |
| `commander` | CLI argument parsing | Standard Node.js CLI framework |
| `express` | Web server | SSE streaming for Web UI |
| `ora` | Terminal spinner | Progress indication during review |
| `zod` | Schema validation | JSON schema parsing for LLM responses |

### Development

| Package | Purpose |
|---------|---------|
| `typescript` | Type checking |
| `tsx` | TypeScript execution (no build step) |
| `vitest` | Test runner |
| `eslint` | Linting |
| `prettier` | Code formatting |
| `@types/express`, `@types/node` | Type definitions |

### Original Work Boundary

All code under `src/` is original work developed during the competition window (May 29–31, 2026). The project uses the above open-source libraries as infrastructure (API clients, CLI framework, web server) — none of the review logic, pipeline orchestration, prompt engineering, confidence gating, or multi-provider routing is adapted from third-party code.

## Future Directions

- **RAG-enhanced context** — Index repository conventions, past reviews, and project-specific patterns via vector store to ground each review in repo-specific knowledge
- **Review quality feedback loop** — Learn from user feedback (false positive / false negative labels already stored) to tune confidence thresholds and suppress recurring noise patterns
- **Incremental review** — Track which files/findings were already reviewed in prior PRs; skip re-review of unchanged code and surface only net-new findings
- **Custom dimension plugins** — Allow teams to define their own review dimensions (e.g., i18n, a11y, regulatory compliance) as pluggable prompt modules
- **Multi-model ensemble** — Run the same dimension across different models and cross-validate findings to reduce single-model blind spots
- **IDE integration** — VS Code / JetBrains extension to trigger reviews and view findings directly in the editor without leaving the coding flow

## Originality Statement

本项目（pr-review-assistant）在 2026 年 5 月 29 日至 31 日比赛期间从零自主开发，未复用任何个人旧代码或第三方 AI Review 工具的核心逻辑。所有代码原创，无抄袭。

## License

MIT
