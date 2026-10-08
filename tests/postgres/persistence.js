import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openPostgres } from "../../backend/src/postgres.js";
import { transaction, id } from "../../backend/src/database.js";
test("PostgreSQL: rollback, transações concorrentes, persistência e migração repetível", async () => {
  const options = { localTest: process.env.TEST_DATABASE_TLS !== "true" };
  let db = await openPostgres(process.env.TEST_DATABASE_URL, options);
  const number = `PG-${id()}`;
  try {
    await assert.rejects(
      transaction(db, async () => {
        await db
          .prepare(
            "INSERT INTO devices(id,number,qr,type,status) VALUES(?,?,?,?,?)",
          )
          .run(id(), number, number, "TABLET", "BOM_ESTADO");
        throw Error("rollback esperado");
      }),
      /rollback esperado/,
    );
    assert.equal(
      await db.prepare("SELECT id FROM devices WHERE number=?").get(number),
      undefined,
    );
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        transaction(db, async () => {
          if (
            await db
              .prepare("SELECT id FROM devices WHERE number=?")
              .get(number)
          )
            throw Error("já existe");
          await db
            .prepare(
              "INSERT INTO devices(id,number,qr,type,status) VALUES(?,?,?,?,?)",
            )
            .run(id(), number, number, "TABLET", "BOM_ESTADO");
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    await db.close();
    db = await openPostgres(process.env.TEST_DATABASE_URL, options);
    assert.ok(
      await db.prepare("SELECT id FROM devices WHERE number=?").get(number),
    );
  } finally {
    await db.prepare("DELETE FROM devices WHERE number=?").run(number);
    await db.close();
  }
});

test("PostgreSQL migra inventário antigo preservando referências e aceita celular", async () => {
  const options = { localTest: process.env.TEST_DATABASE_TLS !== "true" };
  let db = await openPostgres(process.env.TEST_DATABASE_URL, options);
  const number = `MIG-${id()}`;
  const deviceId = id();
  try {
    await db
      .prepare(
        "INSERT INTO devices(id,number,qr,type,status) VALUES(?,?,?,?,?)",
      )
      .run(deviceId, number, number, "TABLET", "CONSERVADO");
    await db.transaction(async () => {
      await db
        .prepare("ALTER TABLE devices DROP CONSTRAINT devices_type_check")
        .run();
      await db
        .prepare(
          "ALTER TABLE devices ADD CONSTRAINT devices_type_check CHECK(type IN ('TABLET','NOTEBOOK','CHROMEBOOK'))",
        )
        .run();
      await db.prepare("DROP INDEX devices_serial").run();
      await db.prepare("DROP INDEX devices_internal").run();
      for (const column of [
        "internal_id",
        "serial_number",
        "manufacturer",
        "model",
      ])
        await db.prepare(`ALTER TABLE devices DROP COLUMN ${column}`).run();
    });
    await db.close();
    db = await openPostgres(process.env.TEST_DATABASE_URL, options);
    const original = await db
      .prepare("SELECT * FROM devices WHERE id=?")
      .get(deviceId);
    assert.equal(original.qr, number);
    assert.equal(original.status, "CONSERVADO");
    assert.equal(original.serial_number, "");
    await db
      .prepare(
        "UPDATE devices SET type='CELULAR',serial_number='00000-PG-MIG' WHERE id=?",
      )
      .run(deviceId);
    await db.close();
    db = await openPostgres(process.env.TEST_DATABASE_URL, options);
    assert.equal(
      (await db.prepare("SELECT type FROM devices WHERE id=?").get(deviceId))
        .type,
      "CELULAR",
    );
    await assert.rejects(
      db.prepare("UPDATE devices SET type='INVALIDO' WHERE id=?").run(deviceId),
    );
  } finally {
    await db.prepare("DELETE FROM devices WHERE id=?").run(deviceId);
    await db.close();
  }
});

test("PostgreSQL rejeita certificado TLS não confiável", () => {
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  const script = `import assert from 'node:assert/strict';import {openPostgres} from './backend/src/postgres.js';await assert.rejects(openPostgres(process.env.TEST_DATABASE_URL), e=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(e.code));`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
