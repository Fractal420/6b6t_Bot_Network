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
let lastCaptchaKey = "";
let lastNotifiedCaptchaKey = "";
let swRegistration = null;
let fleetState = null;
let selectedBotId = "";
try {
  selectedBotId = localStorage.getItem("fractal-bot-id") || "";
} catch {
  selectedBotId = "";
}

function token() {
  const params = new URLSearchParams(location.search);
  return params.get("token") || localStorage.getItem("control-token") || "";
}

function headers() {
  const t = token();
  return t ? { authorization: `Bearer ${t}`, "content-type": "application/json" } : { "content-type": "application/json" };
}

async function rpc(action, extra = {}) {
  const fleetActions = new Set([
    "fleetStatus",
    "fleetAccounts",
    "fleetAddAccount",
    "fleetRemoveAccount",
    "fleetStart",
    "fleetStop",
    "fleetStartAll",
    "fleetStopAll",
    "fleetSetTask",
    "getSettings",
    "saveSettings",
    "catalog",
  ]);
  const payload = { action, ...extra };
  if (!fleetActions.has(action) && typeof selectedBotId === "string" && selectedBotId) {
    payload.botId = selectedBotId;
  }
  const res = await fetch("/v1/rpc", {
    method: "POST",
    credentials: "same-origin",
    headers: headers(),
    body: JSON.stringify(payload),
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

let lastMapCovered = null;
let lastMapProgressAt = 0;
const STALL_MS = 10 * 60 * 1000;
const activityEntries = [];

function setPill(el, text, tone) {
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone || "neutral";
  el.classList.add("pill");
}

function phaseTone(phase, lastError) {
  if (phase === "in_game") return "live";
  if (phase === "lobby" || phase === "authenticating" || phase === "connecting") return "busy";
  if (phase === "reconnecting") return "warn";
  if (phase === "disconnected" || lastError) return "critical";
  return "neutral";
}

function logActivity(text) {
  const line = `${new Date().toISOString().slice(11, 19)} ${text}`;
  activityEntries.unshift(line);
  if (activityEntries.length > 80) activityEntries.length = 80;
  const ol = document.getElementById("activity-log");
  if (!ol) return;
  ol.replaceChildren();
  for (const entry of activityEntries.slice(0, 40)) {
    const li = document.createElement("li");
    li.textContent = entry;
    ol.append(li);
  }
}

function renderJobs(data) {
  const mapping = data.mapping || {};
  const m = mapping.mapping || mapping;
  const active = Boolean(mapping.active || m.active);
  const covered = Number(m.covered ?? m.coveredCells ?? NaN);
  const waypoints = Number(m.waypoints ?? m.total ?? NaN);
  const mode = m.mode || mapping.config?.mode || "—";
  const outDir = mapping.output?.dir || mapping.output?.regionsDir || "—";

  setPill(document.getElementById("map-active-pill"), active ? "active" : "idle", active ? "live" : "neutral");
  const modeEl = document.getElementById("map-mode-label");
  if (modeEl) modeEl.textContent = `mode ${mode}`;
  const prog = document.getElementById("map-progress");
  if (prog) {
    if (Number.isFinite(covered) && Number.isFinite(waypoints) && waypoints > 0) {
      const pct = Math.round((covered / waypoints) * 100);
      prog.textContent = `covered ${covered} / ${waypoints} (${pct}%)`;
    } else {
      prog.textContent = active ? "covered — (waiting for stats)" : "covered — / —";
    }
  }
  const outEl = document.getElementById("map-output");
  if (outEl) outEl.textContent = `output ${outDir}`;

  // Stall: active mapping but covered unchanged for STALL_MS
  const stallEl = document.getElementById("map-stall");
  if (active && Number.isFinite(covered)) {
    if (lastMapCovered !== covered) {
      lastMapCovered = covered;
      lastMapProgressAt = Date.now();
    } else if (!lastMapProgressAt) {
      lastMapProgressAt = Date.now();
    }
    const stalled = Date.now() - lastMapProgressAt > STALL_MS;
    if (stallEl) stallEl.hidden = !stalled;
  } else {
    lastMapCovered = null;
    lastMapProgressAt = 0;
    if (stallEl) stallEl.hidden = true;
  }

}

function renderAlerts(data) {
  const bar = document.getElementById("alerts-bar");
  if (!bar) return;
  const alerts = [];
  if (data.lastKickKind === "captcha" || (data.lastKickLinks && data.lastKickLinks.length)) {
    alerts.push({
      tone: "critical",
      text: `Captcha${data.lastVerificationCode ? ` code ${data.lastVerificationCode}` : ""} — solve and rejoin`,
    });
  } else if (data.lastKickKind === "rate-limit") {
    alerts.push({ tone: "warn", text: "Rate-limit kick — backing off before reconnect" });
  }
  if (data.phase === "disconnected" || data.phase === "reconnecting") {
    alerts.push({ tone: "warn", text: `Connection: ${data.phase}` });
  }
  if (data.lastError?.message && data.phase !== "in_game") {
    alerts.push({ tone: "critical", text: data.lastError.message.slice(0, 160) });
  }
  const stallEl = document.getElementById("map-stall");
  if (stallEl && !stallEl.hidden) {
    alerts.push({ tone: "warn", text: "Elytra mapper stall — no coverage progress for ~10 min" });
  }
  // Fleet-level: any bot with captcha from fleet state
  if (fleetState?.bots) {
    for (const b of fleetState.bots) {
      if (b.bot?.lastKickKind === "captcha") {
        alerts.push({ tone: "critical", text: `${b.username}: captcha` });
      }
    }
  }

  if (!alerts.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  bar.hidden = false;
  bar.replaceChildren();
  for (const a of alerts) {
    const div = document.createElement("div");
    div.className = `alert alert-${a.tone}`;
    div.textContent = a.text;
    bar.append(div);
  }
}

function renderOpsStrip(data) {
  const el = document.getElementById("ops-summary");
  if (!el) return;
  const mapping = data.mapping || {};
  const m = mapping.mapping || mapping;
  const active = Boolean(mapping.active || m.active);
  const covered = m.covered ?? "—";
  const waypoints = m.waypoints ?? "—";
  const fleetN = fleetState?.bots?.length ?? 0;
  const online = fleetState?.bots?.filter((b) => b.running || b.bot?.connected).length ?? (data.connected ? 1 : 0);
  const kick = data.lastKickKind || "none";
  el.textContent = [
    `fleet ${online}/${fleetN}`,
    `phase ${data.phase || "—"}`,
    `world ${data.worldKind || "—"}`,
    active ? `map ${covered}/${waypoints}` : "map off",
    `kick ${kick}`,
  ].join(" · ");
}

function renderStatus(data) {
  status = data;
  document.getElementById("ident-name").textContent = data.username || "not configured";
  document.getElementById("ident-host").textContent = `${data.host}:${data.port} · ${data.version || "?"}`;
  const phase = document.getElementById("phase");
  setPill(phase, data.phase || "idle", phaseTone(data.phase, data.lastError));
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

  if (data.lastKickKind === "captcha" || (data.lastKickLinks && data.lastKickLinks.length)) {
    showCaptchaBanner(
      data.lastKick || "Captcha / anti-bot kick",
      data.lastKickLinks || [],
      data.lastKickKind || "captcha",
      data.lastVerificationCode || "",
    );
  } else if (data.phase === "in_game") {
    hideCaptchaBanner();
  }

  renderJobs(data);
  renderAlerts(data);
  renderOpsStrip(data);

  if (data.position) window.fractalSurvey?.setBot(data.position, data.yaw, data.username);
}

function showCaptchaBanner(reason, links = [], kind = "captcha", verificationCode = "") {
  const banner = document.getElementById("captcha-banner");
  const reasonEl = document.getElementById("captcha-reason");
  const codeEl = document.getElementById("captcha-code");
  const linksEl = document.getElementById("captcha-links");
  if (!banner || !reasonEl || !linksEl) return;

  const key = `${kind}|${reason}|${(links || []).join("|")}|${verificationCode || ""}`;
  lastCaptchaKey = key;

  reasonEl.textContent = reason || "Anti-bot / captcha kick (no detail).";
  if (codeEl) {
    if (verificationCode) {
      codeEl.hidden = false;
      codeEl.textContent = `Verification code: ${verificationCode}`;
    } else {
      codeEl.hidden = true;
      codeEl.textContent = "";
    }
  }
  linksEl.replaceChildren();

  const list = Array.isArray(links) ? links.filter(Boolean) : [];
  if (list.length) {
    for (const url of list) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = url;
      linksEl.append(a);
    }
  } else {
    const p = document.createElement("p");
    p.className = "captcha-none";
    p.textContent =
      "No URL was found in the kick message. Log into this account with a normal Minecraft client to complete verification.";
    linksEl.append(p);
  }

  banner.hidden = false;
  notifyCaptcha(reason, list, verificationCode);
}

function hideCaptchaBanner() {
  const banner = document.getElementById("captcha-banner");
  if (banner) banner.hidden = true;
  lastCaptchaKey = "";
}

function notifyPrefEnabled() {
  return localStorage.getItem("fractal-notify") !== "0";
}

function setNotifyPref(on) {
  localStorage.setItem("fractal-notify", on ? "1" : "0");
  updateNotifyChip();
}

function notificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

function updateNotifyChip() {
  const btn = document.getElementById("toggle-notify");
  if (!btn) return;
  const perm = notificationPermission();
  const want = notifyPrefEnabled();
  btn.classList.remove("on", "warn");
  if (perm === "unsupported") {
    btn.textContent = "notify n/a";
    return;
  }
  if (perm === "denied") {
    btn.textContent = "notify blocked";
    btn.classList.add("warn");
    return;
  }
  if (perm === "granted" && want) {
    btn.textContent = "notify on";
    btn.classList.add("on");
    return;
  }
  btn.textContent = "notify off";
}

async function ensureNotificationPermission() {
  if (!("Notification" in window)) {
    push("err", "This browser does not support notifications");
    return false;
  }
  if (Notification.permission === "granted") {
    setNotifyPref(true);
    return true;
  }
  if (Notification.permission === "denied") {
    push("err", "Notifications are blocked — enable them in browser / site settings");
    updateNotifyChip();
    return false;
  }
  try {
    const result = await Notification.requestPermission();
    updateNotifyChip();
    if (result === "granted") {
      setNotifyPref(true);
      push("sys", "Notifications enabled — captcha kicks will alert this device");
      return true;
    }
    push("err", "Notification permission was not granted");
    return false;
  } catch (err) {
    push("err", `Could not request notifications: ${err?.message || err}`);
    return false;
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return swRegistration;
  } catch (err) {
    console.warn("service worker register failed", err);
    return null;
  }
}

function notifyCaptcha(reason, links = [], verificationCode = "") {
  if (!notifyPrefEnabled()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const key = `${reason}|${(links || []).join("|")}|${verificationCode || ""}`;
  if (key && key === lastNotifiedCaptchaKey) return;
  lastNotifiedCaptchaKey = key;

  const link = Array.isArray(links) && links.length ? links[0] : null;
  const title = "6b6t captcha — action needed";
  const codeLine = verificationCode ? `Code: ${verificationCode}\n` : "";
  const body = link
    ? `${codeLine}${String(reason || "Solve captcha").slice(0, 100)}\n${link}`
    : `${codeLine}${String(reason || "Solve the captcha with a normal client, then rejoin.").slice(0, 160)}`;

  // Prefer service worker notification (works better when tab is backgrounded / on mobile)
  if (swRegistration?.active) {
    swRegistration.active.postMessage({
      type: "captcha-notify",
      title,
      body,
      link,
    });
    return;
  }
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "captcha-notify",
      title,
      body,
      link,
    });
    return;
  }

  try {
    const n = new Notification(title, {
      body,
      tag: "fractal-captcha",
      renotify: true,
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      if (link) window.open(link, "_blank", "noopener,noreferrer");
      n.close();
    };
  } catch (err) {
    console.warn("notification failed", err);
  }
}

function push(kind, text, links) {
  const li = document.createElement("li");
  li.className = kind;
  const time = document.createElement("time");
  time.textContent = new Date().toISOString().slice(11, 19);
  li.append(time, document.createTextNode(text));
  if (Array.isArray(links) && links.length) {
    for (const url of links) {
      li.append(document.createTextNode(" "));
      const a = document.createElement("a");
      a.className = "captcha-inline";
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = url;
      li.append(a);
    }
  }
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
    if (msg.event === "kicked") {
      const data = msg.data;
      const reason = typeof data === "string" ? data : data?.reason ?? String(data ?? "unknown");
      const kind = typeof data === "object" && data?.kind ? data.kind : "other";
      const links = typeof data === "object" && Array.isArray(data?.links) ? data.links : [];
      const code = typeof data === "object" && data?.verificationCode ? String(data.verificationCode) : "";
      push("err", `kicked (${kind}): ${reason}${code ? ` code=${code}` : ""}`, links);
      if (kind === "captcha" || links.length > 0) {
        showCaptchaBanner(reason, links, kind, code);
      }
    }
    if (msg.event === "disconnected") push("err", `disconnected: ${msg.data ?? ""}`);
    if (msg.event === "authenticated") {
      push("sys", "authenticated");
    }
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
    else if (action === "mapStart") {
      const body = await rpc("mapStart", {});
      push("sys", `map start: ${body.data?.result ?? JSON.stringify(body.data ?? body)}`);
      logActivity(`map start ${body.data?.result ?? ""}`);
    } else if (action === "mapStop") {
      const body = await rpc("mapStop", {});
      push("sys", `map stop: ${body.data?.result ?? JSON.stringify(body.data ?? body)}`);
      logActivity("map stop");
    } else {
      await rpc(action);
      if (["join", "leave", "reconnect", "hunt"].includes(action)) logActivity(action);
    }
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
document.getElementById("captcha-dismiss")?.addEventListener("click", () => {
  hideCaptchaBanner();
});

document.getElementById("toggle-notify")?.addEventListener("click", async () => {
  const perm = notificationPermission();
  if (perm === "unsupported") {
    push("err", "Notifications are not supported in this browser");
    return;
  }
  if (perm === "granted" && notifyPrefEnabled()) {
    setNotifyPref(false);
    push("sys", "Captcha notifications disabled");
    return;
  }
  const ok = await ensureNotificationPermission();
  if (ok) {
    // Test ping so the user knows it works
    try {
      new Notification("Fractal notifications on", {
        body: "You will be alerted when a captcha needs solving.",
        tag: "fractal-notify-test",
      });
    } catch {
      /* ignore */
    }
  }
  updateNotifyChip();
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

// Notifications + service worker (captcha alerts on phone / background tab)
updateNotifyChip();
void registerServiceWorker().then(() => updateNotifyChip());
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "captcha-focus" && event.data.link) {
      // User tapped the notification — keep dashboard focused; link already optional
    }
  });
}
// If permission already granted and user has not opted out, keep chip green
if (notificationPermission() === "granted" && notifyPrefEnabled()) {
  updateNotifyChip();
}

window.addEventListener("survey-radius", () => void refreshVoxels());
window.addEventListener("survey-goto", async (event) => {
  const { x, y, z } = event.detail || {};
  if (![x, y, z].every(Number.isFinite)) return;
  await rpc("goto", { x, y, z });
});

// —— Settings (.env) UI ——
async function loadSettingsForm() {
  const form = document.getElementById("settings-form");
  const pathEl = document.getElementById("settings-path");
  const msg = document.getElementById("settings-msg");
  if (!form) return;
  msg.hidden = true;
  const body = await rpc("getSettings", {});
  if (!body.ok || !body.data) {
    msg.hidden = false;
    msg.className = "settings-msg err";
    msg.textContent = body.error || "failed to load settings";
    return;
  }
  const { path: envPath, fields } = body.data;
  pathEl.textContent = envPath || ".env";
  form.replaceChildren();
  const groups = new Map();
  for (const f of fields) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  for (const [group, list] of groups) {
    const box = document.createElement("div");
    box.className = "settings-group";
    const h = document.createElement("h3");
    h.textContent = group;
    box.append(h);
    for (const f of list) {
      const row = document.createElement("div");
      row.className = "settings-row";
      const lab = document.createElement("label");
      lab.htmlFor = `set-${f.key}`;
      lab.textContent = f.label;
      if (f.restart) {
        const tag = document.createElement("span");
        tag.className = "restart-tag";
        tag.textContent = "restart";
        lab.append(tag);
      }
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        for (const opt of f.options || []) {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          if (String(f.value || "") === opt) o.selected = true;
          input.append(o);
        }
        if (!f.value && f.options?.length) input.value = f.options[0];
      } else if (f.type === "boolean") {
        input = document.createElement("select");
        for (const [v, t] of [["1", "yes"], ["0", "no"]]) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = t;
          input.append(o);
        }
        input.value = f.value === "1" ? "1" : "0";
      } else {
        input = document.createElement("input");
        input.type = f.type === "password" ? "password" : f.type === "number" ? "number" : "text";
        input.value = f.value || "";
        if (f.secret && f.hasSecret) input.placeholder = "(unchanged — type to replace)";
        if (f.type === "number") input.step = "any";
      }
      input.id = `set-${f.key}`;
      input.name = f.key;
      input.dataset.key = f.key;
      row.append(lab, input);
      if (f.help) {
        const help = document.createElement("p");
        help.className = "help";
        help.textContent = f.help;
        row.append(help);
      }
      box.append(row);
    }
    form.append(box);
  }
}

