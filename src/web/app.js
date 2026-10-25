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

/** Local clock time (user timezone), HH:MM:SS */
function fmtLocalTime(d = new Date()) {
  try {
    return new Date(d).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date(d).toTimeString().slice(0, 8);
  }
}

/** Parse ISO / epoch / Date into local time string */
function fmtLocalFrom(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number") return fmtLocalTime(new Date(value));
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    // Already a bare HH:MM:SS — leave it
    if (/^\d{2}:\d{2}:\d{2}/.test(String(value))) return String(value).slice(0, 8);
    return String(value);
  }
  return fmtLocalTime(d);
}

function logActivity(text) {
  const line = `${fmtLocalTime()} ${text}`;
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

  // Compact vitals in ops strip for the active profile
  const vitals = document.getElementById("ops-vitals");
  if (vitals) {
    const hasProfile = Boolean(selectedBotId);
    vitals.hidden = !hasProfile;
    if (hasProfile) {
      const worldEl = document.getElementById("ops-world");
      const xyzEl = document.getElementById("ops-xyz");
      const hpEl = document.getElementById("ops-hp");
      const foodEl = document.getElementById("ops-food");
      const pingEl = document.getElementById("ops-ping");
      if (worldEl) worldEl.textContent = data.worldKind || "—";
      if (xyzEl) {
        xyzEl.textContent = data.position
          ? `${Math.round(data.position.x)} ${Math.round(data.position.y)} ${Math.round(data.position.z)}`
          : "—";
      }
      if (hpEl) hpEl.textContent = data.health != null ? String(data.health) : "—";
      if (foodEl) foodEl.textContent = data.food != null ? String(data.food) : "—";
      if (pingEl) pingEl.textContent = data.ping == null ? "—" : `${data.ping}ms`;
    }
  }
}

