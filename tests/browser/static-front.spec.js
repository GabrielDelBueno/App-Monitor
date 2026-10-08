import { test, expect } from "@playwright/test";
import express from "express";
import { createApp } from "../../backend/src/server.js";
import { createUser } from "../../backend/src/database.js";
import { resolve } from "node:path";
async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return server;
}
test("interface estática mostra a marca durante cold start e preserva cookies e proteção de origem", async ({
  page,
}) => {
  let backendUrl,
    first = true;
  const front = express();
  front.use(express.raw({ type: "*/*", limit: "2mb" }));
  front.use("/api", async (req, res) => {
    if (req.originalUrl === "/api/auth/config" && first) {
      first = false;
      return res.type("html").send("<html>Render CARREGANDO APLICATIVO</html>");
    }
    const response = await fetch(backendUrl + req.originalUrl, {
      method: req.method,
      headers: {
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        ...(req.headers.origin ? { origin: req.headers.origin } : {}),
        ...(req.headers["content-type"]
          ? { "content-type": req.headers["content-type"] }
          : {}),
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    });
    res.status(response.status);
    res.set(
      "Content-Type",
      response.headers.get("content-type") || "application/octet-stream",
    );
    res.set("Cache-Control", "no-store");
    for (const cookie of response.headers.getSetCookie())
      res.append("Set-Cookie", cookie);
    res.send(Buffer.from(await response.arrayBuffer()));
  });
  front.use(express.static(resolve("public-static")));
  const frontServer = await listen(front);
  const frontUrl = `http://127.0.0.1:${frontServer.address().port}`;
  const { app, db } = createApp({
    databasePath: ":memory:",
    govbr: null,
    frontendOrigin: frontUrl,
  });
  createUser(db, {
    name: "Admin Estático",
    email: "static-admin@test.local",
    password: "Static-test-password-123!",
    role: "ADMINISTRADOR",
  });
  const backServer = await listen(app);
  backendUrl = `http://127.0.0.1:${backServer.address().port}`;
  try {
    await page.goto(frontUrl);
    await expect(page.locator("#connection-status")).toContainText(
      "Conectando ao servidor",
    );
    await expect(page.locator("body")).not.toContainText("Render CARREGANDO");
    await expect(page.locator("#loginForm")).toBeVisible();
    await page
      .locator("#loginForm [name=email]")
      .fill("static-admin@test.local");
    await page
      .locator("#loginForm [name=password]")
      .fill("Static-test-password-123!");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.locator("#app")).toContainText("Admin Estático");
    const me = await page.evaluate(() =>
      fetch("/api/me").then((r) => r.json()),
    );
    expect(me.role).toBe("ADMINISTRADOR");
    await page.reload();
    await expect(page.locator("#app")).toContainText("Admin Estático");
    const bad = await page.request.post(frontUrl + "/api/login", {
      headers: { Origin: "https://untrusted.example" },
      data: {
        email: "static-admin@test.local",
        password: "Static-test-password-123!",
      },
    });
    expect(bad.status()).toBe(403);
    await page.getByRole("button", { name: "Sair", exact: true }).click();
    await expect(page.locator("#loginForm")).toBeVisible();
  } finally {
    await new Promise((r) => frontServer.close(r));
    await new Promise((r) => backServer.close(r));
    db.close();
  }
});