async function saveSettingsForm() {
  const form = document.getElementById("settings-form");
  const msg = document.getElementById("settings-msg");
  if (!form) return;
  const values = {};
  form.querySelectorAll("[data-key]").forEach((el) => {
    values[el.dataset.key] = el.value;
  });
  const body = await rpc("saveSettings", { values });
  msg.hidden = false;
  if (!body.ok) {
    msg.className = "settings-msg err";
    msg.textContent = body.error || "save failed";
    return;
  }
  const d = body.data || {};
  msg.className = "settings-msg";
  let text = `Saved ${ (d.saved || []).length } key(s) to .env`;
  if (d.restartRequired) {
    text += ` · restart required for: ${(d.restartKeys || []).join(", ")}`;
  }
  msg.textContent = text;
  push("sys", text);
  logActivity(text);
  await loadSettingsForm();
}

document.getElementById("settings-reload")?.addEventListener("click", () => void loadSettingsForm());
document.getElementById("settings-save")?.addEventListener("click", () => void saveSettingsForm());
void loadSettingsForm();

// —— Fleet (multi-account) ——
function setSelectedBot(id) {
  selectedBotId = id || "";
  if (id) localStorage.setItem("fractal-bot-id", id);
  document.getElementById("active-bot-label").textContent = id
    ? `(bot ${shortId(id)})`
    : "(selected bot)";
  renderFleet();
}

