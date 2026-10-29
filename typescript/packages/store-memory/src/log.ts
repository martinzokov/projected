import type { RecordedEvent } from "@projected/application";

/**
 * Up to `limit` events after global position `after`, from a log in increasing position order.
 * A binary search, not a scan: handlers read the log after every command, and a scan would make
 * a long-running process slower with every event it records.
 */
export function readAfter(log: readonly RecordedEvent[], after: number, limit: number): RecordedEvent[] {
  let low = 0;
  let high = log.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((log[middle]?.globalPosition ?? Infinity) <= after) low = middle + 1;
    else high = middle;
  }
  return log.slice(low, low + limit);
}
