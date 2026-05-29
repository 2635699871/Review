# CLAUDE.md

AI-powered Pull Request review assistant. Fetches PR changes via GitHub MCP and provides intelligent code review with risk analysis.

## Project structure

- `src/index.ts` — CLI entry point (`pr-review owner/repo#123`)
- `src/cli.ts` — Commander setup and argument parsing
- `src/core/` — Orchestrator, config, confidence gate
- `src/pipeline/` — Fetcher, context-builder, diff-analyzer, reviewer, aggregator, reporter
- `src/dimensions/` — correctness, security, performance, maintainability
- `src/models/` — Claude client wrapper, model router, prompt templates
- `src/output/` — terminal, markdown, GitHub publishers
- `src/utils/` — file-filter, language-detect, token-budget

## Run

```bash
npx tsx src/index.ts owner/repo#123
npx tsx src/index.ts https://github.com/owner/repo/pull/123 --deep
npx tsx src/index.ts owner/repo#123 --dimensions security,correctness
```

## Tests

```bash
npm test              # vitest run
npm run test:watch    # vitest watch mode
```

## Key decisions

- TypeScript ESM throughout
- Claude Sonnet 4 + thinking mode for code review analysis
- Prompt caching for diff content shared across dimensions
- COMMENT mode only for GitHub PR reviews (never auto-approve)
- Progressive context: diff hunks → full files → repo conventions