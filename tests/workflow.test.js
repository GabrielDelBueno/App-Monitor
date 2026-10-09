import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../backend/src/server.js";
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
    time: "08:50",
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
    (await ti(`/api/appointments/${appointment.id}/approve`, "POST")).status,
    200,
  );
});
test("liberação atômica, limites e aparelhos indisponíveis", async () => {
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
