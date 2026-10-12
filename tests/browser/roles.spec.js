import { test, expect } from "@playwright/test";
import { createApp } from "../../backend/src/server.js";
import { createUser } from "../../backend/src/database.js";
import { readFile } from "node:fs/promises";
test("administrador simplificado, ordem do menu e exportação segura do inventário", async ({
  page,
}) => {
  const { app, db } = createApp({ databasePath: ":memory:" });
  const password = "Roles-browser-test-123!";
  createUser(db, {
    name: "Admin escola",
    email: "admin@roles.local",
    password,
    role: "ADMINISTRADOR",
  });
  const manager = createUser(db, {
    name: "Gerente protegido",
    email: "manager@roles.local",
    password,
    role: "ADMINISTRADOR",
  });
  db.prepare("UPDATE users SET is_manager=1 WHERE id=?").run(manager.id);
  db.prepare(
    "INSERT INTO devices(id,number,qr,type,status,serial_number) VALUES(?,?,?,?,?,?)",
  ).run("csv-device", "=1+1", "QR-EXPORT", "TABLET", "BOM_ESTADO", "SERIE-001");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByLabel("E-mail", { exact: true }).fill("admin@roles.local");
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Sair", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "＋ Novo agendamento" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Liberar dispositivos", exact: true }),
    ).toHaveCount(0);
    const names = await page.locator("[data-page]").allTextContents();
    expect(names.findIndex((n) => n.includes("Inventário"))).toBeGreaterThan(
      names.findIndex((n) => n.includes("Relatórios")),
    );
    expect(names.findIndex((n) => n.includes("Histórico"))).toBeGreaterThan(
      names.findIndex((n) => n.includes("Usuários")),
    );
    await page.getByRole("button", { name: "Inventário", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "＋ Cadastrar dispositivo" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Editar dispositivo" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Excluir", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Importar planilha" }),
    ).toBeVisible();
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportar planilha" }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe("inventario-app-monitor.csv");
    const csv = await readFile(await download.path(), "utf8");
    expect(csv).toContain("SERIE-001");
    expect(csv).toContain("'=1+1");
    await page.getByRole("button", { name: "Usuários", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Desativar", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Gerente protegido", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});
