import { formatInr, percentOf, roundToRupee, safeAdd, splitGst } from './money';
import { CircuitBreaker } from './http';
import { UpstreamError } from './errors';
import { financialYear } from '../../../services/order-pos/src/orders.service';

describe('money', () => {
  it('computes GST with half-up rounding in integer paise', () => {
    expect(percentOf(68_750, 500)).toBe(3_438); // 34.375 → 34.38
    expect(percentOf(1, 500)).toBe(0);
    expect(percentOf(10, 500)).toBe(1); // 0.5 → 1
    expect(percentOf(9_007_199_254_740, 1800)).toBe(1_621_295_865_853);
  });

  it('splits CGST/SGST so the halves always add back to the total', () => {
    for (const tax of [0, 1, 2, 3_437, 3_438, 99_999]) {
      const { cgstPaise, sgstPaise } = splitGst(tax);
      expect(cgstPaise + sgstPaise).toBe(tax);
      expect(Math.abs(cgstPaise - sgstPaise)).toBeLessThanOrEqual(1);
    }
  });

  it('rounds invoices to the nearest rupee', () => {
    expect(roundToRupee(72_188)).toEqual({ roundedPaise: 72_200, roundOffPaise: 12 });
    expect(roundToRupee(72_149)).toEqual({ roundedPaise: 72_100, roundOffPaise: -49 });
    expect(roundToRupee(72_150)).toEqual({ roundedPaise: 72_200, roundOffPaise: 50 });
  });

  it('refuses floats, negatives and overflow', () => {
    expect(() => percentOf(10.5, 500)).toThrow();
    expect(() => percentOf(-1, 500)).toThrow();
    expect(() => safeAdd(Number.MAX_SAFE_INTEGER, 1)).toThrow();
    expect(formatInr(72_200)).toBe('₹722.00');
  });

  it('labels Indian financial years in IST', () => {
    expect(financialYear(new Date('2026-10-18T10:00:00Z'))).toBe('2627');
    expect(financialYear(new Date('2027-03-31T18:30:00Z'))).toBe('2728'); // 1 April IST already
    expect(financialYear(new Date('2027-03-31T18:00:00+05:30'))).toBe('2627');
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures and fails fast', async () => {
    const cb = new CircuitBreaker('x', 2, 60_000);
    const boom = () => Promise.reject(new Error('down'));
    await expect(cb.exec(boom)).rejects.toThrow('down');
    await expect(cb.exec(boom)).rejects.toThrow('down');
    let called = false;
    await expect(cb.exec(async () => (called = true))).rejects.toBeInstanceOf(UpstreamError);
    expect(called).toBe(false);
  });
});
