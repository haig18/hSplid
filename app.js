// ============================================================
// Cuaderno de Gastos — lógica principal (v2: multi-usuario / multi-grupo)
// ============================================================
const { createClient } = supabase;
const sb = createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

const state = {
  session: null,
  groups: [],              // membresías del usuario, para la pantalla de grupos
  currentGroupId: null,
  currentGroup: null,
  myMemberId: null,
  participants: [],         // miembros del grupo actual: {id, name, color}
  categories: [],
  expenses: [],              // cada uno con .splits = [{participant_id, amount}]
  settlements: [],
  settleFrom: null,
  settleTo: null,
  filters: {
    search: "",
    categories: new Set(),
    participants: new Set(),
    dateFrom: "",
    dateTo: "",
  },
  activeTab: "dashboard",
  splitMode: "equal",  // 'equal' | 'custom'
  editingExpenseId: null,
};

const fmt = (n) => (Number(n) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const byId = (id) => document.getElementById(id);

// ------------------------------------------------------------
// Pantallas
// ------------------------------------------------------------
function showScreen(name) {
  // name: 'auth' | 'groups' | 'app'
  byId("authScreen").classList.toggle("hidden", name !== "auth");
  byId("groupsScreen").classList.toggle("hidden", name !== "groups");
  byId("app").classList.toggle("hidden", name !== "app");
}

// ------------------------------------------------------------
// Autenticación
// ------------------------------------------------------------
let authMode = "login";

function renderAuthMode() {
  byId("authTitle").textContent = authMode === "login" ? "Iniciar sesión" : "Crear cuenta";
  byId("authSubmitBtn").textContent = authMode === "login" ? "Entrar" : "Crear cuenta";
  byId("authToggleMode").textContent = authMode === "login" ? "¿No tienes cuenta? Crea una" : "¿Ya tienes cuenta? Inicia sesión";
  byId("authError").classList.add("hidden");
  byId("authInfo").classList.add("hidden");
}
byId("authToggleMode").onclick = (e) => {
  e.preventDefault();
  authMode = authMode === "login" ? "signup" : "login";
  renderAuthMode();
};

function showAuthError(msg) {
  const el = byId("authError");
  el.textContent = msg;
  el.classList.remove("hidden");
}

byId("authSubmitBtn").onclick = async () => {
  const email = byId("authEmail").value.trim();
  const password = byId("authPassword").value;
  byId("authError").classList.add("hidden");
  if (!email || !password) return showAuthError("Rellena email y contraseña");

  if (authMode === "signup") {
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) return showAuthError(error.message);
    if (data.session) {
      showScreen("groups");
      await loadGroupsScreen();
    } else {
      byId("authInfo").textContent = "Cuenta creada. Revisa tu correo para confirmarla y luego inicia sesión.";
      byId("authInfo").classList.remove("hidden");
    }
  } else {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return showAuthError(error.message === "Invalid login credentials" ? "Email o contraseña incorrectos" : error.message);
    showScreen("groups");
    await loadGroupsScreen();
  }
};

byId("authForgotBtn").onclick = async (e) => {
  e.preventDefault();
  const email = byId("authEmail").value.trim();
  if (!email) return showAuthError("Escribe tu email arriba primero");
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
  if (error) return showAuthError(error.message);
  byId("authInfo").textContent = "Te hemos enviado un correo para restablecer la contraseña.";
  byId("authInfo").classList.remove("hidden");
  byId("authError").classList.add("hidden");
};

byId("logoutBtn").onclick = async () => {
  await sb.auth.signOut();
  state.session = null;
  showScreen("auth");
};

// ------------------------------------------------------------
// Pantalla de grupos
// ------------------------------------------------------------
async function fetchGroupBalance(gid, memberId) {
  const [{ data: expenses }, { data: splits }, { data: settlements }] = await Promise.all([
    sb.from("expenses").select("amount, paid_by").eq("group_id", gid),
    sb.from("expense_splits").select("member_id, amount, expenses!inner(group_id)").eq("expenses.group_id", gid),
    sb.from("settlements").select("from_member, to_member, amount").eq("group_id", gid),
  ]);
  let bal = 0;
  (expenses || []).forEach((ex) => { if (ex.paid_by === memberId) bal += Number(ex.amount); });
  (splits || []).forEach((s) => { if (s.member_id === memberId) bal -= Number(s.amount); });
  (settlements || []).forEach((s) => {
    if (s.from_member === memberId) bal += Number(s.amount);
    if (s.to_member === memberId) bal -= Number(s.amount);
  });
  return bal;
}

