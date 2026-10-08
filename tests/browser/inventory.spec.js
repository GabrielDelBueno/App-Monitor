import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createApp } from "../../backend/src/server.js";
import { createUser, openDatabase } from "../../backend/src/database.js";
const headers = [
  "CATEGORIA DO EQUIPAMENTO",
  "FABRICANTE",
  "MODELO",
  "NÚMERO DE SÉRIE",
  "ID DE CONTROLE INTERNO DA UE",
  "STATUS DO EQUIPAMENTO",
  "AVALIAÇÃO TÉCNICA",
];
const fixture = `<table><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>${[
  ["Tablet", "Teste", "Modelo T", "000012345", "TAB-TEST", "Disponível", "Bom"],
  [
    "Notebook Sala de Aula",
    "Teste",
    "Modelo N",
    "SN-002",
    "NOT-TEST",
    "Disponível",
    "Bom",
  ],
  [
    "Notebook Básico Educacional",
    "Teste",
    "Modelo E",
    "SN-003",
    "EDU-TEST",
    "Disponível",
    "Desgaste Natural",
  ],
  [
    "Smartphone",
    "Teste",
    "Modelo C",
    "",
    "CEL-TEST",
    "Disponível",
    "Sem avaliação",
  ],
  [
    "Tablet",
    "Teste",
    "Modelo T",
    "SN-BAD",
    "TAB-BAD",
    "Danificado",
    "Dano físico",
  ],
  ["Desktop", "Teste", "Modelo D", "SN-D", "DESK-TEST", "Disponível", "Bom"],
]
  .map((row) => `<tr>${row.map((value) => `<td>${value}</td>`).join("")}</tr>`)
  .join("")}</table>`;

async function exercise(page, source, expected) {
  const db = openDatabase(":memory:");
  const { app } = createApp({ database: db });
  await createUser(db, {
    name: "Admin Inventário",
    email: "admin-inventory@test.local",
    password: "Test-password-123!",
    role: "ADMINISTRADOR",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(base);
    await page
      .getByLabel("E-mail", { exact: true })
      .fill("admin-inventory@test.local");
    await page.getByLabel("Senha", { exact: true }).fill("Test-password-123!");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.getByRole("button", { name: "Inventário", exact: true }).click();
    await page
      .getByRole("button", { name: "Importar planilha", exact: true })
      .click();
    await page.getByLabel("Planilha de inventário").setInputFiles({
      name: "inventario.xls",
      mimeType: "application/vnd.ms-excel",
      buffer: Buffer.from(source),
    });
    await expect(page.locator("#importPreview")).toContainText(
      `${expected} aparelhos disponíveis selecionados.`,
    );
    const parsed = await page.evaluate(
      (source) => window.parseSchoolInventory(source),
      source,
    );
    expect(parsed.records).toHaveLength(expected);
    expect(
      parsed.records.every((row) =>
        ["BOM_ESTADO", "CONSERVADO"].includes(row.status),
      ),
    ).toBe(true);
    const summary = parsed.records.reduce((counts, row) => {
      counts[row.type] = (counts[row.type] || 0) + 1;
      return counts;
    }, {});
    if (expected === 201)
      expect(summary).toEqual({ TABLET: 124, NOTEBOOK: 52, CELULAR: 25 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM devices").get()).toEqual(
      { n: 0 },
    );
    await page
      .getByRole("button", { name: "Importar dispositivos", exact: true })
      .click();
    await expect(page.locator("#modal")).toHaveCount(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM devices").get().n).toBe(
      expected,
    );
    const row = parsed.records.find((row) => row.serial_number.startsWith("0"));
    expect(row).toBeTruthy();
    const search = page.getByLabel(
      "Buscar por controle interno, série, QR, modelo ou fabricante",
    );
    for (const value of [row.number, row.serial_number]) {
      await search.fill(value);
      await expect(page.locator("#deviceList tbody tr")).toHaveCount(1);
      await expect(page.locator("#deviceList")).toContainText(row.model);
    }
    await page
      .getByRole("button", { name: "Editar dispositivo", exact: true })
      .click();
    await page
      .getByLabel("Modelo", { exact: true })
      .fill(row.model + " conferido");
    await page
      .getByRole("button", { name: "Salvar dispositivo", exact: true })
      .click();
    await expect(page.locator("#modal")).toHaveCount(0);
    expect(
      db.prepare("SELECT model FROM devices WHERE number=?").get(row.number)
        .model,
    ).toBe(row.model + " conferido");
    // Resolve both identifiers through the same entry point used by the camera.
    await page.evaluate((row) => {
      state.appointments = [{ id: "test-appointment", type: row.type }];
      state.appointment = "test-appointment";
      window.identifierChecks = [
        addCode(row.serial_number),
        addCode(row.number),
      ];
    }, row);
    expect(await page.evaluate(() => window.identifierChecks)).toEqual([
      true,
      true,
    ]);
    const ambiguous = await page.evaluate(() => {
      state.devices.push(
        { id: "ambiguous1", number: "REPETIDO", qr: "AMB1" },
        {
          id: "ambiguous2",
          number: "OUTRO",
          qr: "AMB2",
          serial_number: "REPETIDO",
        },
      );
      const before = state.selection.size;
      addCode("REPETIDO");
      return (
        state.selection.size === before &&
        document
          .querySelector("#toast")
          .textContent.includes("mais de um aparelho")
      );
    });
    expect(ambiguous).toBe(true);
    const qr = db
      .prepare("SELECT qr FROM devices WHERE number=?")
      .get(row.number).qr;
    expect(qr).toBe(`APP-MONITOR:${row.number}`);
    await page
      .getByRole("button", { name: "Importar planilha", exact: true })
      .click();
    await page.getByLabel("Planilha de inventário").setInputFiles({
      name: "inventario.xls",
      mimeType: "application/vnd.ms-excel",
      buffer: Buffer.from(source),
    });
    await expect(page.locator("#importPreview")).toContainText(
      `${expected} já cadastrados`,
    );
    await page
      .getByRole("button", { name: "Importar dispositivos", exact: true })
      .click();
    await expect(page.locator("#modal")).toHaveCount(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM devices").get().n).toBe(
      expected,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}
test("importa planilha, filtra disponíveis, pesquisa série/UE e mantém QR sem duplicar", async ({
  page,
}) => exercise(page, fixture, 4));
if (process.env.INVENTORY_SOURCE)
  test("confere e importa os 201 aparelhos da planilha fornecida em banco isolado", async ({
    page,
  }) =>
    exercise(page, readFileSync(process.env.INVENTORY_SOURCE, "utf8"), 201));