function renderStatus(data) {
  status = data;
  window.__fractalStatus = data;
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
  // Connection switches are manual-only — never overwrite while user is controlling them
  const rc = document.getElementById("toggle-reconnect");
  if (rc && !connectionSwitchLocked("reconnect") && rc.dataset.userTouched !== "1") {
    rc.checked = Boolean(data.autoReconnect);
    rc.closest(".task-toggle")?.classList.toggle("on", rc.checked);
  }
  const lb = document.getElementById("toggle-lobby");
  if (lb && !connectionSwitchLocked("lobby") && lb.dataset.userTouched !== "1") {
    lb.checked = Boolean(data.autoLobby);
    lb.closest(".task-toggle")?.classList.toggle("on", lb.checked);
  }
  // Captcha notify is client-local only — never driven by bot status
  syncNotifyToggleUi();
  const huntEl = document.getElementById("hunt-state");
  if (huntEl) huntEl.textContent = data.huntingPortal ? "hunt on" : "hunt off";
  const fault = document.getElementById("fault");
  const info = data.lastError;
  if (fault) {
    if (info?.message) {
      const when = info.at ? fmtLocalFrom(info.at) : "";
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
  updateProfileSelectorUI();

  if (data.position && isView3dPrefEnabled() && isBotLiveForView()) {
    window.fractalSurvey?.setBot(data.position, data.yaw, data.username);
  }
  applyView3dState();
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

/** Locks so status/fleet refresh cannot flip Connection switches after a manual change. */
const connectionManualUntil = { reconnect: 0, lobby: 0, notify: 0 };

function lockConnectionSwitch(key, ms = 120_000) {
  connectionManualUntil[key] = Date.now() + ms;
}

function connectionSwitchLocked(key) {
  return Date.now() < (connectionManualUntil[key] || 0);
}

function notifyPrefEnabled() {
  // Default ON when unset; only explicit "0" disables
  return localStorage.getItem("fractal-notify") !== "0";
}

function setNotifyPref(on) {
  localStorage.setItem("fractal-notify", on ? "1" : "0");
  syncNotifyToggleUi(true);
}

function notificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Keep captcha-notify checkbox in sync with local preference only (never auto-toggle). */
function syncNotifyToggleUi(force = false) {
  const btn = document.getElementById("toggle-notify");
  if (!btn) return;
  if (!force && (btn.dataset.userTouched === "1" || connectionSwitchLocked("notify"))) return;
  const perm = notificationPermission();
  const want = notifyPrefEnabled() && perm !== "denied" && perm !== "unsupported";
  btn.checked = want;
  btn.closest(".task-toggle")?.classList.toggle("on", want);
  btn.closest(".task-toggle")?.classList.toggle("warn", perm === "denied");
}

/** @deprecated name kept for older call sites */
function updateNotifyChip() {
  syncNotifyToggleUi(true);
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

/* —— Wire chat tabs (Tibia / Chat-Tabs style) —— */
const WIRE_MAIN = "main";
const WIRE_MAX_PER_TAB = 300;
const WHISPER_CMD = "w";
const WHISPER_ALIASES = new Set(["w", "msg", "tell", "whisper", "message"]);

/** @type {{ active: string, order: string[], tabs: Map<string, { key: string, name: string, unread: number, messages: object[] }> }} */
const wireChat = {
  active: WIRE_MAIN,
  order: [WIRE_MAIN],
  tabs: new Map([
    [WIRE_MAIN, { key: WIRE_MAIN, name: "Main", unread: 0, messages: [] }],
  ]),
};

const PLAYER_NAME_RE = "[A-Za-z0-9_.\\-]{2,32}";
const TS_PREFIX = "^(?:\\[[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\\]\\s*|<(?:[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)>\\s*)?";
const HEAD_PREFIX = "(?:\\[[^\\]]{1,48}\\]\\s*)?";
const ICON_PREFIX = "(?:[\\u00A0\\s]*(?:[<\\[][^>\\]]{0,32}[>\\]])\\s*)?";

const INCOMING_WHISPER_PATTERNS = (() => {
  const formats = [
    "{player} whispers: {message}",
    "{player} whispers to you: {message}",
    "[{player} -> You]: {message}",
    "{player} -> you: {message}",
    "[PM] {player}: {message}",
    "[MSG] {player}: {message}",
    "[WHISPER] {player}: {message}",
  ];
  const escapeLit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return formats.map((fmt) => {
    let pattern = "";
    let i = 0;
    while (i < fmt.length) {
      if (fmt.startsWith("{player}", i)) {
        pattern += `(${PLAYER_NAME_RE})`;
        i += "{player}".length;
      } else if (fmt.startsWith("{message}", i)) {
        pattern += "(.*)";
        i += "{message}".length;
      } else {
        pattern += escapeLit(fmt[i]);
        i += 1;
      }
    }
    return new RegExp(TS_PREFIX + HEAD_PREFIX + ICON_PREFIX + pattern + "$", "i");
  });
})();

const OUTGOING_WHISPER_RE = new RegExp(
  TS_PREFIX +
    HEAD_PREFIX +
    ICON_PREFIX +
    "(?:You|you)\\s+whispers?(?:ed)?\\s+to\\s+" +
    ICON_PREFIX +
    `(${PLAYER_NAME_RE})\\s*:?[ \\u00a0]*(.*)$`,
  "i",
);

function classifyWireMessage(raw) {
  const text = String(raw || "").trim();
  if (!text) return { type: "system", text };
  const out = text.match(OUTGOING_WHISPER_RE);
  if (out) {
    return {
      type: "whisper_out",
      player: out[1],
      body: (out[2] || "").trim(),
      text,
      key: out[1].toLowerCase(),
    };
  }
  for (const re of INCOMING_WHISPER_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const player = m[1];
      if (!player || /^(you|me)$/i.test(player)) continue;
      return {
        type: "whisper_in",
        player,
        body: (m[2] || "").trim(),
        text,
        key: player.toLowerCase(),
      };
    }
  }
  return { type: "public", text };
}

function ensureWireTab(key, name) {
  if (wireChat.tabs.has(key)) {
    const t = wireChat.tabs.get(key);
    if (name && t.name !== name) t.name = name;
    return t;
  }
  const tab = { key, name: name || key, unread: 0, messages: [] };
  wireChat.tabs.set(key, tab);
  if (!wireChat.order.includes(key)) wireChat.order.push(key);
  return tab;
}

function wireDisplayText(entry) {
  if (entry.kind === "whisper-in" && entry.player) {
    return `${entry.player} whispers: ${entry.body || entry.text}`;
  }
  if (entry.kind === "whisper-out" && entry.player) {
    return `You whisper to ${entry.player}: ${entry.body || entry.text}`;
  }
  return entry.text;
}

function appendEntryToLog(el, entry) {
  const li = document.createElement("li");
  li.className = entry.kind || "";
  const time = document.createElement("time");
  time.textContent = entry.at || fmtLocalTime();
  li.append(time, document.createTextNode(wireDisplayText(entry)));
  if (Array.isArray(entry.links) && entry.links.length) {
    for (const url of entry.links) {
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
  el.append(li);
}

function renderActiveWireLog() {
  const tab = wireChat.tabs.get(wireChat.active) || wireChat.tabs.get(WIRE_MAIN);
  const logs = document.querySelectorAll(".wire-log");
  for (const el of logs) {
    el.replaceChildren();
    if (!tab) continue;
    for (const entry of tab.messages) appendEntryToLog(el, entry);
    el.scrollTop = el.scrollHeight;
  }
}

function renderWireTabs() {
  const bars = [
    document.getElementById("wire-tabs"),
    document.getElementById("wire-tabs-map"),
  ].filter(Boolean);
  for (const bar of bars) {
    bar.replaceChildren();
    for (const key of wireChat.order) {
      const tab = wireChat.tabs.get(key);
      if (!tab) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wire-tab";
      if (key === wireChat.active) btn.classList.add("on");
      if (tab.unread > 0 && key !== wireChat.active) btn.classList.add("has-unread");
      btn.dataset.wireTab = key;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", key === wireChat.active ? "true" : "false");

      const label = document.createElement("span");
      label.textContent = tab.name;
      btn.append(label);

      if (tab.unread > 0 && key !== wireChat.active) {
        const badge = document.createElement("span");
        badge.className = "wire-unread";
        badge.textContent = tab.unread > 99 ? "99+" : String(tab.unread);
        btn.append(badge);
      }

      if (key !== WIRE_MAIN) {
        const close = document.createElement("span");
        close.className = "wire-close";
        close.textContent = "×";
        close.title = "Close tab";
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          closeWireTab(key);
        });
        btn.append(close);
      }

      btn.addEventListener("click", () => selectWireTab(key));
      bar.append(btn);
    }
  }
  updateWirePlaceholder();
}

function selectWireTab(key) {
  if (!wireChat.tabs.has(key)) key = WIRE_MAIN;
  wireChat.active = key;
  const tab = wireChat.tabs.get(key);
  if (tab) tab.unread = 0;
  renderWireTabs();
  renderActiveWireLog();
}

function closeWireTab(key) {
  if (key === WIRE_MAIN) return;
  wireChat.tabs.delete(key);
  wireChat.order = wireChat.order.filter((k) => k !== key);
  if (wireChat.active === key) {
    wireChat.active = wireChat.order[wireChat.order.length - 1] || WIRE_MAIN;
    const active = wireChat.tabs.get(wireChat.active);
    if (active) active.unread = 0;
  }
  renderWireTabs();
  renderActiveWireLog();
}

function updateWirePlaceholder() {
  const active = wireChat.tabs.get(wireChat.active);
  const isPrivate = wireChat.active !== WIRE_MAIN && active;
  const ph = isPrivate
    ? `Reply to ${active.name} (or /command)`
    : "say in chat, or /command";
  for (const id of ["say-input", "say-input-map"]) {
    const input = document.getElementById(id);
    if (input) input.placeholder = ph;
  }
}

function pushWireEntry(entry) {
  const main = ensureWireTab(WIRE_MAIN, "Main");
  main.messages.push(entry);
  if (main.messages.length > WIRE_MAX_PER_TAB) main.messages.splice(0, main.messages.length - WIRE_MAX_PER_TAB);

  if (entry.playerKey && entry.playerKey !== WIRE_MAIN) {
    const priv = ensureWireTab(entry.playerKey, entry.player || entry.playerKey);
    priv.messages.push(entry);
    if (priv.messages.length > WIRE_MAX_PER_TAB) priv.messages.splice(0, priv.messages.length - WIRE_MAX_PER_TAB);
    if (wireChat.active !== priv.key) priv.unread += 1;
  }

  renderWireTabs();
  renderActiveWireLog();
}

function push(kind, text, links) {
  const raw = text == null ? "" : String(text);
  let entry = {
    kind: kind || "",
    text: raw,
    links: Array.isArray(links) ? links : undefined,
    at: fmtLocalTime(),
  };

  if (!kind || kind === "") {
    const c = classifyWireMessage(raw);
    if (c.type === "whisper_in") {
      entry = {
        kind: "whisper-in",
        text: raw,
        body: c.body,
        player: c.player,
        playerKey: c.key,
        at: entry.at,
      };
    } else if (c.type === "whisper_out") {
      entry = {
        kind: "whisper-out",
        text: raw,
        body: c.body,
        player: c.player,
        playerKey: c.key,
        at: entry.at,
      };
    }
  }

  pushWireEntry(entry);
}

/** Parse `/w name body` style outbound so we open/bump the private tab immediately. */
function noteOutgoingWhisperCommand(commandText) {
  const c = String(commandText || "").trim().replace(/^\//, "");
  const parts = c.split(/\s+/);
  if (parts.length < 3) return;
  const base = parts[0].toLowerCase();
  if (!WHISPER_ALIASES.has(base)) return;
  const player = parts[1];
  const body = parts.slice(2).join(" ");
  if (!player || !body) return;
  pushWireEntry({
    kind: "whisper-out",
    text: `You whisper to ${player}: ${body}`,
    body,
    player,
    playerKey: player.toLowerCase(),
    at: fmtLocalTime(),
  });
}

async function sendWireMessage(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  if (trimmed.startsWith("/")) {
    const cmd = trimmed.slice(1);
    noteOutgoingWhisperCommand(cmd);
    await rpc("command", { command: cmd });
    return;
  }
  const active = wireChat.tabs.get(wireChat.active);
  if (wireChat.active !== WIRE_MAIN && active?.name) {
    const cmd = `${WHISPER_CMD} ${active.name} ${trimmed}`;
    noteOutgoingWhisperCommand(cmd);
    await rpc("command", { command: cmd });
    return;
  }
  await rpc("chat", { message: trimmed });
}

/* —— Slash-command suggestions (Minecraft-style) —— */
const MC_COMMANDS = [
  { cmd: "w", hint: "<player> <msg>", playerArg: true },
  { cmd: "msg", hint: "<player> <msg>", playerArg: true },
  { cmd: "tell", hint: "<player> <msg>", playerArg: true },
  { cmd: "whisper", hint: "<player> <msg>", playerArg: true },
  { cmd: "r", hint: "<msg> reply last whisper" },
  { cmd: "reply", hint: "<msg>" },
  { cmd: "tpa", hint: "<player>", playerArg: true },
  { cmd: "tpahere", hint: "<player>", playerArg: true },
  { cmd: "tpaccept", hint: "accept TPA" },
  { cmd: "tpdeny", hint: "deny TPA" },
  { cmd: "tpcancel", hint: "cancel outgoing TPA" },
  { cmd: "home", hint: "[name]" },
  { cmd: "sethome", hint: "[name]" },
  { cmd: "delhome", hint: "<name>" },
  { cmd: "homes", hint: "list homes" },
  { cmd: "spawn", hint: "go to spawn" },
  { cmd: "kill", hint: "suicide" },
  { cmd: "ignore", hint: "<player>", playerArg: true },
  { cmd: "unignore", hint: "<player>", playerArg: true },
  { cmd: "ignorelist", hint: "list ignored" },
  { cmd: "login", hint: "<password>" },
  { cmd: "register", hint: "<password> <password>" },
  { cmd: "changepassword", hint: "<old> <new>" },
  { cmd: "discord", hint: "link / info" },
  { cmd: "help", hint: "[command]" },
  { cmd: "me", hint: "<action>" },
  { cmd: "msg", hint: "<player> <msg>", playerArg: true },
  { cmd: "pm", hint: "<player> <msg>", playerArg: true },
];

// Dedupe by cmd name (keep first)
const MC_COMMAND_LIST = (() => {
  const seen = new Set();
  const out = [];
  for (const c of MC_COMMANDS) {
    if (seen.has(c.cmd)) continue;
    seen.add(c.cmd);
    out.push(c);
  }
  return out;
})();

const PLAYER_ARG_COMMANDS = new Set(
  MC_COMMAND_LIST.filter((c) => c.playerArg).map((c) => c.cmd),
);

function collectSuggestPlayers(prefix) {
  const selfName = (window.__fractalStatus?.username || "").toLowerCase();
  const names = new Set();
  for (const n of knownPlayerNames) names.add(n);
  for (const key of wireChat.order) {
    if (key === WIRE_MAIN) continue;
    const t = wireChat.tabs.get(key);
    if (t?.name) names.add(t.name);
  }
  const pfx = String(prefix || "").toLowerCase();
  return [...names]
    .filter((n) => n && n.toLowerCase() !== selfName)
    .filter((n) => !pfx || n.toLowerCase().startsWith(pfx))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .slice(0, 12);
}

function buildCommandSuggestions(value) {
  const text = String(value || "");
  if (!text.startsWith("/")) return [];

  const body = text.slice(1);
  const space = body.indexOf(" ");
  // Still typing the command name
  if (space < 0) {
    const pfx = body.toLowerCase();
    return MC_COMMAND_LIST.filter((c) => !pfx || c.cmd.startsWith(pfx))
      .slice(0, 12)
      .map((c) => ({
        kind: "cmd",
        label: `/${c.cmd}`,
        insert: `/${c.cmd} `,
        hint: c.hint || "",
      }));
  }

  const cmdName = body.slice(0, space).toLowerCase();
  const after = body.slice(space + 1);
  // Player-arg commands: suggest names for the first argument only
  if (PLAYER_ARG_COMMANDS.has(cmdName) && !after.includes(" ")) {
    return collectSuggestPlayers(after).map((name) => ({
      kind: "player",
      label: name,
      insert: `/${cmdName} ${name} `,
      hint: "player",
    }));
  }
  return [];
}

function bindSaySuggestions(inputId, listId) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!input || !list) return;

  let items = [];
  let active = -1;

  const hide = () => {
    list.hidden = true;
    list.replaceChildren();
    items = [];
    active = -1;
  };

  const render = () => {
    list.replaceChildren();
    if (!items.length) {
      list.hidden = true;
      return;
    }
    list.hidden = false;
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      if (i === active) li.classList.add("on");
      const cmd = document.createElement("span");
      cmd.className = "sg-cmd";
      cmd.textContent = it.label;
      li.append(cmd);
      if (it.hint) {
        const hint = document.createElement("span");
        hint.className = "sg-hint";
        hint.textContent = it.hint;
        li.append(hint);
      }
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        apply(i);
      });
      list.append(li);
    });
  };

  const refresh = () => {
    items = buildCommandSuggestions(input.value);
    active = items.length ? 0 : -1;
    render();
  };

  const apply = (index) => {
    const it = items[index];
    if (!it) return;
    input.value = it.insert;
    input.focus();
    const pos = input.value.length;
    input.setSelectionRange(pos, pos);
    refresh();
  };

  input.addEventListener("input", refresh);
  input.addEventListener("focus", refresh);
  input.addEventListener("blur", () => {
    // Delay so mousedown on a suggestion can fire
    setTimeout(hide, 120);
  });

  input.addEventListener("keydown", (e) => {
    if (list.hidden || !items.length) {
      if (e.key === "Tab" && input.value.startsWith("/")) {
        // Force a refresh and try complete
        items = buildCommandSuggestions(input.value);
        if (items.length) {
          e.preventDefault();
          apply(0);
        }
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % items.length;
      render();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + items.length) % items.length;
      render();
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && e.shiftKey === false && items.length && active >= 0 && e.target.value.match(/^\/\S*$/))) {
      // Tab always completes; Enter only completes when still on bare command name
      if (e.key === "Tab" || /^\/\S*$/.test(input.value)) {
        e.preventDefault();
        apply(active >= 0 ? active : 0);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });
}

bindSaySuggestions("say-input", "say-suggest");
bindSaySuggestions("say-input-map", "say-suggest-map");

// Initial tab bar
renderWireTabs();
renderActiveWireLog();

function eventBotId(data) {
  if (data && typeof data === "object" && data.botId) return String(data.botId);
  return "";
}

function isActiveBotEvent(data) {
  if (!selectedBotId) return true;
  const id = eventBotId(data);
  if (!id) return true; // legacy untagged events
  return id === selectedBotId;
}

let lastSeenChat = "";

/** Usernames seen on tab list / nearby — used for /w and /tpa suggestions. */
const knownPlayerNames = new Set();