async function loadGroupsScreen() {
  byId("userEmail").textContent = state.session.user.email;
  const { data: memberships, error } = await sb
    .from("group_members")
    .select("id, group_id, display_name, groups(id, name, icon, join_code)")
    .eq("user_id", state.session.user.id);
  if (error) {
    console.error(error);
    showToast("Error cargando tus grupos");
    return;
  }
  state.groups = memberships || [];
  const list = byId("groupsList");
  list.innerHTML = "";
  byId("groupsEmpty").classList.toggle("hidden", state.groups.length > 0);

  for (const m of state.groups) {
    if (!m.groups) continue;
    const bal = await fetchGroupBalance(m.group_id, m.id);
    const cls = bal > 0.005 ? "credit" : bal < -0.005 ? "debit" : "";
    const label = bal > 0.005 ? `Te deben ${fmt(bal)}` : bal < -0.005 ? `Debes ${fmt(-bal)}` : "En paz";
    const el = document.createElement("div");
    el.className = "expense-ticket";
    el.innerHTML = `
      <div class="expense-top">
        <div>
          <p class="expense-desc">${m.groups.icon} ${escapeHtml(m.groups.name)}</p>
          <p class="expense-meta">Tú: ${escapeHtml(m.display_name)}</p>
        </div>
        <span class="expense-amount value ${cls}">${label}</span>
      </div>`;
    el.onclick = () => openGroup(m.group_id);
    list.appendChild(el);
  }
}

function genJoinCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

byId("createGroupBtn").onclick = () => {
  byId("newGroupName").value = "";
  byId("newGroupMyName").value = "";
  byId("createGroupError").classList.add("hidden");
  byId("createGroupModal").classList.remove("hidden");
};
byId("closeCreateGroupModal").onclick = () => byId("createGroupModal").classList.add("hidden");

byId("saveCreateGroupBtn").onclick = async () => {
  const name = byId("newGroupName").value.trim();
  const myName = byId("newGroupMyName").value.trim();
  const err = byId("createGroupError");
  err.classList.add("hidden");
  if (!name || !myName) {
    err.textContent = "Rellena los dos campos";
    err.classList.remove("hidden");
    return;
  }
  const groupId = crypto.randomUUID();
  const join_code = genJoinCode();
  const { error } = await sb
    .from("groups")
    .insert({ id: groupId, name, join_code, created_by: state.session.user.id });
  if (error) {
    err.textContent = "Error al crear el grupo";
    err.classList.remove("hidden");
    return;
  }
  await sb.from("group_members").insert({ group_id: groupId, user_id: state.session.user.id, display_name: myName });
  const defaultCats = [
    ["Comida y bebida", "🍽️"], ["Alojamiento", "🛏️"], ["Transporte", "🚗"],
    ["Ocio", "🎉"], ["Compras", "🛍️"], ["Salud", "💊"], ["Otros", "🧾"],
  ];
  await sb.from("categories").insert(defaultCats.map(([n, icon]) => ({ group_id: groupId, name: n, icon })));
  byId("createGroupModal").classList.add("hidden");
  showToast("Grupo creado");
  openGroup(groupId);
};

byId("joinGroupBtn").onclick = () => {
  byId("joinGroupCode").value = "";
  byId("joinGroupMyName").value = "";
  byId("joinGroupError").classList.add("hidden");
  byId("joinGroupModal").classList.remove("hidden");
};
byId("closeJoinGroupModal").onclick = () => byId("joinGroupModal").classList.add("hidden");

byId("saveJoinGroupBtn").onclick = async () => {
  const code = byId("joinGroupCode").value.trim().toUpperCase();
  const myName = byId("joinGroupMyName").value.trim();
  const err = byId("joinGroupError");
  err.classList.add("hidden");
  if (!code || !myName) {
    err.textContent = "Rellena los dos campos";
    err.classList.remove("hidden");
    return;
  }
  const { data, error } = await sb.rpc("join_group_by_code", { code, member_name: myName });
  if (error) {
    err.textContent = "Código no válido";
    err.classList.remove("hidden");
    return;
  }
  byId("joinGroupModal").classList.add("hidden");
  showToast("Te has unido al grupo");
  openGroup(data);
};

byId("backToGroupsBtn").onclick = async () => {
  showScreen("groups");
  await loadGroupsScreen();
};

byId("copyJoinCodeBtn").onclick = () => {
  if (!state.currentGroup) return;
  navigator.clipboard.writeText(state.currentGroup.join_code).then(() => showToast("Código copiado"));
};

