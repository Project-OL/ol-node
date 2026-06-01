/**
 * BigInt serialisation helpers.
 *
 * Fastify's reply serialiser stringifies top-level BigInt fields, but values
 * nested inside `$queryRaw` result objects are returned to the client through
 * service layers that should normalise them explicitly. Always pass BigInt
 * aggregates through `bigIntToStr` before returning from a service.
 */

/** Serialise a (possibly null/undefined) BigInt as a decimal string, defaulting to "0". */
export function bigIntToStr(n: bigint | null | undefined): string {
  return n != null ? n.toString() : "0";
}

/** Format a duration in seconds as `HH:MM:SS` (hours may exceed 24). */
export function formatDuration(totalSeconds: bigint | number | null | undefined): string {
  const raw =
    totalSeconds == null
      ? 0
      : typeof totalSeconds === "bigint"
        ? Number(totalSeconds)
        : totalSeconds;
  const secs = raw > 0 ? Math.floor(raw) : 0;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
