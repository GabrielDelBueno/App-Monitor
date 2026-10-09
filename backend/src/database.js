import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
export const id = () => randomUUID();
export function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password, hash) {
  const [salt, key] = hash.split(":");
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(key, "hex"));
}
export const schema = `
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('TI','PROFESSOR','ADMINISTRADOR')),active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,number TEXT NOT NULL UNIQUE,qr TEXT NOT NULL UNIQUE,type TEXT NOT NULL CHECK(type IN ('TABLET','NOTEBOOK','CHROMEBOOK','CELULAR')),status TEXT NOT NULL CHECK(status IN ('BOM_ESTADO','CONSERVADO','EM_MANUTENCAO','QUEBRADO')),notes TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,internal_id TEXT NOT NULL DEFAULT '',serial_number TEXT NOT NULL DEFAULT '',manufacturer TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS appointments(id TEXT PRIMARY KEY,teacher_id TEXT NOT NULL REFERENCES users(id),date TEXT NOT NULL,time TEXT NOT NULL,class_name TEXT NOT NULL,type TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 25),extras INTEGER NOT NULL DEFAULT 0 CHECK(extras BETWEEN 0 AND 5),status TEXT NOT NULL DEFAULT 'PENDENTE',created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS appointment_items(appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('INITIAL','EXTRA')),type TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 25),PRIMARY KEY(appointment_id,kind,type));
 CREATE TABLE IF NOT EXISTS loans(id TEXT PRIMARY KEY,appointment_id TEXT REFERENCES appointments(id),teacher_id TEXT NOT NULL REFERENCES users(id),ti_id TEXT NOT NULL REFERENCES users(id),class_name TEXT NOT NULL,departed_at TEXT NOT NULL,returned_at TEXT,report TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'EM_USO');
 CREATE TABLE IF NOT EXISTS loan_items(id TEXT PRIMARY KEY,loan_id TEXT NOT NULL REFERENCES loans(id),device_id TEXT NOT NULL REFERENCES devices(id),student TEXT NOT NULL DEFAULT '',departure_status TEXT NOT NULL,return_status TEXT,ti_comment TEXT NOT NULL DEFAULT '',UNIQUE(loan_id,device_id));
 CREATE TABLE IF NOT EXISTS signatures(id TEXT PRIMARY KEY,loan_id TEXT NOT NULL REFERENCES loans(id),user_id TEXT NOT NULL REFERENCES users(id),type TEXT NOT NULL,image TEXT NOT NULL,signed_at TEXT NOT NULL,UNIQUE(loan_id,type));
 CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,message TEXT NOT NULL,page TEXT NOT NULL,entity_id TEXT,status TEXT NOT NULL DEFAULT 'PENDENTE',created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),action TEXT NOT NULL,entity_id TEXT,details TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS oauth_flows(state_hash TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,code_verifier TEXT NOT NULL,nonce TEXT NOT NULL,redirect_uri TEXT NOT NULL,mode TEXT NOT NULL,user_id TEXT REFERENCES users(id),session_hash TEXT,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS external_identities(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),issuer TEXT NOT NULL,subject_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(issuer,subject_hash),UNIQUE(issuer,user_id));
 CREATE INDEX IF NOT EXISTS loan_items_device ON loan_items(device_id);
 CREATE INDEX IF NOT EXISTS loans_teacher ON loans(teacher_id,status);
 CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,status);
 `;
export function openDatabase(path) {
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
  );
  db.exec(schema);
  if (
    !db
      .prepare("PRAGMA table_info(users)")
      .all()
      .some((column) => column.name === "must_change_password")
  ) {
    db.exec(
      "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
    );
  }
  for (const column of [
    "internal_id",
    "serial_number",
    "manufacturer",
    "model",
  ]) {
    if (
      !db
        .prepare("PRAGMA table_info(devices)")
        .all()
        .some((c) => c.name === column)
    )
      db.exec(
        `ALTER TABLE devices ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`,
      );
  }
  const deviceSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE name='devices'")
    .get().sql;
  if (!deviceSql.includes("'CELULAR'")) {
    // Rebuild only the device table; IDs and all references remain unchanged.
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
    try {
      const definition = schema.match(
        /CREATE TABLE IF NOT EXISTS devices\([^;]+;/,
      )[0];
      db.exec(definition.replace("IF NOT EXISTS devices", "devices_updated"));
      const columns =
        "id,number,qr,type,status,notes,active,internal_id,serial_number,manufacturer,model";
      db.exec(`INSERT INTO devices_updated(${columns}) SELECT ${columns} FROM devices;
        DROP TABLE devices; ALTER TABLE devices_updated RENAME TO devices;`);
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw Error("Referências inválidas na atualização do inventário.");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS devices_serial ON devices(serial_number) WHERE serial_number <> ''",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS devices_internal ON devices(internal_id) WHERE internal_id <> ''",
  );
  return db;
}
export async function transaction(db, fn) {
  if (db.transaction) return db.transaction(fn);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function createUser(
  db,
  { name, email, password, role, mustChangePassword = false },
) {
  const user = { id: id(), name, email: email.toLowerCase(), role, active: 1 };
  const result = db
    .prepare(
      "INSERT INTO users(id,name,email,password,role,created_at,must_change_password) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      user.id,
      name,
      user.email,
      passwordHash(password),
      role,
      new Date().toISOString(),
      +mustChangePassword,
    );
  return result?.then ? result.then(() => user) : user;
}
