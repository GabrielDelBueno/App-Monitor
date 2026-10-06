import { openPostgres } from "./postgres.js";
import { existsSync } from "node:fs";
import { openDatabase, createUser } from "./database.js";
if (existsSync(".env")) process.loadEnvFile(".env");
const {
  ADMIN_EMAIL: email,
  ADMIN_NAME: name,
  ADMIN_PASSWORD: password,
} = process.env;
if (!email || !name || !password || password.length < 12) {
  console.error(
    "Defina ADMIN_EMAIL, ADMIN_NAME e ADMIN_PASSWORD (mínimo 12 caracteres) no ambiente para criar o primeiro administrador.",
  );
  process.exit(1);
}
const db = process.env.DATABASE_URL
  ? await openPostgres(process.env.DATABASE_URL)
  : openDatabase(process.env.DATABASE_PATH || "./data/app-monitor.sqlite");
try {
  if (await db.prepare("SELECT id FROM users WHERE role='ADMINISTRADOR'").get())
    throw Error(
      "Já existe um administrador. Use a tela de usuários; o bootstrap não altera contas existentes.",
    );
  await createUser(db, { name, email, password, role: "ADMINISTRADOR" });
  console.log(
    "Administrador criado. Remova ADMIN_PASSWORD da configuração após o cadastro.",
  );
} finally {
  await db.close();
}
