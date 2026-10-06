import { DatabaseSync, backup } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
if (existsSync(".env")) process.loadEnvFile(".env");
export async function createBackup(sourcePath, destination) {
  const source = resolve(sourcePath),
    target = resolve(destination);
  if (source === target)
    throw Error("O backup não pode substituir o banco ativo.");
  if (existsSync(target))
    throw Error("O arquivo de destino já existe; escolha um nome novo.");
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${randomBytes(8).toString("hex")}.partial`;
  closeSync(openSync(temp, "wx", 0o600));
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    await backup(db, temp);
    const check = new DatabaseSync(temp, { readOnly: true });
    try {
      if (
        check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
      )
        throw Error("A verificação do backup falhou.");
    } finally {
      check.close();
    }
    linkSync(temp, target); // Exclusive destination, on the same filesystem.
  } finally {
    db?.close();
    if (existsSync(temp)) unlinkSync(temp);
  }
  return target;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.env.DATABASE_URL) {
    console.error(
      "Este comando é exclusivo do SQLite. Para PostgreSQL use pg_dump; consulte deploy/README.md.",
    );
    process.exit(1);
  }
  if (!process.argv[2]) {
    console.error("Uso: npm run backup -- /caminho/novo-backup.sqlite");
    process.exit(1);
  }
  try {
    console.log(
      "Backup consistente criado:",
      await createBackup(
        process.env.DATABASE_PATH || "./data/app-monitor.sqlite",
        process.argv[2],
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
