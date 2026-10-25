/**
 * Kick reason parsing for 6b6t / anarchy proxies.
 * Merges Elytra classification, Mapart token verification, and 6b6t-join-bot taxonomy.
 */

export type KickKind =
  | "captcha"
  | "rate-limit"
  | "verification-expired"
  | "premium-name"
  | "account-limit"
  | "wrong-password"
  | "version-mismatch"
  | "ddos-blocked"
  | "too-fast"
  | "already-online"
  | "backend-unreachable"
  | "connection-error"
  | "other";

/** Coarse bucket used for reconnect policy */
export type KickReconnectBucket = "captcha" | "rate-limit" | "other";

export interface ParsedKick {
  text: string;
  kind: KickKind;
  /** http(s) URLs (prefer 6b6t verify links first) */
  links: string[];
  /** 6b6t verification code when present */
  verificationCode?: string;
  /** Human hint for operators */
  hint?: string;
}

const CAPTCHA_RE =
  /anti[- ]?bot|captcha|prove you.?re (a )?human|verify\.|human verification|complete the captcha|solve the captcha|verification code|vpn\/proxy|token.?verif|flagged for further verification/i;

const RATE_LIMIT_RE =
  /logging in too fast|already online|connected account limit|DDoS Protection|Connection Blocked|too many connections|please wait/i;

