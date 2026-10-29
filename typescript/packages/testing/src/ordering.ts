import type { EventLog, RecordedEvent } from "@projected/application";

/**
 * Write `streams × perStream` events from concurrent writers while a reader follows the log from
 * its last position, the way an event handler does. Returns what the reader saw and what the log
 * holds once writing is done: a store keeps the global-order guarantee when the two are equal.
 */
export async function followWhileWriting(
  log: EventLog,
  write: (stream: number, index: number) => Promise<unknown>,
  { streams = 40, perStream = 5 }: { readonly streams?: number; readonly perStream?: number } = {},
): Promise<{ readonly seen: readonly number[]; readonly all: readonly number[] }> {
  const seen: number[] = [];
  let writing = true;
  const reader = (async () => {
    let position = 0;
    for (;;) {
      // Read before checking, not after: an empty batch only proves the reader caught up if every
      // write had finished before the read began.
      const writesDone = !writing;
      const batch: readonly RecordedEvent[] = (await log.readAll({ after: position, limit: 50 })).unwrap();
      for (const event of batch) {
        seen.push(event.globalPosition);
        position = event.globalPosition;
      }
      if (writesDone && batch.length === 0) return;
    }
  })();
  await Promise.all(
    Array.from({ length: streams }, async (_, stream) => {
      for (let index = 0; index < perStream; index++) await write(stream, index);
    }),
  );
  writing = false;
  await reader;
  const all = (await log.readAll({ after: 0, limit: streams * perStream + 1 })).unwrap().map((event) => event.globalPosition);
  return { seen, all };
}
