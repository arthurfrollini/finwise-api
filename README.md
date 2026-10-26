# Finwise API

REST API for a personal finance app. Users track bank accounts and transactions by category, with plan-based limits enforced through Stripe subscriptions. Three AI features run on the Claude API, and each one has its own eval:

- automatic transaction categorization;
- answers grounded in Banco Central do Brasil's financial education material, with citations;
- a spending Q&A agent that calls tools over the user's own data.

## Stack

- **Runtime:** Node.js + NestJS 11 (TypeScript)
- **Database:** PostgreSQL 17 with pgvector, via Prisma 6 (Docker image `pgvector/pgvector:pg17-trixie`)
- **Queues:** BullMQ on Redis (email retries, transaction categorization, agent runs)
- **AI:** Claude API. Haiku 5.5 categorizes, Sonnet 5.5 answers and runs the agent, Opus 5.5 judges eval answers. Local multilingual embeddings come from transformers.js (`Xenova/multilingual-e5-small`).
- **Auth:** JWT access token + UUID refresh token + Google OAuth 2.0
- **Email:** Resend
- **Storage:** AWS S3 (avatar upload via presigned URL)
- **Billing:** Stripe (subscriptions, webhooks, dunning)
- **Security:** IP rate limiting (`@nestjs/throttler`), per-plan AI quotas, a global daily AI spend ceiling
- **Observability:** OpenTelemetry traces and metrics to Jaeger and Prometheus, structured logs (`nestjs-pino`) to Loki, all in Grafana, including an LLM spend dashboard. A `/health` check and Grafana alert rules email whoever is on call when Postgres or Redis stops answering, the API goes down, 5xx errors climb, an endpoint or the database gets slow, or AI calls fail or overspend.
- **Tests:** Jest 30 + Supertest. 480 unit tests (including the eval harness) and 97 e2e tests, 95.7% combined statement coverage. Mocks are typed (`jest-mock-extended`), so a fixture that drifts from the real type fails to compile.
- **Type safety:** TypeScript `strict` plus `noUncheckedIndexedAccess` (an array or record lookup may be `undefined` until checked), with no `any`, no type assertions (`as const` aside) and no non-null `!` anywhere, tests included. ESLint enforces all three. Untrusted input (env vars, job payloads, JSON files, HTTP response bodies in e2e) is parsed with zod.

## Architecture

The codebase follows Clean Architecture:

- **Domain** (`domain/`): entities and repository interfaces, no framework dependencies
- **Application** (`application/`): services with the business logic, depending only on domain abstractions
- **Infrastructure** (`infra/`): Prisma repositories, HTTP controllers and DTOs, queue processors

Repositories are abstract classes in the domain layer, injected through NestJS DI, so swapping storage means writing a new `infra/database` implementation. The same pattern covers the embedding model: `EmbeddingProvider` is a DI token, and moving from local to hosted embeddings is a one-line binding change.

Shared concerns (auth guards, plan enforcement, mail, storage, billing, the Claude client) live in `src/shared/` as NestJS modules.

## Modules

