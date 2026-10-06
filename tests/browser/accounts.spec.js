import { test, expect } from "@playwright/test";
import { createApp } from "../../backend/src/server.js";
test("instalação inicial e acesso com senha provisória pelas telas", async ({
  page,
}) => {
  const token = "browser-private-setup-test-token-32-chars",
    password = "First-admin-password-123!";
  const { app, db } = createApp({
    databasePath: ":memory:",
    govbr: null,
    setupToken: token,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  try {
    await page.goto(base);
    await page.getByLabel("Código de instalação", { exact: true }).fill(token);
    await page.getByLabel("Seu nome", { exact: true }).fill("Diretora");
    await page
      .getByLabel("Seu e-mail", { exact: true })
      .fill("diretora@school.local");
    await page.getByLabel("Sua senha (mínimo 12 caracteres)").fill(password);
    await page.getByRole("button", { name: "Criar administrador" }).click();
    await expect(
      page.getByRole("button", { name: "Usuários", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Usuários", exact: true }).click();
    await page.getByRole("button", { name: "＋ Novo usuário" }).click();
    await page.getByLabel("Nome", { exact: true }).fill("Professora da escola");
    await page
      .getByLabel("E-mail", { exact: true })
      .fill("teacher@school.local");
    await page.getByRole("button", { name: "Cadastrar", exact: true }).click();
    await expect(page.locator("#temporaryPassword")).toBeVisible();
    const temporary = await page.locator("#temporaryPassword").inputValue();
    expect(temporary.length).toBeGreaterThanOrEqual(20);
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
    await page.getByRole("button", { name: "Sair", exact: true }).click();
    await page
      .getByLabel("E-mail", { exact: true })
      .fill("teacher@school.local");
    await page.getByLabel("Senha", { exact: true }).fill(temporary);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Defina sua senha" }),
    ).toBeVisible();
    expect((await page.request.get(base + "/api/appointments")).status()).toBe(
      403,
    );
    await page.getByLabel("Senha provisória", { exact: true }).fill(temporary);
    await page
      .getByLabel("Nova senha (mínimo 12 caracteres)", { exact: true })
      .fill("Teacher-new-password-123!");
    await page
      .getByLabel("Confirme a nova senha", { exact: true })
      .fill("Teacher-new-password-123!");
    await page.getByRole("button", { name: "Salvar minha senha" }).click();
    await expect(
      page.getByRole("button", { name: "Agendamentos", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sair", exact: true }).click();
    await page
      .getByLabel("E-mail", { exact: true })
      .fill("diretora@school.local");
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.getByRole("button", { name: "Usuários", exact: true }).click();
    await page
      .getByRole("row")
      .filter({ hasText: "teacher@school.local" })
      .getByRole("button", { name: "Redefinir senha" })
      .click();
    await expect(page.locator("#temporaryPassword")).toBeVisible();
    expect(await page.locator("#temporaryPassword").inputValue()).not.toBe(
      temporary,
    );
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await new Promise((r) => server.close(r));
    db.close();
  }
});
