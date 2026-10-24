const logEl = document.getElementById("log");
const keys = { forward: false, back: false, left: false, right: false, jump: false, sneak: false, sprint: false };
const keyMap = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  Space: "jump",
  ShiftLeft: "sneak",
  ShiftRight: "sneak",
  KeyR: "sprint",
};

let status = null;
let lastControl = "";
let lastFaultAt = "";

function token() {
  const params = new URLSearchParams(location.search);
  return params.get("token") || localStorage.getItem("fractal-token") || "";
}

function headers() {
  const t = token();
  return t ? { authorization: `Bearer ${t}`, "content-type": "application/json" } : { "content-type": "application/json" };
}

async function rpc(action, extra = {}) {
  const res = await fetch("/v1/rpc", {
    method: "POST",
    credentials: "same-origin",
    headers: headers(),
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await res.json();
  if (!body.ok) push("err", body.error || "request failed");
  return body;
}

function fmtUptime(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function setBar(id, value, max = 20) {
  const pct = Math.max(0, Math.min(100, ((value ?? 0) / max) * 100));
  document.querySelector(`#${id} i`).style.width = `${pct}%`;
  document.getElementById(`${id}-n`).textContent = value == null ? "—" : `${value}/${max}`;
}

function renderStatus(data) {
  status = data;
  document.getElementById("ident-name").textContent = data.username || "not configured";
  document.getElementById("ident-host").textContent = `${data.host}:${data.port} · ${data.version || "?"}`;
  const phase = document.getElementById("phase");
  phase.textContent = data.phase || "idle";
  phase.classList.toggle("live", data.phase === "in_game");
  phase.classList.toggle("warn", data.phase === "reconnecting" || data.phase === "disconnected");
  phase.classList.toggle("fail", Boolean(data.lastError) && data.phase !== "in_game");
  document.getElementById("world").textContent = data.worldKind || "—";
  document.getElementById("dimension").textContent = data.dimension || "—";
  document.getElementById("xyz").textContent = data.position
    ? `${data.position.x.toFixed(1)}  ${data.position.y.toFixed(1)}  ${data.position.z.toFixed(1)}`
    : "—";
  document.getElementById("ping").textContent = data.ping == null ? "—" : `${data.ping} ms`;
  document.getElementById("tab").textContent = String(data.players ?? "—");
  document.getElementById("uptime").textContent = fmtUptime(data.uptimeMs);
  setBar("hp", data.health);
  setBar("food", data.food);
  document.getElementById("toggle-reconnect").classList.toggle("on", Boolean(data.autoReconnect));
  document.getElementById("toggle-lobby").classList.toggle("on", Boolean(data.autoLobby));
  document.getElementById("hunt-state").textContent = data.huntingPortal ? "hunt on" : "hunt off";
  const fault = document.getElementById("fault");
  const info = data.lastError;
  if (info?.message) {
    const when = info.at ? info.at.slice(11, 19) : "";
    const code = info.code ? ` [${info.code}]` : "";
    fault.hidden = false;
    fault.textContent = `${when} ${info.source}${code}: ${info.message}`.trim();
    if (info.at && info.at !== lastFaultAt) {
      lastFaultAt = info.at;
      push("err", fault.textContent);
    }
  } else {
    fault.hidden = true;
  }
  if (data.position) window.fractalSurvey?.setBot(data.position, data.yaw, data.username);
}

function push(kind, text) {
  const li = document.createElement("li");
  li.className = kind;
  const time = document.createElement("time");
  time.textContent = new Date().toISOString().slice(11, 19);
  li.append(time, document.createTextNode(text));
  logEl.append(li);
  while (logEl.children.length > 300) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

function renderPlayers(players) {
  const ul = document.getElementById("players");
  ul.innerHTML = "";
  const rows = (players || []).slice(0, 40);
  document.getElementById("player-count").textContent = rows.length ? `(${rows.length})` : "";
  for (const p of rows) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = String(p.username ?? "");
    const distEl = document.createElement("span");
    distEl.textContent = p.distance == null ? "" : `${p.distance.toFixed(1)}m`;
    li.append(name, distEl);
    ul.append(li);
  }
  if (!rows.length) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = "nobody in range";
    li.append(span);
    ul.append(li);
  }
}

let selectedSlot = null;
let packView = { quickBarSlot: 0, held: null, slots: [] };
const SLOT_LABELS = { 5: "head", 6: "chest", 7: "legs", 8: "feet", 45: "offhand" };

function asInvView(data) {
  if (Array.isArray(data)) return { quickBarSlot: 0, held: null, slots: data };
  return data || { quickBarSlot: 0, held: null, slots: [] };
}

function slotMap(slots) {
  const map = new Map();
  for (const item of slots || []) map.set(item.slot, item);
  return map;
}

function shortTag(name) {
  const parts = String(name || "").replace(/^minecraft:/, "").split("_").filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0].slice(0, 5);
  return parts.map((p) => p.slice(0, 3)).join("").slice(0, 6);
}

function itemTint(name) {
  let h = 2166136261;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  const t = (h >>> 0) / 4294967296;
  return `hsl(${16 + t * 38} ${38 + t * 18}% ${16 + t * 14}%)`;
}

function fillCells(root, slots, bySlot, heldSlot) {
  if (!root) return;
  if (!root.childElementCount) {
    for (const slot of slots) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "inv-cell empty";
      btn.dataset.slot = String(slot);
      btn.innerHTML = `<span class="tag"></span><span class="qty"></span><span class="wear" hidden><i></i></span>`;
      root.append(btn);
    }
  }
  for (const btn of root.querySelectorAll(".inv-cell")) {
    const slot = Number(btn.dataset.slot);
    const item = bySlot.get(slot);
    const tag = btn.querySelector(".tag");
    const qty = btn.querySelector(".qty");
    const wear = btn.querySelector(".wear");
    btn.classList.toggle("empty", !item);
    btn.classList.toggle("held", slot === heldSlot);
    btn.classList.toggle("on", slot === selectedSlot);
    btn.title = item
      ? `${item.displayName || item.name} ×${item.count}`
      : SLOT_LABELS[slot] || `empty ${slot}`;
    btn.style.background = item ? itemTint(item.name) : "#100c09";
    tag.textContent = item ? shortTag(item.customName || item.name) : "";
    qty.textContent = item && item.count > 1 ? `×${item.count}` : "";
    if (item?.maxDurability) {
      wear.hidden = false;
      const left = 1 - (item.durabilityUsed || 0) / item.maxDurability;
      wear.querySelector("i").style.width = `${Math.max(4, left * 100)}%`;
      wear.querySelector("i").style.background = left < 0.25 ? "var(--blood)" : "var(--moss)";
    } else {
      wear.hidden = true;
    }
  }
}