function shortId(id) {
  return String(id || "").slice(0, 8);
}

async function refreshFleet() {
  const body = await rpc("fleetStatus", {});
  if (body.ok && body.data) {
    fleetState = body.data;
    if (!selectedBotId && body.data.bots?.length) {
      const running = body.data.bots.find((b) => b.running);
      setSelectedBot((running || body.data.bots[0]).id);
    }
    renderFleet();
  }
}

function featChecked(f, key) {
  return f && f[key] ? "checked" : "";
}

function renderFleet() {
  const grid = document.getElementById("fleet-grid");
  const pathEl = document.getElementById("fleet-path");
  if (!grid || !fleetState) return;
  pathEl.textContent = fleetState.accountsPath || "accounts.json";
  const ann = document.getElementById("announce-json");
  if (ann && fleetState.defaultAnnouncements && !ann.dataset.touched) {
    ann.value = JSON.stringify(fleetState.defaultAnnouncements, null, 0);
  }
  grid.replaceChildren();
  const bots = fleetState.bots || [];
  if (!bots.length) {
    const empty = document.createElement("article");
    empty.className = "fleet-card";
    empty.innerHTML =
      "<h3>No accounts</h3><p class='meta-line'>Add a username below. Stack features: announce + map is fine; hunt vs map conflicts (map wins).</p>";
    grid.append(empty);
    return;
  }
  for (const b of bots) {
    const card = document.createElement("article");
    card.className = "fleet-card" + (b.id === selectedBotId ? " selected" : "");
    const phase = b.bot?.phase || (b.running ? "running" : "stopped");
    const world = b.bot?.worldKind || "—";
    const pos = b.bot?.position
      ? `${Math.round(b.bot.position.x)} ${Math.round(b.bot.position.y)} ${Math.round(b.bot.position.z)}`
      : "—";
    const f = b.features || {};
    const summary = b.featuresSummary || "—";
    card.innerHTML = `
      <h3>${escapeHtml(b.label || b.username)}</h3>
      <p class="meta-line">${escapeHtml(b.username)} · ${phase} · ${world}</p>
      <p class="meta-line">${escapeHtml(summary)} · xyz ${pos}</p>
      <div class="feat-grid" data-feats-for="${b.id}">
        <label class="feat"><input type="checkbox" data-feat="online" ${featChecked(f, "online")} /> online</label>
        <label class="feat"><input type="checkbox" data-feat="announcements" ${featChecked(f, "announcements")} /> announce</label>
        <label class="feat"><input type="checkbox" data-feat="antiAfk" ${featChecked(f, "antiAfk")} /> anti-AFK</label>
        <label class="feat"><input type="checkbox" data-feat="hunt" ${featChecked(f, "hunt")} /> hunt</label>
        <label class="feat"><input type="checkbox" data-feat="map" ${featChecked(f, "map")} /> map</label>
      </div>
      <div class="task-row">
        <button type="button" data-apply-feats="${b.id}">apply features</button>
        <button type="button" data-start="${b.id}">start</button>
        <button type="button" data-stop="${b.id}">stop</button>
        <button type="button" data-select="${b.id}">select</button>
        <button type="button" class="danger" data-remove="${b.id}">remove</button>
      </div>`;
    grid.append(card);
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.getElementById("fleet-grid")?.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.select) {
    setSelectedBot(t.dataset.select);
    await refresh();
    return;
  }
  if (t.dataset.start) {
    await rpc("fleetStart", { id: t.dataset.start });
    await refreshFleet();
    return;
  }
  if (t.dataset.stop) {
    await rpc("fleetStop", { id: t.dataset.stop });
    await refreshFleet();
    return;
  }
  if (t.dataset.remove) {
    if (!confirm("Remove this account from the fleet?")) return;
    await rpc("fleetRemoveAccount", { id: t.dataset.remove });
    await refreshFleet();
    return;
  }
  if (t.dataset.applyFeats) {
    const id = t.dataset.applyFeats;
    const box = document.querySelector(`[data-feats-for="${id}"]`);
    const features = {};
    box?.querySelectorAll("input[data-feat]").forEach((inp) => {
      features[inp.getAttribute("data-feat")] = inp.checked;
    });
    if (features.map) features.mapMode = "box";
    const body = await rpc("fleetSetFeatures", { id, features });
    logActivity(body.data?.result || `features ${id}`);
    await refreshFleet();
  }
});

