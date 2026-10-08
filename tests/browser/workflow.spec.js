import { test, expect } from "@playwright/test";
const password = "Browser-test-123!";
const changedPasswords = new Map();
async function login(page, email) {
  await page.goto("/");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page
    .getByLabel("Senha", { exact: true })
    .fill(changedPasswords.get(email) || password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.locator("#leavePassword, #logout").waitFor();
  if (await page.locator("#firstPasswordForm").count()) {
    const next = "Changed-browser-password-123!";
    await page.getByLabel("Senha provisória", { exact: true }).fill(password);
    await page
      .getByLabel("Nova senha (mínimo 12 caracteres)", { exact: true })
      .fill(next);
    await page.getByLabel("Confirme a nova senha", { exact: true }).fill(next);
    await page.getByRole("button", { name: "Salvar minha senha" }).click();
    changedPasswords.set(email, next);
  }
  await expect(
    page.getByRole("button", { name: "Sair", exact: true }),
  ).toBeVisible();
}
async function logout(page) {
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Entrar", exact: true }),
  ).toBeVisible();
}
async function sign(page) {
  const canvas = page.locator("#signature");
  await canvas.scrollIntoViewIfNeeded();
  const r = await canvas.boundingBox();
  await page.mouse.move(r.x + 20, r.y + 50);
  await page.mouse.down();
  await page.mouse.move(r.x + 150, r.y + 80, { steps: 10 });
  await page.mouse.up();
  await page
    .getByRole("button", { name: "Confirmar minha assinatura" })
    .click();
  await expect(page.locator("#toast")).toHaveText("Assinatura registrada.");
}
test("ciclo escolar completo pelas telas e layout móvel", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "admin@browser.local");
  await page.getByRole("button", { name: "Usuários", exact: true }).click();
  for (const [name, email, role] of [
    ["Professora Mariana", "prof@browser.local", "PROFESSOR"],
    ["Equipe TI", "ti@browser.local", "TI"],
  ]) {
    await page.getByRole("button", { name: "＋ Novo usuário" }).click();
    await page.getByLabel("Nome", { exact: true }).fill(name);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Perfil", { exact: true }).selectOption(role);
    await page
      .getByLabel("Senha provisória (opcional, mínimo 12 caracteres)")
      .fill(password);
    await page.getByRole("button", { name: "Cadastrar", exact: true }).click();
    await expect(page.locator("#temporaryPassword")).toBeVisible();
    await page.getByRole("button", { name: "Fechar", exact: true }).click();
  }
  await page.getByRole("button", { name: "Inventário", exact: true }).click();
  for (let n = 1; n <= 2; n++) {
    await page
      .getByRole("button", { name: "＋ Cadastrar dispositivo" })
      .click();
    await page.getByLabel("Patrimônio", { exact: true }).fill(`TB-${n}`);
    await page
      .getByLabel("Código QR ou código de barras", { exact: true })
      .fill(`QR-${n}`);
    await page.getByRole("button", { name: "Salvar dispositivo" }).click();
    await expect(page.locator("#modal")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "QR", exact: true }).first().click();
  await expect(page.locator(".qr-label img")).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const reader = new ZXingBrowser.BrowserQRCodeReader();
      const result = await reader.decodeFromImageUrl(
        document.querySelector(".qr-label img").src,
      );
      return result.getText();
    }),
  ).toBe("QR-1");
  await page.getByRole("button", { name: "Fechar", exact: true }).click();
  await logout(page);
  await login(page, "prof@browser.local");
  await page.getByRole("button", { name: "＋ Novo agendamento" }).click();
  await page.getByLabel("Turma", { exact: true }).fill("8º Ano B");
  await page.getByLabel("Quantidade", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Salvar agendamento" }).click();
  await expect(page.locator("#modal")).toHaveCount(0);
  await logout(page);
  await login(page, "ti@browser.local");
  await page.getByRole("button", { name: "Agendamentos", exact: true }).click();
  await page.getByRole("button", { name: "Aprovar", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Liberar", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Liberar", exact: true }).click();
  await page.getByLabel("Selecionar TB-1").check();
  await page.getByLabel("Selecionar TB-2").check();
  await page.locator("#releaseDevices").click();
  await expect(
    page.getByRole("button", { name: "Abrir movimentação" }),
  ).toBeVisible();
  await logout(page);
  await login(page, "prof@browser.local");
  await page.getByRole("button", { name: "Abrir movimentação" }).click();
  await page.getByLabel("Aluno do dispositivo TB-1").fill("Ana Souza");
  await page.getByLabel("Aluno do dispositivo TB-2").fill("Bruno Lima");
  await page
    .getByLabel("Relato da utilização e devolução")
    .fill("Aula concluída. Equipamentos devolvidos sem ocorrências.");
  await page.getByRole("button", { name: "Enviar devolução" }).click();
  await expect(page.locator("#modal")).toHaveCount(0);
  await logout(page);
  await login(page, "ti@browser.local");
  await page.getByRole("button", { name: "Abrir movimentação" }).click();
  await page.getByRole("button", { name: "Concluir conferência" }).click();
  await expect(page.locator("#modal")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Relatórios e assinaturas", exact: true })
    .click();
  await page.getByRole("button", { name: "Ver relatório" }).click();
  await sign(page);
  await logout(page);
  await login(page, "prof@browser.local");
  await page
    .getByRole("button", { name: "Relatórios e assinaturas", exact: true })
    .click();
  await page.getByRole("button", { name: "Ver relatório" }).click();
  await sign(page);
  await page.getByRole("button", { name: "Histórico", exact: true }).click();
  await page.getByRole("button", { name: "Visualizar / PDF" }).click();
  await expect(page.locator("#reportDocument")).toContainText("Concluído");
  await expect(page.locator(".signature-image")).toHaveCount(2);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#reportDocument")).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: "Fechar", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Visão geral", exact: true }).click();
  await expect(page.locator(".hero")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
