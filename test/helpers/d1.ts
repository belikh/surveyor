// Minimal in-memory D1 facade over node:sqlite for route tests.
import { DatabaseSync } from "node:sqlite";

export class FakeD1 {
  private db = new DatabaseSync(":memory:");
  private stmts = new Map<string, { sql: string; params: unknown[] }>();
  async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
    for (const s of statements) {
      if (typeof s !== "object" || typeof s.sql !== "string") {
        throw new Error("batch expects prepared statements with .sql");
      }
      await this.run(s.sql, s.params ?? []);
    }
    return [];
  }
  prepare(sql: string) {
    // Compile lazily (like real D1), so a batch can contain DDL and a later
    // statement that depends on it (e.g. CREATE TABLE then CREATE INDEX).
    const compile = () => this.db.prepare(sql);
    const d1Result = (r: { changes: number | bigint }) => ({
      success: true,
      meta: { changes: Number(r.changes) },
    });
    const bound = (params: unknown[]) => ({
      sql,
      params,
      first: async <T>() => compile().get(...params.map(toSql)) as T,
      all: async <T>() => ({
        results: compile().all(...params.map(toSql)) as T[],
      }),
      run: async () => d1Result(compile().run(...params.map(toSql))),
    });
    return {
      sql,
      bind: (...params: unknown[]) => bound(params),
      first: async <T>() => compile().get() as T,
      all: async <T>() => compile().all() as T,
      run: async () => d1Result(compile().run()),
    };
  }
  async run(sql: string, params: unknown[]) {
    const stmt = this.db.prepare(sql);
    stmt.run(...params.map(toSql));
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
}

function toSql(v: unknown): null | string | number | bigint | Uint8Array {
  if (v === null || v === undefined) return null;
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "bigint" ||
    v instanceof Uint8Array
  ) {
    return v;
  }
  return JSON.stringify(v);
}