function rememberPlayers(players) {
  const selfName = (window.__fractalStatus?.username || "").toLowerCase();
  for (const p of players || []) {
    const n = String(p?.username || "").trim();
    if (!n) continue;
    if (n.toLowerCase() === selfName) continue;
    knownPlayerNames.add(n);
  }
  // Cap memory
  if (knownPlayerNames.size > 400) {
    const keep = [...knownPlayerNames].slice(-300);
    knownPlayerNames.clear();
    for (const n of keep) knownPlayerNames.add(n);
  }
}

function renderPlayers(players) {
  const ul = document.getElementById("players");
  ul.innerHTML = "";
  rememberPlayers(players);
  // Nearby = loaded entities only (have distance). Tab-list ghosts with no
  // pose are excluded so the panel does not fill with the whole server.
  const selfName = (window.__fractalStatus?.username || "").toLowerCase();
  const rows = (players || [])
    .filter((p) => p && p.distance != null && Number.isFinite(p.distance))
    .filter((p) => String(p.username || "").toLowerCase() !== selfName)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 40);
  document.getElementById("player-count").textContent = rows.length ? `(${rows.length})` : "";
  for (const p of rows) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = String(p.username ?? "");
    const distEl = document.createElement("span");
    distEl.textContent = `${Number(p.distance).toFixed(1)}m`;
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

function itemLabel(item) {
  if (!item) return "";
  for (const key of ["displayName", "customName", "name"]) {
    let v = item[key];
    if (v && typeof v === "object") {
      v = v.text || v.value || v.toMotd?.() || v.getText?.() || "";
    }
    v = String(v || "").trim();
    if (v && v !== "[object Object]") return v;
  }
  return "item";
}

