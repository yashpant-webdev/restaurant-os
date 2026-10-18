// Generates realistic past sales for the demo and publishes them as the same
// `pos.order.settled` / `payment.refunded` events the live system emits, so the
// analytics service builds its read model exactly as it would in production
// (this is also how a migration from another POS would be imported).
// Seeded random: every demo run produces the same history.
import { randomUUID } from 'node:crypto';

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Priya', 'Arjun', 'Ananya', 'Rohan', 'Kavya', 'Vikram', 'Meera', 'Aditya', 'Sneha', 'Rahul', 'Isha', 'Karan', 'Divya', 'Nikhil', 'Pooja', 'Sameer', 'Neha', 'Varun', 'Aisha', 'Manish'];
const LAST = ['Sharma', 'Iyer', 'Reddy', 'Nair', 'Gupta', 'Rao', 'Menon', 'Kapoor', 'Joshi', 'Pillai', 'Shetty', 'Verma'];

export async function generateHistory({ bus, tenantId, outletId, menu, captains, days }) {
  const rand = rng(20261018);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const weighted = (items, w) => {
    const total = items.reduce((s, x) => s + w(x), 0);
    let r = rand() * total;
    for (const x of items) if ((r -= w(x)) <= 0) return x;
    return items[items.length - 1];
  };
  const pctOf = (net, bp) => Math.floor((net * bp + 5_000) / 10_000);

  // Guests: a few regulars come often, most come once or twice. Some regulars stop
  // coming after the first few weeks (they show up as "At risk" / win-back targets).
  const customers = Array.from({ length: 1100 }, (_, i) => ({
    phone: String(9_000_000_000 + Math.floor(rand() * 999_999_999)).replace(/^9/, pick(['9', '8', '7'])),
    name: `${pick(FIRST)} ${pick(LAST)}`,
    marketingConsent: rand() < 0.65,
    weight: i < 30 ? 6 : i < 150 ? 2 : 0.6,
    // Some regulars stopped coming 6–7 weeks ago: the win-back list should find them.
    churnAfterDay: i < 60 && i % 3 === 0 ? 4 + Math.floor(rand() * 10) : Infinity,
  }));

  const istNow = new Date(Date.now() + 330 * 60_000);
  const today = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  let orders = 0;
  let refunds = 0;
  let seq = 0;
  const publish = (topic, payload, occurredAt) =>
    bus.publish(topic, { eventId: randomUUID(), type: topic, version: 1, occurredAt, tenantId, key: payload.orderId, payload });

  for (let d = days; d >= 1; d--) {
    const dayStart = today - d * 86_400_000; // midnight IST, expressed as a UTC timestamp of the IST calendar day
    const dow = new Date(dayStart).getUTCDay(); // 0 = Sunday
    const dayIndex = days - d;
    const weekendBoost = dow === 0 || dow === 6 ? 1.55 : dow === 5 ? 1.25 : 1;
    const rainyDay = d === 9; // a heavy-rain evening: the anomaly detector should flag it
    const bills = Math.round((30 + rand() * 10) * weekendBoost * (1 + dayIndex * 0.004) * (rainyDay ? 0.45 : 1));

    for (let b = 0; b < bills; b++) {
      const lunch = rand() < 0.36;
      const minuteOfDay = lunch ? 12 * 60 + 15 + rand() * 170 : 19 * 60 + rand() * 225;
      const settled = new Date(dayStart + minuteOfDay * 60_000 - 330 * 60_000); // IST → UTC
      const guests = 1 + Math.floor(rand() * (lunch ? 3 : 5));
      const tableMinutes = 35 + Math.floor(rand() * 50) + guests * 4;

      const qtyByItem = new Map();
      const lineCount = Math.min(menu.length, 1 + Math.floor(guests * 0.9 + rand() * 2));
      for (let i = 0; i < lineCount; i++) {
        const item = weighted(menu, (m) => m.weight * (lunch && m.category === 'Drinks' ? 1.6 : 1));
        const qty = item.category === 'Breads' ? 1 + Math.floor(rand() * guests) : 1 + (rand() < 0.25 ? 1 : 0);
        qtyByItem.set(item, (qtyByItem.get(item) ?? 0) + qty);
      }
      const lines = [...qtyByItem].map(([m, quantity]) => {
        const netPaise = m.pricePaise * quantity;
        return { itemId: m.id, name: m.name, quantity, gstRateBp: m.gstRateBp, netPaise, taxPaise: pctOf(netPaise, m.gstRateBp), costPaise: m.costPaise * quantity };
      });
      const subtotal = lines.reduce((s, l) => s + l.netPaise, 0);
      const tax = lines.reduce((s, l) => s + l.taxPaise, 0);
      const cgst = Math.floor(tax / 2);
      const sgst = tax - cgst;
      const total = Math.floor((subtotal + tax + 50) / 100) * 100;

      const r = rand();
      const methods = r < 0.58 ? ['UPI'] : r < 0.85 ? ['CASH'] : r < 0.97 ? ['CARD'] : ['CASH', 'UPI'];
      const first = methods.length === 2 ? Math.round(total * 0.4) : total;
      const payments = methods.map((method, i) => ({ paymentId: randomUUID(), method, netPaise: i === 0 ? first : total - first }));

      let customer = null;
      if (rand() < 0.55) {
        const eligible = customers.filter((c) => dayIndex < c.churnAfterDay);
        const c = weighted(eligible, (x) => x.weight);
        customer = { phone: c.phone, name: c.name, marketingConsent: c.marketingConsent };
      }

      // Captains: Ravi is the senior one and takes more tables.
      const captain = weighted(captains, (c) => (c.name === 'Ravi' ? 1.6 : c.name === 'Meena' ? 0.8 : 1));
      const orderId = randomUUID();
      seq++;
      await publish(
        'pos.order.settled',
        {
          orderId, outletId, invoiceNo: `H${String(seq).padStart(6, '0')}`,
          subtotalPaise: subtotal, cgstPaise: cgst, sgstPaise: sgst, roundOffPaise: total - subtotal - tax, totalPaise: total, paidPaise: total,
          payments, settledAt: settled.toISOString(), channel: 'DINE_IN', tableRef: `T${1 + Math.floor(rand() * 10)}`, guests,
          openedAt: new Date(settled.getTime() - tableMinutes * 60_000).toISOString(), createdBy: captain.name, captainId: captain.id, captainName: captain.name,
          customer, lines,
        },
        settled.toISOString(),
      );
      orders++;

      const bigRefund = d === 12 && b === 5 || d === 3 && b === 9; // a couple of whole-bill refunds
      if (rand() < 0.012 || bigRefund) {
        const pay = payments[0];
        const refundPaise = bigRefund ? pay.netPaise : Math.min(pay.netPaise, Math.round((lines[0].netPaise * 1.05) / 100) * 100);
        await publish(
          'payment.refunded',
          {
            paymentId: pay.paymentId, orderId, outletId, method: pay.method, status: 'CAPTURED', amountPaise: pay.netPaise,
            capturedPaise: pay.netPaise, refundedPaise: refundPaise, stateVersion: 3, refundId: randomUUID(), refundPaise,
          },
          new Date(settled.getTime() + 20 * 60_000).toISOString(),
        );
        refunds++;
      }

      // Rare payment problems the payment service detects and reports.
      if ((d === 6 && b === 3) || (d === 20 && b === 7)) {
        await publish('pos.order.overpaid', { orderId, outletId, totalPaise: total, paidPaise: total * 2, excessPaise: total }, new Date(settled.getTime() + 60_000).toISOString());
      }
      if (d === 15 && b === 4) {
        const late = { paymentId: randomUUID(), orderId, outletId, method: 'UPI', status: 'CAPTURED', amountPaise: total, capturedPaise: total, refundedPaise: 0, stateVersion: 3, lateCapture: true };
        await publish('payment.captured', late, new Date(settled.getTime() + 5 * 60_000).toISOString());
      }
    }
  }

  // Monthly operating expenses for every month the history touches.
  const expenses = [];
  const months = new Set();
  for (let d = days; d >= 0; d--) months.add(new Date(today - d * 86_400_000).toISOString().slice(0, 7));
  for (const m of months) {
    expenses.push({ businessDate: `${m}-01`, category: 'RENT', amountPaise: 22_000_000, period: 'MONTHLY', note: 'Monthly rent' });
    expenses.push({ businessDate: `${m}-01`, category: 'SALARIES', amountPaise: 31_000_000, period: 'MONTHLY', note: '14 staff' });
    expenses.push({ businessDate: `${m}-05`, category: 'UTILITIES', amountPaise: 5_500_000, period: 'MONTHLY', note: 'Electricity, gas, water' });
    expenses.push({ businessDate: `${m}-10`, category: 'MARKETING', amountPaise: 2_500_000, period: 'MONTHLY', note: 'Instagram + Google ads' });
    expenses.push({ businessDate: `${m}-15`, category: 'MAINTENANCE', amountPaise: 1_200_000, period: 'ONE_TIME', note: 'Kitchen equipment service' });
  }
  return { orders, refunds, expenses };
}