function renderInventory(data) {
  packView = asInvView(data);
  const bySlot = slotMap(packView.slots);
  const heldSlot = 36 + (packView.quickBarSlot || 0);
  fillCells(document.getElementById("inv-gear"), [5, 6, 7, 8, 45], bySlot, heldSlot);
  fillCells(
    document.getElementById("inv-main"),
    Array.from({ length: 27 }, (_, i) => 9 + i),
    bySlot,
    heldSlot,
  );
  fillCells(
    document.getElementById("inv-hot"),
    Array.from({ length: 9 }, (_, i) => 36 + i),
    bySlot,
    heldSlot,
  );
  const held = packView.held;
  const heldEl = document.getElementById("pack-held");
  if (heldEl) {
    heldEl.textContent = held ? `${held.displayName || held.name} ×${held.count}` : "hands empty";
  }
  const selected = selectedSlot == null ? null : bySlot.get(selectedSlot);
  const nameEl = document.getElementById("inv-name");
  if (nameEl) {
    if (selectedSlot == null) nameEl.textContent = "click a slot · click another to swap";
    else if (selected) nameEl.textContent = `${selected.displayName || selected.name}  slot ${selectedSlot}  ×${selected.count}`;
    else nameEl.textContent = `empty slot ${selectedSlot} · click another to move here`;
  }
}

