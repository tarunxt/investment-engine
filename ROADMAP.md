# India Equity Swing-Trading Intelligence Platform

## Mission

Build a fully automated, multi-LLM research pipeline that gathers fresh Indian market intelligence, fans it out to 8 AI models simultaneously, synthesizes the results into a consensus shortlist, reviews that shortlist against the user's live Zerodha portfolio, and delivers a single actionable rebalance strategy — all in one button click.

**Prompt template:** `prompts/prompt-1.txt`  
**Pipeline design:** `plan.md`

---

## Pipeline Overview

```
┌─────────────────────────────────────────────────────────┐
│  STAGE 1 — Independent Research  (8 LLMs in parallel)   │
│                                                         │
│  GPT Thinking · GPT Extended Thinking                   │
│  Gemini Flash · Gemini Pro                              │
│  DeepSeek Chat · DeepSeek Reasoner                      │
│  Claude Sonnet · Claude Opus                            │
└────────────────────────┬────────────────────────────────┘
                         │ 8 stock-pick tables
                         ▼
┌─────────────────────────────────────────────────────────┐
│  STAGE 2 — Cross-LLM Synthesis  (GPT Extended Thinking) │
│  Consensus picks · filter weak ideas · ranked shortlist │
└────────────────────────┬────────────────────────────────┘
                         │ consolidated table
                         ▼
              ┌──────────┴──────────┐
              │  Zerodha Holdings   │  (CSV upload / Kite API)
              └──────────┬──────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│  STAGE 3 — Portfolio Review  (4 LLMs in parallel)       │
│                                                         │
│  GPT Extended Thinking · Gemini Pro                     │
│  Claude Sonnet Adaptive · DeepSeek Reasoner             │
│                                                         │
│  → hold / add / trim / exit / rotate decisions          │
└────────────────────────┬────────────────────────────────┘
                         │ 4 decision tables
                         ▼
┌─────────────────────────────────────────────────────────┐
│  STAGE 4 — Meta-Decision  (GPT Extended Thinking)       │
│  Final rebalance plan · conviction ranking · risk notes │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
              📄 Markdown / PDF Export
```

---

## ✅ Completed — Infrastructure Foundation

| CP | Name | Delivered |
|----|------|-----------|
| CP-0 | Docker Foundation | Compose stack, container orchestration |
| CP-1 | Frontend Stack | Next.js 15, Tailwind, App Router layout |
| CP-2 | Backend API | FastAPI, route structure, schemas |
| CP-3 | Data Layer | PostgreSQL, SQLAlchemy models, Alembic |
| CP-4 | Queue System | Redis, Celery workers, task dispatch |
| CP-5 | Async Jobs | Job model, worker execution, status lifecycle |
| CP-6 | Polling APIs | `GET /jobs`, `GET /jobs/{id}`, frontend polling |
| CP-7 | Infrastructure Stabilization | Config, structured logging, health checks, error handling |
| CP-8 | AI Provider Abstraction | OpenAI + Gemini providers, factory, token tracking, cost estimation |

---

## 🔧 Active — Platform Hardening

### CP-9: Worker Reliability
**Status:** Not Started | **Effort:** 1–2 days

- [ ] Retry with exponential backoff (`max_retries=3`, `retry_backoff=True`)
- [ ] Task time limits: `soft_time_limit=120s`, `time_limit=180s`
- [ ] Dead letter queue for permanently failed jobs
- [ ] Idempotency guard — skip re-execution if job already `completed`

**Blocks:** CP-P2 (fan-out requires reliable workers)

---

### CP-10: Cost Analytics
**Status:** Not Started | **Effort:** 1 day

- [ ] `GET /jobs/stats/cost` — aggregate cost by provider, date, run
- [ ] Per-run total cost displayed on Run detail page
- [ ] Cost trend chart on dashboard

---

### CP-13: Authentication & Security
**Status:** Partially complete

**Done:**
- [x] JWT access + refresh tokens
- [x] bcrypt password hashing
- [x] Login / logout / register endpoints
- [x] CORS locked to specific frontend origin

**Remaining:**
- [ ] Rate limiting on login (5 attempts / 15 min)
- [ ] API key generation (`aip_<32chars>`) for programmatic access

---

### CP-13A: User Management
**Status:** Not Started | **Effort:** 1–2 days

- [ ] RBAC: admin / user / viewer roles
- [ ] `GET /jobs` filtered by authenticated user (users see only their own jobs)
- [ ] `GET /users/{id}`, `PUT /users/{id}`, `DELETE /users/{id}` (admin)
- [ ] `GET /users/{id}/activity` audit log endpoint
- [ ] User profile: avatar URL, bio, timezone, preferences

**Blocks:** CP-13B

---

### CP-13B: User Dashboard
**Status:** Not Started | **Effort:** 2 days

- [ ] Personal job history page with status filters and search
- [ ] Profile settings page (avatar, bio, timezone)
- [ ] Password change page
- [ ] Active sessions list with individual revoke

**Blocks:** CP-P4 (portfolio page lives under the user console)

