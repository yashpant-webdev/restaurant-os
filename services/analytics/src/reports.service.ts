import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { assertOutletAccess, Database, newId, Principal, Tx, ValidationError } from '@ros/common';

export const APP_DB = Symbol('APP_DB');

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
export const RangeQuery = z
  .object({ outletId: z.string().uuid(), from: Day.optional(), to: Day.optional() })
  .strict();
export type RangeQuery = z.infer<typeof RangeQuery>;

export const ExpenseInput = z
  .object({
    outletId: z.string().uuid(),
    businessDate: Day,
    category: z.enum(['RENT', 'SALARIES', 'UTILITIES', 'MARKETING', 'MAINTENANCE', 'OTHER']),
    amountPaise: z.number().int().positive().max(1_000_000_000),
    period: z.enum(['ONE_TIME', 'MONTHLY']).default('ONE_TIME'),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

/** Estimated gateway charges per method, for the P&L (configurable per merchant later). */
const FEE_BP: Record<string, number> = { CASH: 0, UPI: 0, CARD: 200, WALLET: 190, PAYMENT_LINK: 200 };

function istToday(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export interface Range {
  outletId: string;
  from: string;
  to: string;
}

/**
 * Owner reports. All money is integer paise; every SUM is cast back to bigint
 * so it arrives as an exact number. Queries run on the analytics database
 * only, with tenant isolation enforced by row-level security.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(APP_DB) private readonly db: Database) {}

  private range(p: Principal, q: RangeQuery): Range {
    assertOutletAccess(p, q.outletId);
    const to = q.to ?? istToday();
    const from = q.from ?? addDays(to, -29);
    const len = daysBetween(from, to);
    if (len < 0) throw new ValidationError('from must be on or before to');
    if (len > 400) throw new ValidationError('range too long (max 400 days)');
    return { outletId: q.outletId, from, to };
  }

  private run<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.tx(fn, { tenantId: p.tenantId, isolation: 'REPEATABLE READ' }); // consistent snapshot across the report's queries
  }

  // ------------------------------------------------------------------ overview

  async overview(p: Principal, q: RangeQuery) {
    const r = this.range(p, q);
    const len = daysBetween(r.from, r.to) + 1;
    const prev = { ...r, from: addDays(r.from, -len), to: addDays(r.from, -1) };
    return this.run(p, async (tx) => {
      const kpi = async (x: Range) =>
        (
          await tx.query<{ bills: number; net: number; gross: number; tax: number; guests: number; dine_bills: number; avg_table_min: number | null }>(
            `SELECT COUNT(*)::bigint AS bills, COALESCE(SUM(subtotal_paise),0)::bigint AS net, COALESCE(SUM(total_paise),0)::bigint AS gross,
                    COALESCE(SUM(cgst_paise + sgst_paise),0)::bigint AS tax, COALESCE(SUM(guests),0)::bigint AS guests,
                    COUNT(guests)::bigint AS dine_bills,
                    AVG(EXTRACT(EPOCH FROM settled_at - opened_at) / 60) FILTER (WHERE channel = 'DINE_IN' AND opened_at IS NOT NULL)::float8 AS avg_table_min
               FROM fact_orders WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3`,
            [x.outletId, x.from, x.to],
          )
        ).rows[0]!;
      const [cur, before] = [await kpi(r), await kpi(prev)];
      const refunds = await this.sum(tx, `SELECT COALESCE(SUM(amount_paise),0)::bigint AS v FROM fact_refunds WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3`, r);

      const { rows: daily } = await tx.query(
        `SELECT d::date::text AS day, COALESCE(SUM(o.subtotal_paise),0)::bigint AS net, COUNT(o.order_id)::bigint AS bills
           FROM generate_series($2::date, $3::date, interval '1 day') d
           LEFT JOIN fact_orders o ON o.business_date = d::date AND o.outlet_id = $1
          GROUP BY d ORDER BY d`,
        [r.outletId, r.from, r.to],
      );
      const { rows: heat } = await tx.query(
        `SELECT EXTRACT(ISODOW FROM settled_at AT TIME ZONE 'Asia/Kolkata')::int AS dow,
                EXTRACT(HOUR FROM settled_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
                COALESCE(SUM(subtotal_paise),0)::bigint AS net, COUNT(*)::bigint AS bills
           FROM fact_orders WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3 GROUP BY 1, 2`,
        [r.outletId, r.from, r.to],
      );
      const { rows: paymentMix } = await tx.query(
        `SELECT method, COALESCE(SUM(net_paise),0)::bigint AS net, COUNT(*)::bigint AS count FROM fact_payments
          WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3 GROUP BY method ORDER BY net DESC`,
        [r.outletId, r.from, r.to],
      );
      const { rows: topItems } = await tx.query(
        `SELECT name, SUM(quantity)::bigint AS quantity, SUM(net_paise)::bigint AS net FROM fact_order_lines
          WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3 GROUP BY name ORDER BY net DESC LIMIT 10`,
        [r.outletId, r.from, r.to],
      );
      const { rows: channels } = await tx.query(
        `SELECT COALESCE(channel, 'UNKNOWN') AS channel, COUNT(*)::bigint AS bills, SUM(subtotal_paise)::bigint AS net FROM fact_orders
          WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY net DESC`,
        [r.outletId, r.from, r.to],
      );
      const { rows: captains } = await tx.query(
        `SELECT captain_id AS "captainId", MAX(captain_name) AS name, COUNT(*)::bigint AS bills, SUM(subtotal_paise)::bigint AS net,
                COALESCE(SUM(guests),0)::bigint AS guests, ROUND(AVG(total_paise))::bigint AS "avgBill",
                ROUND(AVG(EXTRACT(EPOCH FROM settled_at - opened_at) / 60) FILTER (WHERE opened_at IS NOT NULL))::int AS "avgTableMin"
           FROM fact_orders WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3 AND captain_id IS NOT NULL
          GROUP BY captain_id ORDER BY net DESC`,
        [r.outletId, r.from, r.to],
      );
      const k = (x: typeof cur) => ({
        netSalesPaise: x.net,
        grossSalesPaise: x.gross,
        taxPaise: x.tax,
        bills: x.bills,
        avgBillPaise: x.bills ? Math.round(x.gross / x.bills) : 0,
        guests: x.guests,
        perCoverPaise: x.guests ? Math.round(x.net / x.guests) : 0,
        avgTableMinutes: x.avg_table_min === null ? null : Math.round(x.avg_table_min),
      });
      return { range: r, previousRange: prev, kpis: { ...k(cur), refundsPaise: refunds }, previous: k(before), daily, heatmap: heat, paymentMix, topItems, channels, captains };
    });
  }

  // ------------------------------------------------------------------ menu engineering

  /**
   * Kasavana–Smith menu engineering: popularity = item's share of units sold vs
   * 70% of an equal share; profitability = contribution margin per unit vs the
   * menu's weighted average. Gives Stars / Plowhorses / Puzzles / Dogs.
   */
  async menu(p: Principal, q: RangeQuery) {
    const r = this.range(p, q);
    return this.run(p, async (tx) => {
      const { rows } = await tx.query<{ name: string; quantity: number; net: number; cost: number | null; costed: boolean }>(
        `SELECT name, SUM(quantity)::bigint AS quantity, SUM(net_paise)::bigint AS net, SUM(cost_paise)::bigint AS cost,
                BOOL_AND(cost_paise IS NOT NULL) AS costed
           FROM fact_order_lines WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3 GROUP BY name`,
        [r.outletId, r.from, r.to],
      );
      const costed = rows.filter((x) => x.costed && x.quantity > 0);
      const totalQty = costed.reduce((s, x) => s + x.quantity, 0);
      const totalCm = costed.reduce((s, x) => s + (x.net - (x.cost ?? 0)), 0);
      const avgCm = totalQty ? totalCm / totalQty : 0;
      const popThreshold = costed.length ? 0.7 / costed.length : 0;
      const items = rows
        .map((x) => {
          const mix = totalQty ? x.quantity / totalQty : 0;
          const cmPerUnit = x.costed ? Math.round((x.net - (x.cost ?? 0)) / x.quantity) : null;
          const popular = mix >= popThreshold;
          const profitable = cmPerUnit !== null && cmPerUnit >= avgCm;
          const klass = cmPerUnit === null ? 'NO_COST' : popular ? (profitable ? 'STAR' : 'PLOWHORSE') : profitable ? 'PUZZLE' : 'DOG';
          return {
            name: x.name,
            quantity: x.quantity,
            netPaise: x.net,
            costPaise: x.cost,
            avgPricePaise: Math.round(x.net / x.quantity),
            cmPerUnitPaise: cmPerUnit,
            foodCostPct: x.costed && x.net ? Math.round(((x.cost ?? 0) / x.net) * 1000) / 10 : null,
            mixPct: Math.round(mix * 1000) / 10,
            class: klass,
          };
        })
        .sort((a, b) => b.netPaise - a.netPaise);
      return { range: r, thresholds: { popularityMixPct: Math.round(popThreshold * 1000) / 10, avgCmPerUnitPaise: Math.round(avgCm) }, items };
    });
  }

  // ------------------------------------------------------------------ finance

  async pnl(p: Principal, q: RangeQuery) {
    const r = this.range(p, q);
    return this.run(p, async (tx) => {
      const st = await this.statementFor(tx, r);
      const s = st.sales;
      const pct = (a: number) => (s.net ? Math.round((a / s.net) * 1000) / 10 : null);
      const salaries = st.expenses.find((e) => e.category === 'SALARIES')?.amount ?? 0;

      const { rows: gstByRate } = await tx.query<{ rate_bp: number; taxable: number; tax: number }>(
        `SELECT gst_rate_bp AS rate_bp, SUM(net_paise)::bigint AS taxable, SUM(tax_paise)::bigint AS tax FROM fact_order_lines
          WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3 GROUP BY gst_rate_bp ORDER BY gst_rate_bp`,
        [r.outletId, r.from, r.to],
      );

      // Month by month, each month clipped to the selected range, computed exactly like the main statement.
      const monthly = [];
      for (let m = r.from.slice(0, 7); m <= r.to.slice(0, 7); m = nextMonth(m)) {
        const monthEnd = addDays(`${nextMonth(m)}-01`, -1);
        const mr = { ...r, from: `${m}-01` < r.from ? r.from : `${m}-01`, to: monthEnd > r.to ? r.to : monthEnd };
        const ms = await this.statementFor(tx, mr);
        monthly.push({ month: m, from: mr.from, to: mr.to, net: ms.sales.net, cogs: ms.cogs, expenses: ms.expenseTotal, profit: ms.operatingProfit });
      }

      return {
        range: r,
        statement: {
          netSalesPaise: s.net,
          refundsNetPaise: st.refundsNet,
          roundOffPaise: s.round_off,
          revenuePaise: st.revenue,
          cogsPaise: st.cogs,
          grossProfitPaise: st.grossProfit,
          paymentFeesPaise: st.fees,
          expenses: st.expenses,
          expensesPaise: st.expenseTotal,
          operatingProfitPaise: st.operatingProfit,
        },
        ratios: {
          foodCostPct: pct(st.cogs),
          primeCostPct: pct(st.cogs + salaries),
          grossMarginPct: pct(st.grossProfit),
          operatingMarginPct: pct(st.operatingProfit),
          costCoveragePct: s.net ? Math.round((st.costedNet / s.net) * 1000) / 10 : null,
        },
        gst: {
          outputCgstPaise: s.cgst,
          outputSgstPaise: s.sgst,
          byRate: gstByRate.map((g) => ({ rateBp: g.rate_bp, taxablePaise: g.taxable, taxPaise: g.tax })),
          invoices: s.bills,
        },
        collections: st.methods.map((m) => ({ method: m.method, netPaise: m.net, feePaise: Math.round((m.net * (FEE_BP[m.method] ?? 0)) / 10_000) })),
        refundsGrossPaise: st.refundsGross,
        monthly,
      };
    });
  }

  /** One P&L calculation, used for the period and for each month so the numbers always agree. */
  private async statementFor(tx: Tx, r: Range) {
    const sales = (await tx.query<{ net: number; gross: number; cgst: number; sgst: number; round_off: number; bills: number }>(
      `SELECT COALESCE(SUM(subtotal_paise),0)::bigint AS net, COALESCE(SUM(total_paise),0)::bigint AS gross, COALESCE(SUM(cgst_paise),0)::bigint AS cgst,
              COALESCE(SUM(sgst_paise),0)::bigint AS sgst, COALESCE(SUM(round_off_paise),0)::bigint AS round_off, COUNT(*)::bigint AS bills
         FROM fact_orders WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3`,
      [r.outletId, r.from, r.to],
    )).rows[0]!;
    const c = (await tx.query<{ cost: number; costed_net: number }>(
      `SELECT COALESCE(SUM(cost_paise),0)::bigint AS cost, COALESCE(SUM(net_paise) FILTER (WHERE cost_paise IS NOT NULL),0)::bigint AS costed_net
         FROM fact_order_lines WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3`,
      [r.outletId, r.from, r.to],
    )).rows[0]!;
    const refundsGross = await this.sum(tx, `SELECT COALESCE(SUM(amount_paise),0)::bigint AS v FROM fact_refunds WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3`, r);
    // Refunds include GST; strip it proportionally to estimate the revenue reversal.
    const refundsNet = sales.gross ? Math.round((refundsGross * sales.net) / sales.gross) : 0;
    const { rows: methods } = await tx.query<{ method: string; net: number }>(
      `SELECT method, SUM(net_paise)::bigint AS net FROM fact_payments WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3 GROUP BY method ORDER BY net DESC`,
      [r.outletId, r.from, r.to],
    );
    const fees = methods.reduce((t, m) => t + Math.round((m.net * (FEE_BP[m.method] ?? 0)) / 10_000), 0);
    const expenses = await this.allocatedExpenses(tx, r);
    const expenseTotal = expenses.reduce((t, e) => t + e.amount, 0);
    const revenue = sales.net - refundsNet + sales.round_off;
    const grossProfit = revenue - c.cost;
    return {
      sales, methods, fees, expenses, expenseTotal, refundsGross, refundsNet, revenue, grossProfit,
      cogs: c.cost, costedNet: c.costed_net, operatingProfit: grossProfit - fees - expenseTotal,
    };
  }

  // ------------------------------------------------------------------ CRM

  async customers(p: Principal, q: RangeQuery) {
    const r = this.range(p, q);
    const segment = `CASE
        WHEN visits >= 5 AND last_visit >= $1::date - 30 THEN 'CHAMPION'
        WHEN visits >= 3 AND last_visit >= $1::date - 45 THEN 'LOYAL'
        WHEN visits = 1 AND first_visit >= $1::date - 30 THEN 'NEW'
        WHEN visits >= 3 AND last_visit < $1::date - 45 AND last_visit >= $1::date - 90 THEN 'AT_RISK'
        WHEN last_visit < $1::date - 90 THEN 'LOST'
        ELSE 'OCCASIONAL' END`;
    return this.run(p, async (tx) => {
      const sum = (await tx.query<{ customers: number; consented: number; new_in_range: number }>(
        `SELECT COUNT(*)::bigint AS customers, COUNT(*) FILTER (WHERE marketing_consent)::bigint AS consented,
                COUNT(*) FILTER (WHERE first_visit BETWEEN $1 AND $2)::bigint AS new_in_range
           FROM customers WHERE first_visit <= $2`,
        [r.from, r.to],
      )).rows[0]!;
      const bills = (await tx.query<{ bills: number; identified: number; repeat: number; identified_net: number }>(
        `SELECT COUNT(*)::bigint AS bills, COUNT(o.customer_phone)::bigint AS identified,
                COUNT(*) FILTER (WHERE c.first_visit < o.business_date)::bigint AS repeat,
                COALESCE(SUM(o.subtotal_paise) FILTER (WHERE o.customer_phone IS NOT NULL),0)::bigint AS identified_net
           FROM fact_orders o LEFT JOIN customers c ON c.tenant_id = o.tenant_id AND c.phone = o.customer_phone
          WHERE o.outlet_id = $1 AND o.business_date BETWEEN $2 AND $3`,
        [r.outletId, r.from, r.to],
      )).rows[0]!;
      const { rows: segments } = await tx.query(
        `SELECT ${segment} AS segment, COUNT(*)::bigint AS customers, SUM(spend_paise)::bigint AS spend, AVG(visits)::float8 AS avg_visits
           FROM customers WHERE first_visit <= $1 GROUP BY 1`,
        [r.to],
      );
      const pick = (extra: string, order: string) =>
        tx.query(
          `SELECT '••••••' || right(phone, 4) AS phone, name, visits, spend_paise AS spend, last_visit::text AS last_visit, marketing_consent AS consent,
                  ${segment} AS segment, ($1::date - last_visit) AS days_since
             FROM customers WHERE first_visit <= $1 ${extra} ORDER BY ${order} LIMIT 15`,
          [r.to],
        );
      const top = (await pick('', 'spend_paise DESC')).rows;
      const winBack = (await pick(`AND marketing_consent AND (${segment}) IN ('AT_RISK','LOST')`, 'spend_paise DESC')).rows;
      return {
        range: r,
        summary: {
          customers: sum.customers,
          consented: sum.consented,
          newInRange: sum.new_in_range,
          identifiedBillPct: bills.bills ? Math.round((bills.identified / bills.bills) * 1000) / 10 : 0,
          repeatBillPct: bills.identified ? Math.round((bills.repeat / bills.identified) * 1000) / 10 : 0,
          identifiedNetPaise: bills.identified_net,
        },
        segments,
        top,
        winBack,
      };
    });
  }

  // ------------------------------------------------------------------ alerts

  async alerts(p: Principal, q: RangeQuery) {
    const r = this.range(p, q);
    return this.run(p, async (tx) => {
      const { rows: items } = await tx.query(
        `SELECT kind, severity, message, ref_id, amount_paise, created_at FROM alerts
          WHERE outlet_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3 ORDER BY created_at DESC LIMIT 100`,
        [r.outletId, r.from, r.to],
      );
      const { rows: bySeverity } = await tx.query(
        `SELECT severity, COUNT(*)::bigint AS count, COALESCE(SUM(amount_paise),0)::bigint AS amount FROM alerts
          WHERE outlet_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3 GROUP BY severity`,
        [r.outletId, r.from, r.to],
      );
      const refundRate = (await tx.query<{ refunds: number; sales: number }>(
        `SELECT (SELECT COALESCE(SUM(amount_paise),0) FROM fact_refunds WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3)::bigint AS refunds,
                (SELECT COALESCE(SUM(total_paise),0) FROM fact_orders WHERE outlet_id = $1 AND business_date BETWEEN $2 AND $3)::bigint AS sales`,
        [r.outletId, r.from, r.to],
      )).rows[0]!;
      // Sales anomalies: each finished day vs the median of the same weekday over the 4 weeks before it.
      const { rows: days } = await tx.query<{ day: string; net: number }>(
        `SELECT d::date::text AS day, COALESCE(SUM(o.subtotal_paise),0)::bigint AS net
           FROM generate_series($2::date - 28, $3::date, interval '1 day') d
           LEFT JOIN fact_orders o ON o.business_date = d::date AND o.outlet_id = $1
          GROUP BY d ORDER BY d`,
        [r.outletId, r.from, r.to],
      );
      const netOn = new Map(days.map((d) => [d.day, d.net]));
      const today = istToday();
      const anomalies = [];
      for (const d of days) {
        if (d.day < r.from || d.day >= today) continue; // skip the unfinished current day
        const prior = [7, 14, 21, 28].map((k) => netOn.get(addDays(d.day, -k))).filter((v): v is number => v !== undefined && v > 0).sort((a, b) => a - b);
        if (prior.length < 3) continue;
        const median = prior[Math.floor(prior.length / 2)]!;
        const change = (d.net - median) / median;
        const weekday = new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });
        const label = new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
        if (change <= -0.3) {
          anomalies.push({ kind: 'SALES_DROP', severity: change <= -0.5 ? 'serious' : 'warning', amount_paise: median - d.net, ref_id: d.day,
            message: `Sales on ${weekday} ${label} were ${Math.round(-change * 100)}% below a usual ${weekday} (₹${Math.round(d.net / 100).toLocaleString('en-IN')} vs ₹${Math.round(median / 100).toLocaleString('en-IN')})`,
            created_at: new Date(Date.parse(`${d.day}T23:59:00+05:30`)).toISOString() });
        }
      }
      const all = [...items, ...anomalies];
      all.sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime());
      const sev = new Map(bySeverity.map((b) => [b.severity as string, { ...b }]));
      for (const a of anomalies) {
        const cur = sev.get(a.severity) ?? { severity: a.severity, count: 0, amount: 0 };
        cur.count = (cur.count as number) + 1;
        cur.amount = (cur.amount as number) + a.amount_paise;
        sev.set(a.severity, cur);
      }
      return {
        range: r,
        bySeverity: [...sev.values()],
        refundRatePct: refundRate.sales ? Math.round((refundRate.refunds / refundRate.sales) * 10_000) / 100 : 0,
        items: all,
      };
    });
  }

  // ------------------------------------------------------------------ expenses

  async addExpense(p: Principal, input: z.infer<typeof ExpenseInput>) {
    assertOutletAccess(p, input.outletId);
    const id = newId();
    await this.db.tx(
      (tx) =>
        tx.query(
          `INSERT INTO expenses (id, tenant_id, outlet_id, business_date, category, amount_paise, period, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, p.tenantId, input.outletId, input.businessDate, input.category, input.amountPaise, input.period, input.note ?? null, p.userId],
        ),
      { tenantId: p.tenantId },
    );
    return { id, ...input };
  }

  async listExpenses(p: Principal, q: RangeQuery) {
    const r = this.range(p, q);
    return this.run(p, async (tx) => ({
      range: r,
      items: (
        await tx.query(
          `SELECT id, business_date::text AS "businessDate", category, amount_paise AS "amountPaise", period, note, created_by AS "createdBy"
             FROM expenses WHERE outlet_id = $1 AND business_date BETWEEN date_trunc('month', $2::date) AND $3 ORDER BY business_date DESC, created_at DESC`,
          [r.outletId, r.from, r.to],
        )
      ).rows,
    }));
  }

  /** Expenses that belong to the range: one-time ones by date, monthly ones pro-rata by days. */
  private async allocatedExpenses(tx: Tx, r: Range): Promise<{ category: string; amount: number }[]> {
    const { rows } = await tx.query<{ category: string; amount: number }>(
      `WITH e AS (
         SELECT category, amount_paise, period, business_date,
                date_trunc('month', business_date)::date AS ms,
                (date_trunc('month', business_date) + interval '1 month - 1 day')::date AS me
           FROM expenses WHERE outlet_id = $1)
       SELECT category, ROUND(SUM(CASE
                WHEN period = 'MONTHLY' THEN amount_paise::numeric * GREATEST(0, LEAST($3::date, me) - GREATEST($2::date, ms) + 1) / (me - ms + 1)
                WHEN business_date BETWEEN $2 AND $3 THEN amount_paise ELSE 0 END))::bigint AS amount
         FROM e GROUP BY category ORDER BY amount DESC`,
      [r.outletId, r.from, r.to],
    );
    return rows.filter((x) => x.amount > 0);
  }

  private async sum(tx: Tx, sql: string, r: Range): Promise<number> {
    return (await tx.query<{ v: number }>(sql, [r.outletId, r.from, r.to])).rows[0]!.v;
  }
}
