/**
 * A copy of `value` as a real store would give it back: through JSON. A `Date` comes back as its
 * ISO string, `undefined` properties disappear — so what works in memory works against a database,
 * and nothing shares references with the caller.
 */
export function asJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