| Module | Description |
|--------|-------------|
| `auth` | Sign up, sign in, refresh token, sign out, Google OAuth |
| `users` | Profile, avatar upload, email change flow, admin CRUD (including setting a user's plan) |
| `bank-accounts` | CRUD + current balance computed from transactions |
| `categories` | CRUD, gated by plan (GOLD/PLATINUM only) |
| `transactions` | CRUD with a daily limit per plan; uncategorized transactions are categorized by AI |
| `education` | Questions answered from BCB financial education material, with citations (RAG) |
| `assistant` | Spending Q&A agent over the user's own transactions |
| `billing` | Stripe subscriptions: setup, subscribe, change plan, cancel, webhook |

## AI features

Design specs and implementation plans are in `docs/superpowers/specs/` and `docs/superpowers/plans/`. Every Claude call logs its tokens, cost and latency (never user data), increments Prometheus counters, and writes an `ai_usage` row when it is made for a user.

### Transaction categorization

A transaction created without `categoryId` is saved immediately, and a BullMQ job asks `claude-haiku-5-5` to pick one of that user's categories of the same type. The request uses structured output with a hand-built JSON schema whose `enum` lists the user's category ids plus `none`. The SDK's `zodOutputFormat` helper would drop the `enum`, so it isn't used. The answer is validated again against the database for ownership and type, and written only if the transaction is still uncategorized, so a category the user sets meanwhile always wins.

On the 50-case golden set (41 real merchant names from the owner's statements, 9 synthetic), Haiku 5.5 is right 84% of the time, the same as Opus 5.5, at 1/37 of the cost (US$ 0.006 vs US$ 0.23 per run).

### Answers from BCB material (RAG)

`POST /education/questions` answers from the *Caderno de Educação Financeira: Conteúdo Básico* (Banco Central do Brasil, 2026).

- **Ingestion:** the PDF is copyrighted, so it is downloaded at ingest time, checked against the sha256 in `corpus/manifest.json`, and never committed. `pdftotext` extracts it, and paragraphs are merged into chunks that never cross a page (173 chunks).
- **Retrieval:** chunks are embedded locally and stored in pgvector with an HNSW cosine index. If even the best chunk is below a measured similarity floor, the model isn't called and the answer says the material doesn't cover the question.
- **Answering:** `claude-sonnet-5-5` gets the top 6 chunks as document blocks with the Citations API, so every citation carries the exact cited text, mapped back to a page.

Retrieval on 30 user-phrased questions: recall@5 50%, hit@1 23%, MRR@10 0.34. `evals/rag/README.md` explains why that is low and what to try next. Answer quality: 14 of 20 answers pass an Opus 5.5 judge, and all 20 cite sources.

### Spending Q&A agent

`POST /assistant/questions` returns 202 with a `runId`; `GET /assistant/runs/:runId` returns the status and the answer.

- **Execution:** each run is one BullMQ job. Inside it, `claude-sonnet-5-5` calls three read-only tools: `fetch_categories`, `query_transactions` and `compute_totals`.
- **Tenant scope:** the tool schemas have no user field. Handlers close over the run's user, taken from the authenticated request, so the model cannot reach another user's data.
- **Idempotency:** a repeated `Idempotency-Key` returns the same run without starting a new one.
- **Failure handling:** a run makes at most 6 model calls. Two consecutive rounds of failing tools, or a refusal, end it with a fixed degraded answer. A run whose job gives up is marked `FAILED`.

On 10 questions with exact expected amounts derived from a seeded user, 8 pass: the amount is in the answer, and an Opus 5.5 judge confirms it came from the tool results. The 2 misses hit the step limit and degraded rather than answering wrong.

### Evals

| Where | When | What |
|---|---|---|
| `ci.yml` | every PR and push to `main` | Fixture tests (schema validation, ownership checks, retry paths) and the retrieval eval, keyless and deterministic; any drop in recall@5 or MRR fails the build |
| `evals.yml` | 1st of each month, and on demand | Categorization golden set, RAG answers judged by Opus 5.5, agent cases; fails on a drop of more than 2 cases against the stored baseline |

```bash
npm run eval:retrieval                 # free: local embeddings + pgvector (run rag:ingest first)
npm run eval:categorization -- --models claude-haiku-5-5,claude-opus-5-5
npm run eval:rag-answers
npm run eval:agent                     # seeds its own user in DATABASE_URL
# add -- --update-baseline to record a new baseline after an intended change
```

Baselines live in `evals/baselines/`. Labels and their provenance are in `evals/categorization/LABELING.md`, `evals/rag/README.md` and `evals/agent/README.md`.

## Plans

| | FREE | GOLD | PLATINUM |
|---|---|---|---|
| Bank accounts | 3 | 5 | unlimited |
| Transactions/day | 50 | 200 | unlimited |
| Categories (CRUD) | read-only | full | full |
| AI categorization | yes | yes | yes |
| Education questions (RAG)/day | none | 20 | 50 |
| Assistant questions (agent)/day | none | 20 | 50 |
| Price | free | R$35/mo | R$65/mo |

Days are UTC. On top of the plan quotas, a global ceiling (`AI_DAILY_SPEND_LIMIT_USD`, default US$ 1) stops RAG and agent answers for everyone once a day's recorded Claude spend reaches it. FREE accounts get no RAG or agent questions, so creating free accounts in bulk can't spend AI credit. ADMINISTRATOR has no quota.

## Auth Flow

1. **Sign up / Sign in** returns an `accessToken` (JWT, short-lived) and a `refreshToken` (UUID, 7 days).
2. When the access token expires, `POST /auth/refresh` with the `refreshToken` issues a new pair and deletes the old token.
3. `POST /auth/signout` deletes the refresh token.
4. `GET /auth/google` starts Google OAuth; the callback links or creates the account.

Sign in, sign up and refresh allow 5 requests per minute per client IP. Every other route allows 100, and the AI endpoints 10.

## Email Flow (Resend)

- A welcome email on signup.
- Email change confirmation: the new address receives a token link, and `GET /users/confirm-email?token=…` applies the change.
- Billing: downgrade notification, and cancellation after payment failure.
- Every Resend call has a 10s timeout, so a hung provider can't stall the mail-queue worker; a timed-out send fails and the queue retries it.
- `MAIL_REDIRECT_TO` sends every email to one inbox (local dev). `MAIL_ENABLED=false` skips sending entirely.

## Avatar Upload (AWS S3)

1. `GET /users/me/avatar-upload-url?ext=jpg` returns `{ uploadUrl, avatarUrl }`. `ext` is checked against an image allowlist: jpg, jpeg, png, webp.
2. The frontend uploads directly to S3 with the presigned URL.
3. The frontend calls `PATCH /users/me` with `{ avatarUrl }` to save it.

## Billing Flow (Stripe)

1. `POST /billing/setup` creates a Stripe Customer and SetupIntent, and returns the `clientSecret` for Stripe Elements.
2. The user completes card setup on the frontend.
3. `POST /billing/subscribe` with `{ planId: 'GOLD' | 'PLATINUM' }` creates the subscription.
4. Stripe fires `invoice.payment_succeeded`, and the webhook updates `user.plan`.
5. `POST /billing/change-plan` invoices upgrades immediately (`always_invoice`) and applies downgrades at period end (`none`).
6. `POST /billing/cancel` sets `cancel_at_period_end: true`; the user keeps the plan until the period ends.
7. `customer.subscription.deleted` (dunning failure or period end) resets `user.plan` to FREE.

The webhook (`POST /billing/webhook`) validates the Stripe signature against the raw body. Processing is idempotent: every `event.id` is recorded in `processed_stripe_events` first, with a compensating delete on failure, so Stripe's at-least-once redelivery never applies a plan change twice or duplicates an email. A daily cron prunes those rows after 30 days.

With `BILLING_ENABLED=false`, setup, subscribe, change-plan and cancel answer 404, and an admin sets plans through `PATCH /users/:id`. The webhook keeps working.

## Developer Tools

The app runs with just `db` and `redis` up; the rest is optional.

| Tool | URL | Notes |
|------|-----|-------|
| API reference (Scalar) | http://localhost:3000/reference | Served by the app itself while `npm run start:dev` runs |
| Prisma Studio | `npx prisma studio` → http://localhost:5555 | Database browser |
| RedisInsight | http://localhost:5540 | BullMQ queues: mail, categorization, agent |
| Jaeger UI | http://localhost:16686 | Distributed traces |
| Prometheus UI | http://localhost:9090 | Raw metrics and scrape target status |
| Grafana | http://localhost:3001 (`admin` / `admin`) | Traces, metrics and logs in one place; datasources are provisioned automatically |
| Health check | http://localhost:3000/health | 200 or 503 with Postgres and Redis state; public, meant for an external uptime monitor |
| Grafana LLM dashboard | http://localhost:3001/d/finwise-llm | Claude API spend, tokens and outcomes per feature, provisioned from `docker/grafana/provisioning/dashboards/`. The counters belong to the API process and reset when it restarts. |
| Grafana alerts | http://localhost:3001/alerting/list | Eight rules provisioned from `docker/grafana/provisioning/alerting/`: a dead dependency, an unreachable API, 5xx rate, slow endpoints (p95 over 2s), slow RAG answers (p95 over 15s), slow database queries (p95 over 500ms), and AI failures and spend. Emailed to `ALERT_EMAIL` through Resend's SMTP relay; a stopped Postgres reaches the inbox in about a minute, and a resolved email follows. Leave `ALERT_EMAIL` unset in dev, or "API unreachable" fires whenever the API is off. |

```bash
# Start only the observability stack (Jaeger, Prometheus, Loki, Grafana)
npm run observability:up
```

The app exposes Prometheus metrics at `http://localhost:9464/metrics`; the `prometheus` container scrapes them through `host.docker.internal`, since in dev the app runs on the host.

## Local Setup

```bash
# 1. Postgres (with pgvector) and Redis; add the observability containers if you want them
docker compose up -d

# 2. Dependencies (poppler's pdftotext is also needed for rag:ingest: brew install poppler)
npm install

# 3. Environment
cp .env.example .env  # fill in the values

# 4. Migrations
npx prisma migrate deploy

# 5. Load the RAG corpus (downloads the BCB PDF and the embedding model, ~10s)
npm run rag:ingest

# 6. Dev server
npm run start:dev
```

Prisma can't express the pgvector HNSW index, so `prisma migrate dev` generates `DROP INDEX "knowledge_chunks_embedding_hnsw_idx"` in every new migration. Delete that line before applying it.

## Environment Variables

```env
# Required (validated at startup)
DATABASE_URL=
JWT_SECRET=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET_NAME=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_GOLD=
STRIPE_PRICE_PLATINUM=
REDIS_HOST=
REDIS_PORT=
ANTHROPIC_API_KEY=

# Optional
PORT=                      # default 3000
TRUST_PROXY=               # proxy hops (usually 1) behind a hosting proxy, so rate limits key on the client IP
AI_DAILY_SPEND_LIMIT_USD=  # default 1; 0 turns RAG, agent and categorization off
BILLING_ENABLED=           # false turns off self-service billing routes (404); the webhook keeps working
MAIL_ENABLED=              # false skips sending email
MAIL_REDIRECT_TO=          # send every email to this address (local dev)
BULLMQ_PREFIX=             # default bull; .env.test uses bull-test so tests never share queues with a dev API
THROTTLE_DEFAULT_LIMIT=    # requests/min per route and IP, default 100
THROTTLE_AUTH_LIMIT=       # signin, signup, refresh; default 5
THROTTLE_AI_LIMIT=         # RAG and agent endpoints; default 10
TRANSFORMERS_CACHE=        # embedding model cache, default .cache/models
OTEL_EXPORTER_OTLP_ENDPOINT=  # default http://localhost:4318/v1/traces (Jaeger)
LOKI_URL=                     # default http://localhost:3100

# Optional, read by docker compose for the grafana service (not by the API)
ALERT_EMAIL=               # who gets alert emails; unset keeps alerts quiet (rules still run)
ALERT_FROM_EMAIL=          # sender Resend accepts, default onboarding@resend.dev
```

## Production Notes

- Stripe stays in test mode, and production runs with `BILLING_ENABLED=false`, so nobody can upgrade with Stripe's test card. Plans are set by an admin.
- `npm run admin:promote -- <email>` makes an existing account ADMINISTRATOR (role and plan). Run it once against a new database; after that, manage plans through `PATCH /users/:id`.
- Run with `MAIL_ENABLED=false` until Resend has a verified domain; without one, sends to anyone but the account owner fail.
- Set `TRUST_PROXY=1` behind the hosting proxy so rate limits see the client IP.
- The Anthropic account is prepaid with no auto-reload, which caps the worst case regardless of the in-app limits.
- `npm run build && npm run start:prod` runs `dist/main.js`; CI checks that the build emits it.
- Point an external uptime monitor (UptimeRobot, Better Stack) at `/health`. Grafana's alerts run on the same host, so they can't report the host itself going down.

## Tests

Two suites, kept separate because each covers a different layer. Coverage only means something when the two are combined.

- **Unit** (`test:unit`): Jest, testing the `application`/`domain` layers and the eval harness in isolation, with Jest's own mocks. 480 tests.
- **E2E** (`test:e2e`): Jest + Supertest, booting the real `AppModule` against a dedicated `finwise_test` Postgres database (with pgvector) and real Redis.
  - Mocked external boundaries: `MailService`, `StorageService`, `BillingService`, `LlmService` (the Claude API) and `EmbeddingProvider` (a deterministic fake instead of the 120 MB model).
  - Everything else runs for real: the queues and their workers, the Stripe webhook handler and signature check, pgvector search, the agent's tools over Postgres, quotas and rate limiting.
  - 97 tests across 13 spec files.

```bash
npm run test:unit     # unit only
npm run test:e2e      # e2e only, real DB
npm test              # both, with the merged coverage report
```

`npm test` merges both coverage reports with `nyc`: unit touches `application`/`domain`, and e2e touches `infra`/`http`. Combined: 95.7% statements.

E2E needs Docker running (`docker compose up -d`) and a local `.env.test`, with the same shape as `.env` but fake credentials, high `THROTTLE_*` limits and `BULLMQ_PREFIX=bull-test`. It is gitignored and never used for a real network call.

Running `npm run test:e2e` on its own can occasionally exit non-zero because of a known BullMQ/Redis teardown race that happens after every test has passed (`docs/known-issues/bullmq-teardown-race.md`). `npm test` reads pass/fail from Jest's result summary instead, so it is the command behind the pre-push hook and CI.

## Git Hooks (Husky)

- **pre-push:** `eslint` + `tsc --noEmit` + `prettier --check` (src, test, evals) + `npm test`. Any failure blocks the push.