---

## 🧠 Trading Intelligence Pipeline

### CP-P1: Prompt Management
**Status:** Complete

Store, version, and serve research prompt templates.

**Completion criteria:**
- [x] `Prompt` model: `id`, `name`, `body`, `version`, `created_at`
- [x] Seed `prompts/prompt-1.txt` as the default prompt on first startup
- [x] `GET /prompts` · `POST /prompts` · `GET /prompts/{id}` · `PUT /prompts/{id}`
- [x] Frontend: prompt dropdown in Create Job form populates the textarea

**Migration:** `prompts` table

**Depends on:** CP-8

---

### CP-P2: Multi-LLM Fan-Out — Stage 1
**Status:** Not Started | **Effort:** 2–3 days

Dispatch one research prompt to all 8 configured LLMs simultaneously.

**LLMs:**

| Slot | Provider | Model | Stage 1 Role |
|------|----------|-------|--------------|
| 1 | OpenAI | `o1` | GPT Thinking |
| 2 | OpenAI | `o3` | GPT Extended Thinking |
| 3 | Gemini | `gemini-1.5-flash` | Gemini Fast |
| 4 | Gemini | `gemini-1.5-pro` | Gemini Thinking |
| 5 | DeepSeek | `deepseek-chat` | DeepSeek Search |
| 6 | DeepSeek | `deepseek-reasoner` | DeepSeek DeepThink |
| 7 | Anthropic | `claude-sonnet-4-6` | Claude 1 |
| 8 | Anthropic | `claude-opus-4-7` | Claude 2 |

**Completion criteria:**
- [ ] `DeepSeekProvider` added (`providers/deepseek_provider.py`) — OpenAI-compatible base URL
- [ ] `AnthropicProvider` added (`providers/anthropic_provider.py`)
- [ ] `Run` model: `id`, `prompt_id`, `status`, `stage`, `synthesis_response`, `decision_response`, `created_at`
- [ ] `RunJob` model: `run_id`, `job_id`, `stage` — links a run to its child jobs
- [ ] `POST /runs` — creates a Run, fans out one job per configured LLM via `celery.group`, returns `run_id`
- [ ] `GET /runs` · `GET /runs/{id}` — run list and real-time child-job status
- [ ] Frontend: "New Research Run" button · `/runs` page · per-run progress view

**Migrations:** `runs`, `run_jobs` tables  
**Depends on:** CP-9, CP-P1 | **Blocks:** CP-P3

---

### CP-P3: Cross-LLM Synthesis — Stage 2
**Status:** Not Started | **Effort:** 2 days

After all Stage 1 jobs complete, synthesize outputs into a single consensus shortlist.

**Completion criteria:**
- [ ] `celery.chord` callback fires when all 8 Stage 1 jobs finish
- [ ] `SynthesisService` (`services/synthesis.py`) assembles the synthesis prompt from Stage 1 responses
- [ ] Synthesis dispatched to `o3` (GPT Extended Thinking)
- [ ] Output: ranked consensus table in the same markdown format as `prompt-1.txt`
- [ ] `runs.synthesis_response` populated; `GET /runs/{id}/synthesis` endpoint
- [ ] Frontend: synthesis result shown on Run detail page after Stage 1 completes

**Synthesis prompt structure:**
```
Given 8 independent stock-pick tables from different AI models:
<stage1_outputs>
Identify: consensus picks (≥3 models), high-conviction outliers, names to discard.
Produce a single ranked table in the standard format.
```

**Depends on:** CP-P2 | **Blocks:** CP-P5

---

### CP-P4: Zerodha Portfolio Import
**Status:** Not Started | **Effort:** 1–2 days

Import the user's live holdings so Stage 3 can compare recommendations against real positions.

**Completion criteria:**
- [ ] `Holding` model: `user_id`, `symbol`, `qty`, `avg_price`, `current_price`, `pnl_pct`, `uploaded_at`
- [ ] `POST /portfolio/upload` — parses Zerodha CSV export
- [ ] `GET /portfolio` — current holdings list
- [ ] Frontend: Portfolio page in sidebar (upload button + holdings table)
- [ ] *(Phase 2)* `POST /portfolio/kite` — OAuth flow with Kite Connect for live sync

**Zerodha CSV columns:** `Instrument · Qty · Avg. cost · LTP · Cur. val · P&L · Net chg. · Day chg.`

**Migration:** `holdings` table  
**Depends on:** CP-13A | **Blocks:** CP-P5

---

### CP-P5: Portfolio Review — Stage 3
**Status:** Not Started | **Effort:** 2 days

Four LLMs independently review the synthesis shortlist against current holdings and recommend actions.

**LLMs:**

| Slot | Provider | Model |
|------|----------|-------|
| 1 | OpenAI | `o3` — GPT Extended Thinking |
| 2 | Gemini | `gemini-1.5-pro` — Gemini Thinking |
| 3 | Anthropic | `claude-sonnet-4-6` — Claude Sonnet Adaptive |
| 4 | DeepSeek | `deepseek-reasoner` — DeepSeek |

