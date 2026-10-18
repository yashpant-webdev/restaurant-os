import { ValidationError } from './errors';

/**
 * All money is integer paise (₹1 = 100 paise). Never floats: 0.1 + 0.2 !== 0.3.
 * Multiplications that could exceed 2^53 go through BigInt.
 */

export function assertPaise(value: unknown, field = 'amount'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer number of paise`);
  }
  return value;
}

/** Round-half-up of (amount * rateBasisPoints / 10000). 500 bp = 5%. */
export function percentOf(amountPaise: number, rateBasisPoints: number): number {
  assertPaise(amountPaise);
  if (!Number.isInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > 10_000) {
    throw new ValidationError('rate must be between 0 and 10000 basis points');
  }
  const scaled = BigInt(amountPaise) * BigInt(rateBasisPoints);
  const result = (scaled + 5_000n) / 10_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new ValidationError('amount too large');
  return Number(result);
}

/** Intra-state GST splits equally into CGST and SGST; any odd paisa goes to SGST. */
export function splitGst(taxPaise: number): { cgstPaise: number; sgstPaise: number } {
  assertPaise(taxPaise, 'tax');
  const cgstPaise = Math.floor(taxPaise / 2);
  return { cgstPaise, sgstPaise: taxPaise - cgstPaise };
}

/** Invoices round to the nearest rupee (half-up). roundOff can be negative. */
export function roundToRupee(totalPaise: number): { roundedPaise: number; roundOffPaise: number } {
  assertPaise(totalPaise, 'total');
  const roundedPaise = Math.floor((totalPaise + 50) / 100) * 100;
  return { roundedPaise, roundOffPaise: roundedPaise - totalPaise };
}

export function safeAdd(...values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(sum)) throw new ValidationError('amount overflow');
  return sum;
}

export function safeMultiply(a: number, b: number): number {
  const product = a * b;
  if (!Number.isSafeInteger(product)) throw new ValidationError('amount overflow');
  return product;
}

export function formatInr(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}₹${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
