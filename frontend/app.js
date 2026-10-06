const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const escapeHTML = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const h = escapeHTML;
const labels = {
  TABLET: "Tablet",
  NOTEBOOK: "Notebook",
  CHROMEBOOK: "Chromebook",
  BOM_ESTADO: "Bom estado",
  CONSERVADO: "Conservado",
  EM_MANUTENCAO: "Em manutenção",
  QUEBRADO: "Quebrado",
  PENDENTE: "Pendente",
  APROVADO: "Aprovado",
  EM_USO: "Em uso",
  CONCLUIDO: "Concluído",
  CANCELADO: "Cancelado",
  AGUARDANDO_DEVOLUCAO: "Conferir retorno",
  AGUARDANDO_ASSINATURAS: "Aguardando assinaturas",
  CONCLUIDA: "Concluído",
  TI: "TI",
  PROFESSOR: "Professor",
  ADMINISTRADOR: "Administrador",
};
const state = {
  user: null,
  page: "dashboard",
  devices: [],
  appointments: [],
  loans: [],
  users: [],
  notifications: [],
  audit: [],
  selection: new Set(),
  appointment: null,
  extraLoan: null,
  editAppointment: null,
};
let authConfig = { govbr: false };
let scannerControls = null,
  scannerReader = null,
  generation = 0;
const staff = () => state.user && state.user.role !== "PROFESSOR";
const fmt = (v) =>
  v
    ? new Date(v).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
    : "—";