async function invOp(op, extra = {}) {
  const res = await rpc("inv", { op, ...extra });
  if (res.ok && res.data) renderInventory(res.data);
  else await refresh();
}

function selectedOrThrow() {
  if (selectedSlot == null) {
    push("err", "pick an inventory slot first");
    return null;
  }
  return selectedSlot;
}

async function refresh() {
  try {
    const [st, players, inv] = await Promise.all([
      fetch("/v1/status", { credentials: "same-origin", headers: headers() }).then((r) => r.json()),
      fetch("/v1/players", { credentials: "same-origin", headers: headers() }).then((r) => r.json()).catch(() => ({})),
      fetch("/v1/inventory", { credentials: "same-origin", headers: headers() }).then((r) => r.json()).catch(() => ({})),
    ]);
    if (st.ok) renderStatus(st.data);
    else if (st.error) push("err", st.error === "unauthorized" ? "unauthorized · refresh http://127.0.0.1:37637/" : st.error);
    if (players.ok) {
      renderPlayers(players.data);
      window.fractalSurvey?.setPlayers(players.data);
    }
    if (inv.ok) renderInventory(inv.data);
  } catch {
    push("err", "control API is down · bot process not running");
  }
}

async function refreshVoxels() {
  if (!window.fractalSurvey) return;
  try {
    const r = window.fractalSurvey.radius ?? 20;
    const res = await fetch(`/v1/voxels?r=${r}`, { credentials: "same-origin", headers: headers() }).then((row) => row.json());
    if (res.ok) window.fractalSurvey.setField(res.data);
  } catch {
    /* bot may be between worlds */
  }
}

