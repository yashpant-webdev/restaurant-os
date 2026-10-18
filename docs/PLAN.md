# Restaurant OS: product & architecture plan

> The original plan this codebase is built from. What is actually built so far is listed in the README.


## Context
You want to build a restaurant management SaaS like Petpooja (POS billing, KOT, inventory, online orders, reports) to sell to restaurants, cafés, cloud kitchens, bakeries and QSR chains. It should also have two things these products do poorly:
1. **A real CRM.** This means a full customer record, segments, loyalty, campaigns and feedback.
2. **A real finance suite.** This means a double-entry ledger, P&L per outlet, GST, aggregator payout reconciliation, payables and cash flow.

Constraints: use free or open-source tools first, follow industry practice (microservices, Kubernetes, Kafka, Redis), and build a proper data and analytics layer.
Assumed market: **India** (GST, UPI, Swiggy/Zomato, ONDC). This is a greenfield project; nothing exists yet in `/Users/apple/app-launch`.

**Honest note:** Microservices, Kubernetes and Kafka on day one carry a lot of operations work for a small team. The plan keeps that architecture, but it starts with about 7 services and splits them further only when needed. Every service publishes events from the start, so later splits are cheap.

---

## 1. Product modules (what you sell)

| # | Module | Core features | Petpooja-parity or Differentiator |
|---|---|---|---|
| 1 | **POS / Billing** | Dine-in, takeaway and delivery; table map; KOT; split or merge bills; discounts; service charge; GST invoice; thermal printing (ESC/POS); **works offline** | Parity |
| 2 | **Captain app** | Waiters take orders on a phone or tablet, send KOT and see table status | Parity |
| 3 | **Kitchen Display (KDS)** | Live tickets, prep timers, station routing | Parity |
| 4 | **Menu & Catalog** | Items, variants, add-ons, combos, channel-wise pricing, scheduled menus, taxes | Parity |
| 5 | **Inventory & Purchasing** | Raw materials, recipes (BOM) with auto stock deduction, purchase orders, vendors, GRN, wastage, central-kitchen transfers, low-stock alerts | Parity+ |
| 6 | **Online ordering** | Aggregator sync (Swiggy/Zomato through an integrator), **ONDC**, your own white-label ordering site, QR table ordering | Parity+ |
| 7 | **Payments** | UPI QR, cards, wallets, payment links, settlement tracking | Parity |
| 8 | **CRM & Loyalty** ⭐ | Customer 360 (visits, spend, favourite dishes), RFM segments, points, tiers, cashback, coupons, birthday and anniversary automation, WhatsApp/SMS/email campaigns, feedback/NPS, win-back flows | **Differentiator** |
| 9 | **Finance & Accounting** ⭐ | Double-entry ledger with auto journals from every sale, purchase and expense; chart of accounts; P&L, balance sheet and cash flow per outlet and brand; GST reports (GSTR-1/3B data, e-invoice); TDS; **aggregator payout reconciliation** (commission, ads, penalties, GST on commission); bank reconciliation; payables and receivables; expense capture (OCR receipts); budgets vs actuals; food-cost %; Tally and Zoho Books export | **Differentiator** |
| 10 | **Staff** | Roles, shifts, attendance, tips, simple payroll, void/discount audit trail | Parity+ |
| 11 | **Analytics & AI** ⭐ | Live dashboards, menu engineering (Stars, Plowhorses, Puzzles, Dogs), sales forecasting, auto purchase suggestions, theft/void anomaly alerts, "ask your data" in plain language using Claude | **Differentiator** |
| 12 | **Multi-outlet / Franchise HQ** | Central menu push, franchise royalty calculation, consolidated reports | Parity+ |
| 13 | **Platform** | Your own SaaS subscriptions and billing, public API, webhooks, integration marketplace | Infra |

---

## 2. High-level architecture

