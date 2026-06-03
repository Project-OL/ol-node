import { Prisma } from "@prisma/client";

/** Platform convention: 10_000 points = 1 USD (withdrawal, payroll, coin exchange). */
export const POINTS_PER_USD = 10_000n;

const POINTS_PER_USD_DECIMAL = new Prisma.Decimal(POINTS_PER_USD.toString());

/** USD string with two decimal places (e.g. `"70.00"`). */
export function formatPointsAsUsd(points: bigint): string {
  return new Prisma.Decimal(points.toString())
    .div(POINTS_PER_USD_DECIMAL)
    .toFixed(2);
}
