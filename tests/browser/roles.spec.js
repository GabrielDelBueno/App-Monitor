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
  createUser(db, {
    name: "Professor Configuração",
    email: "prof@roles.local",
    password,
    role: "PROFESSOR",
  });
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
    await page.getByRole("button", { name: "Conta", exact: true }).click();
    await expect(page.locator("#requireAdvance")).toHaveCount(0);
    await expect(page.getByLabel("Senha atual", { exact: true })).toHaveValue(
      "",
    );
    await page
      .getByLabel("Senha atual", { exact: true })
      .fill("senha-digitada-de-teste");
    await page
      .getByRole("button", { name: "👁 Mostrar senha digitada", exact: true })
      .click();
    await expect(
      page.getByLabel("Senha atual", { exact: true }),
    ).toHaveAttribute("type", "text");
    await page
      .getByRole("button", { name: "👁 Ocultar senha digitada", exact: true })
      .click();
    await expect(
      page.getByLabel("Senha atual", { exact: true }),
    ).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
    await page.getByRole("button", { name: "Sair", exact: true }).click();
    await page
      .getByLabel("E-mail", { exact: true })
      .fill("manager@roles.local");
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.getByRole("button", { name: "Conta", exact: true }).click();
    await expect(page.locator("#requireAdvance")).toBeChecked();
    await page.locator("#requireAdvance").uncheck();
    await page
      .getByRole("button", { name: "Salvar configuração", exact: true })
      .click();
    await expect(page.locator("#modal")).toHaveCount(0);
    await page.getByRole("button", { name: "Conta", exact: true }).click();
    await expect(page.locator("#requireAdvance")).not.toBeChecked();
    await page.locator("#requireAdvance").check();
    await page
      .getByRole("button", { name: "Salvar configuração", exact: true })
      .click();
    await expect(page.locator("#modal")).toHaveCount(0);
    await page.getByRole("button", { name: "Sair", exact: true }).click();
    await page.getByLabel("E-mail", { exact: true }).fill("prof@roles.local");
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.getByRole("button", { name: "＋ Novo agendamento" }).click();
    await page.getByLabel("Turma", { exact: true }).fill("Obrigatória");
    await page.getByRole("checkbox", { name: "Tablet", exact: true }).check();
    await expect(
      page.getByText(
        "O adiantamento da assinatura é obrigatório após salvar.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Salvar agendamento" }).click();
    await expect(page.locator("#advanceCanvas")).toBeVisible();
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
    await page.reload();
    await expect(
      page.getByRole("heading", {
        name: "Complete suas pendências para continuar",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Visão geral", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Antecipar assinatura", exact: true })
      .click();
    const canvas = page.locator("#advanceCanvas");
    await canvas.scrollIntoViewIfNeeded();
    const rect = await canvas.boundingBox();
    await page.mouse.move(rect.x + 20, rect.y + 20);
    await page.mouse.down();
    await page.mouse.move(rect.x + 100, rect.y + 45, { steps: 10 });
    await page.mouse.up();
    await page.getByRole("button", { name: "Confirmar antecipação" }).click();
    await expect(
      page.getByRole("button", { name: "Visão geral", exact: true }),
    ).toBeVisible();
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});