```
 Clients ─────────────────────────────────────────────────────────────────────
  POS (Tauri desktop / Android)  Captain app   KDS   Owner app   Admin web (Next.js)
  Online-order site (Next.js)    QR menu       Public API consumers
        │  (offline-first: local SQLite + sync outbox)
        ▼
 Edge:  Cloudflare (DNS, CDN, WAF, TLS)  →  API Gateway (APISIX or Kong OSS)
        │  JWT validation (Keycloak), rate limit (Redis), tenant routing
        ▼
 Services (Kubernetes, k3s) ──────────────────────────────────────────────────
  identity-tenant │ catalog │ order-pos │ kitchen │ payment │ inventory
  online-orders   │ crm-loyalty │ finance-ledger │ staff │ notification
  reporting-api   │ sync-service │ integration-hub │ saas-billing
        │ REST (external)  gRPC (internal)  WebSocket (KDS/POS live)
        ▼
 Data:  PostgreSQL (one DB per service, CloudNativePG)   Redis (cache/locks/pubsub)
        Kafka/Redpanda (event bus) + Schema Registry     Object storage (R2/MinIO)
        Meilisearch (menu/customer search)
        ▼
 Data platform: Debezium CDC → Kafka → ClickHouse (real-time OLAP)
                                     → Iceberg on R2 (data lake: bronze/silver/gold)
                dbt-core + Dagster → Superset/Metabase (embedded dashboards)
                ML (statsforecast/Prophet) + Claude API (NL querying)
```

### Key architecture decisions
- **Offline-first POS.** This is the most important decision; restaurants cannot stop billing when the internet drops.
  - Each POS device keeps a local SQLite database.
  - Every action is written to a local **outbox** with a client-generated UUIDv7 and an idempotency key.
  - The `sync-service` pushes and pulls changes.
  - For orders, the server is the authority. Conflicts are resolved per entity: last write wins for menu items, and orders are append-only.
  - POS devices on the same LAN can also sync with each other over local WebSocket, so the captain app works without internet.