// ------------------------------------------------------------
// Carga de datos del grupo abierto
// ------------------------------------------------------------
async function loadAll() {
  const gid = state.currentGroupId;
  const [{ data: members, error: e1 }, { data: categories, error: e2 },
         { data: expenses, error: e3 }, { data: splits, error: e4 },
         { data: settlements, error: e5 }] = await Promise.all([
    sb.from("group_members").select("*").eq("group_id", gid).order("created_at"),
    sb.from("categories").select("*").eq("group_id", gid).order("created_at"),
    sb.from("expenses").select("*").eq("group_id", gid).order("expense_date", { ascending: false }),
    sb.from("expense_splits").select("*, expenses!inner(group_id)").eq("expenses.group_id", gid),
    sb.from("settlements").select("*").eq("group_id", gid).order("settled_date", { ascending: false }),
  ]);
  if (e1 || e2 || e3 || e4 || e5) {
    console.error(e1 || e2 || e3 || e4 || e5);
    showToast("Error cargando datos del grupo.");
    return;
  }
  state.participants = (members || []).map((m) => ({ id: m.id, name: m.display_name, color: m.color }));
  state.categories = categories || [];
  const splitsByExpense = {};
  (splits || []).forEach((s) => {
    (splitsByExpense[s.expense_id] ||= []).push({ participant_id: s.member_id, amount: s.amount });
  });
  state.expenses = (expenses || []).map((ex) => ({ ...ex, splits: splitsByExpense[ex.id] || [] }));
  state.settlements = (settlements || []).map((s) => ({
    id: s.id,
    from_participant: s.from_member,
    to_participant: s.to_member,
    amount: s.amount,
    settled_date: s.settled_date,
    note: s.note,
  }));
}

// ------------------------------------------------------------
// Filtros
// ------------------------------------------------------------
function matchesFilters(ex) {
  const f = state.filters;
  if (f.search) {
    const s = f.search.toLowerCase();
    if (!ex.description.toLowerCase().includes(s) && !(ex.notes || "").toLowerCase().includes(s)) return false;
  }
  if (f.categories.size && !f.categories.has(ex.category)) return false;
  if (f.participants.size) {
    const involved = new Set([ex.paid_by, ...ex.splits.map((s) => s.participant_id)]);
    let match = false;
    for (const p of f.participants) if (involved.has(p)) match = true;
    if (!match) return false;
  }
  if (f.dateFrom && ex.expense_date < f.dateFrom) return false;
  if (f.dateTo && ex.expense_date > f.dateTo) return false;
  return true;
}
function filteredExpenses() {
  return state.expenses.filter(matchesFilters);
}

// ------------------------------------------------------------
// Cálculo de balances y liquidación de deudas
// (sin cambios respecto a la versión anterior)
// ------------------------------------------------------------
function computeBalances(expenses) {
  const balance = {};
  state.participants.forEach((p) => (balance[p.id] = 0));
  expenses.forEach((ex) => {
    balance[ex.paid_by] = (balance[ex.paid_by] || 0) + Number(ex.amount);
    ex.splits.forEach((s) => {
      balance[s.participant_id] = (balance[s.participant_id] || 0) - Number(s.amount);
    });
  });
  return balance;
}

function simplifyDebts(balance) {
  const creditors = [];
  const debtors = [];
  Object.entries(balance).forEach(([id, amt]) => {
    const r = Math.round(amt * 100) / 100;
    if (r > 0.005) creditors.push({ id, amt: r });
    else if (r < -0.005) debtors.push({ id, amt: -r });
  });
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);
  const txs = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    txs.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt < 0.005) i++;
    if (creditors[j].amt < 0.005) j++;
  }
  return txs;
}

function participantName(id) {
  return state.participants.find((p) => p.id === id)?.name || "—";
}
function categoryIcon(name) {
  return state.categories.find((c) => c.name === name)?.icon || "🧾";
}

// ------------------------------------------------------------
// Render: filtros
// ------------------------------------------------------------
function renderFilterOptions() {
  const catBox = byId("fCategories");
  catBox.innerHTML = "";
  state.categories.forEach((c) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.filters.categories.has(c.name) ? " active" : "");
    chip.textContent = `${c.icon} ${c.name}`;
    chip.onclick = () => {
      state.filters.categories.has(c.name) ? state.filters.categories.delete(c.name) : state.filters.categories.add(c.name);
      renderAll();
    };
    catBox.appendChild(chip);
  });

  const partBox = byId("fParticipants");
  partBox.innerHTML = "";
  state.participants.forEach((p) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.filters.participants.has(p.id) ? " active" : "");
    chip.textContent = p.name;
    chip.onclick = () => {
      state.filters.participants.has(p.id) ? state.filters.participants.delete(p.id) : state.filters.participants.add(p.id);
      renderAll();
    };
    partBox.appendChild(chip);
  });

  byId("fSearch").value = state.filters.search;
  byId("fDateFrom").value = state.filters.dateFrom;
  byId("fDateTo").value = state.filters.dateTo;

  const count = state.filters.categories.size + state.filters.participants.size +
    (state.filters.search ? 1 : 0) + (state.filters.dateFrom ? 1 : 0) + (state.filters.dateTo ? 1 : 0);
  const badge = byId("filterCount");
  if (count > 0) { badge.textContent = count; badge.classList.remove("hidden"); }
  else badge.classList.add("hidden");
}

// ------------------------------------------------------------
// Render: Resumen
// ------------------------------------------------------------
function balanceWithSettlements(expenses) {
  const balance = computeBalances(expenses);
  state.settlements.forEach((s) => {
    balance[s.from_participant] = (balance[s.from_participant] || 0) + Number(s.amount);
    balance[s.to_participant] = (balance[s.to_participant] || 0) - Number(s.amount);
  });
  return balance;
}

