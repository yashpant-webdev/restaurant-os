# Feature map: Petpooja parity + our differentiators

Source: Petpooja's public product pages (46 pages from their sitemap), blog, partner API documentation, app-store listings and reviews (October 2026). Their in-app screens are not public; our user flows are in [USER_FLOWS.md](USER_FLOWS.md).

**Status:** ✅ built · 🟡 partly built · 📐 designed (see [DATABASE.md](DATABASE.md)) · ⭐ our differentiator
**Phase:** when we build it (P1 = now: cashier app + dashboard core; P2 = inventory & central kitchen; P3 = online & customer-facing; P4 = growth & HR).

## Apps we ship

| App | Tech | Users | Notes |
|---|---|---|---|
| **Cashier app** | Flutter (Android first, then iOS) | Billers, managers | Offline-first: local SQLite + sync. Runs on Android POS terminals (Sunmi/PAX), tablets, phones. |
| **Captain app** | Same Flutter codebase, captain mode | Waiters | Table → order → KOT → request bill; settle at table later. |
| **Kitchen display (KDS)** | Same Flutter codebase, KDS mode | Kitchen | Tickets by station, ready/sold-out. |
| **Central dashboard** | Next.js (web) | Owner, head office, managers, store/central kitchen, accountant | All setup, inventory, central kitchen, reports, CRM, finance. |
| **Owner app** | Flutter, later (P3) | Owner | Live sales, alerts, approvals on the phone. |
| Backend | NestJS microservices + PostgreSQL + Kafka/Redpanda | — | Already running: order-pos, payment, analytics. |

## 1. Billing / POS (cashier app)

| Feature | Status | Phase |
|---|---|---|
| Dine-in / takeaway / delivery / advance orders (delivery date, for bakeries) | 🟡 dine-in, takeaway, delivery | P1 |
| Areas and tables with per-area menu, prices and taxes | 🟡 tables ✅, areas 📐 | P1 |
| Item search, categories, **short codes**, keyboard + touch | 📐 | P1 |
| Variants (half/full, sizes), add-on groups with min/max, notes/modifiers | 📐 | P1 |
| KOT per kitchen station; new / modified / cancelled KOT tags; no prices on KOT | 🟡 KOT ✅, stations 📐 | P1 |
| Bill preview, print, reprint (logged), e-bill by WhatsApp/SMS | 🟡 | P1 |
| Discounts: %/flat/BOGO/freebie, item or bill, reasons, caps per user, manager PIN approval, coupons | 📐 | P1 |
| Service charge, packing charge (item/order level), delivery charge | 📐 | P1 |
| Split bill (equal / item-wise / custom amount), merge tables, move table | 📐 | P1 |
| Settle: cash, card, UPI (dynamic QR), due (credit), wallet, complimentary, split tender | 🟡 cash/UPI/split ✅ | P1 |
| Payment-mode change after settlement only with permission | 📐 | P1 |
| Cancel / void item, KOT or bill with reason; logged | 🟡 | P1 |
| Shift open with opening float, pay-in/pay-out, shift handover, day end with denomination count, Z-report | 📐 | P1 |
| Offline billing for days, sync later; per-device gapless invoice series | 📐 | P1 |
| Multi-terminal, KOT from one terminal and bill from another | 🟡 | P1 |
| Staff rights per user and outlet (approve discount, void, after-settlement edit…) | 🟡 roles ✅, fine-grained permissions 📐 | P1 |
| Leakage / audit panel: cancelled or modified KOTs, unbilled KOTs, reprints, table moves | 📐 ⭐ (we push it to the owner live) | P1 |
| Printers: thermal 58/80 mm over LAN/Bluetooth/USB, per-station routing | 📐 | P1 |
| Regional-language bills, multiple brands in one outlet (cloud kitchens) | 📐 | P3 |
| Prepaid cards (food courts, canteens) | 📐 | P4 |
| EDC card machines driven from the POS (Pine Labs, Razorpay, Paytm…), soundbox | 📐 | P3 |

## 2. Menu management (dashboard)

Categories and sub-categories with timings · items (short code, veg/non-veg/egg, tags, spice level, prep time, markup/strike price, image, allergens) · variants · add-on groups · combos · taxes (inclusive/exclusive, per order type) · prices per area and channel · order-type availability · item on/off ("86"), also from the KDS · head-office menu pushed to many outlets with tracking · aggregator menu sync. **Status:** 🟡 basic items ✅, the rest 📐 · **P1**

## 3. Inventory, purchase, central kitchen (dashboard + cashier alerts)