function shortTag(name) {
  // Guard against ChatMessage / object values that used to render as "[OBJE"
  let raw = name;
  if (raw && typeof raw === "object") {
    raw = raw.text || raw.value || raw.toMotd?.() || raw.getText?.() || "";
  }
  raw = String(raw || "").trim();
  if (!raw || raw === "[object Object]") return "?";
  const parts = raw.replace(/^minecraft:/, "").split("_").filter(Boolean);
  if (!parts.length) return raw.slice(0, 5);
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
    const label = itemLabel(item);
    btn.title = item
      ? `${label} ×${item.count}`
      : SLOT_LABELS[slot] || `empty ${slot}`;
    btn.style.background = item ? itemTint(item.name) : "";
    // Slot badge = item TYPE (gapple, totem…), never custom anvil name —
    // custom names often share a kit prefix and made every cell read "FRACT".
    tag.textContent = item ? shortTag(item.name || label) : "";
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
  fillCells(document.getElementById("inv-gear"), [5, 6, 7, 8], bySlot, heldSlot);
  fillCells(document.getElementById("inv-offhand"), [45], bySlot, heldSlot);
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
    heldEl.textContent = held ? `${itemLabel(held)} ×${held.count}` : "hands empty";
  }
  const selected = selectedSlot == null ? null : bySlot.get(selectedSlot);
  const nameEl = document.getElementById("inv-name");
  if (nameEl) {
    if (selectedSlot == null) nameEl.textContent = "click a slot · click another to swap";
    else if (selected) nameEl.textContent = `${itemLabel(selected)}  slot ${selectedSlot}  ×${selected.count}`;
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

function botQuery() {
  return selectedBotId ? `?botId=${encodeURIComponent(selectedBotId)}` : "";
}

let lastPlayersInvFetch = 0;

function activeDashboardTab() {
  const panel = document.querySelector(".tab-panel:not([hidden])");
  return panel?.getAttribute("data-tab") || "play";
}

/**
 * Live dashboard refresh.
 * Status is also pushed on the WebSocket — HTTP is a backup.
 * Players/inventory payloads are larger; only fetch them on the Play tab
 * and at a slower cadence so mobile data stays reasonable with 3D off.
 */
async function refresh(opts = {}) {
  if (document.hidden && !opts.force) return;
  try {
    const q = botQuery();
    const tab = activeDashboardTab();
    const onPlay = tab === "play";
    const detailGap = isView3dPrefEnabled() ? 4000 : 8000;
    const wantDetail =
      opts.force ||
      (onPlay && Date.now() - lastPlayersInvFetch >= detailGap);

    const jobs = [
      fetch(`/v1/status${q}`, { credentials: "same-origin", headers: headers() }).then((r) =>
        r.json(),
      ),
    ];
    if (wantDetail) {
      jobs.push(
        fetch(`/v1/players${q}`, { credentials: "same-origin", headers: headers() })
          .then((r) => r.json())
          .catch(() => ({})),
        fetch(`/v1/inventory${q}`, { credentials: "same-origin", headers: headers() })
          .then((r) => r.json())
          .catch(() => ({})),
      );
    }

    const results = await Promise.all(jobs);
    const st = results[0];
    if (st.ok) renderStatus(st.data);
    else if (
      st.error &&
      st.error !== "No bot running. Add an account and fleetStart it, or fleetStartAll."
    ) {
      push(
        "err",
        st.error === "unauthorized"
          ? "unauthorized · refresh http://127.0.0.1:37637/"
          : st.error,
      );
    }

    if (wantDetail) {
      lastPlayersInvFetch = Date.now();
      const players = results[1] || {};
      const inv = results[2] || {};
      if (players.ok) {
        renderPlayers(players.data);
        window.fractalSurvey?.setPlayers(players.data);
      }
      if (inv.ok) renderInventory(inv.data);
    }
  } catch {
    push("err", "control API is down · bot process not running");
  }
}

const VIEW3D_PREF_KEY = "fractal.view3dEnabled";
const VIEW3D_QUALITY_KEY = "fractal.view3dQuality";

function isView3dPrefEnabled() {
  try {
    const v = localStorage.getItem(VIEW3D_PREF_KEY);
    // Default OFF — terrain polling is the heavy data path on mobile
    if (v === null) return false;
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

function setView3dPref(on) {
  try {
    localStorage.setItem(VIEW3D_PREF_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
  applyView3dState();
}

function getView3dQuality() {
  try {
    if (localStorage.getItem(VIEW3D_QUALITY_KEY) === "full") return "full";
  } catch {
    /* ignore */
  }
  return "lite"; // default: low-bandwidth
}

function setView3dQuality(q) {
  const next = q === "full" ? "full" : "lite";
  try {
    localStorage.setItem(VIEW3D_QUALITY_KEY, next);
  } catch {
    /* ignore */
  }
  const sel = document.getElementById("view3d-quality");
  if (sel) sel.value = next;
  applyView3dState();
  void refreshVoxels();
}

/** Bot is connected / running so a terrain fetch is useful. */
function isBotLiveForView() {
  if (selectedBotId && fleetState?.bots) {
    const bot = fleetState.bots.find((b) => b.id === selectedBotId);
    if (bot) {
      // Explicit online-off → stop 3D immediately (even if still disconnecting)
      if (bot.features && bot.features.online === false) return false;
      if (bot.bot?.connected) return true;
      return false;
    }
  }
  return Boolean(status?.connected);
}

function applyView3dState() {
  const want = isView3dPrefEnabled() && isBotLiveForView();
  const shared = document.getElementById("survey-shared");
  if (shared) {
    // Keep in DOM but dim when off so layout does not jump hard
    shared.classList.toggle("view3d-off", !want);
    shared.setAttribute("aria-hidden", want ? "false" : "true");
  }
  try {
    window.fractalSurvey?.setEnabled?.(want);
  } catch {
    /* survey may not be ready */
  }
  const toggle = document.getElementById("toggle-view3d");
  if (toggle) {
    toggle.checked = isView3dPrefEnabled();
    toggle.closest(".task-toggle")?.classList.toggle("on", toggle.checked);
  }
  const badge = document.getElementById("view3d-state");
  if (badge) {
    if (!isView3dPrefEnabled()) badge.textContent = "3D off (settings)";
    else if (!isBotLiveForView()) badge.textContent = "3D paused (offline)";
    else badge.textContent = `3D on · ${getView3dQuality()}`;
  }
}

async function refreshVoxels() {
  if (!window.fractalSurvey) return;
  // No preference or bot offline → do not hit /v1/voxels (saves mobile data)
  if (!isView3dPrefEnabled() || !isBotLiveForView()) {
    applyView3dState();
    return;
  }
  try {
    const quality = getView3dQuality();
    const r =
      quality === "lite"
        ? Math.min(12, window.fractalSurvey.radius ?? 12)
        : window.fractalSurvey.radius ?? 20;
    const qs = new URLSearchParams();
    qs.set("r", String(r));
    qs.set("q", quality);
    if (selectedBotId) qs.set("botId", selectedBotId);
    const res = await fetch(`/v1/voxels?${qs}`, {
      credentials: "same-origin",
      headers: headers(),
    }).then((row) => row.json());
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
    if (msg.event === "status") {
      if (isActiveBotEvent(msg.data)) renderStatus(msg.data);
      // Surface lastChat from status if live chat event was missed
      const lc = msg.data?.lastChat;
      if (lc && isActiveBotEvent(msg.data) && lc !== lastSeenChat) {
        lastSeenChat = lc;
        push("", lc);
      }
    }
    if (msg.event === "phase") {
      if (!isActiveBotEvent(msg.data)) return;
      const phaseVal = msg.data?.value ?? msg.data;
      const phaseEl = document.getElementById("phase");
      if (phaseEl) phaseEl.textContent = String(phaseVal ?? "");
      push("sys", `phase ${phaseVal}`);
    }
    if (msg.event === "chat") {
      if (!isActiveBotEvent(msg.data)) return;
      const raw = msg.data?.raw ?? (typeof msg.data === "string" ? msg.data : "");
      if (!raw) return;
      lastSeenChat = raw;
      push("", raw);
    }
    if (msg.event === "kicked") {
      if (!isActiveBotEvent(msg.data)) return;
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
    if (msg.event === "disconnected") {
      if (!isActiveBotEvent(msg.data)) return;
      const val = msg.data?.value ?? msg.data;
      push("err", `disconnected: ${val ?? ""}`);
    }
    if (msg.event === "authenticated") {
      if (!isActiveBotEvent(msg.data)) return;
      push("sys", "authenticated");
    }
    if (msg.event === "worldKind") push("sys", `world ${msg.data}`);
    if (msg.event === "portalEntered") push("sys", `portal ${msg.data?.count ?? ""}`);
    if (msg.event === "error" && !msg.data?.lastError) {
      if (!isActiveBotEvent(msg.data)) return;
      push("err", msg.data?.message ?? "error");
    }
    if (msg.event === "detection") {
      if (!isActiveBotEvent(msg.data)) return;
      appendDetectionEvent(msg.data);
      // Refresh nearby list when presence changes
      if (msg.data?.kind === "player_enter" || msg.data?.kind === "player_leave") {
        void refreshDetection();
      }
    }
  });
}

async function sendControl() {
  const packed = JSON.stringify(keys);
  if (packed === lastControl) return;
  lastControl = packed;
  await rpc("control", { state: keys });
}


/* On-screen steer pad (touch / mouse) */
(function bindSteerPad() {
  const press = (control, down) => {
    if (!control) return;
    if (down) {
      if (keys[control]) return;
      keys[control] = true;
      document.querySelectorAll(`[data-k="${control}"]`).forEach((el) => el.classList.add("down"));
    } else {
      if (!keys[control]) return;
      keys[control] = false;
      document.querySelectorAll(`[data-k="${control}"]`).forEach((el) => el.classList.remove("down"));
    }
    void sendControl();
  };
  document.querySelectorAll(".pad [data-k]").forEach((el) => {
    const control = el.getAttribute("data-k");
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      press(control, true);
    });
    el.addEventListener("pointerup", (e) => {
      e.preventDefault();
      press(control, false);
    });
    el.addEventListener("pointercancel", () => press(control, false));
    el.addEventListener("pointerleave", () => press(control, false));
  });
})();

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

document.getElementById("captcha-dismiss")?.addEventListener("click", () => {
  hideCaptchaBanner();
});

// Captcha notify: change-only (no click handler — click+change used to fight each other)

document.getElementById("say").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("say-input");
  const text = input.value.trim();
  if (!text) return;
  await sendWireMessage(text);
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

// —— Detection tab (players / crystals / TNT) ——
const detectionEvents = [];
const DETECTION_MAX = 150;

/* —— Detection push notification prefs (this browser) —— */
const DET_NOTIFY_KEYS = {
  playerEnter: "fractal-det-notify-enter",
  playerLeave: "fractal-det-notify-leave",
  combat: "fractal-det-notify-combat",
  crystals: "fractal-det-notify-crystals",
  tnt: "fractal-det-notify-tnt",
  explosions: "fractal-det-notify-explosions",
  onlyHidden: "fractal-det-notify-hidden",
};

function detNotifyPref(key, defaultOn) {
  try {
    const v = localStorage.getItem(key);
    if (v === null || v === undefined || v === "") return defaultOn;
    return v === "1" || v === "true";
  } catch {
    return defaultOn;
  }
}

function setDetNotifyPref(key, on) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function loadDetNotifyPrefs() {
  return {
    playerEnter: detNotifyPref(DET_NOTIFY_KEYS.playerEnter, true),
    playerLeave: detNotifyPref(DET_NOTIFY_KEYS.playerLeave, false),
    combat: detNotifyPref(DET_NOTIFY_KEYS.combat, true),
    crystals: detNotifyPref(DET_NOTIFY_KEYS.crystals, false),
    tnt: detNotifyPref(DET_NOTIFY_KEYS.tnt, false),
    explosions: detNotifyPref(DET_NOTIFY_KEYS.explosions, false),
    onlyHidden: detNotifyPref(DET_NOTIFY_KEYS.onlyHidden, true),
  };
}

function saveDetNotifyPrefsFromForm(form) {
  if (!form) return;
  const boolSel = (v) => v === "true" || v === true;
  if (form.notifyPlayerEnter) setDetNotifyPref(DET_NOTIFY_KEYS.playerEnter, boolSel(form.notifyPlayerEnter.value));
  if (form.notifyPlayerLeave) setDetNotifyPref(DET_NOTIFY_KEYS.playerLeave, boolSel(form.notifyPlayerLeave.value));
  if (form.notifyCombat) setDetNotifyPref(DET_NOTIFY_KEYS.combat, boolSel(form.notifyCombat.value));
  if (form.notifyCrystals) setDetNotifyPref(DET_NOTIFY_KEYS.crystals, boolSel(form.notifyCrystals.value));
  if (form.notifyTnt) setDetNotifyPref(DET_NOTIFY_KEYS.tnt, boolSel(form.notifyTnt.value));
  if (form.notifyExplosions) setDetNotifyPref(DET_NOTIFY_KEYS.explosions, boolSel(form.notifyExplosions.value));
  if (form.notifyOnlyHidden) setDetNotifyPref(DET_NOTIFY_KEYS.onlyHidden, boolSel(form.notifyOnlyHidden.value));
}

function fillDetNotifyForm(form) {
  if (!form) return;
  const p = loadDetNotifyPrefs();
  if (form.notifyPlayerEnter) form.notifyPlayerEnter.value = p.playerEnter ? "true" : "false";
  if (form.notifyPlayerLeave) form.notifyPlayerLeave.value = p.playerLeave ? "true" : "false";
  if (form.notifyCombat) form.notifyCombat.value = p.combat ? "true" : "false";
  if (form.notifyCrystals) form.notifyCrystals.value = p.crystals ? "true" : "false";
  if (form.notifyTnt) form.notifyTnt.value = p.tnt ? "true" : "false";
  if (form.notifyExplosions) form.notifyExplosions.value = p.explosions ? "true" : "false";
  if (form.notifyOnlyHidden) form.notifyOnlyHidden.value = p.onlyHidden ? "true" : "false";
}

function detectionNotifyWanted(kind) {
  const p = loadDetNotifyPrefs();
  if (kind === "player_enter") return p.playerEnter;
  if (kind === "player_leave") return p.playerLeave;
  if (kind === "attacked" || kind === "death" || kind === "hurt") return p.combat;
  if (kind === "crystal_spawn" || kind === "crystal_gone") return p.crystals;
  if (kind === "tnt_spawn" || kind === "tnt_gone") return p.tnt;
  if (kind === "explosion") return p.explosions;
  return false;
}

function notifyDetection(ev) {
  if (!ev || !ev.kind) return;
  if (!detectionNotifyWanted(ev.kind)) return;
  const prefs = loadDetNotifyPrefs();
  if (prefs.onlyHidden && !document.hidden) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const title =
    ev.kind === "player_enter"
      ? "Player nearby"
      : ev.kind === "player_leave"
        ? "Player left range"
        : ev.kind === "attacked" || ev.kind === "hurt"
          ? "Under attack"
          : ev.kind === "death"
            ? "Bot died"
            : ev.kind?.startsWith("crystal")
              ? "Crystal"
              : ev.kind?.startsWith("tnt")
                ? "TNT"
                : ev.kind === "explosion"
                  ? "Explosion"
                  : "Detection";
  const body = String(ev.message || ev.label || ev.kind).slice(0, 160);
  const tag = `fractal-det-${ev.kind}-${ev.label || "x"}`.slice(0, 64);

  const payload = {
    type: "detection-notify",
    title,
    body,
    tag,
    url: "/#detect",
  };

  if (swRegistration?.active) {
    swRegistration.active.postMessage(payload);
    return;
  }
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage(payload);
    return;
  }
  try {
    const n = new Notification(title, {
      body,
      tag,
      renotify: true,
    });
    n.onclick = () => {
      window.focus();
      try {
        location.hash = "detect";
      } catch {
        /* ignore */
      }
      n.close();
    };
  } catch (err) {
    console.warn("detection notification failed", err);
  }
}

function appendDetectionEvent(ev) {
  if (!ev || !ev.message) return;
  const id = ev.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (ev.id && detectionSeenIds.has(ev.id)) return;
  // de-dupe identical spam within 300ms
  const head = detectionEvents[0];
  if (
    head &&
    head.kind === ev.kind &&
    head.message === ev.message &&
    Math.abs(new Date(head.at).getTime() - new Date(ev.at || Date.now()).getTime()) < 300
  ) {
    if (ev.id) detectionSeenIds.add(ev.id);
    return;
  }
  if (ev.id) detectionSeenIds.add(ev.id);
  notifyDetection(ev);
  detectionEvents.unshift({
    id,
    at: ev.at || new Date().toISOString(),
    kind: ev.kind || "info",
    message: ev.message,
    label: ev.label,
    position: ev.position,
    distance: ev.distance,
  });
  if (detectionEvents.length > DETECTION_MAX) detectionEvents.length = DETECTION_MAX;
  renderDetectionLog();
}

function renderDetectionLog() {
  const ol = document.getElementById("detect-log");
  if (!ol) return;
  ol.replaceChildren();
  for (const ev of detectionEvents.slice(0, 80)) {
    const li = document.createElement("li");
    li.className = ev.kind || "";
    const time = document.createElement("time");
    time.textContent = fmtLocalFrom(ev.at);
    li.append(time, document.createTextNode(ev.message));
    ol.append(li);
  }
}

/** After an intentional Clear, do not re-hydrate from the server ring buffer. */
let detectionCleared = false;
/** Ids already shown — used to pull only *new* server events after a clear. */
const detectionSeenIds = new Set();

async function refreshDetection() {
  if (!selectedBotId && !status?.connected) return;
  try {
    const body = await rpc("detection", {});
    if (!body.ok || !body.data) return;
    const serverEvents = Array.isArray(body.data.events) ? body.data.events : [];

    if (!detectionEvents.length && !detectionCleared) {
      // Page reload / first open — hydrate full history once
      for (const ev of [...serverEvents].reverse()) {
        if (ev?.id) detectionSeenIds.add(ev.id);
        appendDetectionEvent(ev);
      }
      return;
    }

    // After clear (or while log has items): only append events we have not seen
    for (const ev of [...serverEvents].reverse()) {
      if (!ev?.id || detectionSeenIds.has(ev.id)) continue;
      detectionSeenIds.add(ev.id);
      appendDetectionEvent(ev);
    }
  } catch {
    /* ignore */
  }
}

document.getElementById("detect-clear")?.addEventListener("click", () => {
  detectionEvents.length = 0;
  detectionSeenIds.clear();
  detectionCleared = true;
  renderDetectionLog();
  void rpc("clearDetection", {}).catch(() => {});
});

connectEvents();
void refresh({ force: true });
applyView3dState();
void refreshVoxels();
void refreshDetection();
setInterval(() => {
  if (document.hidden) return;
  if (activeDashboardTab() === "detect") void refreshDetection();
}, 5000);

// Status HTTP backup — WS already streams status. Keep this slow on mobile.
setInterval(() => {
  if (document.hidden) return;
  void refresh();
}, 4000);

// Adaptive voxel poll only when 3D is enabled + bot live
let lastVoxelPoll = 0;
setInterval(() => {
  if (document.hidden) return;
  if (!isView3dPrefEnabled() || !isBotLiveForView()) return;
  const gap = getView3dQuality() === "full" ? 3000 : 6000;
  const now = Date.now();
  if (now - lastVoxelPoll < gap) return;
  lastVoxelPoll = now;
  void refreshVoxels();
}, 1000);

// Pause work when the tab is backgrounded (saves radio + battery)
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh({ force: true });
});

