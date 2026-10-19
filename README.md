# Restaurant OS

A restaurant POS and management SaaS (Petpooja-style). It is built as microservices, and payment correctness is the top priority.

Design docs: [plan](docs/PLAN.md) · [feature map vs Petpooja](docs/FEATURES.md) · [user flows](docs/USER_FLOWS.md) · [database design](docs/DATABASE.md).

## Tech stack

| Layer | Choice |
|---|---|
| Language / runtime | TypeScript on Node.js 24 |
| Backend framework | NestJS 11 (Express) |
| Database | PostgreSQL 17 (one database per service, row-level security for tenant isolation) |
| Events | Kafka API: Redpanda locally and in production (KafkaJS client), plus an in-memory bus for tests |
| Cache / locks | Redis (in compose; not used by code yet) |
| Auth | JWT. Keycloak (RS256/JWKS) in production; HS256 shared secret in dev and tests |
| Validation | zod on every request body and every event |
| Logging | pino structured JSON, with secrets redacted |
| Payments | Razorpay adapter, plus a Razorpay-compatible fake gateway for dev and tests |
| Tests | Jest + SWC against a real PostgreSQL server (`embedded-postgres`, no Docker needed) |

## Layout

```
packages/contracts   event schemas shared by all services (zod)
packages/common      DB/transactions, outbox + inbox, auth, money/GST, resilient HTTP, Nest hardening
services/payment     payments, refunds, Razorpay webhooks, reconciler
services/order-pos   menu, tables, KOTs, orders, GST billing, invoice numbers, checkout, payment reflection
services/analytics   owner reports built only from events: sales, menu engineering, P&L, GST, CRM, alerts
tests/e2e            both services together: order → pay → settle → refund
infra/docker         local Postgres, Redpanda, Redis, Keycloak
```

## See it running (no Docker needed)

```bash
npm install --cache /tmp/npm-cache
```

```bash
npm run demo
```

Open http://localhost:4000. A single screen shows three roles of a 10-table restaurant working together:

