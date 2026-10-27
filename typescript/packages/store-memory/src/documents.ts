import { DependencyFailure, Result, type DocumentCollection, type DocumentStore, type z } from "@projected/application";

/** Numbers numerically, everything else by code point — the order every store must agree on. */
const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const [a, b] = [String(left), String(right)];
  return a < b ? -1 : a > b ? 1 : 0;
};

/** A {@link DocumentStore} in memory. Documents are copied in and out, as a real store would serialize them. */
export function inMemoryDocumentStore(): DocumentStore {
  const collections = new Map<string, Map<string, unknown>>();

  const collection = <S extends z.ZodType>(name: string, schema: S): DocumentCollection<z.output<S>> => {
    type Doc = z.output<S>;
    const documents = collections.get(name) ?? new Map<string, unknown>();
    collections.set(name, documents);

    const decode = (id: string, raw: unknown): Result<Doc, DependencyFailure> => {
      const parsed = schema.safeParse(structuredClone(raw));
      return parsed.success
        ? Result.ok(parsed.data as Doc)
        : Result.err(
            new DependencyFailure({
              dependency: `documents:${name}`,
              message: `Stored document ${name}/${id} does not match its schema`,
              cause: parsed.error,
            }),
          );
    };
    const field = (document: unknown, key: string) => (document as Record<string, unknown>)[key];

    return {
      get: async (id) => (documents.has(id) ? decode(id, documents.get(id)) : Result.ok(undefined)),
      put: async (id, document) => {
        documents.set(id, structuredClone(document));
        return Result.ok(undefined);
      },
      delete: async (id) => {
        documents.delete(id);
        return Result.ok(undefined);
      },
      find: async (filter, options = {}) => {
        const { orderBy, limit } = options;
        const matches = [...documents.entries()]
          .filter(([, raw]) =>
            Object.entries(filter).every(([key, value]) => JSON.stringify(field(raw, key)) === JSON.stringify(value)),
          )
          .sort(([idA, a], [idB, b]) => {
            if (orderBy === undefined) return compare(idA, idB);
            return compare(field(a, orderBy), field(b, orderBy)) || compare(idA, idB);
          });
        const decoded: Doc[] = [];
        for (const [id, raw] of limit === undefined ? matches : matches.slice(0, limit)) {
          const document = decode(id, raw);
          if (document.isErr()) return Result.err(document.error);
          decoded.push(document.value);
        }
        return Result.ok(decoded);
      },
    };
  };

  return { collection };
}