const VERIFY_LINK =
  /https?:\/\/(?:verify\.6b6t\.org\/[A-Za-z0-9]{4,12}|verify\.enderdash\.com\/c\/[A-Za-z0-9]{4,12}|(?:www\.)?6b6t\.org\/verify[^\s"'<>]*)/i;

export function isTokenVerificationText(value: unknown): boolean {
  const text = String(value || "").toLowerCase();
  return (
    text.includes("verify.6b6t.org/") ||
    text.includes("https://6b6t.org/verify") ||
    text.includes("verification code") ||
    text.includes("vpn/proxy") ||
    (text.includes("verify") &&
      (text.includes("token") ||
        text.includes("website") ||
        text.includes("browser") ||
        text.includes("captcha") ||
        text.includes("6b6t")))
  );
}

export function extractVerificationCode(value: unknown, selfName = ""): string {
  const text = String(value || "");
  const ignored = new Set(["COLOR", "WHITE", "YELLOW", "GRAY", "EXTRA", "VALUE", "STRING", "TEXT"]);
  const self = String(selfName || "")
    .trim()
    .toUpperCase();
  if (self) ignored.add(self);

  const accept = (candidate: unknown): string => {
    const code = String(candidate || "")
      .trim()
      .toUpperCase();
    return /^[A-Z0-9]{4,12}$/.test(code) && !ignored.has(code) ? code : "";
  };

  const labeled = text.match(/verification code:\s*([A-Z0-9]{4,12})/i);
  if (labeled) {
    const code = accept(labeled[1]);
    if (code) return code;
  }

  try {
    const payload = JSON.parse(text) as unknown;
    const parts: { text: string; color: string }[] = [];
    const collectTextParts = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (typeof n.text === "string") {
        parts.push({
          text: n.text,
          color: typeof n.color === "string" ? n.color : "",
        });
      }
      if (Array.isArray(n.extra)) {
        for (const child of n.extra) collectTextParts(child);
      }
      if (n.value && typeof n.value === "object") collectTextParts(n.value);
    };
    collectTextParts(payload);

    for (let i = 0; i < parts.length; i++) {
      if (!/verification code/i.test(parts[i].text || "")) continue;
      for (let j = i + 1; j < parts.length; j++) {
        const code = accept(parts[j].text);
        if (code) return code;
      }
    }

    const whiteCode = parts.find((part) => part.color.toLowerCase() === "white" && accept(part.text));
    if (whiteCode) return accept(whiteCode.text);
  } catch {
    /* not JSON */
  }

  const jsonWhiteText = [...text.matchAll(/"color"\s*:\s*"white"\s*,\s*"text"\s*:\s*"([A-Z0-9]{4,12})"/gi)]
    .map((match) => accept(match[1]))
    .filter(Boolean);
  if (jsonWhiteText.length) return jsonWhiteText[jsonWhiteText.length - 1];

  return "";
}

export function extractVerificationUrl(value: unknown): string {
  const text = String(value || "").replace(/\\\//g, "/");
  const matches = [...text.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)]
    .map((match) =>
      match[0]
        .replace(/(?:\u00a7[0-9A-FK-OR])+$/gi, "")
        .replace(/§[0-9a-fk-or]+$/gi, "")
        .replace(/[)\]}.,;'"!]+$/, ""),
    )
    .filter(Boolean);

  if (!matches.length) return "";
  return (
    matches.find((url) => /^https?:\/\/verify\.6b6t\.org\//i.test(url)) ||
    matches.find((url) => /^https?:\/\/verify\.enderdash\.com\//i.test(url)) ||
    matches.find((url) => /^https?:\/\/(?:www\.)?6b6t\.org\/verify(?:\/|\?|$)/i.test(url)) ||
    matches[0]
  );
}

export function extractLinks(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of found) {
    const url = raw
      .replace(/\\\//g, "/")
      .replace(/(?:\u00a7[0-9A-FK-OR])+$/gi, "")
      .replace(/[.,;:!?)"'\]]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  out.sort((a, b) => {
    const score = (u: string) =>
      /verify\.6b6t\.org/i.test(u) ? 0 : /enderdash\.com\/c\//i.test(u) ? 1 : /6b6t\.org\/verify/i.test(u) ? 2 : 3;
    return score(a) - score(b);
  });
  return out;
}

/** Join-bot style classification (first match wins). */
export function classifyKick(text: string): KickKind {
  const h = text;
  if (VERIFY_LINK.test(h) || isTokenVerificationText(h) || CAPTCHA_RE.test(h)) return "captcha";
  if (/verification link expired/i.test(h)) return "verification-expired";
  if (/own the mojang account|choose another username/i.test(h)) return "premium-name";
  if (/connected account limit/i.test(h)) return "account-limit";
  if (/wrong password|incorrect password|invalid password/i.test(h)) return "wrong-password";
  if (/unsupported minecraft version|outdated (client|server)/i.test(h)) return "version-mismatch";
  if (/unable to connect to [\w.-]+:|internal server connection error/i.test(h)) return "backend-unreachable";
  if (/ddos protection|connection blocked/i.test(h)) return "ddos-blocked";
  if (/logging in too fast|too fast/i.test(h)) return "too-fast";
  if (/already online|already connected|logged in from another location/i.test(h)) return "already-online";
  if (/internal error occurred|encountered a problem/i.test(h)) return "connection-error";
  if (RATE_LIMIT_RE.test(h)) return "rate-limit";
  return "other";
}

export function kickReconnectBucket(kind: KickKind): KickReconnectBucket {
  if (kind === "captcha" || kind === "verification-expired") return "captcha";
  if (
    kind === "rate-limit" ||
    kind === "too-fast" ||
    kind === "already-online" ||
    kind === "ddos-blocked" ||
    kind === "account-limit" ||
    kind === "backend-unreachable"
  ) {
    return "rate-limit";
  }
  return "other";
}

export function kickHint(kind: KickKind): string | undefined {
  switch (kind) {
    case "captcha":
      return "Open the verify link in a browser on this network, complete it, then rejoin.";
    case "verification-expired":
      return "Wait for the cooldown, then run verification again.";
    case "premium-name":
      return "This username is owned by a paid Minecraft account — pick another offline name.";
    case "account-limit":
      return "6b6t allows a limited number of accounts per IP (often 3). Disconnect others.";
    case "wrong-password":
      return "Check MC_PASSWORD / account password.";
    case "version-mismatch":
      return "Update MC_VERSION to match the server.";
    case "ddos-blocked":
      return "Proxy DDoS shield — wait and retry.";
    case "too-fast":
      return "Logging in too fast — backoff and retry.";
    case "already-online":
      return "Name still online from a previous session — wait or force-disconnect.";
    default:
      return undefined;
  }
}

export function kickText(reason: unknown): string {
  const parts: string[] = [];

  const walk = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === "string") {
      parts.push(v);
      return;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      parts.push(String(v));
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type !== undefined && o.value !== undefined && Object.keys(o).length <= 2) {
        walk(o.value);
        return;
      }
      if (o.text !== undefined) walk(o.text);
      if (o.translate !== undefined) parts.push(String(o.translate));
      if (o.with) walk(o.with);
      if (o.extra) walk(o.extra);
      if (o.value !== undefined && o.text === undefined) walk(o.value);
    }
  };

  let v: unknown = reason;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      /* plain text */
    }
  }
  walk(v);

  const text = parts
    .join("")
    .replace(/\u00a7[0-9a-fk-or]/gi, "")
    .replace(/§[0-9a-fk-or]/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return text || (typeof reason === "string" ? reason : JSON.stringify(reason));
}

export function parseKick(reason: unknown, selfName = ""): ParsedKick {
  const text = kickText(reason);
  const kind = classifyKick(text);
  let links = extractLinks(text);
  const preferred = extractVerificationUrl(reason) || extractVerificationUrl(text);
  if (preferred && !links.includes(preferred)) {
    links = [preferred, ...links];
  } else if (preferred) {
    links = [preferred, ...links.filter((u) => u !== preferred)];
  }
  const verificationCode = extractVerificationCode(reason, selfName) || extractVerificationCode(text, selfName);
  return {
    text,
    kind,
    links,
    verificationCode: verificationCode || undefined,
    hint: kickHint(kind),
  };
}