document.getElementById("toggle-view3d")?.addEventListener("change", (e) => {
  setView3dPref(Boolean(e.target.checked));
  if (e.target.checked) void refreshVoxels();
});
document.getElementById("view3d-quality")?.addEventListener("change", (e) => {
  setView3dQuality(e.target.value);
});
// Sync quality select on load
{
  const sel = document.getElementById("view3d-quality");
  if (sel) sel.value = getView3dQuality();
}

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


// —— Process settings (Settings tab) + per-tab profile settings drawer ——
function openTabSettings(kind) {
  const overlay = document.getElementById("tab-settings-overlay");
  if (!overlay) return;
  const title = document.getElementById("tab-settings-title");
  const titles = {
    play: "Play settings",
    map: "Map settings",
    announce: "Announce settings",
    detect: "Detection settings",
  };
  if (title) title.textContent = titles[kind] || "Settings";
  document.querySelectorAll(".tab-settings-block").forEach((block) => {
    const show = block.getAttribute("data-for") === kind;
    block.hidden = !show;
  });
  const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
  fillProfileSettingsForm(bot);
  // Show save only for play/map/detect (announce uses its own save)
  const saveBtn = document.getElementById("settings-save");
  if (saveBtn) saveBtn.hidden = kind === "announce";
  overlay.hidden = false;
}

function closeTabSettings() {
  const overlay = document.getElementById("tab-settings-overlay");
  if (overlay) overlay.hidden = true;
}

document.querySelectorAll("[data-open-settings]").forEach((btn) => {
  btn.addEventListener("click", () => openTabSettings(btn.getAttribute("data-open-settings")));
});
document.getElementById("tab-settings-close")?.addEventListener("click", () => closeTabSettings());
document.getElementById("tab-settings-close-bottom")?.addEventListener("click", () => closeTabSettings());
document.getElementById("tab-settings-overlay")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeTabSettings();
});

async function loadSettingsForm() {
  const form = document.getElementById("settings-form");
  const pathEl = document.getElementById("settings-path");
  const msg = document.getElementById("settings-msg-global");
  if (!form) return;
  if (msg) msg.hidden = true;
  const body = await rpc("getSettings", {});
  if (!body.ok || !body.data) {
    if (msg) {
      msg.hidden = false;
      msg.className = "settings-msg err";
      msg.textContent = body.error || "failed to load settings";
    }
    return;
  }
  const { path: storePath, folder, fields } = body.data;
  if (pathEl) pathEl.textContent = storePath || folder || "Settings/settings.json";
  form.replaceChildren();
  const groups = new Map();
  for (const f of fields || []) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  for (const [group, list] of groups) {
    const box = document.createElement("details");
    box.className = "settings-group";
    box.open = true;
    const sum = document.createElement("summary");
    sum.textContent = group;
    box.append(sum);
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
  const msg = document.getElementById("settings-msg-global");
  if (!form) return;
  const values = {};
  form.querySelectorAll("[data-key]").forEach((el) => {
    values[el.dataset.key] = el.value;
  });
  const body = await rpc("saveSettings", { values });
  if (msg) {
    msg.hidden = false;
    if (!body.ok) {
      msg.className = "settings-msg err";
      msg.textContent = body.error || "save failed";
      return;
    }
    const d = body.data || {};
    msg.className = "settings-msg ok";
    let text = `Saved ${(d.saved || []).length} process setting(s)`;
    if (d.restartRequired) text += ` · restart: ${(d.restartKeys || []).join(", ")}`;
    msg.textContent = text;
    push("sys", text);
  }
  await loadSettingsForm();
}

document.getElementById("settings-reload")?.addEventListener("click", () => void loadSettingsForm());
document.getElementById("settings-save-global")?.addEventListener("click", () => void saveSettingsForm());
void loadSettingsForm();

// —— Fleet / Profiles (unified) ——
function shortId(id) {
  return String(id || "").slice(0, 8);
}

function phaseToneForBot(bot) {
  if (!bot) return "neutral";
  const phase = bot.bot?.phase || (bot.running ? "running" : "stopped");
  if (phase === "in_game") return "live";
  if (phase === "running" || phase === "connecting" || phase === "reconnecting") return "warn";
  if (bot.bot?.lastKickKind === "captcha" || bot.bot?.lastError) return "fail";
  return "neutral";
}

function updateProfileSelectorUI() {
  const labelEl = document.getElementById("ps-label");
  const metaEl = document.getElementById("ps-meta");
  const dotEl = document.getElementById("ps-status-dot");
  const activeLabel = document.getElementById("active-bot-label");
  const bots = fleetState?.bots || [];
  const bot = bots.find((b) => b.id === selectedBotId) || null;

  if (!bot) {
    if (labelEl) labelEl.textContent = "No profile";
    if (metaEl) metaEl.textContent = bots.length ? "Select a profile" : "Add a profile in Fleet";
    if (dotEl) dotEl.dataset.tone = "neutral";
    if (activeLabel) activeLabel.textContent = "no profile selected";
    return;
  }

  const name = bot.label || bot.username || shortId(bot.id);
  const phase = bot.bot?.phase || (bot.running ? "running" : "stopped");
  const summary = bot.featuresSummary || phase;
  if (labelEl) labelEl.textContent = name;
  if (metaEl) metaEl.textContent = `${phase} · ${summary}`;
  if (dotEl) dotEl.dataset.tone = phaseToneForBot(bot);
  if (activeLabel) activeLabel.textContent = `(${name})`;
}

function renderProfileDropdown() {
  const list = document.getElementById("pd-list");
  const empty = document.getElementById("pd-empty");
  if (!list) return;
  list.replaceChildren();
  const bots = fleetState?.bots || [];
  if (empty) empty.hidden = bots.length > 0;
  for (const b of bots) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pd-item" + (b.id === selectedBotId ? " active" : "");
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", b.id === selectedBotId ? "true" : "false");
    btn.dataset.select = b.id;
    const phase = b.bot?.phase || (b.running ? "running" : "stopped");
    const tone = phaseToneForBot(b);
    btn.innerHTML = `
      <span class="pd-dot" data-tone="${tone}"></span>
      <span class="pd-text">
        <span class="pd-name">${escapeHtml(b.label || b.username)}</span>
        <span class="pd-sub">${escapeHtml(b.username)} · ${escapeHtml(phase)}</span>
      </span>`;
    list.append(btn);
  }
}