function participantShareTotal(expenses, participantIds) {
  let total = 0;
  expenses.forEach((ex) => {
    ex.splits.forEach((s) => {
      if (participantIds.has(s.participant_id)) total += Number(s.amount);
    });
  });
  return total;
}

function renderDashboard() {
  const exs = filteredExpenses();
  const hasParticipantFilter = state.filters.participants.size > 0;
  const total = hasParticipantFilter
    ? participantShareTotal(exs, state.filters.participants)
    : exs.reduce((s, e) => s + Number(e.amount), 0);
  byId("totalAmount").textContent = fmt(total);
  byId("totalCount").textContent = `${exs.length} gasto${exs.length === 1 ? "" : "s"}`;
  const totalLabel = byId("totalLabel");
  if (totalLabel) totalLabel.textContent = hasParticipantFilter ? "Total de los participantes filtrados" : "Total del grupo (según filtros)";

  const balance = balanceWithSettlements(exs);
  const balBox = byId("balancesList");
  balBox.innerHTML = "";
  if (!state.participants.length) {
    balBox.innerHTML = `<p class="muted small">Añade miembros para ver balances.</p>`;
  } else {
    state.participants.forEach((p) => {
      const amt = balance[p.id] || 0;
      const row = document.createElement("div");
      row.className = "ledger-row";
      const cls = amt > 0.005 ? "credit" : amt < -0.005 ? "debit" : "";
      const sign = amt > 0.005 ? "+" : "";
      row.innerHTML = `<span class="label">${p.name}</span><span class="leader"></span><span class="value ${cls}">${sign}${fmt(amt)}</span>`;
      balBox.appendChild(row);
    });
  }

  const txs = simplifyDebts(balance);
  const settleBox = byId("settleList");
  settleBox.innerHTML = "";
  if (!txs.length) {
    settleBox.innerHTML = `<p class="muted small">Todo saldado 🎉</p>`;
  } else {
    txs.forEach((t) => {
      const row = document.createElement("div");
      row.className = "ledger-row clickable";
      row.innerHTML = `<span class="label">${participantName(t.from)} → ${participantName(t.to)}</span><span class="leader"></span><span class="value debit">${fmt(t.amount)}</span>`;
      row.onclick = () => openSettleModal(t.from, t.to, t.amount);
      settleBox.appendChild(row);
    });
  }

  const payBox = byId("paymentsList");
  payBox.innerHTML = "";
  if (!state.settlements.length) {
    payBox.innerHTML = `<p class="muted small">Todavía no hay pagos registrados.</p>`;
  } else {
    state.settlements.forEach((s) => {
      const d = new Date(s.settled_date + "T00:00:00").toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
      const row = document.createElement("div");
      row.className = "ledger-row";
      row.innerHTML = `<span class="label">${participantName(s.from_participant)} → ${participantName(s.to_participant)} <span class="muted small">(${d})</span></span><span class="leader"></span><span class="value credit">${fmt(s.amount)}</span>`;
      const del = document.createElement("button");
      del.className = "btn-icon";
      del.textContent = "🗑";
      del.onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm("¿Eliminar este pago?")) return;
        await sb.from("settlements").delete().eq("id", s.id);
        await loadAll();
        renderAll();
      };
      row.appendChild(del);
      payBox.appendChild(row);
    });
  }
}

function openSettleModal(fromId, toId, amount) {
  state.settleFrom = fromId;
  state.settleTo = toId;
  byId("settleFromName").textContent = participantName(fromId);
  byId("settleToName").textContent = participantName(toId);
  byId("settleAmount").value = amount.toFixed(2);
  byId("settleDate").value = new Date().toISOString().slice(0, 10);
  byId("settleNote").value = "";
  byId("settleModal").classList.remove("hidden");
}
byId("closeSettleModal").onclick = () => byId("settleModal").classList.add("hidden");

byId("saveSettleBtn").onclick = async () => {
  const amount = parseFloat(byId("settleAmount").value);
  const settled_date = byId("settleDate").value;
  const note = byId("settleNote").value.trim();
  if (!amount || amount <= 0 || !settled_date) return showToast("Revisa el importe y la fecha");
  const { error } = await sb.from("settlements").insert({
    group_id: state.currentGroupId,
    from_member: state.settleFrom,
    to_member: state.settleTo,
    amount,
    settled_date,
    note,
  });
  if (error) return showToast("Error al registrar el pago");
  byId("settleModal").classList.add("hidden");
  await loadAll();
  renderAll();
  showToast("Pago registrado");
};

