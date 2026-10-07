import { test, expect } from "@playwright/test";
test("professor se cadastra com nome completo e administrador edita na tela Usuários", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Sou professor — criar minha conta" })
    .click();
  await page
    .locator("#teacherRegistration [name=name]")
    .fill("Professora Maria Silva");
  await page
    .locator("#teacherRegistration [name=email]")
    .fill("autocadastro@browser.local");
  await page
    .locator("#teacherRegistration [name=password]")
    .fill("Teacher-self-registration-123!");
  await page
    .locator("#teacherRegistration [name=confirmation]")
    .fill("Teacher-self-registration-123!");
  await expect(page.locator("#teacherRegistration [name=role]")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Criar conta de professor", exact: true })
    .click();
  await expect(page.locator("#app")).toContainText("Professora Maria Silva");
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await page.locator("#loginForm [name=email]").fill("admin@browser.local");
  await page.locator("#loginForm [name=password]").fill("Browser-test-123!");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Usuários", exact: true }).click();
  const row = page
    .getByRole("row")
    .filter({ hasText: "autocadastro@browser.local" });
  await expect(row).toContainText("Professor");
  await row.getByRole("button", { name: "Editar", exact: true }).click();
  await page
    .locator("#editUserForm [name=name]")
    .fill("Professora Maria Silva Santos");
  await page
    .getByRole("button", { name: "Salvar alterações", exact: true })
    .click();
  await expect(row).toContainText("Professora Maria Silva Santos");
});