function closeProfileDropdown() {
  const dd = document.getElementById("profile-dropdown");
  const btn = document.getElementById("profile-selector-btn");
  if (dd) dd.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function openProfileDropdown() {
  const dd = document.getElementById("profile-dropdown");
  const btn = document.getElementById("profile-selector-btn");
  if (dd) dd.hidden = false;
  if (btn) btn.setAttribute("aria-expanded", "true");
  renderProfileDropdown();
}

function toggleProfileDropdown() {
  const dd = document.getElementById("profile-dropdown");
  if (!dd) return;
  if (dd.hidden) openProfileDropdown();
  else closeProfileDropdown();
}

function setSelectedBot(id) {
  selectedBotId = id || "";
  if (id) {
    try {
      localStorage.setItem("fractal-bot-id", id);
    } catch {
      /* ignore */
    }
  }
  const bot = (fleetState?.bots || []).find((b) => b.id === id) || null;
  renderFleet();
  fillProfileEditor(bot, true);
  fillTasksForm(bot);
  updateProfileSelectorUI();
  renderProfileDropdown();
  // Instantly refresh status/data for the new profile context
  void refresh();
}

async function refreshFleet() {
  const body = await rpc("fleetStatus", {});
  if (body.ok && body.data) {
    fleetState = body.data;
    if (!selectedBotId && body.data.bots?.length) {
      const running = body.data.bots.find((b) => b.running);
      setSelectedBot((running || body.data.bots[0]).id);
      return;
    }
    // If previously selected id is gone, clear or pick another
    if (selectedBotId && !(body.data.bots || []).some((b) => b.id === selectedBotId)) {
      const next = body.data.bots?.[0];
      setSelectedBot(next ? next.id : "");
      return;
    }
    renderFleet();
    updateProfileSelectorUI();
    renderProfileDropdown();
  }
}

function featChecked(f, key) {
  return f && f[key] ? "checked" : "";
}

function renderFleet() {
  const grid = document.getElementById("fleet-grid");
  const pathEl = document.getElementById("fleet-path");
  if (!grid || !fleetState) return;
  if (pathEl) pathEl.textContent = fleetState.accountsPath || "accounts.json";
  const ann = document.getElementById("announce-json");
  if (ann && fleetState.defaultAnnouncements && !ann.dataset.touched) {
    ann.value = JSON.stringify(fleetState.defaultAnnouncements, null, 0);
  }
  grid.replaceChildren();
  const bots = fleetState.bots || [];
  if (!bots.length) {
    const empty = document.createElement("article");
    empty.className = "profile-card empty";
    empty.innerHTML =
      "<strong>No profiles yet</strong><p class='meta-line'>Create a profile below, then configure its tasks on the Tasks tab.</p>";
    grid.append(empty);
    fillProfileEditor(null);
    fillTasksForm(null);
    updateProfileSelectorUI();
    return;
  }
  for (const b of bots) {
    const card = document.createElement("article");
    const phase = b.bot?.phase || (b.running ? "running" : "stopped");
    const world = b.bot?.worldKind || "—";
    const pos = b.bot?.position
      ? `${Math.round(b.bot.position.x)} ${Math.round(b.bot.position.y)} ${Math.round(b.bot.position.z)}`
      : "—";
    const summary = b.featuresSummary || "—";
    const selected = b.id === selectedBotId;
    const noPw = b.auth !== "microsoft" && !b.hasPassword;
    card.className =
      "profile-card" +
      (selected ? " selected" : "") +
      (b.running ? " running" : "") +
      (noPw ? " warn" : "");
    card.innerHTML = `
      <button type="button" class="profile-card-main" data-select="${b.id}">
        <span class="profile-card-title">${escapeHtml(b.label || b.username)}</span>
        <span class="profile-card-meta">${escapeHtml(b.username)}${noPw ? " · <em>no password</em>" : ""}</span>
        <span class="profile-card-state">${escapeHtml(phase)} · ${escapeHtml(summary)}</span>
        <span class="profile-card-pos">${escapeHtml(world)} · ${pos}</span>
      </button>
      <div class="profile-card-actions">
        <button type="button" data-start="${b.id}" ${noPw ? "title=\"Set a password before starting\"" : ""}>Start</button>
        <button type="button" data-stop="${b.id}">Stop</button>
      </div>`;
    grid.append(card);
  }
  fillProfileEditor(bots.find((b) => b.id === selectedBotId) || null);
  fillTasksForm(bots.find((b) => b.id === selectedBotId) || null);
  updateProfileSelectorUI();
}

function fillProfileEditor(bot, force = false) {
  const editor = document.getElementById("profile-editor");
  const form = document.getElementById("profile-form");
  if (!editor || !form) return;
  if (!bot) {
    editor.hidden = true;
    profileFormDirty = false;
    profileFormDirtyUntil = 0;
    return;
  }
  editor.hidden = false;
  const title = document.getElementById("profile-title");
  if (title) title.textContent = bot.label || bot.username;

  const switched = form.id.value && form.id.value !== bot.id;
  // Don't clobber fields while the user is typing (same profile)
  if (!force && !switched && (profileFormDirty || Date.now() < profileFormDirtyUntil)) {
    return;
  }

  profileFormDirty = false;
  profileFormDirtyUntil = 0;
  form.id.value = bot.id;
  form.label.value = bot.label || "";
  form.username.value = bot.username || "";
  form.password.value = "";
  const pw = form.password;
  if (pw) {
    pw.placeholder = bot.hasPassword ? "•••••••• (leave blank to keep)" : "Password required to start";
  }
  form.auth.value = bot.auth || "offline";
  form.host.value = bot.host || "";
  form.port.value = bot.port != null ? bot.port : "";
  form.notes.value = bot.notes || "";
}

let tasksApplying = false;
let tasksDirtyUntil = 0;
/** Per-profile pending feature patches — concurrent toggles merge instead of dropping. */
const featurePatchQueue = new Map();
let featurePatchRunning = false;
let profileFormDirty = false;
let profileFormDirtyUntil = 0;

function fillTasksForm(bot) {
  syncFeatureSwitches(bot);
}

function syncFeatureSwitches(bot) {
  // Never clobber UI while the user is flipping switches or a save is in flight
  if (tasksApplying || featurePatchRunning || Date.now() < tasksDirtyUntil) return;
  const f = (bot && bot.features) || {};
  const setToggle = (name, on) => {
    document.querySelectorAll(`[data-feat="${name}"]`).forEach((wrap) => {
      const input = wrap.querySelector('input[type="checkbox"]');
      // Don't fight a switch the user just touched
      if (input && input.dataset.userTouched === "1") return;
      if (input) input.checked = !!on;
      wrap.classList.toggle("on", !!on);
    });
    const legacy = document.querySelector(`#tasks-form [name="${name}"]`);
    if (legacy) legacy.checked = !!on;
  };
  setToggle("online", f.online);
  setToggle("announcements", f.announcements);
  setToggle("antiAfk", f.antiAfk);
  setToggle("hunt", f.hunt);
  setToggle("map", f.map);
  const mode = f.mapMode || "box";
  const sel = document.getElementById("map-mode-select");
  if (sel && !sel.matches(":focus")) sel.value = mode;
  const legacyMode = document.querySelector("#tasks-form [name=mapMode]");
  if (legacyMode) legacyMode.value = mode;
  const annFor = document.getElementById("announce-for");
  if (annFor) {
    annFor.textContent = bot ? `For ${bot.label || bot.username}` : "Select a profile first";
  }
  const ann = document.getElementById("announce-json");
  if (ann && bot && !ann.dataset.touched) {
    const msgs = bot.announcementMessages;
    if (Array.isArray(msgs)) {
      ann.value = JSON.stringify(msgs, null, 2);
    }
  }
  fillProfileSettingsForm(bot);
}

/**
 * Apply feature flags for a specific profile id.
 * Concurrent toggles (Online + Anti-AFK + Map…) merge into one save per profile
 * so no switch is dropped and profiles never overwrite each other.
 */
async function applyFeaturePatch(botId, partial) {
  if (!botId || !partial || typeof partial !== "object") return;
  const prev = featurePatchQueue.get(botId) || {};
  featurePatchQueue.set(botId, { ...prev, ...partial });

  // Optimistic local state so UI + other profiles stay correct during the RPC
  const bot = (fleetState?.bots || []).find((b) => b.id === botId);
  if (bot) {
    bot.features = { ...(bot.features || {}), ...partial };
    bot.featuresSummary = undefined;
  }

  tasksDirtyUntil = Date.now() + 3000;
  if (featurePatchRunning) return;

  featurePatchRunning = true;
  tasksApplying = true;
  try {
    while (featurePatchQueue.size) {
      const [id, patch] = featurePatchQueue.entries().next().value;
      featurePatchQueue.delete(id);
      const body = await rpc("fleetSetFeatures", { id, features: patch });
      if (body.ok) {
        logActivity(body.data?.result || "features updated");
        const b = (fleetState?.bots || []).find((x) => x.id === id);
        if (b) b.features = { ...(b.features || {}), ...patch };
      } else {
        push("err", body.error || "feature update failed");
      }
    }
    await refreshFleet();
  } finally {
    featurePatchRunning = false;
    tasksApplying = false;
    tasksDirtyUntil = Date.now() + 900;
    // Clear touch locks after server state is back
    document.querySelectorAll("[data-feat] input[type=checkbox]").forEach((inp) => {
      delete inp.dataset.userTouched;
    });
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
    const body = await rpc("fleetStart", { id: t.dataset.start });
    if (!body.ok) push("err", body.error || "start failed");
    else {
      setSelectedBot(t.dataset.start);
      push("sys", body.data?.result || "started");
    }
    await refreshFleet();
    await refresh();
    return;
  }
  if (t.dataset.stop) {
    const body = await rpc("fleetStop", { id: t.dataset.stop });
    if (!body.ok) push("err", body.error || "stop failed");
    else push("sys", body.data?.result || "stopped");
    await refreshFleet();
    await refresh();
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
  // New profiles start offline — user enables Online (or Start) when ready
  const features = {
    online: false,
    announcements: false,
    antiAfk: false,
    hunt: false,
    map: false,
    mapMode: "box",
  };
  const body = await rpc("fleetAddAccount", {
    account: {
      label: String(fd.get("label") || ""),
      username: String(fd.get("username") || ""),
      password: String(fd.get("password") || ""),
      features,
      enabled: false,
      auth: "offline",
    },
  });
  e.target.reset();
  logActivity(`added ${fd.get("username")}`);
  await refreshFleet();
  if (body.ok && body.data?.id) setSelectedBot(body.data.id);
});

document.getElementById("announce-json")?.addEventListener("input", (e) => {
  e.target.dataset.touched = "1";
});
document.getElementById("announce-save")?.addEventListener("click", async () => {
  const ta = document.getElementById("announce-json");
  if (!selectedBotId) {
    push("err", "Select a profile first");
    return;
  }
  try {
    const announcements = JSON.parse(ta.value || "[]");
    const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
    if (!bot) {
      push("err", "Profile not found");
      return;
    }
    const body = await rpc("fleetAddAccount", {
      account: {
        id: selectedBotId,
        username: bot.username,
        announcementMessages: announcements,
      },
    });
    if (body.ok) {
      ta.dataset.touched = "";
      logActivity("saved profile announcements");
      push("sys", "Announce messages saved for profile");
      // Ensure announce feature can run with new messages
      await refreshFleet();
    } else {
      push("err", body.error || "save failed");
    }
  } catch (err) {
    push("err", `Invalid JSON: ${err.message || err}`);
  }
});


// Don't let fleet refresh wipe in-progress edits
document.getElementById("profile-form")?.addEventListener("input", () => {
  profileFormDirty = true;
  profileFormDirtyUntil = Date.now() + 60_000;
});
document.getElementById("profile-form")?.addEventListener("change", () => {
  profileFormDirty = true;
  profileFormDirtyUntil = Date.now() + 60_000;
});

document.getElementById("profile-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = form.id.value;
  if (!id) return;
  const num = (v) => (v === "" || v == null ? undefined : Number(v));
  const account = {
    id,
    username: form.username.value.trim(),
    label: form.label.value.trim() || undefined,
    auth: form.auth.value,
    host: form.host.value.trim() || undefined,
    port: num(form.port.value),
    notes: form.notes.value.trim() || undefined,
  };
  if (form.password.value) account.password = form.password.value;
  const body = await rpc("fleetAddAccount", { account });
  if (body.ok) {
    push("sys", `Saved profile ${account.username}`);
    logActivity(`profile saved ${account.username}`);
    profileFormDirty = false;
    profileFormDirtyUntil = 0;
    if (body.data?.id) setSelectedBot(body.data.id);
  } else {
    push("err", body.error || "save failed");
  }
  await refreshFleet();
});

document.getElementById("profile-remove")?.addEventListener("click", async () => {
  const id = document.getElementById("profile-form")?.id?.value;
  if (!id) return;
  if (!confirm("Remove this profile?")) return;
  await rpc("fleetRemoveAccount", { id });
  if (selectedBotId === id) setSelectedBot("");
  await refreshFleet();
});

// Feature switches (Online, Map, Announce, Anti-AFK, …) — each switch is independent
document.addEventListener("change", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const wrap = t.closest("[data-feat]");
  if (wrap && t.matches('input[type="checkbox"]')) {
    if (!selectedBotId) {
      push("err", "Select a profile first");
      t.checked = !t.checked;
      return;
    }
    // Capture profile at click time so a mid-flight profile switch cannot steal the patch
    const botId = selectedBotId;
    const feat = wrap.getAttribute("data-feat");
    if (!feat) return;
    t.dataset.userTouched = "1";
    wrap.classList.toggle("on", t.checked);
    tasksDirtyUntil = Date.now() + 3000;
    const patch = { [feat]: t.checked };
    if (feat === "map") {
      const mode = document.getElementById("map-mode-select")?.value || "box";
      patch.mapMode = mode;
    }
    void (async () => {
      await applyFeaturePatch(botId, patch);
      // Online includes auto-reconnect; never clear auto-lobby preference
      if (feat === "online") {
        const lobbyEl = document.getElementById("toggle-lobby");
        const lobbyOn = lobbyEl ? Boolean(lobbyEl.checked) : true;
        await rpc("set", {
          autoReconnect: t.checked,
          autoLobby: lobbyOn,
        }).catch(() => {});
        if (!t.checked) applyView3dState();
        await refresh();
        applyView3dState();
      }
    })();
    return;
  }
  if (t.id === "map-mode-select") {
    if (!selectedBotId) return;
    const botId = selectedBotId;
    tasksDirtyUntil = Date.now() + 3000;
    const mapOn = document.querySelector('[data-feat="map"] input')?.checked;
    void applyFeaturePatch(botId, { map: !!mapOn, mapMode: t.value || "box" });
  }
});

