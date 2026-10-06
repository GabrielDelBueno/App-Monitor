import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { schema } from "./database.js";

// Millisecond timestamps and COUNT(*) fit safely in JavaScript numbers.
const types = new pg.TypeOverrides();
types.setTypeParser(20, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw Error("Inteiro fora do limite seguro.");
  return number;
});
export async function openPostgres(
  connectionString,
  { localTest = false } = {},
) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw Error("DATABASE_URL inválida.");
  if (localTest && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw Error("Banco sem TLS permitido apenas no teste local.");
  // Explicit TLS verification cannot be overridden by query string options.
  for (const key of [
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "uselibpqcompat",
  ])
    url.searchParams.delete(key);
  const pool = new pg.Pool({
    connectionString: url.href,
    ssl: localTest ? false : { rejectUnauthorized: true },
    max: 5,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    types,
  });
  pool.on("error", (error) =>
    console.error("Conexão PostgreSQL:", error.code || error.name),
  );
  const context = new AsyncLocalStorage();
  async function query(sql, params = []) {
    let index = 0;
    const text = sql.replace(/\?/g, () => `$${++index}`);
    return (context.getStore() || pool).query(text, params);
  }
  const db = {
    dialect: "postgres",
    prepare(sql) {
      return {
        async get(...params) {
          return (await query(sql, params)).rows[0];
        },
        async all(...params) {
          return (await query(sql, params)).rows;
        },
        async run(...params) {
          return { changes: (await query(sql, params)).rowCount };
        },
      };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialize writes, including initial installation, across connections.
        await client.query("SELECT pg_advisory_xact_lock(734121820)");
        const result = await context.run(client, fn);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  try {
    await db.transaction(async () => {
      await query(schema.replaceAll("expires_at INTEGER", "expires_at BIGINT"));
      await query(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INTEGER NOT NULL DEFAULT 0",
      );
    });
    return db;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