// ------------------------------------------------------------
// Render: Gastos
// ------------------------------------------------------------
function renderExpenses() {
  const exs = filteredExpenses();
  const list = byId("expensesList");
  list.innerHTML = "";
  byId("expensesEmpty").classList.toggle("hidden", exs.length > 0);
  exs.forEach((ex) => {
    const el = document.createElement("div");
    el.className = "expense-ticket";
    const d = new Date(ex.expense_date + "T00:00:00").toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
    el.innerHTML = `
      <div class="expense-top">
        <div>
          <p class="expense-desc">${escapeHtml(ex.description)}</p>
          <p class="expense-meta">${d} · pagó ${participantName(ex.paid_by)}</p>
          <span class="expense-badge">${categoryIcon(ex.category)} ${ex.category}</span>
        </div>
        <span class="expense-amount">${fmt(ex.amount)}</span>
      </div>`;
    el.onclick = () => openDetail(ex);
    list.appendChild(el);
  });
}

// ------------------------------------------------------------
// Render: Estadísticas
// ------------------------------------------------------------
function renderStats() {
  const exs = filteredExpenses();
  const hasParticipantFilter = state.filters.participants.size > 0;
  const byCat = {};
  exs.forEach((e) => {
    if (hasParticipantFilter) {
      e.splits.forEach((s) => {
        if (state.filters.participants.has(s.participant_id)) {
          byCat[e.category] = (byCat[e.category] || 0) + Number(s.amount);
        }
      });
    } else {
      byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount);
    }
  });
  const catBox = byId("statsByCategory");
  catBox.innerHTML = "";
  const catTitle = byId("statsByCategoryTitle");
  if (catTitle) catTitle.textContent = hasParticipantFilter ? "Gasto por categoría (su parte)" : "Gasto por categoría";
  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  if (!catEntries.length) catBox.innerHTML = `<p class="muted small">Sin datos para estos filtros.</p>`;
  catEntries.forEach(([cat, amt]) => {
    const row = document.createElement("div");
    row.className = "ledger-row";
    row.innerHTML = `<span class="label">${categoryIcon(cat)} ${cat}</span><span class="leader"></span><span class="value">${fmt(amt)}</span>`;
    catBox.appendChild(row);
  });

  const byPart = {};
  exs.forEach((e) => (byPart[e.paid_by] = (byPart[e.paid_by] || 0) + Number(e.amount)));
  const partBox = byId("statsByParticipant");
  partBox.innerHTML = "";
  const partEntries = Object.entries(byPart).sort((a, b) => b[1] - a[1]);
  if (!partEntries.length) partBox.innerHTML = `<p class="muted small">Sin datos para estos filtros.</p>`;
  partEntries.forEach(([pid, amt]) => {
    const row = document.createElement("div");
    row.className = "ledger-row";
    row.innerHTML = `<span class="label">${participantName(pid)}</span><span class="leader"></span><span class="value">${fmt(amt)}</span>`;
    partBox.appendChild(row);
  });
}

// ------------------------------------------------------------
// Render: Miembros
// ------------------------------------------------------------
function renderParticipants() {
  const codeEl = byId("joinCodeDisplay");
  if (codeEl && state.currentGroup) codeEl.textContent = state.currentGroup.join_code;

  const box = byId("participantsList");
  box.innerHTML = "";
  if (!state.participants.length) {
    box.innerHTML = `<p class="muted small">Todavía no hay miembros.</p>`;
    return;
  }
  state.participants.forEach((p) => {
    const row = document.createElement("div");
    row.className = "ledger-row";
    row.innerHTML = `<span class="label"><span class="avatar-dot" style="background:${p.color}"></span>${p.name}</span><span class="leader"></span>`;
    const del = document.createElement("button");
    del.className = "btn-icon";
    del.textContent = "🗑";
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`¿Quitar a ${p.name} del grupo? Esto también borrará sus gastos y repartos.`)) return;
      await sb.from("group_members").delete().eq("id", p.id);
      await loadAll();
      renderAll();
    };
    row.appendChild(del);
    box.appendChild(row);
  });
}

// ------------------------------------------------------------
// Render general
// ------------------------------------------------------------
function renderAll() {
  renderFilterOptions();
  renderDashboard();
  renderExpenses();
  renderStats();
  renderParticipants();
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
function showToast(msg) {
  const t = byId("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 2600);
}

// ------------------------------------------------------------
// Pestañas
// ------------------------------------------------------------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tabpanel").forEach((p) => p.classList.add("hidden"));
    byId(`tab-${btn.dataset.tab}`).classList.remove("hidden");
    state.activeTab = btn.dataset.tab;
  };
});

// ------------------------------------------------------------
// Filtros: eventos
// ------------------------------------------------------------
byId("filterToggle").onclick = () => byId("filterPanel").classList.toggle("hidden");
byId("fSearch").oninput = (e) => { state.filters.search = e.target.value; renderAll(); };
byId("fDateFrom").onchange = (e) => { state.filters.dateFrom = e.target.value; renderAll(); };
byId("fDateTo").onchange = (e) => { state.filters.dateTo = e.target.value; renderAll(); };
byId("filterClear").onclick = () => {
  state.filters = { search: "", categories: new Set(), participants: new Set(), dateFrom: "", dateTo: "" };
  renderAll();
};