// Connection flag switches — only change when the user flips them
document.getElementById("toggle-reconnect")?.addEventListener("change", async (e) => {
  const el = e.target;
  const on = el.checked;
  el.dataset.userTouched = "1";
  lockConnectionSwitch("reconnect");
  el.closest(".task-toggle")?.classList.toggle("on", on);
  const botId = selectedBotId;
  await rpc("set", { autoReconnect: on });
  if (botId) {
    const bot = (fleetState?.bots || []).find((b) => b.id === botId);
    if (bot?.username) {
      await rpc("fleetAddAccount", {
        account: {
          id: botId,
          username: bot.username,
          profile: { ...(bot.profile || {}), autoReconnect: on },
        },
      }).catch(() => {});
    }
  }
  await refresh();
  // Keep lock so the refresh response cannot snap the switch back
  lockConnectionSwitch("reconnect");
  el.checked = on;
  el.closest(".task-toggle")?.classList.toggle("on", on);
});
document.getElementById("toggle-lobby")?.addEventListener("change", async (e) => {
  const el = e.target;
  const on = el.checked;
  el.dataset.userTouched = "1";
  lockConnectionSwitch("lobby");
  el.closest(".task-toggle")?.classList.toggle("on", on);
  const botId = selectedBotId;
  await rpc("set", { autoLobby: on });
  if (botId) {
    const bot = (fleetState?.bots || []).find((b) => b.id === botId);
    if (bot?.username) {
      await rpc("fleetAddAccount", {
        account: {
          id: botId,
          username: bot.username,
          profile: { ...(bot.profile || {}), autoLobby: on },
        },
      }).catch(() => {});
    }
  }
  await refresh();
  lockConnectionSwitch("lobby");
  el.checked = on;
  el.closest(".task-toggle")?.classList.toggle("on", on);
});


document.getElementById("profile-start")?.addEventListener("click", async () => {
  const id = document.getElementById("profile-form")?.id?.value;
  if (!id) return;
  const body = await rpc("fleetStart", { id });
  if (!body.ok) push("err", body.error || "start failed");
  else push("sys", body.data?.result || "started");
  setSelectedBot(id);
  await refreshFleet();
  await refresh();
});

document.getElementById("profile-stop")?.addEventListener("click", async () => {
  const id = document.getElementById("profile-form")?.id?.value;
  if (!id) return;
  const body = await rpc("fleetStop", { id });
  if (!body.ok) push("err", body.error || "stop failed");
  else push("sys", body.data?.result || "stopped");
  await refreshFleet();
  await refresh();
});

setInterval(() => {
  if (document.hidden) return;
  // Fleet list is small but no need to hammer it off the Settings tab
  const tab = activeDashboardTab();
  if (tab !== "settings" && tab !== "play") return;
  void refreshFleet();
}, 8000);
void refreshFleet();

/* —— Profile selector (header) —— */
document.getElementById("profile-selector-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleProfileDropdown();
});

document.getElementById("pd-list")?.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const item = t.closest("[data-select]");
  if (!item) return;
  const id = item.getAttribute("data-select");
  if (id) {
    setSelectedBot(id);
    closeProfileDropdown();
  }
});

document.getElementById("pd-manage")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeProfileDropdown();
  openFleetManage();
});

document.getElementById("fleet-back")?.addEventListener("click", () => {
  closeFleetManage();
});

document.addEventListener("click", (e) => {
  const switcher = document.getElementById("profile-switcher");
  if (switcher && !switcher.contains(e.target)) closeProfileDropdown();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeProfileDropdown();
    if (fleetManageOpen) closeFleetManage();
  }
});

/* —— Fleet manage (no tab — opened via Manage) —— */
let fleetManageOpen = false;
let tabBeforeFleet = "play";

/** Module catalog for sidebar + search palette */
const MODULES = [
  {
    id: "play",
    name: "Play",
    desc: "Control, wire, inventory, nearby",
    icon: "▶",
    keywords: ["play", "control", "wire", "chat", "inventory", "move", "goto", "nearby"],
  },
  {
    id: "map",
    name: "Map",
    desc: "Elytra terrain survey",
    icon: "▣",
    keywords: ["map", "elytra", "terrain", "xaero", "survey", "box", "ring"],
  },
  {
    id: "detect",
    name: "Detect",
    desc: "Players, crystals, combat, alerts",
    icon: "◎",
    keywords: ["detect", "detection", "player", "crystal", "tnt", "combat", "notify", "alert"],
  },
  {
    id: "announce",
    name: "Announce",
    desc: "Timed chat messages",
    icon: "✉",
    keywords: ["announce", "announcement", "chat", "spam", "timed"],
  },
];
/** Utilities reachable from the top bar (not sidebar modules) */
const UTILITIES = [
  {
    id: "settings",
    name: "Settings",
    desc: "Process / global settings",
    keywords: ["settings", "config", "host", "token", "global"],
  },
  {
    id: "log",
    name: "Log",
    desc: "Activity feed",
    keywords: ["log", "activity", "history", "events"],
  },
];

function openFleetManage() {
  const current =
    document.querySelector(".side-nav-item.on")?.getAttribute("data-tab") ||
    document.querySelector(".tab-bar .tab.on")?.getAttribute("data-tab");
  if (current && current !== "fleet") tabBeforeFleet = current;
  fleetManageOpen = true;
  closeSidebar();
  for (const btn of document.querySelectorAll(".side-nav-item")) {
    btn.classList.remove("on");
    btn.removeAttribute("aria-current");
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    const isFleet = panel.getAttribute("data-tab") === "fleet";
    panel.classList.toggle("on", isFleet);
    if (isFleet) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
  }
  try {
    history.replaceState(null, "", "#fleet");
  } catch {
    /* ignore */
  }
}

function closeFleetManage() {
  fleetManageOpen = false;
  activateTab(tabBeforeFleet || "play");
}

/* —— Sidebar modules —— */
function openSidebar() {
  document.body.classList.add("nav-open");
  document.documentElement.classList.add("nav-open");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (backdrop) backdrop.hidden = false;
}

function closeSidebar() {
  document.body.classList.remove("nav-open");
  document.documentElement.classList.remove("nav-open");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function toggleSidebar() {
  if (document.body.classList.contains("nav-open")) closeSidebar();
  else openSidebar();
}

function activateTab(name) {
  let tabName = name || "play";
  if (tabName === "profiles" || tabName === "status" || tabName === "tasks" || tabName === "chat") tabName = "play";
  if (tabName === "fleet") {
    openFleetManage();
    return;
  }
  fleetManageOpen = false;
  for (const btn of document.querySelectorAll(".side-nav-item")) {
    const on = btn.getAttribute("data-tab") === tabName;
    btn.classList.toggle("on", on);
    if (on) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  for (const btn of document.querySelectorAll("#nav-settings, #nav-log")) {
    const on = btn.getAttribute("data-tab") === tabName;
    btn.classList.toggle("on", on);
  }
  for (const btn of document.querySelectorAll(".tab-bar .tab")) {
    const on = btn.getAttribute("data-tab") === tabName;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    const on = panel.getAttribute("data-tab") === tabName;
    panel.classList.toggle("on", on);
    if (on) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
  }
  try {
    history.replaceState(null, "", `#${tabName}`);
  } catch {
    /* ignore */
  }
  closeSidebar();
  placeSurveyMount(tabName);
  if (tabName === "map" || tabName === "play") {
    requestAnimationFrame(() => window.fractalSurvey?.resize?.());
  }
  if (tabName === "detect") void refreshDetection();
  renderSideNav(document.getElementById("sidebar-search")?.value || "");
}

function placeSurveyMount(tabName) {
  const shared = document.getElementById("survey-shared");
  if (!shared) return;
  const playMount = document.getElementById("survey-mount-play");
  const mapMount = document.getElementById("survey-mount-map");
  shared.hidden = false;
  if (tabName === "map" && mapMount) {
    mapMount.appendChild(shared);
  } else if (playMount) {
    playMount.appendChild(shared);
  }
}

function filterModuleList(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return MODULES.slice();
  return MODULES.filter((m) => {
    if (m.name.toLowerCase().includes(q)) return true;
    if (m.desc.toLowerCase().includes(q)) return true;
    if (m.id.toLowerCase().includes(q)) return true;
    return m.keywords.some((k) => k.includes(q) || q.includes(k));
  });
}

function renderSideNav(query) {
  const nav = document.getElementById("side-nav");
  if (!nav) return;
  const active =
    document.querySelector(".tab-panel.on")?.getAttribute("data-tab") ||
    activeDashboardTab() ||
    "play";
  const hits = filterModuleList(query);
  nav.replaceChildren();
  if (!hits.length) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty hint";
    empty.textContent = "No modules match";
    nav.append(empty);
    return;
  }
  for (const m of hits) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "side-nav-item" + (m.id === active ? " on" : "");
    btn.setAttribute("data-tab", m.id);
    if (m.id === active) btn.setAttribute("aria-current", "page");
    const icon = document.createElement("span");
    icon.className = "sn-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = m.icon || "•";
    const textWrap = document.createElement("span");
    textWrap.className = "sn-text";
    const strong = document.createElement("strong");
    strong.textContent = m.name;
    const small = document.createElement("small");
    small.textContent = m.desc;
    textWrap.append(strong, small);
    btn.append(icon, textWrap);
    btn.addEventListener("click", () => {
      closeProfileDropdown();
      const search = document.getElementById("sidebar-search");
      if (search) search.value = "";
      activateTab(m.id);
    });
    nav.append(btn);
  }
}