- **Multi-tenancy.** The hierarchy is `organization → brand → outlet`. Every row carries a `tenant_id`, enforced with Postgres **Row-Level Security**. Large chains can later get dedicated databases.
- **Events everywhere.**
  - Services write to an `outbox` table in the same transaction as their data change; Debezium publishes it to Kafka.
  - This avoids dual-write bugs.
  - Topic names follow `<domain>.<entity>.<event>`, for example `pos.order.settled`, `payment.captured`, `inventory.stock.consumed`, `finance.journal.posted`.
  - Avro or Protobuf schemas live in a schema registry (Apicurio or Redpanda's built-in one).
- **Sagas, not distributed transactions.** When an order settles:
  1. payment is captured;
  2. inventory deducts the recipe quantities;
  3. finance posts the journal entry;
  4. CRM adds loyalty points.

  Each consumer is idempotent, and failures go to retry topics and a dead-letter topic (DLQ).
- **Money.** Store integer paise, never floats. Finance journals are immutable; corrections are made with reversing entries.

---

## 3. Tech stack (all free or open-source; ★ = recommended choice)

| Layer | Choice | Why |
|---|---|---|
| Core backend services | ★ **TypeScript + NestJS** | One language across web, mobile and backend; strong DI and modules; widely used |
| Data, finance reporting, ML services | ★ **Python + FastAPI** | pandas, Polars, statsforecast and dbt ecosystem |
| Hot paths, later (sync, KDS fan-out) | Go | Only if profiling shows a need |
| Internal RPC | gRPC (buf) | Typed contracts |
| ORM / migrations | Prisma or Drizzle (TS), SQLAlchemy + Alembic (Py) | |
| Admin dashboard & ordering site | ★ **Next.js 15 + Tailwind + shadcn/ui** | SSR for the ordering site's SEO |
| POS desktop (Windows counters) | ★ **Tauri + React** | Small installer; native printer and serial access |
| POS / Captain / Owner mobile | ★ **React Native (Expo)** | Shares TS logic with web; runs on Sunmi and PAX Android POS hardware |
| Local DB on devices | SQLite (WatermelonDB or op-sqlite) | Offline-first |
| Auth / SSO | ★ **Keycloak** (self-hosted) | OIDC, RBAC, outlet-level PIN login for staff |
| API gateway | ★ **Apache APISIX** (or Kong OSS) | JWT, rate limiting, plugins |
| Event streaming | ★ **Redpanda** (Kafka-compatible, single binary, light on RAM) or Apache Kafka via **Strimzi** | Kafka API, so you can switch later |
| Cache / locks / pub-sub | ★ **Redis** (self-hosted) or Valkey; Upstash free tier for dev | |
| OLTP DB | ★ **PostgreSQL 16** via **CloudNativePG** operator; Neon or Supabase free tier for early dev | |
| OLAP | ★ **ClickHouse** (self-hosted) | Sub-second dashboards across billions of order lines |
| Data lake | **Apache Iceberg** on **Cloudflare R2** (10 GB free, no egress fees) or MinIO; query with **DuckDB** / Trino | |
| CDC | **Debezium** (Kafka Connect) | Outbox pattern and lake ingestion |
| Transformations / orchestration | **dbt-core** + **Dagster** | Industry standard, free |
| BI / embedded dashboards | **Apache Superset** or **Metabase OSS** | Embedded in the owner dashboard |
| Search | **Meilisearch** | Menu and customer search |
| Workflow / scheduled jobs | **Temporal** (self-hosted), or BullMQ for simpler jobs | Campaigns, reconciliation runs |
| Feature flags + product analytics | **PostHog** (free: 1M events/month) | Includes session replay |
| Web analytics | **Google Analytics 4 + Google Tag Manager** on the ordering site | Marketing attribution |
| Errors | **Sentry** free tier | |
| Observability | **Grafana Cloud free tier** (or self-hosted Prometheus, Loki, Tempo, Grafana) with **OpenTelemetry** SDKs | |
| CI/CD | **GitHub Actions** + **GHCR** (registry) + **Argo CD** (GitOps) | |
| Infrastructure as code | **OpenTofu** (Terraform fork) + **Helm** | |
| Secrets | **Sealed Secrets** or **Infisical** (OSS) | |
| Local dev | **k3d** + **Tilt** (or Skaffold), docker-compose for quick starts | |

### Where it runs for free
| Need | Free option | Limit / note |
|---|---|---|
| Kubernetes cluster | ★ **Oracle Cloud Always Free**: 4 ARM OCPU, 24 GB RAM, 200 GB disk, running **k3s**. Choose the **Mumbai/Hyderabad** region for Indian data residency | Enough for dev plus 5–20 pilot restaurants. Size the workloads carefully |
| Frontends | Vercel or Cloudflare Pages | |
| DNS, CDN, WAF, TLS | Cloudflare free | |
| Object storage | Cloudflare R2 (10 GB) | |
| Email | Brevo (300/day) or Resend (3k/month) | |
| Postgres / Redis for dev | Neon, Supabase, Upstash free tiers | |
| Monitoring | Grafana Cloud free, Sentry free, UptimeRobot | |

**Not free, unavoidable:**
- Pay per use:
  - **SMS** (MSG91, about ₹0.15–0.25 per SMS)
  - **WhatsApp Business API** (Meta per-conversation pricing; build directly on Cloud API or use Gupshup/Interakt)
  - **Payments** (Razorpay or Cashfree: no setup fee, about 2% per transaction; UPI is about 0%)
- **Aggregator access**: Swiggy/Zomato need a partner agreement, or go through an integrator such as UrbanPiper. **ONDC** is open and the best route to start.
- **GST e-invoice / IRP**: through a GSP such as ClearTax or Masters India.

**When paying customers arrive**, move to Hetzner, DigitalOcean or AWS Mumbai with managed Postgres. The manifests are the same because Kubernetes is portable.

---

## 4. Microservices and their data

| Service | Owns (Postgres schema) | Publishes | Consumes |
|---|---|---|---|
| `identity-tenant` | orgs, brands, outlets, users, roles, devices | tenant.*, user.* | — |
| `catalog` | items, variants, addons, taxes, channel prices | catalog.item.* | — |
| `order-pos` | orders, order_lines, tables, KOTs, bills, discounts | pos.order.*, pos.kot.created | catalog, payment.* |
| `kitchen` | tickets, stations (mostly Redis) | kitchen.ticket.ready | pos.kot.created |
| `payment` | payments, refunds, settlements | payment.captured/refunded | pos.order.settled |
| `inventory` | materials, recipes, stock_ledger, POs, vendors, GRN | inventory.* | pos.order.settled, payment.* |
| `online-orders` | channel orders, store status, menu sync state | pos.order.created (normalized) | catalog.* |
| `crm-loyalty` | customers, visits, points_ledger, segments, campaigns, feedback | crm.* | pos.order.settled, payment.* |
| `finance-ledger` | accounts, journals, journal_lines, gst_registers, reconciliations, payables, expenses | finance.* | pos.*, payment.*, inventory.grn.*, online-orders.payout.* |
| `staff` | shifts, attendance, tips | staff.* | pos.order.settled |
| `notification` | templates, delivery log | — | crm.campaign.*, many others |
| `sync-service` | device cursors, outbox ingestion | (forwards to owners) | all, for device pull |
| `reporting-api` | (reads ClickHouse) | — | — |
| `integration-hub` | webhooks, API keys, Tally export jobs | — | all |
| `saas-billing` | your subscriptions and plans (use **Lago OSS** + Razorpay Subscriptions) | — | tenant.* |

**Start-up merge (Phase 1):** run `catalog + order-pos + kitchen` as one deployable, `identity-tenant` alone, `payment`, `inventory`, `crm-loyalty`, `finance-ledger` and `notification`, which is 7 deployables. They are split along the boundaries above later, and the topics stay the same.

---

## 5. Finance module design (the main differentiator)
- **Chart of accounts template** for restaurants:
  - Sales by channel
  - Output GST (CGST, SGST, IGST)
  - Input GST
  - COGS (food, beverage, packaging)
  - Aggregator commission
  - Payment gateway fees
  - Rent, salaries, utilities
  - Cash, bank and UPI clearing accounts
- **Posting rules engine.** Each event type maps to a journal template. Rules are configurable per tenant and stored as data, not code. Example for `pos.order.settled`:
  - Debit: UPI Clearing ₹1,050
  - Credit: Sales-Dine-in ₹1,000
  - Credit: CGST ₹25
  - Credit: SGST ₹25
- **Aggregator reconciliation:**
  1. Ingest payout reports (CSV or API) from Swiggy, Zomato and ONDC.
  2. Match them line by line to orders.
  3. Explain the gap between gross sales and net payout: commission, GST on commission, TCS, TDS, ads, penalties, refunds.
  4. Flag disputes.

  This solves a real pain for owners.
- **Bank reconciliation** from imported statements (CSV, or Account Aggregator APIs later), matched by amount, date and UTR.
- **Reports:** P&L per outlet, brand and day; balance sheet; cash flow; food cost %; prime cost; GST summaries; vendor ageing; budget vs actual.
- **Exports:** Tally XML, Zoho Books API, CA-ready Excel.

## 6. CRM & loyalty design
- Customer identity: phone number is the primary key. Merge records across POS, online orders and the QR menu.
- The points ledger is append-only, like the finance ledger.
- Segment builder: rules on RFM, last visit and favourite items. Segments are computed in ClickHouse and synced back.
- Campaigns run as Temporal workflows:
  1. trigger (birthday, lapsed 30 days, new menu item);
  2. message (WhatsApp/SMS/email);
  3. track conversion when a later order uses the coupon.
- Collect feedback through a QR code or WhatsApp after the bill. Low ratings alert the manager.

## 7. Data & analytics pipeline
1. **Ingest:** Debezium CDC from every service's Postgres goes to Kafka. App events from POS and web go to PostHog. Ordering-site traffic goes to GA4 through GTM.
2. **Real-time:** ClickHouse uses the Kafka engine and materialized views to power live owner dashboards (sales today, top items, table turnover).
3. **Lake:** Kafka Connect S3 sink writes to Iceberg on R2.
   - **Bronze:** raw events.
   - **Silver:** cleaned with dbt.
   - **Gold:** facts and dimensions (`fct_order_lines`, `dim_item`, `dim_outlet`, `fct_journal_lines`).
4. **Orchestration:** Dagster schedules dbt runs, ML jobs and reconciliation jobs.
5. **Serving:**
   - Superset or Metabase dashboards embedded in the Next.js admin through signed embed tokens with tenant filters.
   - A Grafana-style internal ops dashboard.
   - Optionally, export GA4 to BigQuery (free sandbox) for marketing analysis.
6. **ML & AI:**
   - Item-level demand forecasting (statsforecast) drives purchase suggestions.
   - Anomaly detection on voids and discounts per cashier.
   - Menu engineering matrix.
   - Claude API for natural-language queries such as "what was my food cost last week at Andheri?". It is text-to-SQL over the gold tables, read-only and tenant-scoped.

---

## 8. Security & compliance (India)
- **DPDP Act 2023:** consent capture for marketing, data deletion workflows, India data residency.
- **PCI DSS:** never touch card data; use Razorpay checkout and tokenization only.
- **GST:**
  - GST-compliant invoice numbering per outlet and financial year.
  - FSSAI number on bills.
  - E-invoice/IRN through a GSP for large chains.
- **Audit log:** an immutable audit log for voids, discounts, price edits and refunds. This is also an anti-theft selling point.
- **Platform security:** mTLS inside the cluster (Linkerd, free), OWASP checks in CI (Trivy, Semgrep), daily Postgres backups to R2 (CloudNativePG + Barman).

## 9. Repository layout (monorepo, Turborepo + pnpm, Python with uv)
```
restaurant-os/
  apps/        admin-web (Next.js) · ordering-site (Next.js) · pos-desktop (Tauri) · pos-mobile (Expo) · kds (web)
  services/    identity-tenant · order-pos · payment · inventory · crm-loyalty · finance-ledger (FastAPI) · notification · sync-service · reporting-api (FastAPI)
  packages/    shared-types · event-schemas (protobuf/avro) · ui · sdk · eslint/tsconfig
  data/        dbt/ · dagster/ · clickhouse/ (DDL, materialized views) · ml/
  infra/       opentofu/ (Oracle, Cloudflare) · helm/ · argocd/ · k3d/ (local) · observability/
  docs/        ADRs · API (OpenAPI) · runbooks
```

## 10. Roadmap
| Phase | Weeks | Deliverable |
|---|---|---|
| **0. Foundations** | 1–3 | Monorepo, k3d local, k3s on Oracle, Argo CD, Keycloak, tenant model, CI, observability, event-schema package |
| **1. MVP POS** | 4–12 | Menu, offline POS billing, KOT printing, tables, UPI/cash, GST invoice, day-end report, owner web dashboard. **Pilot with 2–3 real restaurants** |
| **2. Operations** | 13–18 | Captain app, KDS, inventory + recipes + POs, multi-outlet, staff roles and audit |
| **3. Growth** | 19–26 | CRM + loyalty + WhatsApp campaigns, QR ordering, own ordering site, ONDC, aggregator integration via an integrator |
| **4. Finance** ⭐ | 27–34 | Ledger and posting rules, P&L, GST reports, aggregator and bank reconciliation, payables, Tally export |
| **5. Data & AI** | 35–42 | ClickHouse live dashboards, Iceberg lake, dbt and Dagster, forecasting, anomaly alerts, Claude-based "ask your data" |
| **6. Platform & scale** | 43+ | Public API, webhooks, SaaS billing (Lago), integration marketplace, split services further, move to paid infrastructure as revenue grows |

**Pricing idea (sell to restaurants):** ₹0 for basic POS to win users, about ₹999/month per outlet for Pro (inventory and CRM), about ₹2,499/month per outlet for Finance+AI. Add-ons: WhatsApp credits, aggregator integration.

## 11. Verification (how we'll know each phase works)
- **Local:** `tilt up` on k3d starts every service plus Redpanda, Postgres and Redis. Then run a seed script that creates a demo org, outlet and menu.
- **End-to-end golden flow test** (Playwright + an API test suite):
  1. Disconnect the POS from the internet.
  2. Bill 20 orders.
  3. Reconnect; the orders sync with no duplicates (idempotency check).
  4. `pos.order.settled` events are visible in Redpanda Console.
  5. Inventory stock is deducted according to the recipes.
  6. Balanced journal entries exist (sum of debits = sum of credits).
  7. Loyalty points are credited.
  8. The order appears on the ClickHouse dashboard within 5 seconds.
- **Contract tests:** check event schemas in CI with buf breaking / schema registry compatibility checks.
- **Load test:** k6 with 200 outlets × peak dinner rush (about 30 orders/min each); targets are p95 API under 200 ms and Kafka consumer lag under 2 s.
- **Finance accuracy:** reconcile a real pilot restaurant's month against their CA's books.
- **Pilot:** 2–3 restaurants for 4 weeks before a public launch.

## Next step after approval
Scaffold Phase 0: create the monorepo in `/Users/apple/app-launch/restaurant-os`, the k3d + Tilt local setup, the Keycloak and tenant service skeleton, the event-schema package and the GitHub Actions CI.