const date = (v) => v?.split("-").reverse().join("/") || "—";
const localToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
function toast(message) {
  const t = $("#toast");
  t.textContent = message;
  t.className = "toast";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ""), 4500);
}
async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = r.status === 204 ? null : await r.json();
  if (!r.ok) {
    if (r.status === 401 && path !== "/login") {
      state.user = null;
      login();
    }
    throw Error(
      data.erro + (data.detalhes ? " " + data.detalhes.join("; ") : ""),
    );
  }
  return data;
}
function action(fn) {
  return async (e) => {
    e?.preventDefault();
    const button = e?.currentTarget;
    if (button?.tagName === "BUTTON") button.disabled = true;
    try {
      await fn(e);
    } catch (error) {
      toast(error.message);
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  };
}
function status(v) {
  return `<span class="status ${["EM_MANUTENCAO", "PENDENTE", "AGUARDANDO_ASSINATURAS", "AGUARDANDO_DEVOLUCAO"].includes(v) ? "warn" : ["QUEBRADO", "CANCELADO"].includes(v) ? "bad" : ""}">${h(labels[v] || v)}</span>`;
}
function options(values, selected) {
  return values
    .map(
      (v) =>
        `<option value="${h(v)}" ${v === selected ? "selected" : ""}>${h(labels[v] || v)}</option>`,
    )
    .join("");
}
function empty(text = "Nenhum registro encontrado.") {
  return `<div class="empty">${h(text)}</div>`;
}
function table(headers, rows) {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr>${headers.map((v) => `<th>${h(v)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : empty();
}
function button(label, attrs = "", type = "ghost") {
  return `<button class="btn ${type}" ${attrs}>${label}</button>`;
}
function hero(title, description, extra = "") {
  return `<div class="hero"><div><h1>${h(title)}</h1><p class="muted">${h(description)}</p></div>${extra}</div>`;
}
let fieldCounter = 0;
function field(label, input) {
  const existing = input.match(/\bid="([^"]+)"/);
  const fieldId = existing ? existing[1] : `field-${++fieldCounter}`;
  if (!existing)
    input = input.replace(/^<(input|select|textarea)/, `<$1 id="${fieldId}"`);
  return `<div class="field"><label for="${fieldId}">${label}</label>${input}</div>`;
}
function formValue(form) {
  return Object.fromEntries(new FormData(form));
}
function stopScanner() {
  scannerControls?.stop();
  scannerControls = null;
  scannerReader = null;
  const video = $("#cameraVideo");
  if (video?.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
}
function closeModal() {
  stopScanner();
  $("#modal")?.remove();
}
function modal(content, wide = false) {
  closeModal();
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="modal" class="modal-bg"><div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true"><div class="section-head"><h2>APP Monitor</h2>${button("Fechar", 'id="closeModal"')}</div>${content}</div></div>`,
  );
  $("#closeModal").onclick = closeModal;
  $("#modal input, #modal button")?.focus();
}
function theme() {
  document.body.classList.toggle("dark");
  localStorage.setItem(
    "am-theme",
    document.body.classList.contains("dark") ? "dark" : "light",
  );
}
if (localStorage.getItem("am-theme") === "dark")
  document.body.classList.add("dark");
function login() {
  stopScanner();
  closeModal();
  if (authConfig.needsSetup) return setupPage();
  $("#app").innerHTML =
    `<div class="login"><div class="login-card"><div class="login-logo">AM</div><h1>APP Monitor</h1><p class="muted">Controle de dispositivos escolares</p><form id="loginForm"><div class="login-actions">${field("E-mail", '<input name="email" type="email" autocomplete="username" required>')}${field("Senha", '<input name="password" type="password" autocomplete="current-password" required>')}<button class="btn primary" type="submit">Entrar</button></div></form><div class="notice">Use a conta cadastrada pelo administrador da escola.</div>${authConfig.govbr ? `<p><a class="btn primary govbr-login" href="/auth/govbr">Entrar com GOV.BR${authConfig.environment === "homologacao" ? " (homologação)" : ""}</a></p><p class="muted">No primeiro acesso, entre com sua conta da escola e vincule GOV.BR em Conta.</p>` : ""}${button("Alternar tema", 'id="loginTheme"')}</div></div>`;
  $("#loginTheme").onclick = theme;
  $("#loginForm").onsubmit = action(async (e) => {
    const b = e.currentTarget.querySelector("button");
    b.disabled = true;
    try {
      state.user = await api("/login", {
        method: "POST",
        body: formValue(e.currentTarget),
      });
      state.page = "dashboard";
      await refresh();
    } finally {
      b.disabled = false;
    }
  });
}
function setupPage() {
  $("#app").innerHTML =
    `<div class="login"><div class="login-card"><div class="login-logo">AM</div><h1>Configurar sua escola</h1><p class="muted">Crie a primeira conta de administrador.</p><form id="setupForm"><div class="login-actions">${field("Código de instalação", '<input name="token" type="password" autocomplete="off" required>')}${field("Seu nome", '<input name="name" maxlength="200" required>')}${field("Seu e-mail", '<input name="email" type="email" autocomplete="username" required>')}${field("Sua senha (mínimo 12 caracteres)", '<input name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password" required>')}<button class="btn primary">Criar administrador</button></div></form><p class="muted">O código privado é definido por quem instalou o app. Ele não é uma senha de professor.</p></div></div>`;
  $("#setupForm").onsubmit = action(async (e) => {
    state.user = await api("/setup", {
      method: "POST",
      body: formValue(e.currentTarget),
    });
    authConfig = await api("/auth/config");
    await refresh();
    toast("Administrador criado. Agora você pode cadastrar a equipe.");
  });
}
function passwordChangePage() {
  $("#app").innerHTML =
    `<div class="login"><div class="login-card"><div class="login-logo">AM</div><h1>Defina sua senha</h1><p class="muted">Olá, ${h(state.user.name)}. Troque a senha provisória para acessar o sistema.</p><form id="firstPasswordForm"><div class="login-actions">${field("Senha provisória", '<input name="current" type="password" autocomplete="current-password" required>')}${field("Nova senha (mínimo 12 caracteres)", '<input name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password" required>')}${field("Confirme a nova senha", '<input name="confirmation" type="password" minlength="12" maxlength="200" autocomplete="new-password" required>')}<button class="btn primary">Salvar minha senha</button></div></form><button id="leavePassword" class="btn ghost section">Sair</button></div></div>`;
  $("#firstPasswordForm").onsubmit = action(async (e) => {
    const body = formValue(e.currentTarget);
    if (body.password !== body.confirmation)
      return toast("As senhas não coincidem.");
    await api("/password", {
      method: "POST",
      body: { current: body.current, password: body.password },
    });
    await refresh();
    toast("Sua senha foi definida.");
  });
  $("#leavePassword").onclick = action(async () => {
    await api("/logout", { method: "POST" });
    state.user = null;
    login();
  });
}
async function refresh() {
  if (!state.user) return;
  const current = ++generation;
  const me = await api("/me");
  if (current !== generation || !state.user) return;
  state.user = me;
  if (me.requiresPasswordChange) {
    render();
    return;
  }
  const paths = [
    "/appointments",
    "/loans",
    "/notifications",
    ...(staff() ? ["/devices", "/users"] : []),
  ];
  const results = await Promise.all(paths.map((p) => api(p)));
  if (current !== generation || !state.user) return;
  [state.appointments, state.loans, state.notifications] = results;
  if (staff()) {
    state.devices = results[3];
    state.users = results[4];
  } else {
    state.devices = [];
    state.users = [];
  }
  if (state.user.blocked && ["schedule", "release"].includes(state.page))
    state.page = "reports";
  render();
}
function temporaryPasswordModal(user, password) {
  modal(
    `<h3>Acesso de ${h(user.name)}</h3><p>E-mail: <b>${h(user.email)}</b></p>${field("Senha provisória", `<input id="temporaryPassword" value="${h(password)}" readonly autocomplete="off">`)}<p class="muted">Entregue esta senha à pessoa por um canal privado. Ela será obrigada a trocá-la ao entrar. A senha não poderá ser consultada depois.</p><button id="copyTemporaryPassword" class="btn primary">Copiar senha</button>`,
  );
  $("#copyTemporaryPassword").onclick = action(async () => {
    const input = $("#temporaryPassword");
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(input.value);
      toast("Senha copiada.");
    } else {
      input.focus();
      input.select();
      toast("Use Ctrl+C para copiar a senha selecionada.");
    }
  });
}
function navItems() {
  return [
    ["dashboard", "▦", "Visão geral"],
    ["appointments", "▣", "Agendamentos"],
    ...(staff()
      ? [
          ["release", "⌁", "Liberar dispositivos"],
          ["inventory", "▤", "Inventário"],
        ]
      : []),
    ["loans", "↩", staff() ? "Movimentações e retorno" : "Meus dispositivos"],
    ["reports", "✍", "Relatórios e assinaturas"],
    ["history", "◷", "Histórico"],
    ...(state.user.role === "ADMINISTRADOR"
      ? [
          ["users", "♙", "Usuários"],
          ["audit", "≡", "Auditoria"],
        ]
      : []),
  ];
}
function render() {
  if (!state.user) return login();
  if (state.user.requiresPasswordChange) return passwordChangePage();
  stopScanner();
  closeModal();
  const nav = navItems();
  const page = (
    {
      dashboard,
      appointments,
      release,
      inventory,
      loans,
      reports,
      history,
      users,
      audit: () => auditPage(),
    }[state.page] || dashboard
  )();
  $("#app").innerHTML =
    `<div class="shell"><aside class="sidebar"><div class="brand"><div class="logo">AM</div><span><b>APP Monitor</b><small>Dispositivos escolares</small></span></div><nav class="nav">${nav.map(([p, icon, label]) => `<button data-page="${p}" class="${state.page === p ? "active" : ""}" aria-label="${label}"><span>${icon}</span> <span class="label">${label}</span></button>`).join("")}</nav></aside><main class="main"><header class="topbar"><div><b>${h(state.user.name)}</b><div class="muted">${h(labels[state.user.role])}</div></div><div class="top-actions"><button class="icon-btn" id="notifications" aria-label="Notificações">🔔${state.notifications.filter((n) => n.status === "PENDENTE").length ? `<span class="badge">${state.notifications.filter((n) => n.status === "PENDENTE").length}</span>` : ""}</button>${button("◐", 'id="theme" aria-label="Alternar tema"')}${button("Conta", 'id="account"')}${button("Sair", 'id="logout"')}</div></header><div class="content">${state.user.blocked ? '<div class="notice"><b>Relatório pendente de assinatura.</b> Confira e assine em Relatórios para liberar novos pedidos.</div>' : ""}${page}</div></main></div>`;
  bind();
}
function dashboard() {
  const active = state.loans.filter((l) =>
      ["EM_USO", "AGUARDANDO_DEVOLUCAO"].includes(l.status),
    ),
    pending = state.loans.filter((l) => l.status === "AGUARDANDO_ASSINATURAS");
  return (
    hero(
      `Olá, ${state.user.name.split(" ")[0]}`,
      "Acompanhe os equipamentos, as aulas e os relatórios da escola.",
      button("＋ Novo agendamento", "data-new-appointment", "primary"),
    ) +
    `<div class="grid">${[
      [
        staff() ? "Dispositivos cadastrados" : "Dispositivos em uso",
        staff()
          ? state.devices.length
          : active.reduce((n, l) => n + l.items.length, 0),
      ],
      ["Movimentações em uso", active.length],
      [
        "Agendamentos de hoje",
        state.appointments.filter(
          (a) =>
            a.date === localToday() &&
            !["CANCELADO", "CONCLUIDO"].includes(a.status),
        ).length,
      ],
      ["Relatórios pendentes", pending.length],
    ]
      .map(
        ([title, n]) =>
          `<div class="card stat"><span class="muted">${title}</span><strong>${n}</strong></div>`,
      )
      .join(
        "",
      )}</div><div class="split section"><div class="card"><h2>Movimentações atuais</h2>${loanCards(active)}</div><div class="card"><h2>Próximos agendamentos</h2>${
      state.appointments
        .filter(
          (a) =>
            a.date >= localToday() &&
            !["CANCELADO", "CONCLUIDO"].includes(a.status),
        )
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .slice(0, 5)
        .map(
          (a) =>
            `<div class="timeline item"><b>${date(a.date)} • ${h(a.time)}</b><p>${h(a.teacher_name)} • ${h(a.class_name)}</p>${status(a.status)}</div>`,
        )
        .join("") || empty("Não há aulas agendadas.")
    }</div></div>`
  );
}
function appointments() {
  return (
    hero(
      "Agendamentos",
      "Pedidos de até 25 dispositivos, entre hoje e os próximos 14 dias.",
      button("＋ Novo agendamento", "data-new-appointment", "primary"),
    ) +
    `<div class="card">${table(
      [
        "Data / hora",
        "Professor",
        "Turma",
        "Dispositivos",
        "Situação",
        "Ações",
      ],
      state.appointments.map(
        (a) =>
          `<tr><td>${date(a.date)} • ${h(a.time)}</td><td>${h(a.teacher_name)}</td><td>${h(a.class_name)}</td><td>${a.quantity} ${h(labels[a.type])}${a.extras ? ` + ${a.extras} extras` : ""}</td><td>${status(a.status)}</td><td><div class="toolbar">${["PENDENTE", "APROVADO"].includes(a.status) ? button("Editar", `data-edit-appointment="${a.id}"`) + button("Cancelar", `data-cancel="${a.id}"`, "danger") : ""}${staff() && a.status === "PENDENTE" ? button("Aprovar", `data-approve="${a.id}"`, "success") : ""}${staff() && a.status === "APROVADO" ? button("Liberar", `data-release="${a.id}"`, "primary") : ""}</div></td></tr>`,
      ),
    )}</div>`
  );
}
function appointmentModal(existing) {
  if (state.user.blocked)
    return toast("Assine o relatório pendente antes de criar pedidos.");
  const a = existing || {
    date: localToday(),
    time: "08:50",
    class_name: "",
    type: "TABLET",
    quantity: 25,
  };
  const end = new Date(`${localToday()}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 14);
  modal(
    `<h3>${existing ? "Editar" : "Novo"} agendamento</h3><form id="appointmentForm"><div class="form-grid">${
      staff() && !existing
        ? field(
            "Professor",
            `<select name="teacher_id" required><option value="">Selecione</option>${state.users
              .filter((u) => u.active && u.role === "PROFESSOR")
              .map((u) => `<option value="${u.id}">${h(u.name)}</option>`)
              .join("")}</select>`,
          )
        : ""
    }${field("Data", `<input type="date" name="date" min="${localToday()}" max="${end.toISOString().slice(0, 10)}" value="${a.date}" required>`)}${field("Horário", `<input name="time" type="time" value="${h(a.time)}" required>`)}${field("Turma", `<input name="class_name" value="${h(a.class_name)}" maxlength="200" required>`)}${field("Tipo", `<select name="type">${options(["TABLET", "NOTEBOOK", "CHROMEBOOK"], a.type)}</select>`)}${field("Quantidade", `<input name="quantity" type="number" min="1" max="25" value="${a.quantity}" required>`)}</div><p class="muted">Ao editar, o pedido volta para aprovação e o pedido de extras é reiniciado.</p><button class="btn primary">Salvar agendamento</button></form>`,
    true,
  );
  $("#appointmentForm").onsubmit = action(async (e) => {
    const body = formValue(e.currentTarget);
    body.quantity = Number(body.quantity);
    await api(existing ? `/appointments/${a.id}` : "/appointments", {
      method: existing ? "PATCH" : "POST",
      body,
    });
    closeModal();
    await refresh();
    toast("Agendamento salvo.");
  });
}
function release() {
  const a = state.appointments.find((a) => a.id === state.appointment),
    l = state.loans.find((l) => l.id === state.extraLoan);
  const selectedAppointment = l
    ? state.appointments.find((a) => a.id === l.appointment_id)
    : a;
  const eligible = state.devices.filter(
    (d) =>
      !d.in_use &&
      !["QUEBRADO", "EM_MANUTENCAO"].includes(d.status) &&
      (!selectedAppointment || d.type === selectedAppointment.type),
  );
  const needed = l ? selectedAppointment?.extras : a?.quantity;
  return (
    hero(
      l ? "Liberar dispositivos extras" : "Liberar dispositivos",
      "Selecione um agendamento aprovado e leia os QR Codes dos equipamentos.",
    ) +
    `<div class="card">${
      l
        ? `<div class="notice">Extras para ${h(l.teacher.name)} • ${h(l.class_name)} — ${needed} aparelhos</div>`
        : field(
            "Agendamento aprovado",
            `<select id="releaseAppointment"><option value="">Selecione</option>${state.appointments
              .filter((a) => a.status === "APROVADO")
              .map(
                (a) =>
                  `<option value="${a.id}" ${a.id === state.appointment ? "selected" : ""}>${date(a.date)} ${h(a.time)} • ${h(a.teacher_name)} • ${h(a.class_name)} • ${a.quantity} ${labels[a.type]}</option>`,
              )
              .join("")}</select>`,
          )
    }<div class="toolbar section">${field("QR Code / patrimônio", '<input id="qrInput" placeholder="Leia ou digite o código">')}${button("Adicionar código", 'id="addCode"', "primary")}${button("📷 Abrir câmera", 'id="scan"')}${button(`Liberar ${state.selection.size}${needed ? ` / ${needed}` : ""} dispositivos`, 'id="releaseDevices"', "success")}</div></div><div class="card section"><h2>Equipamentos disponíveis</h2>${table(
      ["Selecionar", "Patrimônio", "Tipo", "Estado"],
      eligible.map(
        (d) =>
          `<tr><td><input type="checkbox" aria-label="Selecionar ${h(d.number)}" data-device="${d.id}" ${state.selection.has(d.id) ? "checked" : ""}></td><td>${h(d.number)}</td><td>${h(labels[d.type])}</td><td>${status(d.status)}</td></tr>`,
      ),
    )}</div>`
  );
}
function addCode(code) {
  const a =
    state.appointments.find((a) => a.id === state.appointment) ||
    state.appointments.find(
      (a) =>
        a.id ===
        state.loans.find((l) => l.id === state.extraLoan)?.appointment_id,
    );
  if (!a) return toast("Selecione um agendamento primeiro.");
  const d = state.devices.find(
    (d) => d.qr === code.trim() || d.number === code.trim(),
  );
  if (!d) return toast("Código não cadastrado no inventário.");
  if (
    d.in_use ||
    ["QUEBRADO", "EM_MANUTENCAO"].includes(d.status) ||
    d.type !== a.type
  )
    return toast("Dispositivo indisponível ou de tipo incompatível.");
  state.selection.add(d.id);
  render();
  toast(`${d.number} selecionado.`);
}
function inventory() {
  return (
    hero(
      "Inventário",
      "Cadastre equipamentos e acompanhe seu estado de conservação.",
      button("＋ Cadastrar dispositivo", 'id="newDevice"', "primary"),
    ) +
    `<div class="card">${field("Buscar por patrimônio ou QR", '<input id="inventorySearch" placeholder="Digite para filtrar">')}<div class="section" id="deviceList">${inventoryTable(state.devices)}</div></div>`
  );
}
function inventoryTable(devices) {
  return table(
    ["Patrimônio / QR", "Tipo", "Estado", "Disponibilidade", "Ações"],
    devices.map(
      (d) =>
        `<tr><td><b>${h(d.number)}</b><br><small>${h(d.qr)}</small></td><td>${h(labels[d.type])}</td><td>${status(d.status)}</td><td>${d.in_use ? "Em uso" : "No inventário"}</td><td><div class="toolbar">${button("QR", `data-qr="${d.id}"`)}${button("Editar estado", `data-edit-device="${d.id}"`)}${button("Excluir", `data-delete-device="${d.id}"`, "danger")}</div></td></tr>`,
    ),
  );
}
function deviceModal(d) {
  modal(
    `<h3>${d ? "Editar estado" : "Cadastrar dispositivo"}</h3><form id="deviceForm"><div class="form-grid">${!d ? field("Patrimônio", '<input name="number" maxlength="200" required>') + field("Código QR", '<input name="qr" maxlength="200" required>') + field("Tipo", `<select name="type">${options(["TABLET", "NOTEBOOK", "CHROMEBOOK"], "TABLET")}</select>`) : `<p><b>${h(d.number)}</b></p>`}${field("Estado", `<select name="status">${options(["BOM_ESTADO", "CONSERVADO", "EM_MANUTENCAO", "QUEBRADO"], d?.status || "BOM_ESTADO")}</select>`)}</div>${field("Observações", `<textarea name="notes" maxlength="2000">${h(d?.notes || "")}</textarea>`)}<button class="btn primary section">Salvar dispositivo</button></form>`,
    true,
  );
  $("#deviceForm").onsubmit = action(async (e) => {
    await api(d ? `/devices/${d.id}` : "/devices", {
      method: d ? "PATCH" : "POST",
      body: formValue(e.currentTarget),
    });
    await refresh();
    toast("Dispositivo salvo.");
  });
}
function loanCards(list) {
  return (
    list
      .map(
        (l) =>
          `<div class="loan-card"><div class="section-head"><b>${h(l.class_name)} • ${h(l.teacher.name)}</b>${status(l.status)}</div><p class="muted">${l.items.length} dispositivos • saída ${fmt(l.departed_at)}</p>${button(l.status === "AGUARDANDO_ASSINATURAS" ? "Ver relatório" : "Abrir movimentação", `data-loan="${l.id}"`, "primary")}</div>`,
      )
      .join("") || empty("Nenhuma movimentação neste momento.")
  );
}
function loans() {
  return (
    hero(
      staff() ? "Movimentações e retorno" : "Meus dispositivos",
      "Associação de alunos, pedidos extras, devolução e conferência.",
    ) +
    `<div class="card">${loanCards(state.loans.filter((l) => l.status !== "CONCLUIDA"))}</div>`
  );
}
function loanModal(l) {
  if (["AGUARDANDO_ASSINATURAS", "CONCLUIDA"].includes(l.status))
    return reportModal(l);
  const teacher = state.user.id === l.teacher_id;
  const a = state.appointments.find((a) => a.id === l.appointment_id);
  modal(
    `<h3>${h(l.class_name)} • ${h(l.teacher.name)}</h3>${status(l.status)}<p>Saída: ${fmt(l.departed_at)}</p>${l.report ? `<div class="notice"><b>Relato do professor</b><p>${h(l.report)}</p></div>` : ""}<form id="loanForm">${table(
      [
        "Dispositivo",
        "Aluno",
        "Saída",
        ...(staff() && l.status === "AGUARDANDO_DEVOLUCAO"
          ? ["Retorno", "Comentário TI"]
          : []),
      ],
      l.items.map(
        (i) =>
          `<tr><td>${h(i.number)}</td><td>${teacher && l.status === "EM_USO" ? `<input class="student-input" data-item="${i.id}" value="${h(i.student)}" maxlength="200" aria-label="Aluno do dispositivo ${h(i.number)}">` : h(i.student || "Não informado")}</td><td>${status(i.departure_status)}</td>${staff() && l.status === "AGUARDANDO_DEVOLUCAO" ? `<td><select data-return="${i.id}" aria-label="Estado de ${h(i.number)}">${options(["BOM_ESTADO", "CONSERVADO", "EM_MANUTENCAO", "QUEBRADO"], i.departure_status)}</select></td><td><input data-comment="${i.id}" maxlength="2000" placeholder="Obrigatório se alterar o estado" aria-label="Comentário sobre ${h(i.number)}"></td>` : ""}</tr>`,
      ),
    )}${teacher && l.status === "EM_USO" ? `${field("Relato da utilização e devolução", '<textarea id="returnReport" rows="4" minlength="5" maxlength="4000" placeholder="Relate a utilização e qualquer ocorrência."></textarea>')}<div class="toolbar section">${button("Salvar associações", 'id="saveStudents" type="button"', "primary")}${button("Solicitar extras", 'id="requestExtras" type="button"')}${button("Enviar devolução", 'id="submitReturn" type="button"', "success")}</div>` : ""}${staff() && l.status === "AGUARDANDO_DEVOLUCAO" ? `<p class="muted">Confira fisicamente todos os itens antes de concluir.</p>${button("Concluir conferência", 'id="checkReturn" type="button"', "success")}` : ""}</form>${staff() && l.status === "EM_USO" && a?.extras && l.items.length === a.quantity ? `<div class="notice">Pedido extra: ${a.extras} dispositivos. ${button("Liberar extras", `id="releaseExtras"`)}</div>` : ""}`,
    true,
  );
  const students = () =>
    $$("[data-item]").map((input) => ({
      id: input.dataset.item,
      student: input.value,
    }));
  if ($("#saveStudents"))
    $("#saveStudents").onclick = action(async () => {
      await api(`/loans/${l.id}/students`, {
        method: "PATCH",
        body: { items: students() },
      });
      toast("Associações salvas.");
    });
  if ($("#submitReturn"))
    $("#submitReturn").onclick = action(async () => {
      const report = $("#returnReport").value;
      if (report.trim().length < 5)
        return toast("Preencha o relato de devolução.");
      if (students().some((i) => !i.student.trim()))
        return toast("Associe todos os alunos antes de devolver.");
      await api(`/loans/${l.id}/students`, {
        method: "PATCH",
        body: { items: students() },
      });
      await api(`/loans/${l.id}/return`, { method: "POST", body: { report } });
      await refresh();
      toast("Devolução enviada para conferência.");
    });
  if ($("#requestExtras"))
    $("#requestExtras").onclick = () => {
      modal(
        `<h3>Solicitar dispositivos extras</h3><p>Um único pedido de até 5 aparelhos por aula.</p><form id="extraForm">${field("Quantidade", '<input name="quantity" type="number" min="1" max="5" value="1" required>')}<button class="btn primary section">Enviar pedido</button></form>`,
      );
      $("#extraForm").onsubmit = action(async (e) => {
        await api(`/loans/${l.id}/extras`, {
          method: "POST",
          body: { quantity: Number(formValue(e.currentTarget).quantity) },
        });
        await refresh();
        toast("Pedido enviado ao TI.");
      });
    };
  if ($("#releaseExtras"))
    $("#releaseExtras").onclick = () => {
      state.extraLoan = l.id;
      state.appointment = null;
      state.selection.clear();
      state.page = "release";
      render();
    };
  if ($("#checkReturn"))
    $("#checkReturn").onclick = action(async () => {
      const items = l.items.map((i) => ({
        id: i.id,
        status: $(`[data-return="${i.id}"]`).value,
        comment: $(`[data-comment="${i.id}"]`).value,
      }));
      await api(`/loans/${l.id}/check`, { method: "POST", body: { items } });
      await refresh();
      toast("Conferência concluída. O relatório aguarda as assinaturas.");
    });
}
function reports() {
  return (
    hero(
      "Relatórios e assinaturas",
      "Confira os dados antes de assinar. Cada usuário registra apenas a própria assinatura.",
    ) +
    `<div class="card">${loanCards(state.loans.filter((l) => ["AGUARDANDO_ASSINATURAS", "CONCLUIDA"].includes(l.status)))}</div>`
  );
}
function history() {
  return (
    hero(
      "Histórico",
      "Consulte as movimentações e imprima os relatórios concluídos.",
    ) +
    `<div class="card">${field("Buscar professor ou turma", '<input id="historySearch" placeholder="Digite para filtrar">')}<div class="section" id="historyList">${historyTable(state.loans.filter((l) => l.status === "CONCLUIDA"))}</div></div>`
  );
}
function historyTable(list) {
  return table(
    ["Saída", "Professor", "Turma", "Itens", "Relatório"],
    list.map(
      (l) =>
        `<tr><td>${fmt(l.departed_at)}</td><td>${h(l.teacher.name)}</td><td>${h(l.class_name)}</td><td>${l.items.length}</td><td>${button("Visualizar / PDF", `data-loan="${l.id}"`)}</td></tr>`,
    ),
  );
}
function reportModal(l) {
  const ownType = state.user.id === l.teacher_id ? "PROFESSOR" : "TI";
  const canSign =
    l.status === "AGUARDANDO_ASSINATURAS" &&
    (ownType === "PROFESSOR" || staff()) &&
    !l.signatures.some((s) => s.type === ownType);
  modal(
    `<div id="reportDocument" class="report-preview"><div class="report-title"><h2>APP Monitor • Relatório de empréstimo</h2><small>Registro ${h(l.id)}</small></div><div class="report-meta"><div><b>Professor:</b> ${h(l.teacher.name)}</div><div><b>Turma:</b> ${h(l.class_name)}</div><div><b>TI da liberação:</b> ${h(l.ti.name)}</div><div><b>Situação:</b> ${h(labels[l.status])}</div><div><b>Saída:</b> ${fmt(l.departed_at)}</div><div><b>Retorno conferido:</b> ${fmt(l.returned_at)}</div></div>${table(
      ["Dispositivo", "Aluno", "Saída", "Retorno", "Comentário TI"],
      l.items.map(
        (i) =>
          `<tr><td>${h(i.number)}</td><td>${h(i.student)}</td><td>${h(labels[i.departure_status])}</td><td>${h(labels[i.return_status] || "—")}</td><td class="wrap-cell">${h(i.ti_comment)}</td></tr>`,
      ),
    )}<h3>Relato do professor</h3><p class="wrap-cell">${h(l.report)}</p><div class="signature-grid">${[
      "PROFESSOR",
      "TI",
    ]
      .map((type) => {
        const s = l.signatures.find((s) => s.type === type);
        return `<div class="signature-card"><b>Assinatura ${labels[type]}</b>${s ? `<img class="signature-image" src="${h(s.image)}" alt="Assinatura ${labels[type]}"><small>${h(s.name)} • ${fmt(s.signed_at)}</small>` : '<p class="muted">Pendente</p>'}</div>`;
      })
      .join(
        "",
      )}</div><p class="muted">Assinaturas manuscritas registradas por contas autenticadas; não equivalem a assinatura certificada ICP-Brasil.</p></div>${canSign ? `<div class="section"><h3>Sua assinatura • ${h(labels[ownType])}</h3><canvas id="signature" class="signature-pad" aria-label="Desenhe sua assinatura"></canvas><div class="toolbar">${button("Limpar", 'id="clearSignature"')}${button("Confirmar minha assinatura", 'id="signReport"', "success")}</div></div>` : ""}<div class="toolbar section">${button("Imprimir / salvar PDF", 'id="printReport"')}</div>`,
    true,
  );
  $("#printReport").onclick = () => window.print();
  if (canSign) {
    const c = $("#signature"),
      ratio = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    c.width = Math.round(r.width * ratio);
    c.height = Math.round(r.height * ratio);
    const ctx = c.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    let drawing = false,
      signed = false;
    const pos = (e) => {
      const rect = c.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };
    c.onpointerdown = (e) => {
      drawing = true;
      c.setPointerCapture(e.pointerId);
      ctx.beginPath();
      ctx.moveTo(...pos(e));
    };
    c.onpointermove = (e) => {
      if (!drawing) return;
      ctx.lineTo(...pos(e));
      ctx.stroke();
      signed = true;
    };
    c.onpointerup = c.onpointercancel = () => (drawing = false);
    $("#clearSignature").onclick = () => {
      ctx.clearRect(0, 0, c.width / ratio, c.height / ratio);
      signed = false;
    };
    $("#signReport").onclick = action(async () => {
      if (!signed) return toast("Desenhe sua assinatura antes de confirmar.");
      await api(`/loans/${l.id}/sign`, {
        method: "POST",
        body: { image: c.toDataURL("image/png") },
      });
      await refresh();
      toast("Assinatura registrada.");
    });
  }
}
function users() {
  return (
    hero(
      "Usuários",
      "O administrador cadastra professores, equipe de TI e outros administradores.",
      button("＋ Novo usuário", 'id="newUser"', "primary"),
    ) +
    `<div class="card">${table(
      ["Nome", "E-mail", "Perfil", "Situação", "Ação"],
      state.users.map(
        (u) =>
          `<tr><td>${h(u.name)}</td><td>${h(u.email)}</td><td>${labels[u.role]}</td><td>${u.active ? "Ativo" : "Inativo"}</td><td>${u.id !== state.user.id ? button(u.active ? "Desativar" : "Reativar", `data-user="${u.id}"`, u.active ? "danger" : "success") + " " + button("Redefinir senha", `data-reset-password="${u.id}"`) : ""}</td></tr>`,
      ),
    )}</div>`
  );
}
function auditPage() {
  return (
    hero("Auditoria", "Últimas 200 ações registradas pelo servidor.") +
    `<div class="card">${table(
      ["Data", "Usuário", "Ação", "Registro"],
      state.audit.map(
        (a) =>
          `<tr><td>${fmt(a.created_at)}</td><td>${h(a.name || "—")}</td><td>${h(a.action)}</td><td>${h(a.entity_id)}</td></tr>`,
      ),
    )}</div>`
  );
}
async function scan() {
  const appGeneration = generation;
  modal(
    `<h3>Ler QR Code</h3><p>Aponte a câmera para o código. Em produção, a câmera exige HTTPS.</p><div class="camera-box"><video id="cameraVideo" autoplay playsinline></video></div><p id="cameraStatus" role="status">Abrindo câmera…</p>${field("Leitor USB / entrada manual", '<input id="manualCode" placeholder="Código QR ou patrimônio">')}${button("Adicionar", 'id="manualAdd"', "primary")}`,
    true,
  );
  $("#manualAdd").onclick = () => addCode($("#manualCode").value);
  $("#manualCode").onkeydown = (e) => {
    if (e.key === "Enter") $("#manualAdd").click();
  };
  try {
    if (!window.ZXingBrowser)
      throw Error("Biblioteca de câmera indisponível. Use a entrada manual.");
    const reader = new ZXingBrowser.BrowserQRCodeReader();
    scannerReader = reader;
    const video = $("#cameraVideo");
    const controls = await reader.decodeFromConstraints(
      { video: { facingMode: "environment" } },
      video,
      (result, _error, controls) => {
        if (result) {
          controls.stop();
          addCode(result.getText());
        }
      },
    );
    if (
      !video.isConnected ||
      scannerReader !== reader ||
      generation !== appGeneration
    ) {
      controls.stop();
      return;
    }
    scannerControls = controls;
    $("#cameraStatus").textContent = "Câmera ativa. Aponte para um QR Code.";
  } catch {
    if ($("#cameraStatus"))
      $("#cameraStatus").textContent =
        "Câmera indisponível. Autorize a câmera em HTTPS ou use um leitor USB / entrada manual.";
  }
}
async function notifications() {
  modal(
    `<h3>Notificações</h3><p class="muted">Visualizar remove o alerta; concluir arquiva a notificação.</p>${
      state.notifications
        .filter((n) => n.status !== "CONCLUIDA")
        .map(
          (n) =>
            `<div class="loan-card"><b>${h(n.title)}</b><p>${h(n.message)}</p><div class="toolbar">${button("Abrir", `data-notification="${n.id}"`)}${button("Concluir", `data-complete-notification="${n.id}"`)}</div></div>`,
        )
        .join("") || empty()
    }`,
  );
  $$("[data-notification]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        const n = state.notifications.find(
          (n) => n.id === b.dataset.notification,
        );
        await api(`/notifications/${n.id}`, {
          method: "PATCH",
          body: { status: "VISUALIZADA" },
        });
        state.page = n.page;
        await refresh();
        if (n.entity_id) {
          const l = state.loans.find((l) => l.id === n.entity_id);
          if (l) loanModal(l);
        }
      })),
  );
  $$("[data-complete-notification]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        await api(`/notifications/${b.dataset.completeNotification}`, {
          method: "PATCH",
          body: { status: "CONCLUIDA" },
        });
        await refresh();
        notifications();
      })),
  );
}
function bindTables() {
  $$("[data-loan]").forEach(
    (b) =>
      (b.onclick = () =>
        loanModal(state.loans.find((l) => l.id === b.dataset.loan))),
  );
  $$("[data-edit-device]").forEach(
    (b) =>
      (b.onclick = () =>
        deviceModal(state.devices.find((d) => d.id === b.dataset.editDevice))),
  );
  $$("[data-delete-device]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        if (
          !confirm(
            "Excluir este dispositivo do inventário? O histórico será preservado.",
          )
        )
          return;
        await api(`/devices/${b.dataset.deleteDevice}`, { method: "DELETE" });
        await refresh();
        toast("Dispositivo excluído do inventário.");
      })),
  );
  $$("[data-qr]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        const d = state.devices.find((d) => d.id === b.dataset.qr);
        const { image: url } = await api(`/devices/${d.id}/qr`);
        modal(
          `<h3>Etiqueta de patrimônio</h3><div id="reportDocument" class="qr-label"><h2>APP Monitor</h2><img src="${url}" alt="QR Code do dispositivo ${h(d.number)}"><h3>${h(d.number)}</h3><p>${h(d.qr)}</p></div>${button("Imprimir etiqueta", 'id="printLabel"')}`,
        );
        $("#printLabel").onclick = () => window.print();
      })),
  );
}
function bind() {
  $$("[data-page]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        state.page = b.dataset.page;
        state.extraLoan = null;
        if (state.page === "audit") state.audit = await api("/audit");
        await refresh();
      })),
  );
  $("#theme").onclick = theme;
  $("#notifications").onclick = notifications;
  $("#logout").onclick = action(async () => {
    await api("/logout", { method: "POST" });
    generation++;
    state.user = null;
    state.selection.clear();
    login();
  });
  $("#account").onclick = () => {
    modal(
      `<h3>Alterar senha</h3><form id="passwordForm">${field("Senha atual", '<input name="current" type="password" autocomplete="current-password" required>')}${field("Nova senha (mínimo 12 caracteres)", '<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required>')}<button class="btn primary section">Salvar senha</button></form>`,
    );
    if (authConfig.govbr && state.user.role === "PROFESSOR") {
      $("#modal .modal").insertAdjacentHTML(
        "beforeend",
        state.user.govbrLinked
          ? '<div class="notice">Sua conta GOV.BR já está vinculada.</div>'
          : '<div class="notice"><h3>Vincular GOV.BR</h3><p>Confirme sua identidade no GOV.BR para usar esse método de entrada nesta conta da escola.</p><a href="/auth/govbr/link" class="btn primary govbr-login">Vincular minha conta GOV.BR</a></div>',
      );
    }
    $("#passwordForm").onsubmit = action(async (e) => {
      await api("/password", {
        method: "POST",
        body: formValue(e.currentTarget),
      });
      closeModal();
      toast("Senha alterada. Outras sessões foram encerradas.");
    });
  };
  $$("[data-new-appointment]").forEach(
    (b) => (b.onclick = () => appointmentModal()),
  );
  $$("[data-edit-appointment]").forEach(
    (b) =>
      (b.onclick = () =>
        appointmentModal(
          state.appointments.find((a) => a.id === b.dataset.editAppointment),
        )),
  );
  $$("[data-approve]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        await api(`/appointments/${b.dataset.approve}/approve`, {
          method: "POST",
        });
        await refresh();
        toast("Pedido aprovado.");
      })),
  );
  $$("[data-cancel]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        if (!confirm("Cancelar este agendamento?")) return;
        await api(`/appointments/${b.dataset.cancel}/cancel`, {
          method: "POST",
        });
        await refresh();
        toast("Pedido cancelado.");
      })),
  );
  $$("[data-release]").forEach(
    (b) =>
      (b.onclick = () => {
        state.appointment = b.dataset.release;
        state.extraLoan = null;
        state.selection.clear();
        state.page = "release";
        render();
      }),
  );
  if ($("#releaseAppointment"))
    $("#releaseAppointment").onchange = (e) => {
      state.appointment = e.target.value;
      state.selection.clear();
      render();
    };
  $$("[data-device]").forEach(
    (input) =>
      (input.onchange = () => {
        input.checked
          ? state.selection.add(input.dataset.device)
          : state.selection.delete(input.dataset.device);
        $("#releaseDevices").textContent =
          `Liberar ${state.selection.size} dispositivos`;
      }),
  );
  if ($("#addCode")) $("#addCode").onclick = () => addCode($("#qrInput").value);
  if ($("#qrInput"))
    $("#qrInput").onkeydown = (e) => {
      if (e.key === "Enter") addCode(e.target.value);
    };
  if ($("#scan")) $("#scan").onclick = scan;
  if ($("#releaseDevices"))
    $("#releaseDevices").onclick = action(async () => {
      const extras = state.extraLoan;
      if (!extras && !state.appointment)
        return toast("Selecione um agendamento.");
      await api(extras ? `/loans/${extras}/extras/release` : "/loans", {
        method: "POST",
        body: extras
          ? { device_ids: [...state.selection] }
          : {
              appointment_id: state.appointment,
              device_ids: [...state.selection],
            },
      });
      state.selection.clear();
      state.extraLoan = null;
      state.appointment = null;
      state.page = "loans";
      await refresh();
      toast("Dispositivos liberados.");
    });
  if ($("#newDevice")) $("#newDevice").onclick = () => deviceModal();
  if ($("#inventorySearch"))
    $("#inventorySearch").oninput = (e) => {
      const q = e.target.value.toLowerCase();
      $("#deviceList").innerHTML = inventoryTable(
        state.devices.filter((d) =>
          `${d.number} ${d.qr}`.toLowerCase().includes(q),
        ),
      );
      bindTables();
    };
  if ($("#historySearch"))
    $("#historySearch").oninput = (e) => {
      const q = e.target.value.toLowerCase();
      $("#historyList").innerHTML = historyTable(
        state.loans.filter(
          (l) =>
            l.status === "CONCLUIDA" &&
            `${l.teacher.name} ${l.class_name}`.toLowerCase().includes(q),
        ),
      );
      bindTables();
    };
  if ($("#newUser"))
    $("#newUser").onclick = () => {
      modal(
        `<h3>Cadastrar usuário</h3><form id="userForm"><div class="login-actions">${field("Nome", '<input name="name" maxlength="200" required>')}${field("E-mail", '<input name="email" type="email" required>')}${field("Perfil", `<select name="role">${options(["PROFESSOR", "TI", "ADMINISTRADOR"], "PROFESSOR")}</select>`)}${field("Senha provisória (opcional, mínimo 12 caracteres)", '<input name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password" placeholder="Deixe vazio para gerar automaticamente">')}<button class="btn primary">Cadastrar</button></div></form>`,
      );
      $("#userForm").onsubmit = action(async (e) => {
        const body = formValue(e.currentTarget);
        if (!body.password) delete body.password;
        const user = await api("/users", { method: "POST", body });
        await refresh();
        temporaryPasswordModal(user, user.temporaryPassword);
        toast("Usuário cadastrado.");
      });
    };
  $$("[data-user]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        const u = state.users.find((u) => u.id === b.dataset.user);
        if (!confirm(`${u.active ? "Desativar" : "Reativar"} ${u.name}?`))
          return;
        await api(`/users/${u.id}`, {
          method: "PATCH",
          body: { active: !u.active },
        });
        await refresh();
      })),
  );
  $$("[data-reset-password]").forEach(
    (b) =>
      (b.onclick = action(async () => {
        const user = state.users.find((u) => u.id === b.dataset.resetPassword);
        if (
          !confirm(
            `Gerar uma nova senha provisória para ${user.name}? As sessões atuais serão encerradas.`,
          )
        )
          return;
        const result = await api(`/users/${user.id}/password`, {
          method: "POST",
          body: {},
        });
        await refresh();
        temporaryPasswordModal(user, result.temporaryPassword);
      })),
  );
  bindTables();
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});
window.addEventListener("pagehide", stopScanner);
(async () => {
  try {
    authConfig = await api("/auth/config");
    state.user = await api("/me");
    await refresh();
  } catch (error) {
    login();
    if (!error.message.includes("Entre na sua conta")) toast(error.message);
  }
  const params = new URLSearchParams(location.search);
  const messages = {
    govbr_unavailable:
      "GOV.BR indisponível ou configuração ainda não validada.",
    govbr_invalid_flow:
      "Esta tentativa expirou ou não pertence a este navegador. Tente novamente.",
    govbr_cancelled: "Entrada pelo GOV.BR cancelada.",
    govbr_not_linked:
      "Entre com a conta da escola e vincule GOV.BR em Conta antes de usar esse login.",
    govbr_account_disabled:
      "A conta da escola está inativa ou sua sessão expirou.",
    govbr_already_linked:
      "Esta identidade GOV.BR já está vinculada a outra conta, ou a conta já possui outro vínculo.",
    govbr_invalid_response:
      "Não foi possível validar a resposta do GOV.BR. Tente novamente.",
  };
  if (Object.hasOwn(messages, params.get("auth_error")))
    toast(messages[params.get("auth_error")]);
  if (params.get("auth_success") === "govbr_linked")
    toast("Sua conta GOV.BR foi vinculada.");
  if (params.has("auth_error") || params.has("auth_success"))
    window.history.replaceState(null, "", location.pathname);
})();