function connectEvents() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/v1/events`;
  const ws = new WebSocket(url);
  const label = document.getElementById("ws-state");
  ws.addEventListener("open", () => {
    label.textContent = "socket live";
    label.classList.add("hot");
  });
  ws.addEventListener("close", () => {
    label.textContent = "socket cold";
    label.classList.remove("hot");
    setTimeout(connectEvents, 2000);
  });
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.event === "status") renderStatus(msg.data);
    if (msg.event === "phase") {
      document.getElementById("phase").textContent = msg.data;
      push("sys", `phase ${msg.data}`);
    }
    if (msg.event === "chat") push("", msg.data?.raw ?? String(msg.data));
    if (msg.event === "kicked") push("err", `kicked: ${msg.data}`);
    if (msg.event === "disconnected") push("err", `disconnected: ${msg.data ?? ""}`);
    if (msg.event === "authenticated") push("sys", "authenticated");
    if (msg.event === "worldKind") push("sys", `world ${msg.data}`);
    if (msg.event === "portalEntered") push("sys", `portal ${msg.data?.count ?? ""}`);
    if (msg.event === "error" && !msg.data?.lastError) push("err", msg.data?.message ?? "error");
  });
}

async function sendControl() {
  const packed = JSON.stringify(keys);
  if (packed === lastControl) return;
  lastControl = packed;
  await rpc("control", { state: keys });
}

function surveyOwnsKeys() {
  return window.fractalSurvey?.ownsKeys?.() ?? false;
}

function clearBotKeys() {
  let any = false;
  for (const name of Object.keys(keys)) {
    if (!keys[name]) continue;
    keys[name] = false;
    any = true;
    document.querySelector(`[data-k="${name}"]`)?.classList.remove("down");
  }
  if (any) void sendControl();
}

document.querySelectorAll("[data-rpc]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.getAttribute("data-rpc");
    if (action === "join") await rpc("join", { options: {} });
    else if (action === "leave") await rpc("leave", { reason: "dashboard" });
    else await rpc(action);
    await refresh();
  });
});

document.getElementById("toggle-reconnect").addEventListener("click", async () => {
  await rpc("set", { autoReconnect: !status?.autoReconnect });
  await refresh();
});
document.getElementById("toggle-lobby").addEventListener("click", async () => {
  await rpc("set", { autoLobby: !status?.autoLobby });
  await refresh();
});

document.getElementById("say").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("say-input");
  const text = input.value.trim();
  if (!text) return;
  if (text.startsWith("/")) await rpc("command", { command: text.slice(1) });
  else await rpc("chat", { message: text });
  input.value = "";
});

document.getElementById("goto").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const x = Number(form.x.value);
  const y = Number(form.y.value);
  const z = Number(form.z.value);
  if (![x, y, z].every(Number.isFinite)) {
    push("err", "goto needs numeric x y z");
    return;
  }
  await rpc("goto", { x, y, z });
});

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  const digit = event.code.match(/^Digit([1-9])$/);
  if (digit) {
    event.preventDefault();
    const slot = 35 + Number(digit[1]);
    selectedSlot = slot;
    void invOp("hold", { slot });
    return;
  }
  if (surveyOwnsKeys()) return;
  if (selectedSlot != null && event.code === "KeyQ") {
    event.preventDefault();
    void invOp(event.shiftKey ? "dropStack" : "drop", { slot: selectedSlot });
    return;
  }
  const control = keyMap[event.code];
  if (!control) return;
  event.preventDefault();
  if (keys[control]) return;
  keys[control] = true;
  document.querySelector(`[data-k="${control}"]`)?.classList.add("down");
  void sendControl();
});

window.addEventListener("keyup", (event) => {
  const control = keyMap[event.code];
  if (!control) return;
  if (!keys[control]) return;
  keys[control] = false;
  document.querySelector(`[data-k="${control}"]`)?.classList.remove("down");
  void sendControl();
});

document.getElementById("inv")?.addEventListener("click", async (event) => {
  const btn = event.target.closest(".inv-cell");
  if (!btn) return;
  const slot = Number(btn.dataset.slot);
  if (!Number.isFinite(slot)) return;
  if (event.shiftKey) {
    selectedSlot = slot;
    await invOp("dropStack", { slot });
    return;
  }
  if (event.altKey) {
    selectedSlot = slot;
    await invOp("drop", { slot, count: 1 });
    return;
  }
  if (event.detail >= 2) {
    selectedSlot = slot;
    await invOp("hold", { slot });
    return;
  }
  if (selectedSlot != null && selectedSlot !== slot) {
    const by = slotMap(packView.slots);
    if (!by.get(selectedSlot) && !by.get(slot)) {
      selectedSlot = slot;
      renderInventory(packView);
      return;
    }
    const from = selectedSlot;
    selectedSlot = slot;
    await invOp("swap", { slot: from, to: slot });
    return;
  }
  selectedSlot = selectedSlot === slot ? null : slot;
  renderInventory(packView);
});

document.querySelectorAll("[data-inv]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const slot = selectedOrThrow();
    if (slot == null) return;
    const op = btn.getAttribute("data-inv");
    if (op === "offhand") await invOp("equip", { slot, dest: "off-hand" });
    else await invOp(op, { slot });
  });
});

window.addEventListener("survey-keys", (event) => {
  if (event.detail?.owns) clearBotKeys();
});

connectEvents();
void refresh();
void refreshVoxels();
setInterval(() => void refresh(), 1500);
setInterval(() => void refreshVoxels(), 2200);

window.addEventListener("survey-radius", () => void refreshVoxels());
window.addEventListener("survey-goto", async (event) => {
  const { x, y, z } = event.detail || {};
  if (![x, y, z].every(Number.isFinite)) return;
  await rpc("goto", { x, y, z });
});
