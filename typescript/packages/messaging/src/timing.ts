/** Wait `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `work`, or a rejection once `ms` have passed without an answer: for a transport's `ping()`,
 * which must answer promptly even when its broker never will.
 */
export const withTimeout = <T>(ms: number, work: Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