document.querySelectorAll("#nav-settings, #nav-log").forEach((btn) => {
  btn.addEventListener("click", () => {
    closeProfileDropdown();
    closeSidebar();
    const search = document.getElementById("sidebar-search");
    if (search) search.value = "";
    activateTab(btn.getAttribute("data-tab"));
  });
});
document.getElementById("nav-toggle")?.addEventListener("click", () => {
  closeProfileDropdown();
  toggleSidebar();
  // Focus search when opening drawer on mobile
  if (document.body.classList.contains("nav-open")) {
    setTimeout(() => document.getElementById("sidebar-search")?.focus(), 50);
  }
});
document.getElementById("sidebar-close")?.addEventListener("click", () => closeSidebar());
document.getElementById("sidebar-backdrop")?.addEventListener("click", () => closeSidebar());

document.getElementById("sidebar-search")?.addEventListener("input", (e) => {
  renderSideNav(e.target.value);
});
document.getElementById("sidebar-search")?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.target.value = "";
    renderSideNav("");
    e.target.blur();
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const first = document.querySelector("#side-nav .side-nav-item");
    if (first) first.click();
  }
});

renderSideNav("");

const hashTab = (location.hash || "").replace(/^#/, "");
const valid = new Set(["play", "map", "detect", "announce", "settings", "log"]);
const legacy = {
  profiles: "play",
  status: "play",
  tasks: "play",
  chat: "play",
  fleet: "fleet",
};
if (hashTab === "fleet" || legacy[hashTab] === "fleet") {
  openFleetManage();
} else {
  const resolved =
    (legacy[hashTab] && legacy[hashTab] !== "fleet" ? legacy[hashTab] : null) ||
    (valid.has(hashTab) ? hashTab : "play");
  activateTab(resolved);
}


/* dual wire + goto on map tab */
document.getElementById("say-map")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("say-input-map");
  const textVal = (input?.value || "").trim();
  if (!textVal) return;
  input.value = "";
  await sendWireMessage(textVal);
});

document.getElementById("goto-map")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const x = Number(fd.get("x"));
  const y = Number(fd.get("y"));
  const z = Number(fd.get("z"));
  if (![x, y, z].every(Number.isFinite)) {
    push("err", "goto needs numeric x y z");
    return;
  }
  await rpc("goto", { x, y, z });
});


/* —— Per-profile settings (Settings/Profiles/<id>.json) —— */
function fillProfileSettingsForm(bot) {
  const form = document.getElementById("profile-settings-form");
  const pathEl = document.getElementById("tab-settings-path");
  if (!form) return;
  if (!bot) {
    if (pathEl) pathEl.textContent = "Select a profile first";
    form.querySelectorAll("input, select").forEach((el) => {
      if ("value" in el) el.value = "";
    });
    return;
  }
  {
    const fileStem = String(bot.label || bot.username || bot.id || "profile")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "profile";
    if (pathEl) pathEl.textContent = `Profile · ${bot.label || bot.username} · Settings/Profiles/${fileStem}.json`;
  }
  const p = bot.profile || {};
  form.autoLobby.value = p.autoLobby === false ? "false" : "true";
  form.autoReconnect.value = p.autoReconnect === false ? "false" : "true";
  form.requiredServerPortals.value = p.requiredServerPortals ?? "";
  form.portalRetryMs.value = p.portalRetryMs ?? "";
  form.reconnectMs.value = p.reconnectMs ?? "";
  form.reconnectMaxMs.value = p.reconnectMaxMs ?? "";
  form.rateLimitCooldownMs.value = p.rateLimitCooldownMs ?? "";
  form.captchaCooldownMs.value = p.captchaCooldownMs ?? "";
  form.viewDistance.value = p.viewDistance ?? "";
  if (form.version) form.version.value = p.version || "";
  form.mapOutputDir.value = p.mapOutputDir || "./output";
  form.mapHomeName.value = p.mapHomeName || "spawn";
  // Always pick a visible option (empty string leaves the select blank on mobile)
  form.mapMode.value = p.mapMode || "box";
  form.mapAutoStart.value = p.mapAutoStart === true ? "true" : "false";
  form.mapBoxX1.value = p.mapBox?.x1 ?? "20000";
  form.mapBoxZ1.value = p.mapBox?.z1 ?? "20000";
  form.mapBoxX2.value = p.mapBox?.x2 ?? "24000";
  form.mapBoxZ2.value = p.mapBox?.z2 ?? "24000";
  form.host.value = bot.host || "";
  form.port.value = bot.port != null ? bot.port : "";
  // Detection
  if (form.detectionRecheckMs) form.detectionRecheckMs.value = p.detectionRecheckMs ?? "3000";
  if (form.detectionPlayers) form.detectionPlayers.value = p.detectionPlayers === false ? "false" : "true";
  if (form.detectionCrystals) form.detectionCrystals.value = p.detectionCrystals === false ? "false" : "true";
  if (form.detectionTnt) form.detectionTnt.value = p.detectionTnt === false ? "false" : "true";
  if (form.detectionExplosions) form.detectionExplosions.value = p.detectionExplosions === false ? "false" : "true";
  if (form.detectionCombat) form.detectionCombat.value = p.detectionCombat === false ? "false" : "true";
  fillDetNotifyForm(form);
}

async function saveProfileSettings() {
  const form = document.getElementById("profile-settings-form");
  const msg = document.getElementById("settings-msg");
  if (!form) return;

  // Device-local notification prefs (always saved, even without a profile)
  saveDetNotifyPrefsFromForm(form);
  const anyNotify =
    form.notifyPlayerEnter?.value === "true" ||
    form.notifyPlayerLeave?.value === "true" ||
    form.notifyCombat?.value === "true" ||
    form.notifyCrystals?.value === "true" ||
    form.notifyTnt?.value === "true" ||
    form.notifyExplosions?.value === "true";
  if (anyNotify) {
    void ensureNotificationPermission().then((ok) => {
      if (ok) void registerServiceWorker();
    });
  }

  if (!selectedBotId) {
    if (msg) {
      msg.hidden = false;
      msg.textContent = "Notification prefs saved on this device (select a profile for bot settings)";
      msg.className = "settings-msg ok";
    }
    return;
  }
  const num = (v) => (v === "" || v == null ? undefined : Number(v));
  const boolSel = (v) => (v === "true" ? true : v === "false" ? false : undefined);
  const boxNums = [
    num(form.mapBoxX1.value),
    num(form.mapBoxZ1.value),
    num(form.mapBoxX2.value),
    num(form.mapBoxZ2.value),
  ];
  const mapBox = boxNums.every((n) => typeof n === "number" && Number.isFinite(n))
    ? { x1: boxNums[0], z1: boxNums[1], x2: boxNums[2], z2: boxNums[3] }
    : undefined;
  const account = {
    id: selectedBotId,
    username: (fleetState?.bots || []).find((b) => b.id === selectedBotId)?.username,
    host: form.host.value.trim() || undefined,
    port: num(form.port.value),
    profile: {
      autoLobby: boolSel(form.autoLobby.value),
      autoReconnect: boolSel(form.autoReconnect.value),
      requiredServerPortals: num(form.requiredServerPortals.value),
      portalRetryMs: num(form.portalRetryMs.value),
      reconnectMs: num(form.reconnectMs.value),
      reconnectMaxMs: num(form.reconnectMaxMs.value),
      rateLimitCooldownMs: num(form.rateLimitCooldownMs.value),
      captchaCooldownMs: num(form.captchaCooldownMs.value),
      viewDistance: num(form.viewDistance.value),
      version: form.version?.value?.trim() || undefined,
      mapOutputDir: form.mapOutputDir.value.trim() || undefined,
      mapHomeName: form.mapHomeName.value.trim() || undefined,
      mapMode: form.mapMode.value.trim() || undefined,
      mapAutoStart: boolSel(form.mapAutoStart.value),
      mapBox,
      detectionRecheckMs: num(form.detectionRecheckMs?.value),
      detectionPlayers: boolSel(form.detectionPlayers?.value),
      detectionCrystals: boolSel(form.detectionCrystals?.value),
      detectionTnt: boolSel(form.detectionTnt?.value),
      detectionExplosions: boolSel(form.detectionExplosions?.value),
      detectionCombat: boolSel(form.detectionCombat?.value),
    },
  };
  if (!account.username) {
    if (msg) {
      msg.hidden = false;
      msg.textContent = "Profile not found";
      msg.className = "settings-msg err";
    }
    return;
  }
  const body = await rpc("fleetAddAccount", { account });
  if (msg) {
    msg.hidden = false;
    if (body.ok) {
      msg.textContent = "Saved for this profile · notification prefs stored on this device";
      msg.className = "settings-msg ok";
      closeTabSettings();
      await rpc("set", {
        autoLobby: account.profile.autoLobby,
        autoReconnect: account.profile.autoReconnect,
      }).catch(() => {});
    } else {
      msg.textContent = body.error || "Save failed";
      msg.className = "settings-msg err";
    }
  }
  await refreshFleet();
}

document.getElementById("settings-save")?.addEventListener("click", () => void saveProfileSettings());

// Hook fillProfileSettings into setSelectedBot / renderFleet
const _origSetSelectedBot = setSelectedBot;
setSelectedBot = function (id) {
  _origSetSelectedBot(id);
  const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId) || null;
  fillProfileSettingsForm(bot);
};

document.getElementById("toggle-notify")?.addEventListener("change", async (e) => {
  const btn = e.target;
  const wrap = btn.closest(".task-toggle");
  const wantOn = !!btn.checked;
  btn.dataset.userTouched = "1";
  lockConnectionSwitch("notify", 600_000);

  if (!wantOn) {
    setNotifyPref(false);
    wrap?.classList.remove("on");
    push("sys", "Captcha notifications disabled");
    return;
  }

  const perm = notificationPermission();
  if (perm === "unsupported") {
    btn.checked = false;
    wrap?.classList.remove("on");
    setNotifyPref(false);
    push("err", "Notifications are not supported in this browser");
    return;
  }
  if (perm === "denied") {
    btn.checked = false;
    wrap?.classList.remove("on");
    setNotifyPref(false);
    push("err", "Notifications are blocked — enable them in browser / site settings");
    return;
  }

  const ok = await ensureNotificationPermission();
  if (!ok) {
    btn.checked = false;
    wrap?.classList.remove("on");
    setNotifyPref(false);
    return;
  }

  setNotifyPref(true);
  wrap?.classList.add("on");
  push("sys", "Captcha notifications enabled");
  try {
    new Notification("Fractal notifications on", {
      body: "You will be alerted when a captcha needs solving.",
      tag: "fractal-notify-test",
    });
  } catch {
    /* ignore */
  }
});
