import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.js";
import { createUser, id } from "./database.js";
if (process.env.NODE_ENV === "production")
  throw Error("A demonstração não pode ser iniciada em produção.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { app, db } = createApp({
  databasePath: resolve(root, "data/demo.sqlite"),
  secure: false,
  govbr: null,
});
if (!db.prepare("SELECT id FROM users LIMIT 1").get()) {
  for (const [name, email, role] of [
    ["Administrador de demonstração", "admin@demo.local", "ADMINISTRADOR"],
    ["Equipe TI", "ti@demo.local", "TI"],
    ["Professor de demonstração", "professor@demo.local", "PROFESSOR"],
  ])
    createUser(db, { name, email, password: "Demo-Monitor-2026!", role });
  for (let n = 1; n <= 30; n++) {
    const number = String(n).padStart(3, "0");
    db.prepare(
      "INSERT INTO devices(id,number,qr,type,status) VALUES(?,?,?,?,?)",
    ).run(
      id(),
      `TB-${number}`,
      `APP-TAB-${number}`,
      "TABLET",
      n === 30 ? "EM_MANUTENCAO" : "BOM_ESTADO",
    );
  }
}
const port = Number(process.env.PORT || 3333);
app.listen(port, "127.0.0.1", () =>
  console.log(
    `Demonstração local na porta ${port}. Banco separado: data/demo.sqlite. Não use contas de demonstração em produção.`,
  ),
);