document.getElementById("fleet-start-all")?.addEventListener("click", async () => {
  await rpc("fleetStartAll", {});
  logActivity("fleet start all");
  await refreshFleet();
});
document.getElementById("fleet-stop-all")?.addEventListener("click", async () => {
  await rpc("fleetStopAll", {});
  logActivity("fleet stop all");
  await refreshFleet();
});
document.getElementById("fleet-refresh")?.addEventListener("click", () => void refreshFleet());

document.getElementById("fleet-add")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const features = {
    online: fd.get("online") === "on",
    announcements: fd.get("announcements") === "on",
    antiAfk: fd.get("antiAfk") === "on",
    hunt: fd.get("hunt") === "on",
    map: fd.get("map") === "on",
    mapMode: "box",
  };
  if (!features.online && !features.hunt && !features.map) features.online = true;
  await rpc("fleetAddAccount", {
    account: {
      label: String(fd.get("label") || ""),
      username: String(fd.get("username") || ""),
      password: String(fd.get("password") || ""),
      features,
      enabled: true,
      auth: "offline",
    },
  });
  e.target.reset();
  logActivity(`added ${fd.get("username")}`);
  await refreshFleet();
});

document.getElementById("announce-json")?.addEventListener("input", (e) => {
  e.target.dataset.touched = "1";
});
document.getElementById("announce-save")?.addEventListener("click", async () => {
  const ta = document.getElementById("announce-json");
  try {
    const announcements = JSON.parse(ta.value || "[]");
    await rpc("fleetSetAnnouncements", { announcements });
    ta.dataset.touched = "";
    logActivity("saved default announcements");
    push("sys", "Default announcements saved");
    await refreshFleet();
  } catch (err) {
    push("err", `Invalid JSON: ${err.message || err}`);
  }
});

setInterval(() => void refreshFleet(), 4000);
void refreshFleet();