- **Captain (phone):** tap a table, set the number of guests, add items and **Send KOT**. Come back later to add another round (KOT #2, #3...), then **Request bill**.
- **Cashier (floor):** every table as a tile with its status (free, occupied, bill requested, paying), running amount, guests, minutes open and items. Click a table for the GST bill, then take cash, UPI (press "Customer pays" to act as the customer's phone) or a split. Once paid, the invoice number is assigned and the table frees up.
- **Kitchen:** every KOT as a ticket, the moment the captain sends it.

- **Captains on duty (cashier):** add a captain, remove one (blocked while they own open tables), and see each captain's open tables and running amount. Move a table to another captain from its bill. A removed captain's phone is signed out immediately and every request from it is refused.
- **Live activity:** every action (table opened, KOT sent, bill requested, payment, table moved, staff changes) is written to an activity log and pushed to staff screens.

How "who has this order" works:
1. When a captain opens a table, the order is stamped with their staff id. The order service checks they are an active captain on every request.
2. The action and an activity row are saved in one transaction, plus an outbox event (`pos.activity.recorded`).
3. The relay publishes the event, and the order service's live hub pushes it to every connected screen of that outlet over Server-Sent Events. The cashier sees it within a moment; a screen that reconnects reloads the log, so nothing is missed.
4. The settled bill carries the captain into analytics, which powers captain performance on the owner dashboard.

Demo data is kept in `.demo-data/` between runs; `npm run demo -- --fresh` starts over.

**Owner dashboard: http://localhost:4000/owner** (loaded with 60 days of realistic history):

| Page | What the owner gets |
|---|---|
| Overview | **Right now** (open tables, running bills, guests seated, by captain, live); net sales, bills, average bill, guests, table time, GST, refunds (each vs the previous period); captain performance; daily trend; payment mix; busy-hours heatmap; top dishes |
| Menu engineering | Every dish rated Star / Plowhorse / Puzzle / Dog by popularity × profit per plate, with what to do about it |
| Finance & GST | Automatic P&L (sales − refunds − food cost − gateway fees − expenses, with monthly costs accrued by day), food and prime cost %, GST output by rate with CGST/SGST, collections by method, month by month, expense entry |
| Customers (CRM) | Known guests, repeat rate, segments (Champions, Loyal, New, Occasional, At risk, Lost), top guests (masked numbers), win-back list of consenting guests |
| Alerts | Sales-drop detection (each day vs the same weekday over the last 4 weeks), overpayments, late captures, refunds by size, refund rate |

How analytics is set up: the analytics service never reads another service's database. It consumes `pos.order.settled`, `payment.refunded`, `payment.captured` and `pos.order.overpaid` events into its own reporting tables (inbox dedup, tenant RLS). The tables have the same shape as the planned ClickHouse / data-lake "gold" layer, so reporting can move to ClickHouse without changing the APIs. Financial reports are owner-only, and managers see sales and CRM. 
## Run the tests

```bash
npm install --cache /tmp/npm-cache
```

```bash
npm test
```

## How payments stay correct

- **Money** is integer paise everywhere, `BIGINT` in Postgres. Floats are rejected, and overflow is checked.
- **Idempotency** works at three levels:
  - Order ids come from the POS device.
  - Each checkout needs an `Idempotency-Key`.
  - Payment ids are generated by the order service, so every retry is safe.
- **State machine**: every transition is a conditional `UPDATE … WHERE status = …`, run in the same transaction as the audit row and the outbox event.
- **Refunds** use a reservation column with a Postgres CHECK. Concurrent refunds can never exceed the captured amount.
- **No lost events**: the transactional outbox writes events in the same commit as the data, and the inbox makes duplicate deliveries no-ops. Payment events carry a full snapshot plus a version, so out-of-order delivery is harmless.
- **The gateway is the source of truth**:
  - Webhooks are HMAC-verified (constant-time comparison) and stored before processing.
  - Client callbacks are verified by signature, and the amount is always fetched from the gateway server-to-server.
  - A reconciler recovers lost webhooks, gateway timeouts and refunds with unknown outcomes.
- **Real-world edge cases**:
  - Amount mismatches and duplicate captures are flagged for a human.
  - A payment captured after it was cancelled is recorded as a late capture, and the order is marked overpaid.
  - GST invoice numbers are gapless per outlet and financial year.

## Crash resistance

- Process guards: unhandled errors trigger a logged, graceful shutdown with exit code 1, and Kubernetes restarts the replica. SIGTERM drains in-flight requests.
- Every database query has a statement timeout. Pool errors are handled, and serialization and deadlock conflicts are retried.
- Every outbound call has a timeout, retries with backoff and jitter (only for idempotent requests), and a circuit breaker.
- Background loops (outbox relay, reconciler) catch everything and back off, so a broker or gateway outage delays work but doesn't crash the service.
- Poison events go to `dead_letters` after N attempts instead of blocking the queue.
- Bad config fails at startup with field names only, never values. Production refuses dev auth, the fake gateway and the in-memory bus.

## Security

- Deny by default: every route needs a valid JWT unless it is marked `@Public()`. Roles and outlet access are checked per route.
- Tenant isolation is enforced by Postgres row-level security, with `FORCE` on and the app role lacking BYPASSRLS. A code bug cannot leak another tenant's data.
- Least-privilege database roles:
  - No role has DELETE.
  - The audit table is append-only via a trigger.
  - Only the worker role can process webhooks and relay events.
- HTTP hardening: Helmet headers, a 100 kB body limit, strict zod schemas that reject unknown fields, rate limiting, CORS allowlist, request ids, and error responses that never leak internals.
- No card data is ever stored; payments use Razorpay checkout. Secrets and VPAs are redacted from logs.

## Not done yet

- **Running the two services as separate processes needs Docker**, for Redpanda/Kafka. The in-memory bus only works inside a single process, which is what the tests use. Install Docker Desktop or OrbStack, then:

  ```bash
  docker compose -f infra/docker/docker-compose.yml up -d
  ```

  The compose file has not been started yet; its image tags are unverified.
- The KafkaJS adapter and the real Razorpay HTTP adapter are written but have not been exercised against live systems.
- Production service-to-service tokens: the Keycloak client-credentials / token-exchange provider is still missing. The order service refuses to start with `NODE_ENV=production` until it exists.
- Not built yet: discounts, inventory, a double-entry ledger with Tally export, aggregator payout reconciliation, WhatsApp sending, POS app, Kubernetes manifests, CI. Gateway fees in the P&L are estimates (UPI 0%, card 2%).