**Completion criteria:**
- [ ] `celery.chord` callback fires when Stage 2 synthesis completes
- [ ] `PortfolioReviewService` (`services/review.py`) builds the review prompt
- [ ] Four Stage 3 jobs fanned out in parallel via `celery.group`
- [ ] Each output: decision table — symbol · action · qty · price zone · rationale · conviction score
- [ ] `GET /runs/{id}/review` — returns all 4 Stage 3 responses
- [ ] Frontend: Stage 3 results shown side-by-side on Run detail page

**Review prompt structure:**
```
Current Zerodha holdings: <holdings_table>
Stage 2 consensus picks:  <synthesis_table>

Act as a professional India equity swing-trading strategist.
For each holding and each new pick, decide: hold / add / trim / exit / rotate.
Output a decision table with conviction score and rationale.
```

**Depends on:** CP-P3, CP-P4 | **Blocks:** CP-P6

---

### CP-P6: Meta-Decision — Stage 4
**Status:** Not Started | **Effort:** 1–2 days

One final LLM synthesizes all four Stage 3 reviews into a single, clean, actionable rebalance plan.

**Completion criteria:**
- [ ] `celery.chord` callback fires when all Stage 3 jobs complete
- [ ] `MetaDecisionService` (`services/decision.py`) assembles final prompt from 4 Stage 3 outputs
- [ ] Decision dispatched to `o3` (GPT Extended Thinking)
- [ ] `runs.decision_response` populated; `GET /runs/{id}/decision` endpoint
- [ ] `GET /runs/{id}/export` — returns formatted Markdown report
- [ ] Frontend: "Export Report" button · Markdown preview on Run detail page

**Final report sections:**
```markdown
## [DATE] | Portfolio Rebalance Strategy

### Immediate Actions
| Stock | Action | Qty | Price Zone | Rationale | Conviction |

### Holds (No Change)
| Stock | Current Position | Reason |

### Risk Notes
...
```

**Depends on:** CP-P5 | **Blocks:** CP-P7

---

### CP-P7: Run History & Analytics
**Status:** Not Started | **Effort:** 1 day

Track all research runs over time and surface recurring signals.

- [ ] `GET /runs` paginated list: date, total cost, status, final decision preview
- [ ] Per-run aggregate cost (sum of all child job costs)
- [ ] "Most frequently picked stocks" across the last N runs
- [ ] Historical run comparison on dashboard

**Depends on:** CP-P6

---

## 📋 Future Checkpoints

### CP-11: Scheduled Runs
Automatically trigger the full Stage 1→4 pipeline on a cron schedule (daily pre-market, weekly review).
- [ ] `Schedule` model with cron expression + linked prompt
- [ ] Celery Beat integration
- [ ] `POST/GET/DELETE /schedules` endpoints
- [ ] Frontend schedule manager

**Depends on:** CP-9, CP-P2

---

### CP-14: Live Market Data Injection
Augment Stage 1 prompts with real-time NSE/BSE data so LLMs reason over fresh numbers.
- [ ] NSE/BSE price feed (Yahoo Finance / AlphaVantage)
- [ ] Indian market news aggregation (Google News RSS)
- [ ] Data freshness cache with 15-min TTL
- [ ] Prompt builder auto-injects current prices + headlines

**Depends on:** CP-P2

---

### CP-16: Observability
- [ ] Flower dashboard for Celery queue visibility
- [ ] Prometheus `/metrics` endpoint
- [ ] Grafana: jobs/min, stage latencies, cost/run, provider error rates
- [ ] Alert if a run is stuck in processing > 30 min

---

### CP-17: Production Deployment
- [ ] GitHub Actions CI/CD (lint → test → build → push)
- [ ] Frontend on Vercel
- [ ] Backend + workers on Railway or ECS
- [ ] Secrets via environment / Vault
- [ ] Automated Alembic migrations on deploy

---

## 🎯 Build Sequence

```
Now
 1.  CP-9   — Worker reliability (retries, timeouts)
 2.  CP-13  — Auth hardening (rate limiting, API keys)
 3.  CP-13A — User management + RBAC
 4.  CP-13B — User dashboard
 5.  CP-P1  — Prompt management (seed prompt-1.txt)
 6.  CP-P2  — Multi-LLM fan-out + DeepSeek/Anthropic providers + Run model
 7.  CP-P3  — Stage 2 synthesis (chord callback → o3)
 8.  CP-P4  — Zerodha portfolio import (CSV upload)
 9.  CP-P5  — Stage 3 portfolio review (4 LLMs)
10.  CP-P6  — Stage 4 meta-decision + Markdown export
11.  CP-P7  — Run history & analytics
12.  CP-10  — Cost analytics
─────────────────────────────────────────
Later
13.  CP-11  — Scheduled runs (Celery Beat)
14.  CP-14  — Live market data injection
15.  CP-16  — Observability (Flower, Prometheus, Grafana)
16.  CP-17  — Production deployment (CI/CD, cloud)
```
