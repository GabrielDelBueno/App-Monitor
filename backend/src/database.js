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
export function openDatabase(path) {
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
  );
  db.exec(`
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('TI','PROFESSOR','ADMINISTRADOR')),active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,number TEXT NOT NULL UNIQUE,qr TEXT NOT NULL UNIQUE,type TEXT NOT NULL CHECK(type IN ('TABLET','NOTEBOOK','CHROMEBOOK')),status TEXT NOT NULL CHECK(status IN ('BOM_ESTADO','CONSERVADO','EM_MANUTENCAO','QUEBRADO')),notes TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS appointments(id TEXT PRIMARY KEY,teacher_id TEXT NOT NULL REFERENCES users(id),date TEXT NOT NULL,time TEXT NOT NULL,class_name TEXT NOT NULL,type TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 25),extras INTEGER NOT NULL DEFAULT 0 CHECK(extras BETWEEN 0 AND 5),status TEXT NOT NULL DEFAULT 'PENDENTE',created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS loans(id TEXT PRIMARY KEY,appointment_id TEXT REFERENCES appointments(id),teacher_id TEXT NOT NULL REFERENCES users(id),ti_id TEXT NOT NULL REFERENCES users(id),class_name TEXT NOT NULL,departed_at TEXT NOT NULL,returned_at TEXT,report TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'EM_USO');
 CREATE TABLE IF NOT EXISTS loan_items(id TEXT PRIMARY KEY,loan_id TEXT NOT NULL REFERENCES loans(id),device_id TEXT NOT NULL REFERENCES devices(id),student TEXT NOT NULL DEFAULT '',departure_status TEXT NOT NULL,return_status TEXT,ti_comment TEXT NOT NULL DEFAULT '',UNIQUE(loan_id,device_id));
 CREATE TABLE IF NOT EXISTS signatures(id TEXT PRIMARY KEY,loan_id TEXT NOT NULL REFERENCES loans(id),user_id TEXT NOT NULL REFERENCES users(id),type TEXT NOT NULL,image TEXT NOT NULL,signed_at TEXT NOT NULL,UNIQUE(loan_id,type));
 CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,message TEXT NOT NULL,page TEXT NOT NULL,entity_id TEXT,status TEXT NOT NULL DEFAULT 'PENDENTE',created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),action TEXT NOT NULL,entity_id TEXT,details TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS loan_items_device ON loan_items(device_id);
 CREATE INDEX IF NOT EXISTS loans_teacher ON loans(teacher_id,status);
 CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,status);
 `);
  return db;
}
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function createUser(db, { name, email, password, role }) {
  const user = { id: id(), name, email: email.toLowerCase(), role, active: 1 };
  db.prepare(
    "INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)",
  ).run(
    user.id,
    name,
    user.email,
    passwordHash(password),
    role,
    new Date().toISOString(),
  );
  return user;
}
