import express from "express";
import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import QRCode from "qrcode";
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
const types = ["TABLET", "NOTEBOOK", "CHROMEBOOK"],
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
  databasePath = process.env.DATABASE_PATH ||
    resolve(root, "data/app-monitor.sqlite"),
  secure = process.env.COOKIE_SECURE === "true",
} = {}) {
  const db = openDatabase(databasePath),
    app = express(),
    attempts = new Map();
  const get = (sql, ...params) => db.prepare(sql).get(...params),
    all = (sql, ...params) => db.prepare(sql).all(...params),
    run = (sql, ...params) => db.prepare(sql).run(...params);
  const audit = (user, action, entity, details = {}) =>
    run(
      "INSERT INTO audit VALUES(?,?,?,?,?,?)",
      id(),
      user.id,
      action,
      entity,
      JSON.stringify(details),
      now(),
    );
  const notify = (user, title, message, page, entity) =>
    run(
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
  const notifyStaff = (title, message, page, entity) =>
    all(
      "SELECT id FROM users WHERE active=1 AND role IN ('TI','ADMINISTRADOR')",
    ).forEach((u) => notify(u.id, title, message, page, entity));
  const resolveNotifications = (entity) =>
    run(
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
  const blocked = (u) =>
    get(
      "SELECT l.id FROM loans l WHERE l.teacher_id=? AND l.status='AGUARDANDO_ASSINATURAS' AND NOT EXISTS(SELECT 1 FROM signatures s WHERE s.loan_id=l.id AND s.type='PROFESSOR')",
      u.id,
    );
  const mustUnblocked = (u) => {
    if (blocked(u))
      fail(409, "Assine o relatório pendente antes de continuar.");
  };
  const appointment = (appointmentId) =>
    get("SELECT * FROM appointments WHERE id=?", appointmentId) ||
    fail(404, "Agendamento não encontrado.");
  const loan = (loanId) =>
    get("SELECT * FROM loans WHERE id=?", loanId) ||
    fail(404, "Movimentação não encontrada.");
  const owns = (u, l) => {
    if (!staff(u) && l.teacher_id !== u.id)
      fail(403, "Movimentação de outro professor.");
  };
  const available = (deviceId) =>
    !get(
      "SELECT i.id FROM loan_items i JOIN loans l ON l.id=i.loan_id WHERE i.device_id=? AND l.status IN ('EM_USO','AGUARDANDO_DEVOLUCAO')",
      deviceId,
    );
  const validateDevices = (ids, type) =>
    ids.map((deviceId) => {
      const d = get("SELECT * FROM devices WHERE id=? AND active=1", deviceId);
      if (!d) fail(404, "Dispositivo não encontrado.");
      if (type && d.type !== type)
        fail(409, "Tipo incompatível com o agendamento.");
      if (
        ["QUEBRADO", "EM_MANUTENCAO"].includes(d.status) ||
        !available(deviceId)
      )
        fail(409, `Dispositivo ${d.number} indisponível.`);
      return d;
    });
  const fullLoan = (l) => ({
    ...l,
    teacher: get("SELECT id,name,email FROM users WHERE id=?", l.teacher_id),
    ti: get("SELECT id,name FROM users WHERE id=?", l.ti_id),
    items: all(
      "SELECT i.*,d.number,d.qr,d.type FROM loan_items i JOIN devices d ON d.id=i.device_id WHERE loan_id=? ORDER BY d.number",
      l.id,
    ),
    signatures: all(
      "SELECT s.*,u.name FROM signatures s JOIN users u ON u.id=s.user_id WHERE loan_id=?",
      l.id,
    ),
  });
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
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
        if (new URL(req.headers.origin).host !== req.headers.host)
          return res.status(403).json({ erro: "Origem não autorizada." });
      } catch {
        return res.status(403).json({ erro: "Origem inválida." });
      }
    }
    next();
  });
  app.get("/health", (_req, res) => {
    get("SELECT 1");
    res.json({ ok: true, app: "APP Monitor", database: "ok" });
  });
  app.post("/api/login", (req, res) => {
    const d = z
      .object({
        email: z.email().max(200),
        password: z.string().min(1).max(200),
      })
      .parse(req.body);
    const key = req.socket.remoteAddress,
      time = Date.now();
    for (const [k, v] of attempts) if (v.until < time) attempts.delete(k);
    const attempt = attempts.get(key) || { count: 0, until: time + 900000 };
    if (attempt.count >= 15)
      fail(429, "Muitas tentativas. Tente novamente em 15 minutos.");
    const u = get("SELECT * FROM users WHERE email=?", d.email.toLowerCase());
    if (!u || !u.active || !verifyPassword(d.password, u.password)) {
      attempt.count++;
      attempts.set(key, attempt);
      fail(401, "E-mail ou senha inválidos.");
    }
    attempts.delete(key);
    const token = randomBytes(32).toString("hex");
    run("DELETE FROM sessions WHERE expires_at<?", time);
    run(
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
    audit(u, "LOGIN", u.id);
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role });
  });
  app.use("/api", (req, res, next) => {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("am_session="))
      ?.slice(11);
    const hashed = token
      ? createHash("sha256").update(token).digest("hex")
      : "";
    const u = get(
      "SELECT u.id,u.name,u.email,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1",
      hashed,
      Date.now(),
    );
    if (!u)
      return res
        .status(401)
        .json({ erro: "Entre na sua conta para continuar." });
    req.user = u;
    req.sessionHash = hashed;
    next();
  });
  app.post("/api/logout", (req, res) => {
    run("DELETE FROM sessions WHERE token=?", req.sessionHash);
    res.clearCookie("am_session", { path: "/" });
    res.status(204).end();
  });
  app.get("/api/me", (req, res) =>
    res.json({ ...req.user, blocked: !!blocked(req.user) }),
  );
  app.post("/api/password", (req, res) => {
    const d = z
      .object({
        current: z.string().max(200),
        password: z.string().min(12).max(200),
      })
      .parse(req.body);
    const u = get("SELECT * FROM users WHERE id=?", req.user.id);
    if (!verifyPassword(d.current, u.password))
      fail(400, "Senha atual incorreta.");
    transaction(db, () => {
      run(
        "UPDATE users SET password=? WHERE id=?",
        passwordHash(d.password),
        u.id,
      );
      run(
        "DELETE FROM sessions WHERE user_id=? AND token<>?",
        u.id,
        req.sessionHash,
      );
      audit(u, "ALTERAR_SENHA", u.id);
    });
    res.json({ ok: true });
  });
  app.get("/api/users", (req, res) => {
    mustStaff(req.user);
    res.json(all("SELECT id,name,email,role,active FROM users ORDER BY name"));
  });
  app.post("/api/users", (req, res) => {
    mustAdmin(req.user);
    const d = z
      .object({
        name: text,
        email: z.email().max(200),
        password: z.string().min(12).max(200),
        role: z.enum(["TI", "PROFESSOR", "ADMINISTRADOR"]),
      })
      .parse(req.body);
    res.status(201).json(
      transaction(db, () => {
        const u = createUser(db, d);
        audit(req.user, "CRIAR_USUARIO", u.id);
        return u;
      }),
    );
  });
  app.patch("/api/users/:id", (req, res) => {
    mustAdmin(req.user);
    const d = z.object({ active: z.boolean() }).parse(req.body);
    if (req.params.id === req.user.id)
      fail(409, "Você não pode desativar a própria conta.");
    if (!get("SELECT id FROM users WHERE id=?", req.params.id))
      fail(404, "Usuário não encontrado.");
    transaction(db, () => {
      run("UPDATE users SET active=? WHERE id=?", +d.active, req.params.id);
      if (!d.active) run("DELETE FROM sessions WHERE user_id=?", req.params.id);
      audit(req.user, "ALTERAR_USUARIO", req.params.id, { active: d.active });
    });
    res.json({ ok: true });
  });
  app.get("/api/devices", (req, res) => {
    mustStaff(req.user);
    res.json(
      all(
        `SELECT d.*,EXISTS(SELECT 1 FROM loan_items i JOIN loans l ON l.id=i.loan_id WHERE i.device_id=d.id AND l.status IN ('EM_USO','AGUARDANDO_DEVOLUCAO')) AS in_use FROM devices d WHERE d.active=1 ORDER BY d.number`,
      ),
    );
  });
  app.get("/api/devices/:id/qr", async (req, res) => {
    mustStaff(req.user);
    const d = get(
      "SELECT qr FROM devices WHERE id=? AND active=1",
      req.params.id,
    );
    if (!d) fail(404, "Dispositivo não encontrado.");
    res.json({
      image: await QRCode.toDataURL(d.qr, { width: 400, margin: 2 }),
    });
  });
  app.post("/api/devices", (req, res) => {
    mustStaff(req.user);
    const d = z
      .object({
        number: text,
        qr: text,
        type: z.enum(types),
        status: z.enum(statuses),
        notes: z.string().trim().max(2000).default(""),
      })
      .parse(req.body);
    const deviceId = id();
    transaction(db, () => {
      run(
        "INSERT INTO devices(id,number,qr,type,status,notes) VALUES(?,?,?,?,?,?)",
        deviceId,
        d.number,
        d.qr,
        d.type,
        d.status,
        d.notes,
      );
      audit(req.user, "CRIAR_DISPOSITIVO", deviceId);
    });
    res.status(201).json(get("SELECT * FROM devices WHERE id=?", deviceId));
  });
  app.patch("/api/devices/:id", (req, res) => {
    mustStaff(req.user);
    const d = z
      .object({
        status: z.enum(statuses),
        notes: z.string().trim().max(2000).default(""),
      })
      .parse(req.body);
    if (!get("SELECT id FROM devices WHERE id=? AND active=1", req.params.id))
      fail(404, "Dispositivo não encontrado.");
    if (!available(req.params.id))
      fail(409, "Altere o estado durante a conferência de retorno.");
    transaction(db, () => {
      run(
        "UPDATE devices SET status=?,notes=? WHERE id=?",
        d.status,
        d.notes,
        req.params.id,
      );
      audit(req.user, "ALTERAR_DISPOSITIVO", req.params.id, d);
    });
    res.json({ ok: true });
  });
  app.delete("/api/devices/:id", (req, res) => {
    mustStaff(req.user);
    if (!get("SELECT id FROM devices WHERE id=? AND active=1", req.params.id))
      fail(404, "Dispositivo não encontrado.");
    if (!available(req.params.id))
      fail(409, "Não é possível excluir um dispositivo emprestado.");
    transaction(db, () => {
      run("UPDATE devices SET active=0 WHERE id=?", req.params.id);
      audit(req.user, "EXCLUIR_DISPOSITIVO", req.params.id);
    });
    res.status(204).end();
  });
  app.get("/api/appointments", (req, res) =>
    res.json(
      all(
        `SELECT a.*,u.name AS teacher_name FROM appointments a JOIN users u ON u.id=a.teacher_id ${staff(req.user) ? "" : "WHERE a.teacher_id=?"} ORDER BY date DESC,time DESC`,
        ...(staff(req.user) ? [] : [req.user.id]),
      ),
    ),
  );
  const appointmentSchema = z.object({
    date: z.iso.date(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    class_name: text,
    type: z.enum(types),
    quantity: z.number().int().min(1).max(25),
  });
  const validateDate = (d) => {
    const start = today(),
      end = new Date(`${start}T12:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 14);
    if (d < start || d > end.toISOString().slice(0, 10))
      fail(400, "Agende entre hoje e os próximos 14 dias.");
  };
  app.post("/api/appointments", (req, res) => {
    mustUnblocked(req.user);
    const d = appointmentSchema.parse(req.body);
    validateDate(d.date);
    const teacherId = staff(req.user)
      ? z.string().parse(req.body.teacher_id)
      : req.user.id;
    const u = get(
      "SELECT id FROM users WHERE id=? AND role='PROFESSOR' AND active=1",
      teacherId,
    );
    if (!u) fail(400, "Selecione um professor ativo.");
    const aId = id();
    transaction(db, () => {
      run(
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
      notifyStaff(
        "Novo agendamento",
        `${req.user.name} criou um agendamento para ${d.class_name}.`,
        "appointments",
        aId,
      );
      audit(req.user, "CRIAR_AGENDAMENTO", aId);
    });
    res.status(201).json(appointment(aId));
  });
  app.patch("/api/appointments/:id", (req, res) => {
    mustUnblocked(req.user);
    const a = appointment(req.params.id);
    if (!staff(req.user) && a.teacher_id !== req.user.id)
      fail(403, "Agendamento de outro professor.");
    if (!["PENDENTE", "APROVADO"].includes(a.status))
      fail(409, "Agendamento encerrado ou em uso.");
    const d = appointmentSchema.parse(req.body);
    validateDate(d.date);
    transaction(db, () => {
      run(
        "UPDATE appointments SET date=?,time=?,class_name=?,type=?,quantity=?,status='PENDENTE',extras=0 WHERE id=?",
        d.date,
        d.time,
        d.class_name,
        d.type,
        d.quantity,
        a.id,
      );
      resolveNotifications(a.id);
      notifyStaff(
        "Agendamento editado",
        `${req.user.name} alterou uma requisição.`,
        "appointments",
        a.id,
      );
      audit(req.user, "EDITAR_AGENDAMENTO", a.id);
    });
    res.json(appointment(a.id));
  });
  app.post("/api/appointments/:id/approve", (req, res) => {
    mustStaff(req.user);
    const a = appointment(req.params.id);
    if (a.status !== "PENDENTE")
      fail(409, "Apenas pedidos pendentes podem ser aprovados.");
    transaction(db, () => {
      run("UPDATE appointments SET status='APROVADO' WHERE id=?", a.id);
      resolveNotifications(a.id);
      notify(
        a.teacher_id,
        "Agendamento aprovado",
        "A equipe de TI aprovou sua requisição.",
        "appointments",
        a.id,
      );
      audit(req.user, "APROVAR_AGENDAMENTO", a.id);
    });
    res.json(appointment(a.id));
  });
  app.post("/api/appointments/:id/cancel", (req, res) => {
    const a = appointment(req.params.id);
    if (!staff(req.user) && a.teacher_id !== req.user.id)
      fail(403, "Agendamento de outro professor.");
    if (!["PENDENTE", "APROVADO"].includes(a.status))
      fail(409, "Agendamento encerrado ou em uso.");
    transaction(db, () => {
      run("UPDATE appointments SET status='CANCELADO' WHERE id=?", a.id);
      resolveNotifications(a.id);
      notify(
        a.teacher_id,
        "Agendamento cancelado",
        "Sua requisição foi cancelada.",
        "appointments",
        a.id,
      );
      audit(req.user, "CANCELAR_AGENDAMENTO", a.id);
    });
    res.json({ ok: true });
  });
  app.get("/api/loans", (req, res) =>
    res.json(
      all(
        `SELECT * FROM loans ${staff(req.user) ? "" : "WHERE teacher_id=?"} ORDER BY departed_at DESC`,
        ...(staff(req.user) ? [] : [req.user.id]),
      ).map(fullLoan),
    ),
  );
  app.post("/api/loans", (req, res) => {
    mustStaff(req.user);
    const d = z
      .object({
        appointment_id: z.string(),
        device_ids: z.array(z.string()).min(1).max(25),
      })
      .parse(req.body);
    res.status(201).json(
      transaction(db, () => {
        const a = appointment(d.appointment_id);
        if (a.status !== "APROVADO")
          fail(409, "Aprove o agendamento antes de liberar.");
        if (a.date !== today())
          fail(409, "A liberação deve ocorrer no dia agendado.");
        const teacher = get(
          "SELECT id,active FROM users WHERE id=?",
          a.teacher_id,
        );
        if (!teacher.active) fail(409, "Professor inativo.");
        mustUnblocked(teacher);
        if (
          d.device_ids.length !== a.quantity ||
          new Set(d.device_ids).size !== d.device_ids.length
        )
          fail(
            400,
            "Selecione a quantidade exata, sem dispositivos repetidos.",
          );
        const devices = validateDevices(d.device_ids, a.type),
          lId = id();
        run(
          "INSERT INTO loans(id,appointment_id,teacher_id,ti_id,class_name,departed_at) VALUES(?,?,?,?,?,?)",
          lId,
          a.id,
          a.teacher_id,
          req.user.id,
          a.class_name,
          now(),
        );
        for (const device of devices)
          run(
            "INSERT INTO loan_items(id,loan_id,device_id,departure_status) VALUES(?,?,?,?)",
            id(),
            lId,
            device.id,
            device.status,
          );
        run("UPDATE appointments SET status='EM_USO' WHERE id=?", a.id);
        resolveNotifications(a.id);
        notify(
          a.teacher_id,
          "Dispositivos liberados",
          "Associe os alunos aos dispositivos da aula.",
          "loans",
          lId,
        );
        audit(req.user, "LIBERAR_DISPOSITIVOS", lId, { devices: d.device_ids });
        return fullLoan(loan(lId));
      }),
    );
  });
  app.patch("/api/loans/:id/students", (req, res) => {
    const l = loan(req.params.id);
    if (l.teacher_id !== req.user.id)
      fail(403, "Somente o professor responsável pode associar alunos.");
    if (l.status !== "EM_USO") fail(409, "Movimentação não está em uso.");
    const d = z
      .object({
        items: z
          .array(
            z.object({ id: z.string(), student: z.string().trim().max(200) }),
          )
          .min(1)
          .max(30),
      })
      .parse(req.body);
    transaction(db, () => {
      for (const item of d.items) {
        if (
          !get(
            "SELECT id FROM loan_items WHERE id=? AND loan_id=?",
            item.id,
            l.id,
          )
        )
          fail(400, "Item inválido.");
        run(
          "UPDATE loan_items SET student=? WHERE id=?",
          item.student,
          item.id,
        );
      }
      audit(req.user, "ASSOCIAR_ALUNOS", l.id);
    });
    res.json(fullLoan(loan(l.id)));
  });
  app.post("/api/loans/:id/extras", (req, res) => {
    mustUnblocked(req.user);
    const l = loan(req.params.id);
    if (l.teacher_id !== req.user.id)
      fail(403, "Somente o professor responsável pode solicitar extras.");
    if (l.status !== "EM_USO")
      fail(409, "Movimentação encerrada para pedidos.");
    const d = z
      .object({ quantity: z.number().int().min(1).max(5) })
      .parse(req.body);
    const a = appointment(l.appointment_id);
    if (a.extras) fail(409, "Já existe um pedido extra para esta aula.");
    transaction(db, () => {
      run("UPDATE appointments SET extras=? WHERE id=?", d.quantity, a.id);
      notifyStaff(
        "Dispositivos extras",
        `${req.user.name} solicitou ${d.quantity} dispositivos extras.`,
        "loans",
        l.id,
      );
      audit(req.user, "PEDIR_EXTRAS", l.id, d);
    });
    res.json({ ok: true });
  });
  app.post("/api/loans/:id/extras/release", (req, res) => {
    mustStaff(req.user);
    const l = loan(req.params.id);
    const a = appointment(l.appointment_id);
    const d = z
      .object({ device_ids: z.array(z.string()).min(1).max(5) })
      .parse(req.body);
    res.json(
      transaction(db, () => {
        if (l.status !== "EM_USO" || !a.extras)
          fail(409, "Não há pedido extra liberável.");
        const count = get(
          "SELECT COUNT(*) AS n FROM loan_items WHERE loan_id=?",
          l.id,
        ).n;
        if (count !== a.quantity) fail(409, "Os extras já foram liberados.");
        if (
          d.device_ids.length !== a.extras ||
          new Set(d.device_ids).size !== a.extras
        )
          fail(400, "Selecione a quantidade exata de extras.");
        const devices = validateDevices(d.device_ids, a.type);
        for (const device of devices)
          run(
            "INSERT INTO loan_items(id,loan_id,device_id,departure_status) VALUES(?,?,?,?)",
            id(),
            l.id,
            device.id,
            device.status,
          );
        resolveNotifications(l.id);
        notify(
          l.teacher_id,
          "Extras liberados",
          "Os dispositivos extras estão disponíveis.",
          "loans",
          l.id,
        );
        audit(req.user, "LIBERAR_EXTRAS", l.id);
        return fullLoan(loan(l.id));
      }),
    );
  });
  app.post("/api/loans/:id/return", (req, res) => {
    const l = loan(req.params.id);
    if (l.teacher_id !== req.user.id)
      fail(403, "Somente o professor responsável pode devolver.");
    if (l.status !== "EM_USO") fail(409, "Devolução já enviada.");
    const d = z
      .object({ report: z.string().trim().min(5).max(4000) })
      .parse(req.body);
    if (
      get(
        "SELECT id FROM loan_items WHERE loan_id=? AND trim(student)=''",
        l.id,
      )
    )
      fail(400, "Associe um aluno a cada dispositivo antes de devolver.");
    transaction(db, () => {
      run(
        "UPDATE loans SET status='AGUARDANDO_DEVOLUCAO',report=? WHERE id=?",
        d.report,
        l.id,
      );
      resolveNotifications(l.id);
      notifyStaff(
        "Conferência de retorno",
        `${req.user.name} enviou a devolução de ${l.class_name}.`,
        "loans",
        l.id,
      );
      audit(req.user, "DEVOLVER", l.id);
    });
    res.json(fullLoan(loan(l.id)));
  });
  app.post("/api/loans/:id/check", (req, res) => {
    mustStaff(req.user);
    const l = loan(req.params.id);
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
    transaction(db, () => {
      const items = all("SELECT * FROM loan_items WHERE loan_id=?", l.id);
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
        run(
          "UPDATE loan_items SET return_status=?,ti_comment=? WHERE id=?",
          item.status,
          item.comment,
          item.id,
        );
        run(
          "UPDATE devices SET status=? WHERE id=?",
          item.status,
          original.device_id,
        );
      }
      run(
        "UPDATE loans SET status='AGUARDANDO_ASSINATURAS',returned_at=? WHERE id=?",
        now(),
        l.id,
      );
      resolveNotifications(l.id);
      notify(
        l.teacher_id,
        "Relatório para assinatura",
        "A devolução foi conferida. Confira e assine o relatório.",
        "reports",
        l.id,
      );
      audit(req.user, "CONFERIR_RETORNO", l.id);
    });
    res.json(fullLoan(loan(l.id)));
  });
  app.post("/api/loans/:id/sign", (req, res) => {
    const l = loan(req.params.id);
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
    transaction(db, () => {
      if (
        get("SELECT id FROM signatures WHERE loan_id=? AND type=?", l.id, type)
      )
        fail(409, "Este perfil já assinou o relatório.");
      run(
        "INSERT INTO signatures VALUES(?,?,?,?,?,?)",
        id(),
        l.id,
        req.user.id,
        type,
        d.image,
        now(),
      );
      audit(req.user, "ASSINAR_RELATORIO", l.id, { type });
      if (
        get("SELECT COUNT(*) AS n FROM signatures WHERE loan_id=?", l.id).n ===
        2
      ) {
        run("UPDATE loans SET status='CONCLUIDA' WHERE id=?", l.id);
        run(
          "UPDATE appointments SET status='CONCLUIDO' WHERE id=?",
          l.appointment_id,
        );
        resolveNotifications(l.id);
        notify(
          l.teacher_id,
          "Relatório concluído",
          "As duas assinaturas foram registradas.",
          "reports",
          l.id,
        );
      } else if (type === "PROFESSOR") {
        resolveNotifications(l.id);
        notifyStaff(
          "Assinatura de TI pendente",
          "O professor assinou. Falta a assinatura da equipe de TI.",
          "reports",
          l.id,
        );
      }
    });
    res.json(fullLoan(loan(l.id)));
  });
  app.get("/api/notifications", (req, res) =>
    res.json(
      all(
        "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
        req.user.id,
      ),
    ),
  );
  app.patch("/api/notifications/:id", (req, res) => {
    const d = z
      .object({ status: z.enum(["VISUALIZADA", "CONCLUIDA"]) })
      .parse(req.body);
    if (
      !get(
        "SELECT id FROM notifications WHERE id=? AND user_id=?",
        req.params.id,
        req.user.id,
      )
    )
      fail(404, "Notificação não encontrada.");
    run(
      "UPDATE notifications SET status=? WHERE id=? AND user_id=?",
      d.status,
      req.params.id,
      req.user.id,
    );
    res.json({ ok: true });
  });
  app.get("/api/audit", (req, res) => {
    mustAdmin(req.user);
    res.json(
      all(
        "SELECT a.*,u.name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY created_at DESC LIMIT 200",
      ),
    );
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ erro: "Rota não encontrada." }),
  );
  app.use(
    "/vendor/zxing",
    express.static(resolve(root, "node_modules/@zxing/browser/umd")),
  );
  app.use(
    "/vendor/qrcode",
    express.static(resolve(root, "node_modules/qrcode/build")),
  );
  app.use(express.static(resolve(root, "frontend")));
  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError)
      return res
        .status(400)
        .json({
          erro: "Dados inválidos.",
          detalhes: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
    if (err instanceof HttpError)
      return res.status(err.status).json({ erro: err.message });
    if (String(err.message).includes("UNIQUE constraint failed"))
      return res
        .status(409)
        .json({ erro: "E-mail, patrimônio ou código QR já cadastrado." });
    if (err.type === "entity.too.large")
      return res.status(413).json({ erro: "Arquivo muito grande." });
    if (err instanceof SyntaxError)
      return res.status(400).json({ erro: "JSON inválido." });
    console.error("Erro interno:", err.message);
    res.status(500).json({ erro: "Não foi possível concluir a operação." });
  });
  return { app, db };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { app } = createApp();
  const port = Number(process.env.PORT || 3333);
  app.listen(port, process.env.HOST || "0.0.0.0", () =>
    console.log(`APP Monitor iniciado na porta ${port}`),
  );
}
