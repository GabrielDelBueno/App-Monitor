import { test, expect } from "@playwright/test";
test("instalação, ícones e aviso offline sem guardar dados autenticados", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Instalar App Monitor" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Instalar App Monitor" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Adicionar à Tela de Início",
  );
  await page.getByRole("button", { name: "Entendi" }).click();
  const manifest = await (
    await page.request.get("/manifest.webmanifest")
  ).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  for (const icon of manifest.icons) {
    expect((await page.request.get(icon.src)).status()).toBe(200);
  }
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, {
          once: true,
        }),
      );
    const login = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@browser.local",
        password: "Browser-test-123!",
      }),
    });
    if (!login.ok) throw Error("login falhou");
    const devices = await fetch("/api/devices");
    if (!devices.ok) throw Error("API falhou");
  });
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        urls.push(new URL(request.url).pathname);
    return urls;
  });
  expect(cached).toEqual(["/offline.html"]);
  await context.setOffline(true);
  const apiUnavailable = await page.evaluate(async () => {
    try {
      await fetch("/api/devices");
      return false;
    } catch {
      return true;
    }
  });
  expect(apiUnavailable).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Você está sem conexão" }),
  ).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("link", { name: "Tentar novamente" }).click();
  await expect(page.locator("#app")).not.toBeEmpty();
  await expect(
    page.getByRole("heading", { name: "Você está sem conexão" }),
  ).toHaveCount(0);
});
