// Checked integer arithmetic for money. All amounts are integer minor
// units (cents). Every operation throws on overflow, underflow, or
// non-integer input so a bad value can never silently corrupt the ledger.

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function assertAmount(n: unknown): asserts n is number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_SAFE) {
    throw new Error(`invalid amount: ${String(n)}`);
  }
}

export function add(a: number, b: number): number {
  assertAmount(a);
  assertAmount(b);
  const r = a + b;
  if (r > MAX_SAFE) throw new Error("amount overflow");
  return r;
}

export function sub(a: number, b: number): number {
  assertAmount(a);
  assertAmount(b);
  if (b > a) throw new Error("amount underflow");
  return a - b;
}

/** Format minor units as a decimal string, e.g. 1999 -> "19.99". */
export function formatMinor(minor: number, decimals = 2): string {
  assertAmount(minor);
  const div = 10 ** decimals;
  const whole = Math.floor(minor / div);
  const frac = String(minor % div).padStart(decimals, "0");
  return `${whole}.${frac}`;
}

/** Parse a decimal string into minor units. Throws on bad input. */
export function parseMajor(s: string, decimals = 2): number {
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid money string: ${s}`);
  const [w, f = ""] = s.split(".");
  const minor = Number(w) * 10 ** decimals + Number(f.padEnd(decimals, "0"));
  assertAmount(minor);
  return minor;
}
