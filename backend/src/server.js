import {
  deviceTypes,
  deviceFields,
  importSchema,
  planInventoryImport,
  applyInventoryImport,
} from "./inventory.js";
import { openPostgres } from "./postgres.js";
import express from "express";
import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { govbrFromEnvironment, registerGovbr } from "./govbr.js";
import {
  openDatabase,
  id,
  verifyPassword,
  createUser,
  passwordHash,
  transaction,
} from "./database.js";
if (existsSync(".env")) process.loadEnvFile(".env");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const types = deviceTypes,
  statuses = ["BOM_ESTADO", "CONSERVADO", "EM_MANUTENCAO", "QUEBRADO"];
const text = z.string().trim().min(1).max(200),
  now = () => new Date().toISOString();
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
export function createApp({
  database,
  databasePath = process.env.DATABASE_PATH ||
    resolve(root, "data/app-monitor.sqlite"),
  secure = process.env.COOKIE_SECURE === "true",
  govbr = govbrFromEnvironment(),
  frontendOrigin = process.env.FRONTEND_ORIGIN,
  publicBaseUrl = process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL,
  setupToken = process.env.SETUP_TOKEN,
  trustProxy = process.env.TRUST_PROXY === "1",
} = {}) {
  if (process.env.NODE_ENV === "production" && !secure)
    throw Error("Produção requer COOKIE_SECURE=true.");
  if (setupToken && setupToken.length < 32)
    throw Error("SETUP_TOKEN deve conter pelo menos 32 caracteres aleatórios.");
  const publicOrigin = publicBaseUrl ? new URL(publicBaseUrl).origin : null;
  let staticOrigin = null;
  if (frontendOrigin) {
    const url = new URL(frontendOrigin);
    if (
      (url.protocol !== "https:" && process.env.NODE_ENV === "production") ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw Error(
        "FRONTEND_ORIGIN deve ser somente a origem HTTPS do site estático.",
      );
    staticOrigin = url.origin;
  }
  const db = database || openDatabase(databasePath),
    app = express(),
    attempts = new Map();
  const get = (sql, ...params) => db.prepare(sql).get(...params),
    all = (sql, ...params) => db.prepare(sql).all(...params),
    run = (sql, ...params) => db.prepare(sql).run(...params);
  const audit = async (user, action, entity, details = {}) =>
    await run(
      "INSERT INTO audit VALUES(?,?,?,?,?,?)",
      id(),
      user.id,
      action,
      entity,
      JSON.stringify(details),
      now(),
    );
  const notify = async (user, title, message, page, entity) =>
    await run(
      "INSERT INTO notifications VALUES(?,?,?,?,?,?,?,?)",
      id(),
      user,
      title,
      message,
      page,
      entity,
      "PENDENTE",
      now(),
    );
  const notifyStaff = async (title, message, page, entity) =>
    await Promise.all(
      (
        await all(
          "SELECT id FROM users WHERE active=1 AND role IN ('TI','ADMINISTRADOR')",
        )
      ).map(async (u) => await notify(u.id, title, message, page, entity)),
    );
  const resolveNotifications = async (entity) =>
    await run(
      "UPDATE notifications SET status='CONCLUIDA' WHERE entity_id=?",
      entity,
    );
  const staff = (u) => u.role === "TI" || u.role === "ADMINISTRADOR";
  const mustStaff = (u) => {
    if (!staff(u)) fail(403, "Acesso restrito à equipe de TI.");
  };
  const mustAdmin = (u) => {
    if (u.role !== "ADMINISTRADOR")
      fail(403, "Acesso restrito ao administrador.");
  };
  const blocked = async (u) =>
    await get(
      "SELECT l.id FROM loans l WHERE l.teacher_id=? AND l.status='AGUARDANDO_ASSINATURAS' AND NOT EXISTS(SELECT 1 FROM signatures s WHERE s.loan_id=l.id AND s.type='PROFESSOR')",
      u.id,
    );
  const mustUnblocked = async (u) => {
    if (await blocked(u))
      fail(409, "Assine o relatório pendente antes de continuar.");
  };
  const withItems = async (a) => ({
    ...a,
    items: await requestedItems(a, "INITIAL"),
    extra_items: await requestedItems(a, "EXTRA"),
  });
  const requestedItems = async (a, kind) => {
    const rows = await all(
      "SELECT type,quantity FROM appointment_items WHERE appointment_id=? AND kind=? ORDER BY type",
      a.id,
      kind,
    );
    return rows.length
      ? rows
      : kind === "INITIAL"
        ? [{ type: a.type, quantity: a.quantity }]
        : a.extras
          ? [{ type: a.type, quantity: a.extras }]
          : [];
  };
  const saveItems = async (aId, kind, items) => {
    await run(
      "DELETE FROM appointment_items WHERE appointment_id=? AND kind=?",
      aId,
      kind,
    );
    for (const item of items)
      await run(
        "INSERT INTO appointment_items(appointment_id,kind,type,quantity) VALUES(?,?,?,?)",
        aId,
        kind,
        item.type,
        item.quantity,
      );
  };
  const parseItems = (body, limit, fallbackType) => {
    const items = z
      .array(
        z.object({
          type: z.enum(types),
          quantity: z.number().int().min(1).max(limit),
        }),
      )
      .min(1)
      .max(types.length)
      .parse(
        body.items ?? [
          { type: body.type ?? fallbackType, quantity: body.quantity },
        ],
      );
    if (new Set(items.map((i) => i.type)).size !== items.length)
      fail(400, "Selecione cada tipo apenas uma vez.");
    const quantity = items.reduce((n, i) => n + i.quantity, 0);
    if (quantity > limit)
      fail(400, `O pedido pode ter até ${limit} aparelhos no total.`);
    return { items, quantity, type: items[0].type };
  };
  const validateComposition = (devices, items) => {
    if (
      devices.length !== items.reduce((n, i) => n + i.quantity, 0) ||
      items.some(
        (i) => devices.filter((d) => d.type === i.type).length !== i.quantity,
      )
    )
      fail(400, "Selecione a quantidade exata de cada tipo solicitado.");
  };
  const appointment = async (appointmentId) => {
    const a = await get("SELECT * FROM appointments WHERE id=?", appointmentId);
    if (!a) fail(404, "Agendamento não encontrado.");
    return withItems(a);
  };
  const loan = async (loanId) =>
    (await get("SELECT * FROM loans WHERE id=?", loanId)) ||
    fail(404, "Movimentação não encontrada.");
  const owns = (u, l) => {
    if (!staff(u) && l.teacher_id !== u.id)
      fail(403, "Movimentação de outro professor.");
  };
  const available = async (deviceId) =>
    !(await get(
      "SELECT i.id FROM loan_items i JOIN loans l ON l.id=i.loan_id WHERE i.device_id=? AND l.status IN ('EM_USO','AGUARDANDO_DEVOLUCAO')",
      deviceId,
    ));
  const validateDevices = async (ids, type) =>
    await Promise.all(
      ids.map(async (deviceId) => {
        const d = await get(
          "SELECT * FROM devices WHERE id=? AND active=1",
          deviceId,
        );
        if (!d) fail(404, "Dispositivo não encontrado.");
        if (type && d.type !== type)
          fail(409, "Tipo incompatível com o agendamento.");
        if (
          ["QUEBRADO", "EM_MANUTENCAO"].includes(d.status) ||
          !(await available(deviceId))
        )
          fail(409, `Dispositivo ${d.number} indisponível.`);
        return d;
      }),
    );
  const fullLoan = async (l) => ({
    ...l,
    teacher: await get(
      "SELECT id,name,email FROM users WHERE id=?",
      l.teacher_id,
    ),
    ti: await get("SELECT id,name FROM users WHERE id=?", l.ti_id),
    items: await all(
      "SELECT i.*,d.number,d.qr,d.type FROM loan_items i JOIN devices d ON d.id=i.device_id WHERE loan_id=? ORDER BY d.number",
      l.id,
    ),
    signatures: await all(
      "SELECT s.*,u.name FROM signatures s JOIN users u ON u.id=s.user_id WHERE loan_id=?",
      l.id,
    ),
  });
  const sessionUser = async (req) => {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("am_session="))
      ?.slice(11);
    const sessionHash = token
      ? createHash("sha256").update(token).digest("hex")
      : "";
    const user = await get(
      "SELECT u.id,u.name,u.email,u.role,u.active,u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1",
      sessionHash,
      Date.now(),
    );
    return user
      ? {
          user,
          sessionHash,
        }
      : null;
  };
  const issueSession = async (res, u, action = "LOGIN") => {
    const token = randomBytes(32).toString("hex"),
      time = Date.now();
    await run("DELETE FROM sessions WHERE expires_at<?", time);
    await run(
      "INSERT INTO sessions VALUES(?,?,?)",
      createHash("sha256").update(token).digest("hex"),
      u.id,
      time + 8 * 3600000,
    );
    res.cookie("am_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure,
      maxAge: 8 * 3600000,
      path: "/",
    });
    await audit(u, action, u.id);
  };
  // One request at a time protects multi-step validations and SQLite async transactions.
  // This school deployment runs a single application instance.
  let requestTail = Promise.resolve();
  app.use(async (req, res, next) => {
    if (!req.path.startsWith("/api/") && !req.path.startsWith("/auth/"))
      return next();
    const previous = requestTail;
    let release;
    requestTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    if (res.destroyed) {
      release();
      return;
    }
    res.once("finish", release);
    req.releaseRequest = release;
    next();
  });
  // Keep the queue locked until an aborted request's handler finishes too.
  for (const method of ["get", "post", "patch", "delete"]) {
    const register = app[method].bind(app);
    app[method] = (path, ...handlers) => {
      if (
        typeof path === "string" &&
        (path.startsWith("/api/") || path.startsWith("/auth/"))
      ) {
        handlers = handlers.map((handler) => async (req, res, next) => {
          try {
            await handler(req, res, next);
          } catch (error) {
            next(error);
          } finally {
            req.releaseRequest?.();
          }
        });
      }
      return register(path, ...handlers);
    };
  }
  app.disable("x-powered-by");
  if (trustProxy) app.set("trust proxy", 1);
  app.use(
    express.json({
      limit: "2mb",
    }),
  );
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin
    ) {
      try {
        const origin = new URL(req.headers.origin);
        const originalAllowed = publicOrigin
          ? origin.origin === publicOrigin
          : origin.host === req.headers.host;
        if (!originalAllowed && origin.origin !== staticOrigin)
          return res.status(403).json({
            erro: "Origem não autorizada.",
          });
      } catch {
        return res.status(403).json({
          erro: "Origem inválida.",
        });
      }
    }
    next();
  });
  app.get("/health", async (_req, res) => {
    await get("SELECT 1");
    res.json({
      ok: true,
      app: "APP Monitor",
      database: "ok",
    });
  });
  app.post("/api/setup", async (req, res) => {
    if (
      !setupToken ||
      (await get("SELECT id FROM users WHERE role='ADMINISTRADOR'"))
    )
      fail(404, "Instalação inicial indisponível.");
    const key = `setup|${req.ip}`,
      time = Date.now(),
      attempt = attempts.get(key) || {
        count: 0,
        until: time + 900000,
      };
    if (attempt.until < time) {
      attempt.count = 0;
      attempt.until = time + 900000;
    }
    if (attempt.count >= 50)
      fail(429, "Muitas tentativas de instalação. Aguarde 15 minutos.");
    const d = z
      .object({
        token: z.string().max(500),
        name: text,
        email: z.email().max(200),
        password: z.string().min(12).max(200),
      })
      .parse(req.body);
    const equal = timingSafeEqual(
      createHash("sha256").update(d.token).digest(),
      createHash("sha256").update(setupToken).digest(),
    );
    if (!equal) {
      attempt.count++;
      attempts.set(key, attempt);
      fail(403, "Código de instalação inválido.");
    }
    const user = await transaction(db, async () => {
      if (await get("SELECT id FROM users WHERE role='ADMINISTRADOR'"))
        fail(409, "A instalação já foi concluída.");
      const u = await createUser(db, {
        ...d,
        role: "ADMINISTRADOR",
      });
      await audit(u, "INSTALACAO_INICIAL", u.id);
      return u;
    });
    await issueSession(res, user);
    res.status(201).json(user);
  });
  registerGovbr({
    app,
    db,
    secure,
    settings: govbr,
    issueSession,
    sessionUser,
    setupAvailable: async () =>
      !!setupToken &&
      !(await get("SELECT id FROM users WHERE role='ADMINISTRADOR'")),
  });
  app.post("/api/register", async (req, res) => {
    const key = `register|${req.ip}`,
      time = Date.now();
    for (const [k, v] of attempts) if (v.until < time) attempts.delete(k);
    const attempt = attempts.get(key) || { count: 0, until: time + 900000 };
    if (attempt.count >= 10)
      fail(
        429,
        "Muitas tentativas de cadastro. Tente novamente em 15 minutos.",
      );
    attempt.count++;
    attempts.set(key, attempt);
    if (
      !(await get(
        "SELECT id FROM users WHERE role='ADMINISTRADOR' AND active=1",
      ))
    )
      fail(403, "A escola precisa concluir a instalação antes dos cadastros.");
    const d = z
      .object({
        name: text.refine(
          (value) =>
            value.split(/\s+/).filter((part) => /\p{L}/u.test(part)).length >=
            2,
          "Informe seu nome completo, com nome e sobrenome.",
        ),
        email: z.email().max(200),
        password: z.string().min(12).max(200),
      })
      .strict()
      .parse(req.body);
    const user = await transaction(db, async () => {
      const u = await createUser(db, { ...d, role: "PROFESSOR" });
      await audit(u, "AUTOCADASTRO_PROFESSOR", u.id);
      await notifyStaff(
        "Novo professor cadastrado",
        `${u.name} criou uma conta de professor.`,
        "users",
        u.id,
      );
      return u;
    });
    await issueSession(res, user);
    res.status(201).json(user);
  });
  app.post("/api/login", async (req, res) => {
    const d = z
      .object({
        email: z.email().max(200),
        password: z.string().min(1).max(200),
      })
      .parse(req.body);
    const key = `${req.ip}|${d.email.toLowerCase()}`,
      time = Date.now();
    for (const [k, v] of attempts) if (v.until < time) attempts.delete(k);
    const attempt = attempts.get(key) || {
      count: 0,
      until: time + 900000,
    };
    if (attempt.count >= 15)
      fail(429, "Muitas tentativas. Tente novamente em 15 minutos.");
    const u = await get(
      "SELECT * FROM users WHERE email=?",
      d.email.toLowerCase(),
    );
    if (!u || !u.active || !verifyPassword(d.password, u.password)) {
      attempt.count++;
      attempts.set(key, attempt);
      fail(401, "E-mail ou senha inválidos.");
    }
    attempts.delete(key);
    await issueSession(res, u);
    res.json({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
    });
  });
  app.use("/api", async (req, res, next) => {
    const session = await sessionUser(req);
    if (res.destroyed) {
      req.releaseRequest?.();
      return;
    }
    if (!session)
      return res.status(401).json({
        erro: "Entre na sua conta para continuar.",
      });
    req.user = session.user;
    req.sessionHash = session.sessionHash;
    if (
      req.user.must_change_password &&
      !["/me", "/password", "/logout"].includes(req.path)
    )
      return res.status(403).json({
        erro: "Troque a senha provisória para continuar.",
        requiresPasswordChange: true,
      });
    next();
  });
  app.post("/api/logout", async (req, res) => {
    await run("DELETE FROM sessions WHERE token=?", req.sessionHash);
    res.clearCookie("am_session", {
      path: "/",
    });
    res.status(204).end();
  });
  app.get("/api/me", async (req, res) =>
    res.json({
      ...req.user,
      blocked: !!(await blocked(req.user)),
      requiresPasswordChange: !!req.user.must_change_password,
      govbrLinked: !!(await get(
        "SELECT id FROM external_identities WHERE user_id=?",
        req.user.id,
      )),
    }),
  );
  app.post("/api/password", async (req, res) => {
    const d = z
      .object({
        current: z.string().max(200),
        password: z.string().min(12).max(200),
      })
      .parse(req.body);
    const u = await get("SELECT * FROM users WHERE id=?", req.user.id);
    if (d.password === d.current)
      fail(400, "Escolha uma senha diferente da senha atual.");
    if (!verifyPassword(d.current, u.password))
      fail(400, "Senha atual incorreta.");
    await transaction(db, async () => {
      await run(
        "UPDATE users SET password=?,must_change_password=0 WHERE id=?",
        passwordHash(d.password),
        u.id,
      );
      await run(
        "DELETE FROM sessions WHERE user_id=? AND token<>?",
        u.id,
        req.sessionHash,
      );
      await audit(u, "ALTERAR_SENHA", u.id);
    });
    res.json({
      ok: true,
    });
  });
  app.get("/api/users", async (req, res) => {
    mustStaff(req.user);
    res.json(
      await all(
        "SELECT id,name,email,role,active,must_change_password FROM users ORDER BY name",
      ),
    );
  });
  app.post("/api/users", async (req, res) => {
    mustAdmin(req.user);
    const d = z
      .object({
        name: text,
        email: z.email().max(200),
        password: z.string().min(12).max(200).optional(),
        role: z.enum(["TI", "PROFESSOR", "ADMINISTRADOR"]),
      })
      .parse(req.body);
    res.status(201).json(
      await transaction(db, async () => {
        const temporaryPassword =
          d.password || randomBytes(15).toString("base64url");
        const u = await createUser(db, {
          ...d,
          password: temporaryPassword,
          mustChangePassword: true,
        });
        await audit(req.user, "CRIAR_USUARIO", u.id);
        return {
          ...u,
          temporaryPassword,
        };
      }),
    );
  });
  app.post("/api/users/:id/password", async (req, res) => {
    mustAdmin(req.user);
    if (req.params.id === req.user.id)
      fail(409, "Altere sua própria senha em Conta.");
    if (!(await get("SELECT id FROM users WHERE id=?", req.params.id)))
      fail(404, "Usuário não encontrado.");
    const d = z
      .object({
        password: z.string().min(12).max(200).optional(),
      })
      .parse(req.body || {});
    const temporaryPassword =
      d.password || randomBytes(15).toString("base64url");
    await transaction(db, async () => {
      await run(
        "UPDATE users SET password=?,must_change_password=1 WHERE id=?",
        passwordHash(temporaryPassword),
        req.params.id,
      );
      await run("DELETE FROM sessions WHERE user_id=?", req.params.id);
      await audit(req.user, "REDEFINIR_SENHA", req.params.id);
    });
    res.json({
      temporaryPassword,
    });
  });
  app.patch("/api/users/:id", async (req, res) => {
    mustAdmin(req.user);
    const d = z
      .object({
        name: text.optional(),
        email: z.email().max(200).optional(),
        role: z.enum(["TI", "PROFESSOR", "ADMINISTRADOR"]).optional(),
        active: z.boolean().optional(),
      })
      .strict()
      .refine(
        (value) => Object.keys(value).length > 0,
        "Informe uma alteração.",
      )
      .parse(req.body);
    const existing = await get("SELECT * FROM users WHERE id=?", req.params.id);
    if (!existing) fail(404, "Usuário não encontrado.");
    if (
      req.params.id === req.user.id &&
      (d.active === false || (d.role && d.role !== "ADMINISTRADOR"))
    )
      fail(
        409,
        "Você não pode desativar ou retirar o perfil administrador da própria conta.",
      );
    await transaction(db, async () => {
      await run(
        "UPDATE users SET name=?,email=?,role=?,active=? WHERE id=?",
        d.name ?? existing.name,
        d.email?.toLowerCase() ?? existing.email,
        d.role ?? existing.role,
        d.active === undefined ? existing.active : +d.active,
        existing.id,
      );
      if (
        d.active === false ||
        (d.role && d.role !== existing.role) ||
        (d.email && d.email.toLowerCase() !== existing.email)
      )
        await run("DELETE FROM sessions WHERE user_id=?", existing.id);
      await audit(req.user, "ALTERAR_USUARIO", existing.id, d);
    });
    res.json({ ok: true });
  });
  app.get("/api/devices", async (req, res) => {
    mustStaff(req.user);
    res.json(
      await all(
        `SELECT d.*,EXISTS(SELECT 1 FROM loan_items i JOIN loans l ON l.id=i.loan_id WHERE i.device_id=d.id AND l.status IN ('EM_USO','AGUARDANDO_DEVOLUCAO')) AS in_use FROM devices d WHERE d.active=1 ORDER BY d.number`,
      ),
    );
  });
  app.get("/api/devices/:id/qr", async (req, res) => {
    mustStaff(req.user);
    const d = await get(
      "SELECT qr FROM devices WHERE id=? AND active=1",
      req.params.id,
    );
    if (!d) fail(404, "Dispositivo não encontrado.");
    res.json({
      image: await QRCode.toDataURL(d.qr, {
        width: 400,
        margin: 2,
      }),
    });
  });
  app.post("/api/devices/import", async (req, res) => {
    mustAdmin(req.user);
    const input = importSchema.parse(req.body);
    const summary = await transaction(db, async () => {
      const plan = await planInventoryImport(db, input.records);
      const result = {
        created: plan.create.length,
        enriched: plan.update.length,
        unchanged: plan.unchanged,
        conflicts: plan.conflicts,
        total: input.records.length,
      };
      if (!input.dry_run) {
        if (plan.conflicts.length)
          fail(
            409,
            "Importação não realizada: há identificadores em conflito. Confira a prévia.",
          );
        await applyInventoryImport(db, plan);
        await audit(req.user, "IMPORTAR_INVENTARIO", null, result);
      }
      return result;
    });
    res.json(summary);
  });
  app.post("/api/devices", async (req, res) => {
    mustStaff(req.user);
    const d = z
      .object({
        number: text,
        qr: text,
        ...deviceFields,
        type: z.enum(types),
        status: z.enum(statuses),
        notes: z.string().trim().max(2000).default(""),
      })
      .parse(req.body);
    const deviceId = id();
    await transaction(db, async () => {
      await run(
        "INSERT INTO devices(id,number,qr,type,status,notes,internal_id,serial_number,manufacturer,model) VALUES(?,?,?,?,?,?,?,?,?,?)",
        deviceId,
        d.number,
        d.qr,
        d.type,
        d.status,
        d.notes,
        d.internal_id || d.number,
        d.serial_number,
        d.manufacturer,
        d.model,
      );
      await audit(req.user, "CRIAR_DISPOSITIVO", deviceId);
    });
    res
      .status(201)
      .json(await get("SELECT * FROM devices WHERE id=?", deviceId));
  });
  app.patch("/api/devices/:id", async (req, res) => {
    mustStaff(req.user);
    const d = z
      .object({
        internal_id: deviceFields.internal_id.removeDefault().optional(),
        serial_number: deviceFields.serial_number.removeDefault().optional(),
        manufacturer: deviceFields.manufacturer.removeDefault().optional(),
        model: deviceFields.model.removeDefault().optional(),
        status: z.enum(statuses),
        notes: z.string().trim().max(2000).default(""),
      })
      .parse(req.body);
    if (
      !(await get(
        "SELECT id FROM devices WHERE id=? AND active=1",
        req.params.id,
      ))
    )
      fail(404, "Dispositivo não encontrado.");
    if (!(await available(req.params.id)))
      fail(409, "Altere o estado durante a conferência de retorno.");
    await transaction(db, async () => {
      await run(
        "UPDATE devices SET status=?,notes=?,internal_id=COALESCE(?,internal_id),serial_number=COALESCE(?,serial_number),manufacturer=COALESCE(?,manufacturer),model=COALESCE(?,model) WHERE id=?",
        d.status,
        d.notes,
        d.internal_id ?? null,
        d.serial_number ?? null,
        d.manufacturer ?? null,
        d.model ?? null,
        req.params.id,
      );
      await audit(req.user, "ALTERAR_DISPOSITIVO", req.params.id, d);
    });
    res.json({
      ok: true,
    });
  });
  app.delete("/api/devices/:id", async (req, res) => {
    mustStaff(req.user);
    if (
      !(await get(
        "SELECT id FROM devices WHERE id=? AND active=1",
        req.params.id,
      ))
    )
      fail(404, "Dispositivo não encontrado.");
    if (!(await available(req.params.id)))
      fail(409, "Não é possível excluir um dispositivo emprestado.");
    await transaction(db, async () => {
      await run("UPDATE devices SET active=0 WHERE id=?", req.params.id);
      await audit(req.user, "EXCLUIR_DISPOSITIVO", req.params.id);
    });
    res.status(204).end();
  });
  app.get("/api/appointments", async (req, res) =>
    res.json(
      await Promise.all(
        (
          await all(
            `SELECT a.*,u.name AS teacher_name FROM appointments a JOIN users u ON u.id=a.teacher_id ${staff(req.user) ? "" : "WHERE a.teacher_id=?"} ORDER BY date DESC,time DESC`,
            ...(staff(req.user) ? [] : [req.user.id]),
          )
        ).map(withItems),
      ),
    ),
  );
  const appointmentSchema = z.object({
    date: z.iso.date(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    class_name: text,
  });
  const validateDate = (d) => {
    const start = today(),
      end = new Date(`${start}T12:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 14);
    if (d < start || d > end.toISOString().slice(0, 10))
      fail(400, "Agende entre hoje e os próximos 14 dias.");
  };
  app.post("/api/appointments", async (req, res) => {
    await mustUnblocked(req.user);
    const d = {
      ...appointmentSchema.parse(req.body),
      ...parseItems(req.body, 25),
    };
    validateDate(d.date);
    const teacherId = staff(req.user)
      ? z.string().parse(req.body.teacher_id)
      : req.user.id;
    const u = await get(
      "SELECT id FROM users WHERE id=? AND role='PROFESSOR' AND active=1",
      teacherId,
    );
    if (!u) fail(400, "Selecione um professor ativo.");
    const aId = id();
    await transaction(db, async () => {
      await run(
        "INSERT INTO appointments(id,teacher_id,date,time,class_name,type,quantity,created_at) VALUES(?,?,?,?,?,?,?,?)",
        aId,
        teacherId,
        d.date,
        d.time,
        d.class_name,
        d.type,
        d.quantity,
        now(),
      );
      await saveItems(aId, "INITIAL", d.items);
      await notifyStaff(
        "Novo agendamento",
        `${req.user.name} criou um agendamento para ${d.class_name}.`,
        "appointments",
        aId,
      );
      await audit(req.user, "CRIAR_AGENDAMENTO", aId);
    });
    res.status(201).json(await appointment(aId));
  });
  app.patch("/api/appointments/:id", async (req, res) => {
    await mustUnblocked(req.user);
    const a = await appointment(req.params.id);
    if (!staff(req.user) && a.teacher_id !== req.user.id)
      fail(403, "Agendamento de outro professor.");
    if (!["PENDENTE", "APROVADO"].includes(a.status))
      fail(409, "Agendamento encerrado ou em uso.");
    const d = {
      ...appointmentSchema.parse(req.body),
      ...parseItems(req.body, 25),
    };
    validateDate(d.date);
    await transaction(db, async () => {
      await run(
        "UPDATE appointments SET date=?,time=?,class_name=?,type=?,quantity=?,status='PENDENTE',extras=0 WHERE id=?",
        d.date,
        d.time,
        d.class_name,
        d.type,
        d.quantity,
        a.id,
      );
      await saveItems(a.id, "INITIAL", d.items);
      await saveItems(a.id, "EXTRA", []);
      await resolveNotifications(a.id);
      await notifyStaff(
        "Agendamento editado",
        `${req.user.name} alterou uma requisição.`,
        "appointments",
        a.id,
      );
      await audit(req.user, "EDITAR_AGENDAMENTO", a.id);
    });
    res.json(await appointment(a.id));
  });
  app.post("/api/appointments/:id/approve", async (req, res) => {
    mustStaff(req.user);
    const a = await appointment(req.params.id);
    if (a.status !== "PENDENTE")
      fail(409, "Apenas pedidos pendentes podem ser aprovados.");
    await transaction(db, async () => {
      await run("UPDATE appointments SET status='APROVADO' WHERE id=?", a.id);
      await resolveNotifications(a.id);
      await notify(
        a.teacher_id,
        "Agendamento aprovado",
        "A equipe de TI aprovou sua requisição.",
        "appointments",
        a.id,
      );
      await audit(req.user, "APROVAR_AGENDAMENTO", a.id);
    });
    res.json(await appointment(a.id));
  });
  app.post("/api/appointments/:id/cancel", async (req, res) => {
    const a = await appointment(req.params.id);
    if (!staff(req.user) && a.teacher_id !== req.user.id)
      fail(403, "Agendamento de outro professor.");
    if (!["PENDENTE", "APROVADO"].includes(a.status))
      fail(409, "Agendamento encerrado ou em uso.");
    await transaction(db, async () => {
      await run("UPDATE appointments SET status='CANCELADO' WHERE id=?", a.id);
      await resolveNotifications(a.id);
      await notify(
        a.teacher_id,
        "Agendamento cancelado",
        "Sua requisição foi cancelada.",
        "appointments",
        a.id,
      );
      await audit(req.user, "CANCELAR_AGENDAMENTO", a.id);
    });
    res.json({
      ok: true,
    });
  });
  app.get("/api/loans", async (req, res) =>
    res.json(
      await Promise.all(
        (
          await all(
            `SELECT * FROM loans ${staff(req.user) ? "" : "WHERE teacher_id=?"} ORDER BY departed_at DESC`,
            ...(staff(req.user) ? [] : [req.user.id]),
          )
        ).map(fullLoan),
      ),
    ),
  );
  app.post("/api/loans", async (req, res) => {
    mustStaff(req.user);
    const d = z
      .object({
        appointment_id: z.string(),
        device_ids: z.array(z.string()).min(1).max(25),
      })
      .parse(req.body);
    res.status(201).json(
      await transaction(db, async () => {
        const a = await appointment(d.appointment_id);
        if (a.status !== "APROVADO")
          fail(409, "Aprove o agendamento antes de liberar.");
        if (a.date !== today())
          fail(409, "A liberação deve ocorrer no dia agendado.");
        const teacher = await get(
          "SELECT id,active FROM users WHERE id=?",
          a.teacher_id,
        );
        if (!teacher.active) fail(409, "Professor inativo.");
        await mustUnblocked(teacher);
        if (
          d.device_ids.length !== a.quantity ||
          new Set(d.device_ids).size !== d.device_ids.length
        )
          fail(
            400,
            "Selecione a quantidade exata, sem dispositivos repetidos.",
          );
        const devices = await validateDevices(d.device_ids);
        validateComposition(devices, a.items);
        const lId = id();
        await run(
          "INSERT INTO loans(id,appointment_id,teacher_id,ti_id,class_name,departed_at) VALUES(?,?,?,?,?,?)",
          lId,
          a.id,
          a.teacher_id,
          req.user.id,
          a.class_name,
          now(),
        );
        for (const device of devices)
          await run(
            "INSERT INTO loan_items(id,loan_id,device_id,departure_status) VALUES(?,?,?,?)",
            id(),
            lId,
            device.id,
            device.status,
          );
        await run("UPDATE appointments SET status='EM_USO' WHERE id=?", a.id);
        await resolveNotifications(a.id);
        await notify(
          a.teacher_id,
          "Dispositivos liberados",
          "Associe os alunos aos dispositivos da aula.",
          "loans",
          lId,
        );
        await audit(req.user, "LIBERAR_DISPOSITIVOS", lId, {
          devices: d.device_ids,
        });
        return await fullLoan(await loan(lId));
      }),
    );
  });
  app.patch("/api/loans/:id/students", async (req, res) => {
    const l = await loan(req.params.id);
    if (l.teacher_id !== req.user.id)
      fail(403, "Somente o professor responsável pode associar alunos.");
    if (l.status !== "EM_USO") fail(409, "Movimentação não está em uso.");
    const d = z
      .object({
        items: z
          .array(
            z.object({
              id: z.string(),
              student: z.string().trim().max(200),
            }),
          )
          .min(1)
          .max(30),
      })
      .parse(req.body);
    await transaction(db, async () => {
      for (const item of d.items) {
        if (
          !(await get(
            "SELECT id FROM loan_items WHERE id=? AND loan_id=?",
            item.id,
            l.id,
          ))
        )
          fail(400, "Item inválido.");
        await run(
          "UPDATE loan_items SET student=? WHERE id=?",
          item.student,
          item.id,
        );
      }
      await audit(req.user, "ASSOCIAR_ALUNOS", l.id);
    });
    res.json(await fullLoan(await loan(l.id)));
  });
  app.post("/api/loans/:id/extras", async (req, res) => {
    await mustUnblocked(req.user);
    const l = await loan(req.params.id);
    if (l.teacher_id !== req.user.id)
      fail(403, "Somente o professor responsável pode solicitar extras.");
    if (l.status !== "EM_USO")
      fail(409, "Movimentação encerrada para pedidos.");
    const a = await appointment(l.appointment_id);
    const d = parseItems(
      req.body,
      5,
      a.items.length === 1 ? a.type : undefined,
    );
    if (a.extras) fail(409, "Já existe um pedido extra para esta aula.");
    await transaction(db, async () => {
      await run(
        "UPDATE appointments SET extras=? WHERE id=?",
        d.quantity,
        a.id,
      );
      await saveItems(a.id, "EXTRA", d.items);
      await notifyStaff(
        "Dispositivos extras",
        `${req.user.name} solicitou ${d.quantity} dispositivos extras.`,
        "loans",
        l.id,
      );
      await audit(req.user, "PEDIR_EXTRAS", l.id, d);
    });
    res.json({
      ok: true,
    });
  });
  app.post("/api/loans/:id/extras/release", async (req, res) => {
    mustStaff(req.user);
    const l = await loan(req.params.id);
    const a = await appointment(l.appointment_id);
    const d = z
      .object({
        device_ids: z.array(z.string()).min(1).max(5),
      })
      .parse(req.body);
    res.json(
      await transaction(db, async () => {
        if (l.status !== "EM_USO" || !a.extras)
          fail(409, "Não há pedido extra liberável.");
        const count = (
          await get(
            "SELECT COUNT(*) AS n FROM loan_items WHERE loan_id=?",
            l.id,
          )
        ).n;
        if (count !== a.quantity) fail(409, "Os extras já foram liberados.");
        if (
          d.device_ids.length !== a.extras ||
          new Set(d.device_ids).size !== a.extras
        )
          fail(400, "Selecione a quantidade exata de extras.");
        const devices = await validateDevices(d.device_ids);
        validateComposition(devices, a.extra_items);
        for (const device of devices)
          await run(
            "INSERT INTO loan_items(id,loan_id,device_id,departure_status) VALUES(?,?,?,?)",
            id(),
            l.id,
            device.id,
            device.status,
          );
        await resolveNotifications(l.id);
        await notify(
          l.teacher_id,
          "Extras liberados",
          "Os dispositivos extras estão disponíveis.",
          "loans",
          l.id,
        );
        await audit(req.user, "LIBERAR_EXTRAS", l.id);
        return await fullLoan(await loan(l.id));
      }),
    );
  });
  app.post("/api/loans/:id/return", async (req, res) => {
    const l = await loan(req.params.id);
    if (l.teacher_id !== req.user.id)
      fail(403, "Somente o professor responsável pode devolver.");
    if (l.status !== "EM_USO") fail(409, "Devolução já enviada.");
    const d = z
      .object({
        report: z.string().trim().min(5).max(4000),
      })
      .parse(req.body);
    if (
      await get(
        "SELECT id FROM loan_items WHERE loan_id=? AND trim(student)=''",
        l.id,
      )
    )
      fail(400, "Associe um aluno a cada dispositivo antes de devolver.");
    await transaction(db, async () => {
      await run(
        "UPDATE loans SET status='AGUARDANDO_DEVOLUCAO',report=? WHERE id=?",
        d.report,
        l.id,
      );
      await resolveNotifications(l.id);
      await notifyStaff(
        "Conferência de retorno",
        `${req.user.name} enviou a devolução de ${l.class_name}.`,
        "loans",
        l.id,
      );
      await audit(req.user, "DEVOLVER", l.id);
    });
    res.json(await fullLoan(await loan(l.id)));
  });
  app.post("/api/loans/:id/check", async (req, res) => {
    mustStaff(req.user);
    const l = await loan(req.params.id);
    if (l.status !== "AGUARDANDO_DEVOLUCAO")
      fail(409, "Aguarde o professor enviar a devolução.");
    const d = z
      .object({
        items: z
          .array(
            z.object({
              id: z.string(),
              status: z.enum(statuses),
              comment: z.string().trim().max(2000),
            }),
          )
          .min(1)
          .max(30),
      })
      .parse(req.body);
    await transaction(db, async () => {
      const items = await all("SELECT * FROM loan_items WHERE loan_id=?", l.id);
      if (
        items.length !== d.items.length ||
        new Set(d.items.map((i) => i.id)).size !== items.length ||
        d.items.some((i) => !items.find((j) => j.id === i.id))
      )
        fail(400, "Confira todos os itens, sem repetições.");
      for (const item of d.items) {
        const original = items.find((i) => i.id === item.id);
        if (item.status !== original.departure_status && !item.comment)
          fail(400, "Explique as alterações de estado na conferência.");
        await run(
          "UPDATE loan_items SET return_status=?,ti_comment=? WHERE id=?",
          item.status,
          item.comment,
          item.id,
        );
        await run(
          "UPDATE devices SET status=? WHERE id=?",
          item.status,
          original.device_id,
        );
      }
      await run(
        "UPDATE loans SET status='AGUARDANDO_ASSINATURAS',returned_at=? WHERE id=?",
        now(),
        l.id,
      );
      await resolveNotifications(l.id);
      await notify(
        l.teacher_id,
        "Relatório para assinatura",
        "A devolução foi conferida. Confira e assine o relatório.",
        "reports",
        l.id,
      );
      await audit(req.user, "CONFERIR_RETORNO", l.id);
    });
    res.json(await fullLoan(await loan(l.id)));
  });
  app.post("/api/loans/:id/sign", async (req, res) => {
    const l = await loan(req.params.id);
    const type = req.user.id === l.teacher_id ? "PROFESSOR" : "TI";
    if (type === "TI") mustStaff(req.user);
    if (l.status !== "AGUARDANDO_ASSINATURAS")
      fail(409, "Relatório ainda não está disponível para assinatura.");
    const d = z
      .object({
        image: z
          .string()
          .max(500000)
          .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
      })
      .parse(req.body);
    const png = Buffer.from(d.image.split(",")[1], "base64");
    if (
      png.length < 100 ||
      png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    )
      fail(400, "Assinatura inválida.");
    await transaction(db, async () => {
      if (
        await get(
          "SELECT id FROM signatures WHERE loan_id=? AND type=?",
          l.id,
          type,
        )
      )
        fail(409, "Este perfil já assinou o relatório.");
      await run(
        "INSERT INTO signatures VALUES(?,?,?,?,?,?)",
        id(),
        l.id,
        req.user.id,
        type,
        d.image,
        now(),
      );
      await audit(req.user, "ASSINAR_RELATORIO", l.id, {
        type,
      });
      if (
        (
          await get(
            "SELECT COUNT(*) AS n FROM signatures WHERE loan_id=?",
            l.id,
          )
        ).n === 2
      ) {
        await run("UPDATE loans SET status='CONCLUIDA' WHERE id=?", l.id);
        await run(
          "UPDATE appointments SET status='CONCLUIDO' WHERE id=?",
          l.appointment_id,
        );
        await resolveNotifications(l.id);
        await notify(
          l.teacher_id,
          "Relatório concluído",
          "As duas assinaturas foram registradas.",
          "reports",
          l.id,
        );
      } else if (type === "PROFESSOR") {
        await resolveNotifications(l.id);
        await notifyStaff(
          "Assinatura de TI pendente",
          "O professor assinou. Falta a assinatura da equipe de TI.",
          "reports",
          l.id,
        );
      }
    });
    res.json(await fullLoan(await loan(l.id)));
  });
  app.get("/api/notifications", async (req, res) =>
    res.json(
      await all(
        "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
        req.user.id,
      ),
    ),
  );
  app.patch("/api/notifications/:id", async (req, res) => {
    const d = z
      .object({
        status: z.enum(["VISUALIZADA", "CONCLUIDA"]),
      })
      .parse(req.body);
    if (
      !(await get(
        "SELECT id FROM notifications WHERE id=? AND user_id=?",
        req.params.id,
        req.user.id,
      ))
    )
      fail(404, "Notificação não encontrada.");
    await run(
      "UPDATE notifications SET status=? WHERE id=? AND user_id=?",
      d.status,
      req.params.id,
      req.user.id,
    );
    res.json({
      ok: true,
    });
  });
  app.get("/api/audit", async (req, res) => {
    mustAdmin(req.user);
    res.json(
      await all(
        "SELECT a.*,u.name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY created_at DESC LIMIT 200",
      ),
    );
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({
      erro: "Rota não encontrada.",
    }),
  );
  app.use(
    "/vendor/zxing",
    express.static(resolve(root, "node_modules/@zxing/browser/umd")),
  );
  app.use(
    "/vendor/qrcode",
    express.static(resolve(root, "node_modules/qrcode/build")),
  );
  app.use(
    express.static(resolve(root, "frontend"), {
      setHeaders(res, path) {
        if (
          path.endsWith("sw.js") ||
          path.endsWith("index.html") ||
          path.endsWith("manifest.webmanifest")
        )
          res.set("Cache-Control", "no-cache");
      },
    }),
  );
  app.use((err, _req, res, _next) => {
    if (res.destroyed) {
      _req.releaseRequest?.();
      return;
    }
    if (err instanceof z.ZodError)
      return res.status(400).json({
        erro: "Dados inválidos.",
        detalhes: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    if (err instanceof HttpError)
      return res.status(err.status).json({
        erro: err.message,
      });
    if (
      err.code === "23505" ||
      String(err.message).includes("UNIQUE constraint failed")
    )
      return res.status(409).json({
        erro: "E-mail, patrimônio ou código QR já cadastrado.",
      });
    if (err.type === "entity.too.large")
      return res.status(413).json({
        erro: "Arquivo muito grande.",
      });
    if (err instanceof SyntaxError)
      return res.status(400).json({
        erro: "JSON inválido.",
      });
    console.error("Erro interno:", err.code || err.name);
    res.status(500).json({
      erro: "Não foi possível concluir a operação.",
    });
  });
  return {
    app,
    db,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.env.RENDER === "true" && !process.env.DATABASE_URL)
      throw Error("Configure DATABASE_URL no painel privado do Render.");
    const database = process.env.DATABASE_URL
      ? await openPostgres(process.env.DATABASE_URL)
      : undefined;
    const { app } = createApp({ database });
    const port = Number(process.env.PORT || 3333);
    app.listen(port, process.env.HOST || "0.0.0.0", () =>
      console.log(`APP Monitor iniciado na porta ${port}`),
    );
  } catch (error) {
    console.error(
      "Falha ao iniciar. Verifique as configurações privadas e o acesso ao banco:",
      error.code || error.name,
    );
    process.exitCode = 1;
  }
}
