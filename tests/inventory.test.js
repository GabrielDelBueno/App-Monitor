import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../backend/src/server.js";
import { createUser, openDatabase, schema } from "../backend/src/database.js";
import { openPostgres } from "../backend/src/postgres.js";

test("migração SQLite preserva empréstimos, IDs e QR e permite celular ao reabrir", () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-migration-"));
  const path = join(dir, "old.sqlite");
  try {
    const old = new DatabaseSync(path);
    old.exec(
      schema
        .replace(",'CELULAR'", "")
        .replace(
          ",internal_id TEXT NOT NULL DEFAULT '',serial_number TEXT NOT NULL DEFAULT '',manufacturer TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT ''",
          "",
        ),
    );
    old
      .prepare("INSERT INTO users VALUES(?,?,?,?,?,?,?)")
      .run(
        "user",
        "Admin",
        "old@test.local",
        "hash",
        "ADMINISTRADOR",
        1,
        "date",
      );
    old
      .prepare("INSERT INTO devices VALUES(?,?,?,?,?,?,?)")
      .run(
        "device",
        "TAB-OLD",
        "QR-OLD",
        "TABLET",
        "CONSERVADO",
        "Notas antigas",
        1,
      );
    old
      .prepare(
        "INSERT INTO loans(id,teacher_id,ti_id,class_name,departed_at) VALUES(?,?,?,?,?)",
      )
      .run("loan", "user", "user", "Turma", "date");
    old
      .prepare(
        "INSERT INTO loan_items(id,loan_id,device_id,departure_status) VALUES(?,?,?,?)",
      )
      .run("item", "loan", "device", "CONSERVADO");
    old.close();
    let db = openDatabase(path);
    assert.equal(
      db.prepare("SELECT device_id FROM loan_items").get().device_id,
      "device",
    );
    assert.equal(db.prepare("SELECT qr FROM devices").get().qr, "QR-OLD");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.prepare(
      "INSERT INTO devices(id,number,qr,type,status,serial_number) VALUES(?,?,?,?,?,?)",
    ).run("phone", "CEL-01", "QR-PHONE", "CELULAR", "BOM_ESTADO", "0000123");
    db.close();
    db = openDatabase(path);
    assert.equal(
      db.prepare("SELECT serial_number FROM devices WHERE id='phone'").get()
        .serial_number,
      "0000123",
    );
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO devices(id,number,qr,type,status) VALUES('bad','BAD','BAD','INVALIDO','BOM_ESTADO')",
        )
        .run(),
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importação autenticada: prévia, enriquecimento, preservação de QR, repetição, conflitos e celular", async () => {
  const database = process.env.TEST_DATABASE_URL
    ? await openPostgres(process.env.TEST_DATABASE_URL, {
        localTest: process.env.TEST_DATABASE_TLS !== "true",
      })
    : openDatabase(":memory:");
  const { app, db } = createApp({ database });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, cookie = "") => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const row = {
    number: "IMP-001",
    qr: "APP-MONITOR:IMP-001",
    serial_number: "0000012345",
    manufacturer: "Fabricante Teste",
    model: "Modelo Teste",
    type: "TABLET",
    status: "BOM_ESTADO",
    notes: "Planilha",
  };
  try {
    for (const [role, email] of [
      ["ADMINISTRADOR", "import-admin@test.local"],
      ["PROFESSOR", "import-prof@test.local"],
      ["TI", "import-ti@test.local"],
    ])
      await createUser(db, {
        name: "Teste Importação",
        email,
        password: "Test-password-123!",
        role,
      });
    assert.equal(
      (await request("/api/devices/import", { records: [row] })).status,
      401,
    );
    const login = async (email) =>
      (await request("/api/login", { email, password: "Test-password-123!" }))
        .cookie;
    const admin = await login("import-admin@test.local");
    for (const email of ["import-prof@test.local", "import-ti@test.local"])
      assert.equal(
        (
          await request(
            "/api/devices/import",
            { records: [row] },
            await login(email),
          )
        ).status,
        403,
      );
    const existing = await request(
      "/api/devices",
      {
        number: row.number,
        qr: "QR-ORIGINAL",
        type: "TABLET",
        status: "CONSERVADO",
        notes: "Não sobrescrever",
      },
      admin,
    );
    assert.equal(existing.status, 201);
    const second = {
      ...row,
      number: "IMP-002",
      qr: "QR-IMP-002",
      serial_number: "0000023456",
      type: "CELULAR",
    };
    let result = await request(
      "/api/devices/import",
      { records: [row, second], dry_run: true },
      admin,
    );
    assert.equal(result.data.created, 1);
    assert.equal(result.data.enriched, 1);
    assert.equal(
      (
        await db
          .prepare("SELECT serial_number FROM devices WHERE id=?")
          .get(existing.data.id)
      ).serial_number,
      "",
    );
    result = await request(
      "/api/devices/import",
      { records: [row, second], dry_run: false },
      admin,
    );
    assert.equal(result.status, 200);
    const updated = await db
      .prepare("SELECT * FROM devices WHERE id=?")
      .get(existing.data.id);
    assert.equal(updated.qr, "QR-ORIGINAL");
    assert.equal(updated.status, "CONSERVADO");
    assert.equal(updated.notes, "Não sobrescrever");
    assert.equal(updated.serial_number, "0000012345");
    result = await request(
      "/api/devices/import",
      { records: [row, second], dry_run: false },
      admin,
    );
    assert.equal(result.data.created, 0);
    assert.equal(result.data.enriched, 0);
    assert.equal(result.data.unchanged, 2);
    const patchResponse = await fetch(
      base + "/api/devices/" + existing.data.id,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: admin },
        body: JSON.stringify({
          status: "CONSERVADO",
          notes: "Não sobrescrever",
          manufacturer: "Fabricante corrigido",
        }),
      },
    );
    assert.equal(patchResponse.status, 200);
    const patched = await db
      .prepare("SELECT * FROM devices WHERE id=?")
      .get(existing.data.id);
    assert.equal(patched.serial_number, row.serial_number);
    assert.equal(patched.model, row.model);
    assert.equal(patched.manufacturer, "Fabricante corrigido");
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const phoneAppointment = await request(
      "/api/appointments",
      {
        date,
        time: "10:00",
        class_name: "Turma celular",
        type: "CELULAR",
        quantity: 1,
      },
      await login("import-prof@test.local"),
    );
    assert.equal(phoneAppointment.status, 201);
    assert.equal(phoneAppointment.data.type, "CELULAR");
    const conflict = { ...row, serial_number: second.serial_number };
    result = await request(
      "/api/devices/import",
      { records: [conflict], dry_run: true },
      admin,
    );
    assert.equal(result.data.conflicts.length, 1);
    assert.equal(
      (
        await request(
          "/api/devices/import",
          {
            records: [
              { ...row, number: "IMP-NEW", qr: "QR-NEW", serial_number: "NEW" },
              conflict,
            ],
            dry_run: false,
          },
          admin,
        )
      ).status,
      409,
    );
    assert.equal(
      await db.prepare("SELECT id FROM devices WHERE number='IMP-NEW'").get(),
      undefined,
    );
    assert.equal(
      (await request("/api/devices/import", { records: [row, row] }, admin))
        .data.conflicts.length,
      1,
    );
    assert.equal(
      (
        await request(
          "/api/devices/import",
          { records: [{ ...row, status: "QUEBRADO" }] },
          admin,
        )
      ).status,
      400,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (process.env.TEST_DATABASE_URL) {
      await db
        .prepare(
          "DELETE FROM notifications WHERE entity_id IN (SELECT id FROM appointments WHERE class_name='Turma celular')",
        )
        .run();
      await db
        .prepare("DELETE FROM appointments WHERE class_name='Turma celular'")
        .run();
      await db
        .prepare(
          "DELETE FROM audit WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'import-%@test.local')",
        )
        .run();
      await db
        .prepare(
          "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'import-%@test.local')",
        )
        .run();
      await db
        .prepare("DELETE FROM users WHERE email LIKE 'import-%@test.local'")
        .run();
      await db.prepare("DELETE FROM devices WHERE number LIKE 'IMP-%'").run();
    }
    await db.close();
  }
});