| Feature | Status | Phase |
|---|---|---|
| Raw materials, units, categories, stores per outlet | 📐 | P2 |
| Multi-stage recipes (semi-finished), auto deduction on every sale | 📐 | P2 |
| Low-stock alerts on the billing screen; dish auto sold-out when stock runs out | 📐 ⭐ auto sold-out | P2 |
| Vendors, purchase orders, receiving (GRN) with rejects, vendor returns, purchase bills and payments | 📐 | P2 |
| Purchase Manager: compare vendor rate cards (Excel upload), cheapest-cart suggestion | 📐 | P3 |
| Central kitchen: outlet indents → approve → production → dispatch → receive (with variance) → returns | 📐 | P2 |
| Consolidated delivery routes, e-way bills for transfers and purchases | 📐 | P3 |
| Stock transfers between outlets | 📐 | P2 |
| FIFO, batches, expiry alerts | 📐 | P2 |
| Wastage with reasons and photos | 📐 | P2 |
| Daily stock closing, stock audits, **variance (expected vs actual) in ₹** | 📐 ⭐ | P2 |
| Liquor tracking by peg / ml (bars) | 📐 | P3 |
| Reports: day-end stock, consumption, price trends, food cost | 🟡 food cost from recipe cost ✅ | P2 |

## 4. Floor & customer-facing

| Feature | Status | Phase |
|---|---|---|
| Captain app (offline, KOT, request bill, assigned tables) | ✅ web demo, Flutter in P1 | P1 |
| Kitchen display: tickets/aggregated view, stations, ready, sold-out | 🟡 ticket list ✅ | P1 |
| Token display on a TV with voice call-out | 📐 | P3 |
| QR scan & order per table (OTP before KOT, rounds, pay online/counter) | 📐 | P3 |
| Self-ordering kiosk | 📐 | P4 |
| Table reservations, waitlist, deposits, no-show tracking | 📐 | P3 |
| Waiter-call buttons (water / waiter / bill) → captain app + TV | 📐 | P4 |
| Digital menu boards on TVs | 📐 | P4 |
| Own website with online ordering (commission-free) | 📐 | P3 |

## 5. Online orders

Swiggy, Zomato, ONDC, own website, call centre in one inbox; accept/reject with reason; auto-accept window; food ready → dispatched → delivered; rider status and OTP; store on/off with reason and reopen time; item on/off across channels; **payout reconciliation** (commission, GST on commission, TCS, TDS, ads, penalties; matched / missing / mismatched orders). **Status:** 📐 · **P3** (reconciliation ⭐, tied to finance)

## 6. Customers, loyalty, marketing

| Feature | Status | Phase |
|---|---|---|
| One customer profile from every channel; labels; notes; history | 🟡 analytics CRM ✅, phone on order ✅ | P1 |
| Loyalty points and cashback, tiers, expiry, OTP-verified redemption | 📐 | P3 |
| Wallet / gift cards | 📐 | P3 |
| Coupons with rules | 📐 | P1 (bill) / P3 (campaigns) |
| Segments (RFM, lapsed), campaigns on WhatsApp/SMS, birthday/anniversary/win-back automations | 🟡 segments + win-back list ✅ | P3 |
| Feedback by QR/WhatsApp; alert on bad ratings | 📐 | P3 |
| Reviews from Google/Zomato/Swiggy with AI-drafted replies | 📐 | P4 |
| Referral programme, ads (Meta), ROI dashboard | 📐 | P4 |
| Credit (khata) accounts for regulars and companies | 📐 | P1 (due payments) |

## 7. Reports, head office, finance

| Feature | Status | Phase |
|---|---|---|
| Owner dashboard: live sales, right-now floor, captain performance, menu engineering, CRM, alerts | ✅ ⭐ | — |
| 90+ standard reports (day end, item/category, settlement, cancellations, discounts, tax, staff, due payments) | 🟡 | P1–P2 |
| Head office: zones/regions, consolidated views, central menu and raw-material master | 📐 | P2 |
| P&L with expenses accrued by day; GST summary | ✅ ⭐ | — |
| Double-entry ledger, vendor payables, bank reconciliation, GSTR-1/3B data, Tally export | 📐 ⭐ | P2–P3 |
| Payment settlement reconciliation (gateway payouts vs bills) | 🟡 payment side ✅ | P2 |
| Custom dashboards, email alerts, "ask your data" AI | 📐 ⭐ | P4 |

## 8. Staff & HR (Petpooja sells these as Attendo and Stepwise)

Attendance (biometric, face, geofenced mobile punch) · shifts and rosters · leave · payroll with PF/ESI/PT, overtime, advances · tips · task checklists with photo proof · licence reminders. **Status:** 🟡 staff list + captain ownership ✅ · **P4**

## 9. Platform

Offline server option for chains · open API and webhooks · Tally/SAP export · integrations marketplace · onboarding/migration tools · 24×7 support tooling. **Status:** 📐 · **P3–P4**

## Where we beat Petpooja (from reviews and their gaps)

1. **Finance built in**: real P&L, ledger, reconciliation, instead of exporting to Tally and an accountant.
2. **Variance in rupees**: theoretical vs actual consumption per ingredient, with theft and over-portioning alerts.
3. **CRM and loyalty that work out of the box**: reviewers call Petpooja's weak.
4. **Live owner view**: activity feed, leakage alerts and right-now floor, not just end-of-day reports.
5. **Simple, transparent pricing** and a fast, stable POS at peak hours (the most common complaint about them).
