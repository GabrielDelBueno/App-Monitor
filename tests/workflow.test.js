import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, provisionManagers } from "../backend/src/server.js";
import { createUser, openDatabase } from "../backend/src/database.js";
import { openPostgres } from "../backend/src/postgres.js";
import QRCode from "qrcode";
const dir = mkdtempSync(join(tmpdir(), "app-monitor-test-")),
  dbPath = join(dir, "test.sqlite");
let server,
  db,
  base,
  admin,
  ti,
  prof,
  other,
  teacher,
  otherTeacher,
  appointment,
  loan,
  devices = [],
  signature;
const password = "Test-password-123!",
  changedPassword = "Changed-password-123!";
function client() {
  let cookie = "";
  return async (path, method = "GET", body) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = r.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = r.status === 204 ? null : await r.json();
    return { status: r.status, data };
  };
}
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
before(async () => {
  const database = process.env.TEST_DATABASE_URL
    ? await openPostgres(process.env.TEST_DATABASE_URL, {
        localTest: process.env.TEST_DATABASE_TLS !== "true",
      })
    : undefined;
  const instance = createApp({ database, databasePath: dbPath });
  db = instance.db;
  await createUser(db, {
    name: "Admin",
    email: "admin@test.local",
    password,
    role: "ADMINISTRADOR",
  });
  await provisionManagers(db, "admin@test.local");
  await db
    .prepare(
      "INSERT INTO app_settings(key,value) VALUES('advance_required','false') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run();
  server = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = client();
  ti = client();
  prof = client();
  other = client();
  signature = await QRCode.toDataURL("test-signature");
});
after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});
test("autenticação, expiração e proteção de origem", async () => {
  assert.equal((await client()("/api/loans")).status, 401);
  assert.equal(
    (
      await admin("/api/login", "POST", {
        email: "admin@test.local",
        password: "incorrect",
      })
    ).status,
    401,
  );
  assert.equal(
    (await admin("/api/login", "POST", { email: "admin@test.local", password }))
      .status,
    200,
  );
  const r = await fetch(base + "/api/login", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "admin@test.local", password }),
  });
  assert.equal(r.status, 403);
  assert.equal((await admin("/health")).data.database, "ok");
});
test("administra usuários e aplica os perfis", async () => {
  for (const [name, email, role] of [
    ["TI", "ti@test.local", "TI"],
    ["Professor", "prof@test.local", "PROFESSOR"],
    ["Outro", "other@test.local", "PROFESSOR"],
  ]) {
    const r = await admin("/api/users", "POST", {
      name,
      email,
      role,
      password,
    });
    assert.equal(r.status, 201);
    if (email.startsWith("prof")) teacher = r.data;
    if (email.startsWith("other")) otherTeacher = r.data;
  }
  for (const [c, email] of [
    [ti, "ti@test.local"],
    [prof, "prof@test.local"],
    [other, "other@test.local"],
  ]) {
    assert.equal(
      (await c("/api/login", "POST", { email, password })).status,
      200,
    );
    assert.equal((await c("/api/me")).data.requiresPasswordChange, true);
    assert.equal((await c("/api/appointments")).status, 403);
    assert.equal(
      (
        await c("/api/password", "POST", {
          current: password,
          password: changedPassword,
        })
      ).status,
      200,
    );
  }
  assert.equal((await prof("/api/users")).status, 403);
  assert.equal(
    (
      await ti("/api/users", "POST", {
        name: "Não",
        email: "no@test.local",
        role: "TI",
        password,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await admin("/api/users", "POST", {
        name: "Repetido",
        email: "prof@test.local",
        role: "PROFESSOR",
        password,
      })
    ).status,
    409,
  );
});
test("inventário, QR, exclusão lógica e manutenção", async () => {
  for (let i = 1; i <= 5; i++) {
    const r = await ti("/api/devices", "POST", {
      number: `TB-${i}`,
      qr: `QR-${i}`,
      type: "TABLET",
      status: i === 3 ? "EM_MANUTENCAO" : "BOM_ESTADO",
    });
    assert.equal(r.status, 201);
    devices.push(r.data);
  }
  assert.equal((await prof("/api/devices")).status, 403);
  assert.equal(
    (
      await ti("/api/devices", "POST", {
        number: "TB-1",
        qr: "duplicate",
        type: "TABLET",
        status: "BOM_ESTADO",
      })
    ).status,
    409,
  );
  assert.match(
    (await ti(`/api/devices/${devices[0].id}/qr`)).data.image,
    /^data:image\/png;base64,/,
  );
  assert.equal(
    (await ti(`/api/devices/${devices[4].id}`, "DELETE")).status,
    204,
  );
  assert.equal((await ti("/api/devices")).data.length, 4);
});
test("agendamento, isolamento e aprovação", async () => {
  const body = {
    date: today(),
    class_name: "8º B",
    type: "TABLET",
    quantity: 2,
  };
  assert.equal(
    (await prof("/api/appointments", "POST", { ...body, quantity: 26 })).status,
    400,
  );
  assert.equal(
    (await prof("/api/appointments", "POST", { ...body, date: "2020-01-01" }))
      .status,
    400,
  );
  const r = await prof("/api/appointments", "POST", body);
  assert.equal(r.status, 201);
  appointment = r.data;
  assert.equal(
    appointment.time,
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(appointment.created_at)),
  );
  const editedTime = await prof(
    `/api/appointments/${appointment.id}`,
    "PATCH",
    { ...body, time: "invalid" },
  );
  assert.equal(editedTime.status, 200);
  assert.equal(editedTime.data.time, appointment.time);
  assert.equal(
    (
      await other(`/api/appointments/${appointment.id}/advance-sign`, "POST", {
        image: signature,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await prof(`/api/appointments/${appointment.id}/advance-sign`, "POST", {
        image: "invalid",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await prof(`/api/appointments/${appointment.id}/advance-sign`, "POST", {
        image: signature,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await prof(`/api/appointments/${appointment.id}/advance-sign`, "POST", {
        image: signature,
      })
    ).status,
    409,
  );
  assert.equal(
    (await prof(`/api/appointments/${appointment.id}`, "PATCH", body)).data
      .advance_signature,
    undefined,
  );
  assert.equal(
    (
      await prof(`/api/appointments/${appointment.id}/advance-sign`, "POST", {
        image: signature,
      })
    ).status,
    200,
  );

  assert.equal((await other("/api/appointments")).data.length, 0);
  assert.equal(
    (await other(`/api/appointments/${appointment.id}`, "PATCH", body)).status,
    403,
  );
  assert.equal(
    (await prof(`/api/appointments/${appointment.id}/approve`, "POST")).status,
    403,
  );
  assert.equal(
    (await prof("/api/appointments")).data.find((a) => a.id === appointment.id)
      .status,
    "PENDENTE",
  );
});
test("liberação atômica, limites e aparelhos indisponíveis", async () => {
  // This scenario exercises the optional, no-advance-signature flow.
  await db
    .prepare("DELETE FROM advance_signatures WHERE appointment_id=?")
    .run(appointment.id);
  const path = "/api/loans",
    body = {
      appointment_id: appointment.id,
      device_ids: [devices[0].id, devices[2].id],
    };
  assert.equal((await ti(path, "POST", body)).status, 409);
  assert.equal((await ti("/api/loans")).data.length, 0);
  assert.equal(
    (
      await ti(path, "POST", {
        ...body,
        device_ids: [devices[0].id, devices[0].id],
      })
    ).status,
    400,
  );
  const r = await ti(path, "POST", {
    ...body,
    device_ids: [devices[0].id, devices[1].id],
  });
  assert.equal(r.status, 201);
  loan = r.data;
  assert.equal(loan.signatures.length, 0);
  assert.equal(
    (await ti(`/api/devices/${devices[0].id}`, "DELETE")).status,
    409,
  );
  assert.equal(
    (await ti(`/api/devices/${devices[0].id}`, "PATCH", { status: "QUEBRADO" }))
      .status,
    409,
  );
  assert.equal((await other("/api/loans")).data.length, 0);
  assert.equal(
    (
      await other(`/api/loans/${loan.id}/students`, "PATCH", {
        items: [{ id: loan.items[0].id, student: "Outra pessoa" }],
      })
    ).status,
    403,
  );
  const a = (
    await other("/api/appointments", "POST", {
      date: today(),
      time: "09:40",
      class_name: "9º A",
      type: "TABLET",
      quantity: 1,
    })
  ).data;
  await ti(`/api/appointments/${a.id}/approve`, "POST");
  assert.equal(
    (
      await ti(path, "POST", {
        appointment_id: a.id,
        device_ids: [devices[0].id],
      })
    ).status,
    409,
  );
});
test("pedido de extras e liberação única", async () => {
  assert.ok(
    (await prof("/api/notifications")).data.some(
      (n) => n.entity_id === loan.id && n.title === "Dispositivos liberados",
    ),
  );
  assert.equal((await prof("/api/me")).data.blocked, true);
  await prof(`/api/loans/${loan.id}/students`, "PATCH", {
    items: loan.items.map((i) => ({ id: i.id, student: "Aluno teste" })),
  });
  assert.ok(
    !(await prof("/api/notifications")).data.some(
      (n) => n.entity_id === loan.id && n.title === "Dispositivos liberados",
    ),
  );
  assert.equal(
    (await prof(`/api/loans/${loan.id}/extras`, "POST", { quantity: 6 }))
      .status,
    400,
  );
  assert.equal(
    (await prof(`/api/loans/${loan.id}/extras`, "POST", { quantity: 1 }))
      .status,
    200,
  );
  assert.equal(
    (await prof(`/api/loans/${loan.id}/extras`, "POST", { quantity: 1 }))
      .status,
    409,
  );
  const r = await ti(`/api/loans/${loan.id}/extras/release`, "POST", {
    device_ids: [devices[3].id],
  });
  assert.equal(r.status, 200);
  loan = r.data;
  assert.equal(loan.items.length, 3);
  assert.equal(
    (
      await ti(`/api/loans/${loan.id}/extras/release`, "POST", {
        device_ids: [devices[3].id],
      })
    ).status,
    409,
  );
});
test("associação, devolução, conferência e desbloqueio por assinatura", async () => {
  assert.equal(
    (
      await prof(`/api/loans/${loan.id}/return`, "POST", {
        report: "Aula concluída.",
      })
    ).status,
    400,
  );
  assert.equal(
    (await prof(`/api/loans/${loan.id}/sign`, "POST", { image: signature }))
      .status,
    409,
  );
  assert.equal(
    (await ti(`/api/loans/${loan.id}/check`, "POST", { items: [] })).status,
    409,
  );
  const items = loan.items.map((i, n) => ({
    id: i.id,
    student: `Aluno ${n + 1}`,
  }));
  assert.equal(
    (await prof(`/api/loans/${loan.id}/students`, "PATCH", { items })).status,
    200,
  );
  const unused = await prof(`/api/loans/${loan.id}/students`, "PATCH", {
    items: [{ id: items[0].id, student: "Nome anterior", not_used: true }],
  });
  assert.equal(unused.status, 200);
  assert.equal(unused.data.items.find((i) => i.id === items[0].id).student, "");
  assert.equal(unused.data.items.find((i) => i.id === items[0].id).not_used, 1);
  assert.equal(
    (
      await prof(`/api/loans/${loan.id}/return`, "POST", {
        report: "Aula concluída; um tablet apresentou falha.",
      })
    ).status,
    200,
  );
  const checks = loan.items.map((i, n) => ({
    id: i.id,
    status: n === 0 ? "QUEBRADO" : "BOM_ESTADO",
    comment: n === 0 ? "Tela quebrada" : "Conferido",
  }));
  assert.equal(
    (
      await ti(`/api/loans/${loan.id}/check`, "POST", {
        items: checks.slice(1),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await ti(`/api/loans/${loan.id}/check`, "POST", {
        items: checks.map((i) => ({ ...i, comment: "" })),
      })
    ).status,
    400,
  );
  assert.equal(
    (await ti(`/api/loans/${loan.id}/check`, "POST", { items: checks })).status,
    200,
  );
  assert.equal((await prof("/api/me")).data.blocked, true);
  assert.equal(
    (
      await prof("/api/appointments", "POST", {
        date: today(),
        time: "10:00",
        class_name: "A",
        type: "TABLET",
        quantity: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (await other(`/api/loans/${loan.id}/sign`, "POST", { image: signature }))
      .status,
    403,
  );
  assert.equal(
    (
      await ti(`/api/loans/${loan.id}/sign`, "POST", {
        image: "data:image/png;base64,aA==",
      })
    ).status,
    400,
  );
  assert.equal(
    (await prof(`/api/loans/${loan.id}/sign`, "POST", { image: signature }))
      .status,
    200,
  );
  assert.equal((await prof("/api/me")).data.blocked, false);
  assert.equal(
    (await prof(`/api/loans/${loan.id}/sign`, "POST", { image: signature }))
      .status,
    409,
  );
  const completed = await ti(`/api/loans/${loan.id}/sign`, "POST", {
    image: signature,
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.status, "CONCLUIDA");
  assert.equal(completed.data.signatures.length, 2);
  assert.equal((await prof("/api/appointments")).data[0].status, "CONCLUIDO");
  assert.equal(
    (await ti("/api/devices")).data.find((d) => d.id === devices[0].id).status,
    "QUEBRADO",
  );
  assert.equal(
    (await prof(`/api/loans/${loan.id}/students`, "PATCH", { items })).status,
    409,
  );
});
test("notificações, auditoria e dados persistem ao reabrir o banco", async () => {
  await db
    .prepare("UPDATE notifications SET status='PENDENTE' WHERE entity_id=?")
    .run(loan.id);
  assert.ok(
    !(await prof("/api/notifications")).data.some(
      (n) => n.entity_id === loan.id,
    ),
  );
  await db
    .prepare("INSERT INTO notifications VALUES(?,?,?,?,?,?,?,?)")
    .run(
      "test-open-notification",
      teacher.id,
      "Aviso de teste",
      "Mensagem ainda não lida",
      "dashboard",
      null,
      "PENDENTE",
      new Date().toISOString(),
    );
  const n = (await prof("/api/notifications")).data.find(
    (n) => n.status === "PENDENTE",
  );
  assert.ok(n);
  assert.equal(
    (
      await other(`/api/notifications/${n.id}`, "PATCH", {
        status: "CONCLUIDA",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await prof(`/api/notifications/${n.id}`, "PATCH", {
        status: "VISUALIZADA",
      })
    ).status,
    200,
  );
  assert.ok(
    !(await prof("/api/notifications")).data.some((item) => item.id === n.id),
  );
  assert.equal(
    (await prof(`/api/notifications/${n.id}`, "PATCH", { status: "CONCLUIDA" }))
      .status,
    200,
  );
  assert.equal((await ti("/api/audit")).status, 403);
  assert.ok(
    (await admin("/api/audit")).data.some(
      (a) => a.action === "ASSINAR_RELATORIO",
    ),
  );
  const reopened = process.env.TEST_DATABASE_URL
    ? await openPostgres(process.env.TEST_DATABASE_URL, {
        localTest: process.env.TEST_DATABASE_TLS !== "true",
      })
    : openDatabase(dbPath);
  assert.equal(
    (await reopened.prepare("SELECT status FROM loans WHERE id=?").get(loan.id))
      .status,
    "CONCLUIDA",
  );
  await reopened.close();
});
test("pedido misto preserva quantidades por tipo, edição, persistência e extras", async () => {
  const items = [
    { type: "TABLET", quantity: 2 },
    { type: "NOTEBOOK", quantity: 1 },
  ];
  const body = {
    date: today(),
    time: "10:00",
    class_name: "Turma mista",
    items,
  };
  assert.equal(
    (
      await prof("/api/appointments", "POST", {
        ...body,
        items: [...items, items[0]],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await prof("/api/appointments", "POST", {
        ...body,
        items: [
          { type: "TABLET", quantity: 25 },
          { type: "NOTEBOOK", quantity: 1 },
        ],
      })
    ).status,
    400,
  );
  const created = await prof("/api/appointments", "POST", body);
  assert.equal(created.status, 201);
  const a = created.data;
  assert.equal(a.quantity, 3);
  assert.equal(a.items.length, 2);
  await ti(`/api/appointments/${a.id}/approve`, "POST");
  const edited = await prof(`/api/appointments/${a.id}`, "PATCH", body);
  assert.equal(edited.data.status, "PENDENTE");
  assert.deepEqual(edited.data.items, a.items);
  const reopened = process.env.TEST_DATABASE_URL
    ? await openPostgres(process.env.TEST_DATABASE_URL, {
        localTest: process.env.TEST_DATABASE_TLS !== "true",
      })
    : openDatabase(dbPath);
  assert.equal(
    (
      await reopened
        .prepare(
          "SELECT COUNT(*) AS n FROM appointment_items WHERE appointment_id=?",
        )
        .get(a.id)
    ).n,
    2,
  );
  await reopened.close();
  await ti(`/api/appointments/${a.id}/approve`, "POST");
  const available = [];
  for (const [n, type] of [
    "TABLET",
    "TABLET",
    "TABLET",
    "NOTEBOOK",
    "CELULAR",
  ].entries()) {
    const r = await admin("/api/devices", "POST", {
      number: `MIX-${n}`,
      qr: `QR-MIX-${n}`,
      type,
      status: "BOM_ESTADO",
    });
    assert.equal(r.status, 201);
    available.push(r.data.id);
  }
  const wrong = await ti("/api/loans", "POST", {
    appointment_id: a.id,
    device_ids: available.slice(0, 3),
  });
  assert.equal(wrong.status, 400);
  assert.equal(
    (await prof("/api/appointments")).data.find((x) => x.id === a.id).status,
    "APROVADO",
  );
  const released = await ti("/api/loans", "POST", {
    appointment_id: a.id,
    device_ids: [available[0], available[1], available[3]],
  });
  assert.equal(released.status, 201);
  const l = released.data;
  await prof(`/api/loans/${l.id}/students`, "PATCH", {
    items: l.items.map((i) => ({ id: i.id, student: "Aluno misto" })),
  });
  assert.equal(
    (await prof(`/api/loans/${l.id}/extras`, "POST", { quantity: 1 })).status,
    400,
  );
  assert.equal(
    (
      await prof(`/api/loans/${l.id}/extras`, "POST", {
        items: [{ type: "CELULAR", quantity: 1 }],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await ti(`/api/loans/${l.id}/extras/release`, "POST", {
        device_ids: [available[2]],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await ti(`/api/loans/${l.id}/extras/release`, "POST", {
        device_ids: [available[4]],
      })
    ).status,
    200,
  );
});
test("TI corrige aparelho em uso sem copiar aluno e preserva auditoria", async () => {
  const all = (await ti("/api/loans")).data;
  const current = all.find((l) => l.status === "EM_USO");
  const before = current.items[0];
  const replacement = (
    await ti("/api/devices", "POST", {
      number: "CORRECAO-NOTE",
      qr: "CORRECAO-QR",
      type: "NOTEBOOK",
      status: "BOM_ESTADO",
    })
  ).data;
  const body = {
    item_id: before.id,
    device_id: replacement.id,
    reason: "Tablet registrado em vez do notebook entregue",
  };
  assert.equal(
    (await prof(`/api/loans/${current.id}/devices`, "PATCH", body)).status,
    403,
  );
  assert.equal(
    (await ti(`/api/loans/${loan.id}/devices`, "PATCH", body)).status,
    409,
  );
  assert.equal(
    (
      await ti(`/api/loans/${current.id}/devices`, "PATCH", {
        ...body,
        device_id: current.items[1].device_id,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await ti(`/api/loans/${current.id}/devices`, "PATCH", {
        ...body,
        reason: "",
      })
    ).status,
    400,
  );
  const corrected = await ti(`/api/loans/${current.id}/devices`, "PATCH", body);
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.items.length, current.items.length);
  assert.ok(
    !corrected.data.items.some((i) => i.device_id === before.device_id),
  );
  const added = corrected.data.items.find(
    (i) => i.device_id === replacement.id,
  );
  assert.equal(added.student, "");
  assert.equal(added.not_used, 0);
  assert.equal(added.type, "NOTEBOOK");
  const inventory = (await ti("/api/devices")).data;
  assert.equal(
    !!inventory.find((d) => d.id === before.device_id).in_use,
    false,
  );
  assert.equal(!!inventory.find((d) => d.id === replacement.id).in_use, true);
  assert.ok(
    (await admin("/api/audit")).data.some(
      (a) => a.action === "CORRIGIR_APARELHO_MOVIMENTACAO",
    ),
  );
  assert.equal(
    (
      await ti(`/api/devices/${before.device_id}`, "PATCH", {
        status: "BOM_ESTADO",
        type: "CHROMEBOOK",
      })
    ).status,
    200,
  );
  assert.equal(
    (await ti("/api/devices")).data.find((d) => d.id === before.device_id).type,
    "CHROMEBOOK",
  );
});
test("corrige cadastro antigo do modelo Chromebook ao reabrir o banco", async () => {
  const d = (
    await ti("/api/devices", "POST", {
      number: "CHR-MIGRATION",
      qr: "QR-MIGRATION",
      type: "NOTEBOOK",
      status: "BOM_ESTADO",
      model: "Chromebook",
      manufacturer: "SAMSUNG",
      serial_number: "SERIAL-MIGRATION",
    })
  ).data;
  const reopened = process.env.TEST_DATABASE_URL
    ? await openPostgres(process.env.TEST_DATABASE_URL, {
        localTest: process.env.TEST_DATABASE_TLS !== "true",
      })
    : openDatabase(dbPath);
  const actual = await reopened
    .prepare("SELECT * FROM devices WHERE id=?")
    .get(d.id);
  assert.equal(actual.type, "CHROMEBOOK");
  assert.equal(actual.qr, "QR-MIGRATION");
  assert.equal(actual.serial_number, "SERIAL-MIGRATION");
  await reopened.close();
});
test("assinatura antecipada regulariza pendências antigas sem sobrescrever assinaturas", async () => {
  const originalDate = "2026-01-01T10:00:00.000Z";
  const previous = await db
    .prepare("SELECT * FROM signatures WHERE loan_id=? AND type='PROFESSOR'")
    .get(loan.id);
  await db
    .prepare(
      "INSERT INTO advance_signatures(appointment_id,user_id,image,signed_at) VALUES(?,?,?,?)",
    )
    .run(appointment.id, teacher.id, signature, originalDate);
  await db
    .prepare(
      "INSERT INTO loans(id,appointment_id,teacher_id,ti_id,class_name,departed_at,status) SELECT 'legacy-advance',appointment_id,teacher_id,ti_id,class_name,departed_at,'AGUARDANDO_ASSINATURAS' FROM loans WHERE id=?",
    )
    .run(loan.id);
  await db
    .prepare(
      "INSERT INTO signatures(id,loan_id,user_id,type,image,signed_at) SELECT 'legacy-ti','legacy-advance',user_id,type,image,signed_at FROM signatures WHERE loan_id=? AND type='TI'",
    )
    .run(loan.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = process.env.TEST_DATABASE_URL
      ? await openPostgres(process.env.TEST_DATABASE_URL, {
          localTest: process.env.TEST_DATABASE_TLS !== "true",
        })
      : openDatabase(dbPath);
    const copied = await reopened
      .prepare(
        "SELECT * FROM signatures WHERE loan_id='legacy-advance' AND type='PROFESSOR'",
      )
      .get();
    assert.equal(copied.image, signature);
    assert.equal(copied.signed_at, originalDate);
    assert.equal(copied.user_id, teacher.id);
    assert.equal(
      (
        await reopened
          .prepare("SELECT status FROM loans WHERE id='legacy-advance'")
          .get()
      ).status,
      "CONCLUIDA",
    );
    assert.deepEqual(
      await reopened
        .prepare(
          "SELECT * FROM signatures WHERE loan_id=? AND type='PROFESSOR'",
        )
        .get(loan.id),
      previous,
    );
    await reopened.close();
  }
});
test("consultas das listas não crescem com o histórico e preservam isolamento", async () => {
  const prepare = db.prepare.bind(db);
  let queries = 0;
  db.prepare = (...args) => {
    queries++;
    return prepare(...args);
  };
  try {
    queries = 0;
    const beforeAppointments = await prof("/api/appointments");
    const beforeLoans = await prof("/api/loans");
    const baseline = queries;
    for (let n = 0; n < 30; n++) {
      await prepare(
        "INSERT INTO appointments(id,teacher_id,date,time,class_name,type,quantity,status,created_at) SELECT ?,teacher_id,date,time,class_name,type,quantity,'CONCLUIDO',created_at FROM appointments WHERE id=?",
      ).run(`batch-a-${n}`, appointment.id);
      await prepare(
        "INSERT INTO loans(id,appointment_id,teacher_id,ti_id,class_name,departed_at,status) SELECT ?,?,teacher_id,ti_id,class_name,departed_at,'CONCLUIDA' FROM loans WHERE id=?",
      ).run(`batch-l-${n}`, `batch-a-${n}`, loan.id);
    }
    queries = 0;
    const afterAppointments = await prof("/api/appointments");
    const afterLoans = await prof("/api/loans");
    assert.equal(queries, baseline);
    assert.equal(
      afterAppointments.data.length,
      beforeAppointments.data.length + 30,
    );
    assert.equal(afterLoans.data.length, beforeLoans.data.length + 30);
    assert.deepEqual(
      afterLoans.data.find((l) => l.id === loan.id),
      beforeLoans.data.find((l) => l.id === loan.id),
    );
    assert.equal(
      (await other("/api/loans")).data.some((l) => l.id.startsWith("batch-l-")),
      false,
    );
    assert.equal(
      (await other("/api/appointments")).data.some((a) =>
        a.id.startsWith("batch-a-"),
      ),
      false,
    );
  } finally {
    db.prepare = prepare;
  }
});
test("TI regulariza ausências com conferência e assinatura identificada, sem apagar histórico", async () => {
  for (const [n, initialStatus] of [
    "EM_USO",
    "AGUARDANDO_ASSINATURAS",
  ].entries()) {
    const device = (
      await ti("/api/devices", "POST", {
        number: `REG-${n}`,
        qr: `REG-${n}`,
        type: "TABLET",
        status: "BOM_ESTADO",
      })
    ).data;
    const lid = `reg-loan-${n}`,
      aid = `reg-appt-${n}`,
      itemid = `reg-item-${n}`;
    await db
      .prepare(
        "INSERT INTO appointments(id,teacher_id,date,time,class_name,type,quantity,status,created_at) SELECT ?,teacher_id,date,time,class_name,type,1,'EM_USO',created_at FROM appointments WHERE id=?",
      )
      .run(aid, appointment.id);
    await db
      .prepare(
        "INSERT INTO loans(id,appointment_id,teacher_id,ti_id,class_name,departed_at,status) SELECT ?,?,teacher_id,ti_id,class_name,departed_at,? FROM loans WHERE id=?",
      )
      .run(lid, aid, initialStatus, loan.id);
    await db
      .prepare(
        "INSERT INTO loan_items(id,loan_id,device_id,departure_status) VALUES(?,?,?,'BOM_ESTADO')",
      )
      .run(itemid, lid, device.id);
    const path = `/api/loans/${lid}/regularize`;
    const body = {
      reason: "Regularização de registro antigo",
      missing_students: true,
      unsigned: true,
      close: true,
      confirmed_return: false,
      items: [{ id: itemid, student: "", status: "BOM_ESTADO", comment: "" }],
    };
    assert.equal((await prof(path, "PATCH", body)).status, 403);
    assert.equal((await ti(path, "PATCH", body)).status, 400);
    assert.equal(
      (await db.prepare("SELECT status FROM loans WHERE id=?").get(lid)).status,
      initialStatus,
    );
    if (n === 0) {
      const result = await ti(path, "PATCH", {
        ...body,
        confirmed_return: true,
      });
      assert.equal(result.status, 200);
      assert.equal(result.data.status, "CONCLUIDA");
      assert.equal(result.data.signatures.length, 0);
      assert.equal(result.data.correction.unsigned, 1);
      assert.equal(result.data.correction.missing_students, 1);
      assert.equal(
        Boolean(
          (await ti("/api/devices")).data.find((d) => d.id === device.id)
            .in_use,
        ),
        false,
      );
      assert.equal(
        (await ti(path, "PATCH", { ...body, confirmed_return: true })).status,
        409,
      );
    } else {
      const edited = await ti(path, "PATCH", {
        ...body,
        missing_students: false,
        unsigned: false,
        close: false,
        image: signature,
        items: [{ ...body.items[0], student: "Aluno registrado pelo TI" }],
      });
      assert.equal(edited.status, 200);
      assert.equal(edited.data.signatures[0].user_id, teacher.id);
      assert.equal(edited.data.items[0].student, "Aluno registrado pelo TI");
      assert.ok(edited.data.correction.actor_id);
      assert.equal(
        (await ti(path, "PATCH", { ...body, confirmed_return: true })).status,
        400,
      );
      const closed = await ti(path, "PATCH", {
        ...body,
        confirmed_return: true,
        missing_students: false,
        unsigned: false,
        items: [{ ...body.items[0], student: "Aluno registrado pelo TI" }],
      });
      assert.equal(closed.status, 200);
      assert.equal(closed.data.status, "CONCLUIDA");
      assert.equal(closed.data.signatures[0].image, signature);
    }
  }
});
test("envios simultâneos e repetidos criam um único agendamento", async () => {
  const body = {
    request_id: "8dbaea9e-4e31-4af4-b023-6b01caebfa53",
    teacher_id: teacher.id,
    date: today(),
    class_name: "Teste envio único",
    items: [{ type: "TABLET", quantity: 1 }],
  };
  const responses = await Promise.all([
    admin("/api/appointments", "POST", body),
    admin("/api/appointments", "POST", body),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  assert.equal(responses[0].data.id, responses[1].data.id);
  const replay = await admin("/api/appointments", "POST", body);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, responses[0].data.id);
  assert.equal(
    (await admin("/api/appointments")).data.filter(
      (a) => a.class_name === body.class_name,
    ).length,
    1,
  );
  assert.equal(
    (
      await admin("/api/appointments", "POST", {
        ...body,
        class_name: "Dados alterados",
      })
    ).status,
    409,
  );
  const distinct = await admin("/api/appointments", "POST", {
    ...body,
    request_id: "8dbaea9e-4e31-4af4-b023-6b01caebfa54",
  });
  assert.equal(distinct.status, 201);
  assert.notEqual(distinct.data.id, replay.data.id);
});
test("senha, desativação e logout encerram acesso", async () => {
  assert.equal(
    (
      await prof("/api/password", "POST", {
        current: "incorrect",
        password: "new-test-password-123",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await prof("/api/password", "POST", {
        current: changedPassword,
        password: "new-test-password-123",
      })
    ).status,
    200,
  );
  assert.equal((await other("/api/logout", "POST")).status, 204);
  assert.equal((await other("/api/me")).status, 401);
  assert.equal(
    (
      await other("/api/login", "POST", {
        email: "other@test.local",
        password: changedPassword,
      })
    ).status,
    200,
  );
  assert.equal(
    (await admin(`/api/users/${otherTeacher.id}`, "PATCH", { active: false }))
      .status,
    200,
  );
  assert.equal((await other("/api/me")).status, 401);
});
