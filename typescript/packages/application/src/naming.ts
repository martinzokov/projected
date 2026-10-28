/** Operation, event handler and task names, as they appear in URLs: `enlist-student`. */
export const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** What a handler may return: the value, or a promise of it. */
export type MaybePromise<T> = T | Promise<T>;
