import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, provisionManagers } from "../backend/src/server.js";
import { createUser } from "../backend/src/database.js";
const password = "Account-test-password-123!";
async function fixture(options = {}) {
  const { app, db } = createApp({
    databasePath: ":memory:",
    govbr: null,
    ...options,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  function browser() {
    let cookie = "";
    return async (path, method = "GET", body) => {
      const r = await fetch(base + path, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.headers.get("set-cookie"))
        cookie = r.headers.get("set-cookie").split(";")[0];
      return {
        status: r.status,
        data: r.status === 204 ? null : await r.json(),
      };
    };
  }
  return {
    db,
    browser,
    close: async () => {
      await new Promise((r) => server.close(r));
      db.close();
    },
  };
}
test("instalação pela web exige token privado e cria somente o primeiro administrador", async () => {
  const token = "fixture-setup-token-at-least-32-characters",
    f = await fixture({ setupToken: token });
  try {
    const b = f.browser();
    const config = (await b("/api/auth/config")).data;
    assert.equal(config.needsSetup, true);
    assert.ok(!JSON.stringify(config).includes(token));
    const body = {
      token: "invalid",
      name: "Administrador",
      email: "admin@accounts.local",
      password,
    };
    assert.equal((await b("/api/setup", "POST", body)).status, 403);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
    const created = await b("/api/setup", "POST", { ...body, token });
    assert.equal(created.status, 201);
    assert.equal(created.data.role, "ADMINISTRADOR");
    assert.equal((await b("/api/me")).data.role, "ADMINISTRADOR");
    assert.equal((await b("/api/auth/config")).data.needsSetup, false);
    assert.equal(
      (await b("/api/setup", "POST", { ...body, token })).status,
      404,
    );
  } finally {
    await f.close();
  }
});
test("todos os perfis recebem senha provisória e são obrigados a trocá-la, sem acesso operacional antecipado", async () => {
  const f = await fixture();
  try {
    createUser(f.db, {
      name: "Admin",
      email: "root@accounts.local",
      password,
      role: "ADMINISTRADOR",
    });
    const admin = f.browser();
    await admin("/api/login", "POST", {
      email: "root@accounts.local",
      password,
    });
    for (const role of ["PROFESSOR", "TI", "ADMINISTRADOR"]) {
      const email = `${role.toLowerCase()}@accounts.local`,
        created = await admin("/api/users", "POST", {
          name: role,
          email,
          role,
        });
      assert.equal(created.status, 201);
      assert.ok(created.data.temporaryPassword.length >= 20);
      const b = f.browser();
      assert.equal(
        (
          await b("/api/login", "POST", {
            email,
            password: created.data.temporaryPassword,
          })
        ).status,
        200,
      );
      assert.equal((await b("/api/me")).data.requiresPasswordChange, true);
      assert.equal((await b("/api/appointments")).status, 403);
      assert.equal(
        (
          await b("/api/password", "POST", {
            current: created.data.temporaryPassword,
            password: created.data.temporaryPassword,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await b("/api/password", "POST", {
            current: created.data.temporaryPassword,
            password,
          })
        ).status,
        200,
      );
      assert.equal((await b("/api/me")).data.requiresPasswordChange, false);
      assert.equal((await b("/api/appointments")).status, 200);
      const audit = JSON.stringify(f.db.prepare("SELECT * FROM audit").all());
      assert.ok(!audit.includes(created.data.temporaryPassword));
      const users = await admin("/api/users");
      assert.ok(
        !JSON.stringify(users.data).includes(created.data.temporaryPassword),
      );
    }
  } finally {
    await f.close();
  }
});
test("redefinição administrativa revoga sessões, invalida a senha anterior e exige nova troca", async () => {
  const f = await fixture();
  try {
    const root = createUser(f.db, {
      name: "Admin",
      email: "root@reset.local",
      password,
      role: "ADMINISTRADOR",
    });
    const target = createUser(f.db, {
      name: "Professor",
      email: "prof@reset.local",
      password,
      role: "PROFESSOR",
    });
    const admin = f.browser(),
      teacher = f.browser();
    await admin("/api/login", "POST", { email: root.email, password });
    await teacher("/api/login", "POST", { email: target.email, password });
    assert.equal(
      (await teacher(`/api/users/${root.id}/password`, "POST", {})).status,
      403,
    );
    assert.equal(
      (await admin(`/api/users/${root.id}/password`, "POST", {})).status,
      409,
    );
    const reset = await admin(`/api/users/${target.id}/password`, "POST", {});
    assert.equal(reset.status, 200);
    assert.equal((await teacher("/api/me")).status, 401);
    assert.equal(
      (await teacher("/api/login", "POST", { email: target.email, password }))
        .status,
      401,
    );
    assert.equal(
      (
        await teacher("/api/login", "POST", {
          email: target.email,
          password: reset.data.temporaryPassword,
        })
      ).status,
      200,
    );
    assert.equal((await teacher("/api/appointments")).status, 403);
    assert.equal(
      (
        await teacher("/api/password", "POST", {
          current: reset.data.temporaryPassword,
          password: "Changed-reset-password-123!",
        })
      ).status,
      200,
    );
    assert.equal((await teacher("/api/appointments")).status, 200);
  } finally {
    await f.close();
  }
});
test("autocadastro exige nome completo, impede perfis privilegiados e mantém edição administrativa", async () => {
  const f = await fixture();
  try {
    const publicClient = f.browser(),
      admin = f.browser();
    const body = {
      name: "Maria Silva Santos",
      email: "maria@register.local",
      password,
    };
    assert.equal(
      (await publicClient("/api/register", "POST", body)).status,
      403,
    );
    createUser(f.db, {
      name: "Administrador",
      email: "admin@register.local",
      password,
      role: "ADMINISTRADOR",
    });
    assert.equal(
      (await publicClient("/api/register", "POST", { ...body, name: "Maria" }))
        .status,
      400,
    );
    assert.equal(
      (
        await publicClient("/api/register", "POST", {
          ...body,
          role: "ADMINISTRADOR",
        })
      ).status,
      400,
    );
    assert.equal(
      (await publicClient("/api/register", "POST", { ...body, role: "TI" }))
        .status,
      400,
    );
    const registered = await publicClient("/api/register", "POST", body);
    assert.equal(registered.status, 201);
    assert.equal(registered.data.role, "PROFESSOR");
    const id = registered.data.id;
    assert.equal((await publicClient("/api/me")).data.name, body.name);
    assert.equal(
      (await publicClient(`/api/users/${id}`, "PATCH", { role: "TI" })).status,
      403,
    );
    assert.equal(
      (await f.browser()("/api/register", "POST", body)).status,
      409,
    );
    await admin("/api/login", "POST", {
      email: "admin@register.local",
      password,
    });
    assert.ok((await admin("/api/users")).data.some((u) => u.id === id));
    assert.equal(
      (
        await admin(`/api/users/${id}`, "PATCH", {
          name: "Maria Silva Costa",
          email: "maria.novo@register.local",
        })
      ).status,
      200,
    );
    assert.equal((await publicClient("/api/me")).status, 401);
    assert.equal(
      (
        await publicClient("/api/login", "POST", {
          email: "maria.novo@register.local",
          password,
        })
      ).status,
      200,
    );
    assert.equal(
      (await publicClient("/api/me")).data.name,
      "Maria Silva Costa",
    );
    assert.equal(
      (await admin(`/api/users/${id}`, "PATCH", { active: false })).status,
      403,
    );
    assert.equal((await publicClient("/api/me")).status, 200);
  } finally {
    await f.close();
  }
});
test("administrador simplificado não opera aparelhos nem altera gerentes", async () => {
  const f = await fixture();
  try {
    const manager = createUser(f.db, {
      name: "Gerente",
      email: "manager@roles.local",
      password,
      role: "ADMINISTRADOR",
    });
    f.db.prepare("UPDATE users SET is_manager=1 WHERE id=?").run(manager.id);
    const user = createUser(f.db, {
      name: "Admin",
      email: "admin@roles.local",
      password,
      role: "ADMINISTRADOR",
    });
    const admin = f.browser(),
      root = f.browser();
    await admin("/api/login", "POST", { email: user.email, password });
    assert.equal(
      (await root("/api/login", "POST", { email: manager.email, password }))
        .data.role,
      "GERENTE",
    );
    assert.ok(
      !(await admin("/api/users")).data.some((u) => u.id === manager.id),
    );
    assert.ok((await root("/api/users")).data.some((u) => u.id === manager.id));
    for (const [url, method, body] of [
      ["/api/devices", "POST", {}],
      ["/api/devices/unknown", "PATCH", {}],
      ["/api/devices/unknown", "DELETE"],
      ["/api/appointments", "POST", {}],
      ["/api/appointments/unknown", "PATCH", {}],
      ["/api/loans", "POST", {}],
      [`/api/users/${manager.id}`, "PATCH", { name: "Ataque" }],
      [`/api/users/${manager.id}/password`, "POST", {}],
      [`/api/users/${user.id}`, "PATCH", { active: false }],
    ])
      assert.equal((await admin(url, method, body)).status, 403, url);
    assert.equal(
      (
        await admin("/api/users", "POST", {
          name: "Outro gerente",
          email: "invalid@roles.local",
          role: "GERENTE",
        })
      ).status,
      400,
    );
    const device = await root("/api/devices", "POST", {
      number: "=1+1",
      qr: "ROLE-QR",
      type: "TABLET",
      status: "BOM_ESTADO",
    });
    assert.equal(device.status, 201);
    assert.equal((await admin("/api/devices")).status, 200);
    assert.equal(
      (
        await root(`/api/devices/${device.data.id}`, "PATCH", {
          status: "CONSERVADO",
        })
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("ativação de gerentes exige contas existentes e é atômica e repetível", async () => {
  const f = await fixture();
  try {
    const user = createUser(f.db, {
      name: "Gestor teste",
      email: "manager-provision@local.test",
      password,
      role: "TI",
    });
    await assert.rejects(() =>
      provisionManagers(f.db, user.email + ",missing@local.test"),
    );
    assert.equal(
      f.db.prepare("SELECT is_manager FROM users WHERE id=?").get(user.id)
        .is_manager,
      0,
    );
    await provisionManagers(f.db, user.email);
    await provisionManagers(f.db, user.email);
    assert.equal(
      f.db.prepare("SELECT is_manager FROM users WHERE id=?").get(user.id)
        .is_manager,
      1,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit WHERE action='ATIVAR_GERENTE'",
        )
        .get().n,
      1,
    );
  } finally {
    await f.close();
  }
});
