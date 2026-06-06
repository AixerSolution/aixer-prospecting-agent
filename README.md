# Aixer Solutions — Prospecting Agent v1

**GitHub:** https://github.com/AixerSolution/aixer-prospecting-agent

An AI-powered daily lead generation system for [Aixer Solutions](https://www.aixers.com). Finds Singapore SMEs, scores their fit for AI consultancy services, and drafts personalised cold emails.

## How it works

Four agents run in sequence on a target sector:

| Phase | Agent | What it does |
|---|---|---|
| 1 | **Prospector** | Finds 5–12 candidate companies via Claude model knowledge + SBF-targeted searches |
| 1.5 | **SME Verifier** | Web-searches each company; discards if revenue/capital > SGD 5M or company is inactive |
| 2 | **Fit Assessor** | Scores on 5 dimensions (automation readiness, tech maturity, multi-agent fit, revenue stage, customer AI readiness) |
| 3 | **Outreach** | Drafts a personalised cold email for each qualified lead (score > 0.5) |

## Requirements

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com) with web search access enabled

## Setup

```bash
npm install
cp .env.example .env
# add your ANTHROPIC_API_KEY to .env
```

## Usage

```bash
# Today's sector (rotates by day of week)
ANTHROPIC_API_KEY=sk-ant-... node prospecting.mjs

# Specific sector
ANTHROPIC_API_KEY=sk-ant-... node prospecting.mjs --sector "Healthcare"
```

Sectors in the default rotation: Manufacturing & Logistics, Retail & E-commerce, Financial Services, Professional Services, Healthcare.

## Configuration

| File | Purpose |
|---|---|
| `config.json` | Model, sector rotation, revenue/employee thresholds, max emails per run |
| `20_SEARCH_MATRIX.json` | Per-sector search queries and optional `seed_companies` list |
| `30_FIT_SCORING_RUBRIC.json` | Dimension weights and score thresholds |
| `40_EMAIL_TEMPLATES.json` | Email tone and format rules |
| `50_SYSTEM_PROMPTS.md` | Full agent system prompts for reference |

**Target criteria (default):** Revenue SGD 300K–5M, 5–200 employees, Singapore-registered, not MNC subsidiaries.

**Score thresholds:** PASS < 0.3 | NURTURE 0.3–0.5 | FOLLOW_UP 0.5–0.7 | PRIORITIZE 0.7–0.85 | URGENT > 0.85

## Seeded runs (low-coverage sectors)

For sectors where the model hallucinates company names (e.g. Construction), add a `seed_companies` array to the sector entry in `20_SEARCH_MATRIX.json`. The Prospector will research those exact companies instead of discovering from scratch — bypassing hallucination risk entirely.

## Output

Results are saved to `output/prospecting_<timestamp>.json` with:
- `qualified_leads` — companies scoring > 0.5 with fit scores and signals
- `all_scored` — every company that reached the scoring phase
- `outreach_emails` — generated email drafts (review before sending)

## Known limitations

- **Manufacturing & Logistics** has a high hallucination rate — always use `seed_companies` for this sector.
- Decision-maker names should be independently verified before sending emails; the Prospector agent can hallucinate contact names in sectors with sparse online coverage.

## Rate limiting

The agent sleeps 12s between SME verification calls and uses exponential backoff (20/40/60/80s) on 429 errors.