// ------------------------------------------------------------
// Modal de gasto: apertura / cierre
// ------------------------------------------------------------
function fillSelectOptions() {
  const catSel = byId("exCategory");
  catSel.innerHTML = state.categories.map((c) => `<option value="${c.name}">${c.icon} ${c.name}</option>`).join("");
  const paidSel = byId("exPaidBy");
  paidSel.innerHTML = state.participants.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
}

function renderSplitParticipants(preselected, customAmounts) {
  const box = byId("exSplitParticipants");
  box.innerHTML = "";
  state.participants.forEach((p) => {
    const row = document.createElement("label");
    row.className = "split-participant-row";
    const checked = preselected ? preselected.has(p.id) : true;
    row.innerHTML = `<input type="checkbox" data-pid="${p.id}" ${checked ? "checked" : ""}/> ${p.name}`;
    box.appendChild(row);
  });
  box.querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.onchange = () => { if (state.splitMode === "custom") renderCustomSplitInputs(customAmounts); }));
  renderCustomSplitInputs(customAmounts);
}

function selectedSplitParticipants() {
  return [...document.querySelectorAll("#exSplitParticipants input:checked")].map((cb) => cb.dataset.pid);
}

function renderCustomSplitInputs(existingAmounts) {
  const box = byId("customSplitBox");
  if (state.splitMode !== "custom") { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const ids = selectedSplitParticipants();
  box.innerHTML = "";
  ids.forEach((pid) => {
    const row = document.createElement("div");
    row.className = "custom-split-row";
    const val = existingAmounts && existingAmounts[pid] != null ? existingAmounts[pid] : "";
    row.innerHTML = `<span style="flex:1">${participantName(pid)}</span><input type="number" step="0.01" min="0" data-pid="${pid}" value="${val}" placeholder="0,00" />`;
    box.appendChild(row);
  });
}

function setSplitMode(mode) {
  state.splitMode = mode;
  byId("splitEqualBtn").classList.toggle("active", mode === "equal");
  byId("splitCustomBtn").classList.toggle("active", mode === "custom");
  renderCustomSplitInputs();
}
byId("splitEqualBtn").onclick = () => setSplitMode("equal");
byId("splitCustomBtn").onclick = () => setSplitMode("custom");

function openExpenseModal(ex) {
  state.editingExpenseId = ex ? ex.id : null;
  fillSelectOptions();
  byId("expenseModalTitle").textContent = ex ? "Editar gasto" : "Nuevo gasto";
  byId("deleteExpenseBtn").classList.toggle("hidden", !ex);
  byId("splitError").classList.add("hidden");

  if (ex) {
    byId("exDescription").value = ex.description;
    byId("exAmount").value = ex.amount;
    byId("exCategory").value = ex.category;
    byId("exPaidBy").value = ex.paid_by;
    byId("exDate").value = ex.expense_date;
    byId("exNotes").value = ex.notes || "";
    const preselected = new Set(ex.splits.map((s) => s.participant_id));
    const amounts = {};
    ex.splits.forEach((s) => (amounts[s.participant_id] = s.amount));
    const isEqualSplit = (() => {
      if (!ex.splits.length) return true;
      const per = Number(ex.amount) / ex.splits.length;
      return ex.splits.every((s) => Math.abs(Number(s.amount) - per) < 0.02);
    })();
    state.splitMode = isEqualSplit ? "equal" : "custom";
    setSplitMode(state.splitMode);
    renderSplitParticipants(preselected, amounts);
  } else {
    byId("exDescription").value = "";
    byId("exAmount").value = "";
    byId("exDate").value = new Date().toISOString().slice(0, 10);
    byId("exNotes").value = "";
    state.splitMode = "equal";
    setSplitMode("equal");
    renderSplitParticipants(null, null);
  }
  byId("expenseModal").classList.remove("hidden");
}
function closeExpenseModal() { byId("expenseModal").classList.add("hidden"); }

byId("newExpenseBtn").onclick = () => {
  if (!state.participants.length) return showToast("Este grupo todavía no tiene miembros");
  openExpenseModal(null);
};
byId("closeExpenseModal").onclick = closeExpenseModal;

// ------------------------------------------------------------
// Guardar / eliminar gasto
// ------------------------------------------------------------
byId("saveExpenseBtn").onclick = async () => {
  const description = byId("exDescription").value.trim();
  const amount = parseFloat(byId("exAmount").value);
  const category = byId("exCategory").value;
  const paid_by = byId("exPaidBy").value;
  const expense_date = byId("exDate").value;
  const notes = byId("exNotes").value.trim();
  const ids = selectedSplitParticipants();
  const errBox = byId("splitError");
  errBox.classList.add("hidden");

  if (!description || !amount || amount <= 0 || !paid_by || !expense_date) {
    errBox.textContent = "Completa descripción, importe, pagador y fecha.";
    errBox.classList.remove("hidden");
    return;
  }
  if (!ids.length) {
    errBox.textContent = "Selecciona al menos un miembro para el reparto.";
    errBox.classList.remove("hidden");
    return;
  }

  let splitAmounts = {};
  if (state.splitMode === "equal") {
    const per = Math.floor((amount / ids.length) * 100) / 100;
    let remainder = Math.round((amount - per * ids.length) * 100) / 100;
    ids.forEach((pid, i) => { splitAmounts[pid] = per + (i < Math.round(remainder * 100) ? 0.01 : 0); });
  } else {
    let sum = 0;
    document.querySelectorAll("#customSplitBox input").forEach((inp) => {
      const v = parseFloat(inp.value) || 0;
      splitAmounts[inp.dataset.pid] = v;
      sum += v;
    });
    if (Math.abs(sum - amount) > 0.02) {
      errBox.textContent = `Los importes personalizados suman ${fmt(sum)} pero el gasto es de ${fmt(amount)}.`;
      errBox.classList.remove("hidden");
      return;
    }
  }

  let expenseId = state.editingExpenseId;
  if (expenseId) {
    const { error } = await sb.from("expenses").update({ description, amount, category, paid_by, expense_date, notes }).eq("id", expenseId);
    if (error) return showToast("Error al guardar");
    await sb.from("expense_splits").delete().eq("expense_id", expenseId);
  } else {
    const { data, error } = await sb.from("expenses").insert({
      group_id: state.currentGroupId,
      description, amount, category, paid_by, expense_date, notes,
      created_by: state.session.user.id,
    }).select().single();
    if (error) return showToast("Error al guardar");
    expenseId = data.id;
  }
  const splitRows = Object.entries(splitAmounts).map(([participant_id, amt]) => ({ expense_id: expenseId, member_id: participant_id, amount: amt }));
  await sb.from("expense_splits").insert(splitRows);

  closeExpenseModal();
  await loadAll();
  renderAll();
  showToast("Gasto guardado");
};

byId("deleteExpenseBtn").onclick = async () => {
  if (!state.editingExpenseId) return;
  if (!confirm("¿Eliminar este gasto?")) return;
  await sb.from("expenses").delete().eq("id", state.editingExpenseId);
  closeExpenseModal();
  await loadAll();
  renderAll();
  showToast("Gasto eliminado");
};

// ------------------------------------------------------------
// Detalle de gasto
// ------------------------------------------------------------
let detailExpenseId = null;
function openDetail(ex) {
  detailExpenseId = ex.id;
  const body = byId("detailBody");
  const d = new Date(ex.expense_date + "T00:00:00").toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" });
  let html = `
    <div class="detail-line"><span>Descripción</span><strong>${escapeHtml(ex.description)}</strong></div>
    <div class="detail-line"><span>Importe</span><strong>${fmt(ex.amount)}</strong></div>
    <div class="detail-line"><span>Categoría</span><strong>${categoryIcon(ex.category)} ${ex.category}</strong></div>
    <div class="detail-line"><span>Fecha</span><strong>${d}</strong></div>
    <div class="detail-line"><span>Pagado por</span><strong>${participantName(ex.paid_by)}</strong></div>`;
  if (ex.notes) html += `<div class="detail-line"><span>Notas</span><strong>${escapeHtml(ex.notes)}</strong></div>`;
  html += `<p class="section-title" style="margin-top:14px">Reparto</p>`;
  ex.splits.forEach((s) => {
    html += `<div class="detail-line"><span>${participantName(s.participant_id)}</span><strong>${fmt(s.amount)}</strong></div>`;
  });
  body.innerHTML = html;
  byId("detailModal").classList.remove("hidden");
}
byId("closeDetailModal").onclick = () => byId("detailModal").classList.add("hidden");
byId("editFromDetailBtn").onclick = () => {
  byId("detailModal").classList.add("hidden");
  const ex = state.expenses.find((e) => e.id === detailExpenseId);
  if (ex) openExpenseModal(ex);
};

// ------------------------------------------------------------
// Exportar PDF (estilo Splid) — sin cambios en la lógica
// ------------------------------------------------------------
function consumptionByParticipant(expenses) {
  const totals = {};
  state.participants.forEach((p) => (totals[p.id] = 0));
  expenses.forEach((ex) => {
    ex.splits.forEach((s) => {
      totals[s.participant_id] = (totals[s.participant_id] || 0) + Number(s.amount);
    });
  });
  return totals;
}

function cellStr(n) {
  if (Math.abs(n) < 0.005) return "";
  const sign = n > 0 ? "+" : "";
  return `${sign}${fmt(n)}`;
}

function exportPdf() {
  if (!window.jspdf) return showToast("La librería de PDF no ha cargado, revisa tu conexión");
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const exs = filteredExpenses();
  const participants = state.participants;
  const groupName = state.currentGroup ? state.currentGroup.name : "Cuaderno de Gastos";
  const today = new Date().toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });

  doc.setFontSize(16);
  doc.text(groupName, 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Generado el ${today} · Cuaderno de Gastos`, 14, 22);
  doc.setTextColor(0);

  const rows = [];
  const movementDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit" });

  exs.forEach((ex) => {
    const row = [ex.description, fmt(ex.amount), participantName(ex.paid_by), movementDate(ex.expense_date), ex.category];
    participants.forEach((p) => {
      let net = 0;
      if (p.id === ex.paid_by) net += Number(ex.amount);
      const split = ex.splits.find((s) => s.participant_id === p.id);
      if (split) net -= Number(split.amount);
      row.push(cellStr(net));
    });
    row._date = ex.expense_date;
    rows.push(row);
  });
  state.settlements.forEach((s) => {
    const row = ["Pago", fmt(s.amount), participantName(s.from_participant), movementDate(s.settled_date), "–"];
    participants.forEach((p) => {
      let net = 0;
      if (p.id === s.to_participant) net += Number(s.amount);
      if (p.id === s.from_participant) net -= Number(s.amount);
      row.push(cellStr(net));
    });
    row._date = s.settled_date;
    rows.push(row);
  });
  rows.sort((a, b) => (a._date > b._date ? 1 : -1));

  const balance = balanceWithSettlements(exs);
  const totalsRow = ["", "", "", "", "Balance final", ...participants.map((p) => cellStr(balance[p.id] || 0))];

  doc.autoTable({
    startY: 28,
    head: [["Título", "Cantidad", "De", "Fecha", "Categoría", ...participants.map((p) => p.name)]],
    body: rows.map((r) => r.slice(0, r.length)),
    foot: [totalsRow],
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [61, 79, 145] },
    footStyles: { fillColor: [242, 241, 234], textColor: 0, fontStyle: "bold" },
  });

  const txs = simplifyDebts(balance);
  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 10,
    head: [["Pagos para ajuste", "", ""]],
    body: txs.length
      ? txs.map((t) => [participantName(t.from), "debe a " + participantName(t.to), fmt(t.amount)])
      : [["Todo saldado", "", ""]],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [61, 79, 145] },
  });

  const consumption = consumptionByParticipant(exs);
  const totalGeneral = exs.reduce((s, e) => s + Number(e.amount), 0);
  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 10,
    head: [["Gasto total (por participante)", ""]],
    body: [
      ...participants.map((p) => [p.name, fmt(consumption[p.id] || 0)]),
      ["Suma", fmt(totalGeneral)],
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [61, 79, 145] },
    didParseCell: (data) => {
      if (data.row.index === participants.length) data.cell.styles.fontStyle = "bold";
    },
  });

  const byCat = {};
  exs.forEach((e) => (byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount)));
  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 10,
    head: [["Gasto total (por categoría)", ""]],
    body: [...catEntries.map(([cat, amt]) => [cat, fmt(amt)]), ["Suma", fmt(totalGeneral)]],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [61, 79, 145] },
    didParseCell: (data) => {
      if (data.row.index === catEntries.length) data.cell.styles.fontStyle = "bold";
    },
  });

  doc.save(`${groupName.replace(/\s+/g, "_")}.pdf`);
}

byId("exportPdfBtn").onclick = exportPdf;

// ------------------------------------------------------------
// Abrir un grupo concreto
// ------------------------------------------------------------
async function openGroup(gid) {
  state.currentGroupId = gid;
  showScreen("app");
  const { data: group, error } = await sb.from("groups").select("*").eq("id", gid).single();
  if (error || !group) {
    showToast("No se pudo abrir el grupo");
    showScreen("groups");
    return;
  }
  state.currentGroup = group;
  byId("groupName").textContent = group.name;
  byId("groupIcon").textContent = group.icon;

  const { data: myMembership } = await sb
    .from("group_members").select("id")
    .eq("group_id", gid).eq("user_id", state.session.user.id).single();
  state.myMemberId = myMembership ? myMembership.id : null;

  await loadAll();
  byId("groupSub").textContent = `${state.participants.length} miembro${state.participants.length === 1 ? "" : "s"} · ${state.expenses.length} gasto${state.expenses.length === 1 ? "" : "s"}`;
  renderAll();
}

// ------------------------------------------------------------
// Arranque: comprobar sesión y reaccionar a cambios de auth
// ------------------------------------------------------------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  if (session) {
    showScreen("groups");
    await loadGroupsScreen();
  } else {
    renderAuthMode();
    showScreen("auth");
  }

  sb.auth.onAuthStateChange((event, session) => {
    state.session = session;
    if (event === "SIGNED_OUT") {
      showScreen("auth");
      renderAuthMode();
    }
  });
}

boot();
