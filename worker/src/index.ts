export interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS: string;
  ADMIN_PASSWORD: string;
  IMPORT_REQUEST_SECRET?: string;
  RESEND_API_KEY?: string;
  IMPORT_NOTIFY_TO?: string;
  IMPORT_NOTIFY_FROM?: string;
  HERMES_SHARED_SECRET?: string;
  HERMES_USERNAME?: string;
  HERMES_LINK_MATCH?: string;
}

interface ForwardRule {
  subdomain: string;
  target: string;
}

interface User {
  id: string;
  username: string;
  password_hash: string;
  is_admin: number;
  daily_limit: number;
  hourly_limit: number;
  lifetime_limit: number;
  created_at: number;
}

interface ImportRequestRow {
  id: string;
  status: string;
  registrar: string;
  target_username: string;
  api_key_tail: string;
  domain_count: number;
  domains_text: string;
  notes: string;
  requested_by: string;
  notification_sent: number;
  notification_error: string;
  created_at: number;
  updated_at: number;
}

// Resolved request actor: admin (ADMIN_PASSWORD bearer) or a logged-in user.
type Actor = { isAdmin: boolean; user: User | null };

// Defaults for newly created users (per-domain quotas).
const DEFAULT_DAILY_LIMIT = 5;
const DEFAULT_HOURLY_LIMIT = 2;
const DEFAULT_LIFETIME_LIMIT = 50;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_IMPORT_TEXT_CHARS = 20000;
const MAX_IMPORT_NOTES_CHARS = 2000;
const MAX_IMPORT_SECRET_CHARS = 10000;
// Fallback only — real deployments set HERMES_USERNAME (see wrangler.toml).
const DEFAULT_HERMES_USERNAME = "hermes";
const DEFAULT_HERMES_LINK_MATCH = "https://app.heygen.com/magic-web,https://auth.heygen.com/magic-web";

// ========== Helpers ==========

function generatePassword(): string {
  const upper   = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower   = "abcdefghjkmnpqrstuvwxyz";
  const digits  = "23456789";
  const special = "!@#$%^&*";
  const all     = upper + lower + digits + special;
  const arr     = new Uint8Array(10);
  crypto.getRandomValues(arr);
  const chars = [
    upper  [arr[0] % upper.length],
    lower  [arr[1] % lower.length],
    digits [arr[2] % digits.length],
    special[arr[3] % special.length],
    ...Array.from(arr.slice(4), (b) => all[b % all.length]),
  ];
  // shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = arr[i % arr.length] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
}

function randomToken(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] || char));
}

async function importRequestCryptoKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptImportPayload(secret: string, payload: unknown): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await importRequestCryptoKey(secret);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return `${bytesToBase64(iv)}.${bytesToBase64(cipher)}`;
}

async function decryptImportPayload(secret: string, encrypted: string): Promise<Record<string, string>> {
  const [ivB64, cipherB64] = encrypted.split(".");
  if (!ivB64 || !cipherB64) throw new Error("invalid encrypted payload");
  const key = await importRequestCryptoKey(secret);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(cipherB64),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
}

async function sendImportRequestNotification(env: Env, request: {
  id: string; registrar: string; targetUsername: string; requestedBy: string; domainCount: number; notes: string; hasAccountDetails: boolean;
}): Promise<{ sent: boolean; error?: string }> {
  if (!env.RESEND_API_KEY || !env.IMPORT_NOTIFY_TO || !env.IMPORT_NOTIFY_FROM) {
    return { sent: false, error: "notification_not_configured" };
  }
  const html = `
    <h2>New domain import request</h2>
    <p><b>Request ID:</b> ${escapeHtml(request.id)}</p>
    <p><b>Registrar:</b> ${escapeHtml(request.registrar)}</p>
    <p><b>Target user:</b> ${escapeHtml(request.targetUsername)}</p>
    <p><b>Requested by:</b> ${escapeHtml(request.requestedBy || "Not provided")}</p>
    <p><b>Estimated domains:</b> ${request.domainCount || "Not provided"}</p>
    <p><b>Account details:</b> ${request.hasAccountDetails ? "Provided in encrypted storage" : "Single account fields only"}</p>
    <p><b>Notes:</b></p>
    <pre>${escapeHtml(request.notes || "")}</pre>
    <p>Open the admin panel to review. This email does not include API keys, secrets, or passwords.</p>
  `;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.IMPORT_NOTIFY_FROM,
      to: [env.IMPORT_NOTIFY_TO],
      subject: `Domain import request pending: ${request.targetUsername}`,
      html,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { sent: false, error: text.slice(0, 300) || `resend_${res.status}` };
  }
  return { sent: true };
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  const isAllowed = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : (allowed[0] || "*"),
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
}

async function streamToText(stream: ReadableStream | null, maxChars = MAX_RAW_EMAIL_CHARS): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (result.length + chunk.length > maxChars) {
      result += chunk.slice(0, Math.max(0, maxChars - result.length));
      truncated = true;
      try { await reader.cancel("message too large"); } catch {}
      break;
    }
    result += chunk;
  }
  if (!truncated) result += decoder.decode();
  return truncated ? `${result}\n\n[truncated]` : result;
}

// ========== D1 Config Helpers ==========

async function getConfig(db: D1Database, key: string): Promise<string> {
  try {
    const row = await db.prepare("SELECT value FROM config WHERE key = ?").bind(key).first() as { value: string } | null;
    return row?.value || "";
  } catch {
    return "";
  }
}

async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(key, value).run();
}

async function getDomains(db: D1Database): Promise<string[]> {
  const raw = await getConfig(db, "domains");
  try { return JSON.parse(raw); } catch { return []; }
}

async function getDomainsPool2(db: D1Database): Promise<string[]> {
  const raw = await getConfig(db, "domains_pool2");
  try { return JSON.parse(raw); } catch { return []; }
}

async function getForwardRules(db: D1Database): Promise<ForwardRule[]> {
  const raw = await getConfig(db, "forward_rules");
  try { return JSON.parse(raw); } catch { return []; }
}

// Set of all configured (Cloudflare-routed) domains: pool1 + pool2 + forward subdomains.
async function getConfiguredDomains(db: D1Database): Promise<Set<string>> {
  const [domains, pool2, forwardRules] = await Promise.all([
    getDomains(db),
    getDomainsPool2(db),
    getForwardRules(db),
  ]);
  return new Set([
    ...domains.map((d) => d.toLowerCase()),
    ...pool2.map((d) => d.toLowerCase()),
    ...forwardRules.map((r) => r.subdomain.toLowerCase()),
  ]);
}

// Quota is consumed only by addresses that have received an activation link.
// Ordinary mail and reserved-but-unused addresses do not count.
async function getDomainLifetimeUsed(db: D1Database, domain: string): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) as count FROM passwords WHERE last_link_received_at IS NOT NULL AND domain = ?"
  ).bind(domain).first() as { count: number } | null;
  return row?.count || 0;
}

// hourly (clock-hour), daily (since 23:30 ET reset), lifetime activation-link counts for a domain.
async function getDomainCounts(db: D1Database, domain: string): Promise<{ daily: number; hourly: number; lifetime: number }> {
  const resetTs = getLastEasternReset();
  const hourStart = new Date();
  hourStart.setMinutes(0, 0, 0);
  const [d, h, l] = await Promise.all([
    db.prepare("SELECT COUNT(*) as c FROM passwords WHERE last_link_received_at IS NOT NULL AND domain = ? AND last_link_received_at >= ?").bind(domain, resetTs).first() as Promise<{ c: number } | null>,
    db.prepare("SELECT COUNT(*) as c FROM passwords WHERE last_link_received_at IS NOT NULL AND domain = ? AND last_link_received_at >= ?").bind(domain, hourStart.getTime()).first() as Promise<{ c: number } | null>,
    db.prepare("SELECT COUNT(*) as c FROM passwords WHERE last_link_received_at IS NOT NULL AND domain = ?").bind(domain).first() as Promise<{ c: number } | null>,
  ]);
  return { daily: d?.c || 0, hourly: h?.c || 0, lifetime: l?.c || 0 };
}

function domainWithinQuota(counts: { daily: number; hourly: number; lifetime: number }, user: Pick<User, "daily_limit" | "hourly_limit" | "lifetime_limit">): boolean {
  return counts.hourly < user.hourly_limit &&
    counts.daily < user.daily_limit &&
    counts.lifetime < user.lifetime_limit;
}

// ========== Users / Sessions / Ownership ==========

// 容错匹配：调用方已传入 trim().toLowerCase() 的归一化值。这里用 lower(trim(...))
// 对存量行做同样归一，使绕过 API 灌库/旧版本写入的非归一 username 行也能被解析到，
// 避免「admin 列表能看到、按 username 登录/改密/派域名却 404/401」的漂移。
// users 表行数极小，放弃 username 索引走全表扫描的代价可忽略。
async function getUserByUsername(db: D1Database, username: string): Promise<User | null> {
  return await db.prepare("SELECT * FROM users WHERE lower(trim(username)) = ?").bind(username).first() as User | null;
}

async function getUserById(db: D1Database, id: string): Promise<User | null> {
  return await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first() as User | null;
}

async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(token, userId, now, now + SESSION_TTL_MS).run();
  return token;
}

async function resolveSession(db: D1Database, token: string): Promise<User | null> {
  const row = await db.prepare(
    "SELECT user_id, expires_at FROM sessions WHERE token = ?"
  ).bind(token).first() as { user_id: string; expires_at: number } | null;
  if (!row || row.expires_at < Date.now()) return null;
  return await getUserById(db, row.user_id);
}

async function resolveActorByToken(env: Env, token: string): Promise<Actor | null> {
  if (!token) return null;
  if (token === env.ADMIN_PASSWORD) return { isAdmin: true, user: null };
  const user = await resolveSession(env.DB, token);
  return user ? { isAdmin: false, user } : null;
}

async function resolveActor(request: Request, env: Env): Promise<Actor | null> {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  return resolveActorByToken(env, auth.slice(7));
}

function checkAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.ADMIN_PASSWORD}`;
}

function checkHermesAuth(request: Request, env: Env): boolean {
  const secret = env.HERMES_SHARED_SECRET || "";
  if (!secret) return false;
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${secret}`;
}

function getHermesUsername(env: Env): string {
  return (env.HERMES_USERNAME || DEFAULT_HERMES_USERNAME).trim().toLowerCase();
}

function getHermesLinkMatch(env: Env): string {
  return (env.HERMES_LINK_MATCH || DEFAULT_HERMES_LINK_MATCH).trim();
}

function getHermesLinkMatches(env: Env): string[] {
  return getHermesLinkMatch(env).split(",").map((s) => s.trim()).filter(Boolean);
}

async function getDomainOwner(db: D1Database, domain: string): Promise<{ owner_id: string; enabled: number } | null> {
  return await db.prepare(
    "SELECT owner_id, enabled FROM domain_owner WHERE domain = ?"
  ).bind(domain).first() as { owner_id: string; enabled: number } | null;
}

async function getUserDomains(db: D1Database, userId: string): Promise<{ domain: string; enabled: number }[]> {
  const rows = await db.prepare(
    "SELECT domain, enabled FROM domain_owner WHERE owner_id = ? ORDER BY domain"
  ).bind(userId).all();
  return (rows.results || []) as { domain: string; enabled: number }[];
}

// Word lists for human-looking local parts. Kept in sync with the frontend's
// src/lib/utils.ts so manual and auto-generated addresses share one scheme.
const FIRST_NAMES = [
  "james","john","robert","michael","william","david","richard","joseph","thomas","charles",
  "mary","patricia","jennifer","linda","barbara","elizabeth","susan","jessica","sarah","karen",
  "alex","chris","jordan","taylor","morgan","casey","riley","jamie","avery","skyler",
  "emma","liam","noah","olivia","sophia","lucas","mason","ethan","ava","isabella",
  "jack","lily","ryan","grace","owen","zoe","evan","chloe","sean","maya",
];
const LAST_NAMES = [
  "smith","johnson","williams","brown","jones","garcia","miller","davis","rodriguez","martinez",
  "hernandez","lopez","gonzalez","wilson","anderson","thomas","taylor","moore","jackson","martin",
  "lee","perez","thompson","white","harris","sanchez","clark","ramirez","lewis","robinson",
  "walker","young","allen","king","wright","scott","torres","hill","flores","green",
  "adams","nelson","baker","hall","rivera","campbell","mitchell","carter","roberts","reed",
];
const ADJECTIVES = [
  "blue","happy","silent","brave","calm","clever","cosmic","golden","lucky","mellow",
  "noble","quick","rapid","shiny","swift","witty","bright","bold","crisp","fancy",
  "gentle","jolly","keen","lively","misty","proud","royal","sunny","vivid","zen",
];
const NOUNS = [
  "falcon","otter","tiger","river","maple","comet","willow","harbor","meadow","canyon",
  "ember","pixel","cobra","lynx","raven","badger","panda","koala","heron","marlin",
  "quartz","cedar","orchid","summit","breeze","lotus","onyx","drift","wren","fox",
];
// Excludes easily-confused chars: 0 o 1 l i
const SAFE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

function randInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const limit = Math.floor(0xffffffff / max) * max;
  while (buf[0] >= limit) crypto.getRandomValues(buf);
  return buf[0] % max;
}

function pick<T>(arr: T[]): T {
  return arr[randInt(arr.length)];
}

function randomChars(length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) result += SAFE_CHARS.charAt(randInt(SAFE_CHARS.length));
  return result;
}

// Generate a human-looking, lowercase local part by mixing templates.
function generateLocalPart(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const sep = pick(["", "", "", ".", "_"]);
    let v: string;
    switch (randInt(4)) {
      case 0:
        v = `${pick(FIRST_NAMES)}${sep}${pick(LAST_NAMES)}${randInt(990) + 7}`;
        break;
      case 1:
        v = `${pick(FIRST_NAMES)}${pick(LAST_NAMES)}${randInt(90) + 10}`;
        break;
      case 2:
        v = `${pick(ADJECTIVES)}${pick(NOUNS)}${randInt(90) + 10}`;
        break;
      default:
        v = `${pick(FIRST_NAMES)}${sep || "."}${randomChars(4)}`;
        break;
    }
    if (v.length >= 6 && v.length <= 20) return v;
  }
  return `${pick(FIRST_NAMES)}${randInt(990) + 7}`;
}

async function generateAddressForOwner(
  db: D1Database,
  owner: User,
  profileId: string,
  count = 1,
): Promise<string[]> {
  const userDomains = await getUserDomains(db, owner.id);
  const enabledDomains = userDomains.filter((d) => d.enabled).map((d) => d.domain);
  if (!enabledDomains.length) {
    throw new Error("no enabled domains for owner");
  }

  const usedRows = await db.prepare(
    "SELECT address FROM profile_addresses WHERE profile_id = ?"
  ).bind(profileId).all();
  const usedDomains = new Set(
    (usedRows.results || []).map((r: Record<string, unknown>) => String(r.address).split("@")[1].toLowerCase())
  );
  const preferredDomains = enabledDomains.filter((d) => !usedDomains.has(d.toLowerCase()));
  const candidateDomains = preferredDomains.length > 0 ? preferredDomains : enabledDomains;

  const quotaCounts = await Promise.all(
    candidateDomains.map((d) => getDomainCounts(db, d).then((counts) => ({ domain: d, counts })))
  );
  const eligibleDomains = quotaCounts
    .filter(({ counts }) => domainWithinQuota(counts, owner))
    .map(({ domain }) => domain);
  if (!eligibleDomains.length) {
    throw new Error("all owner domains have reached activation-link quota");
  }

  const generated: string[] = [];
  let attempts = 0;
  const maxAttempts = Math.max(20, count * 20);

  while (generated.length < count && attempts < maxAttempts) {
    attempts += 1;
    const domain = eligibleDomains[Math.floor(Math.random() * eligibleDomains.length)];
    const address = `${generateLocalPart()}@${domain}`;
    if (generated.includes(address)) continue;
    const existing = await db.prepare(
      "SELECT address FROM passwords WHERE address = ? LIMIT 1"
    ).bind(address).first();
    if (existing) continue;

    const now = Date.now();
    await db.prepare(
      "INSERT INTO passwords (address, password, label, confirmed, created_at, updated_at, domain, owner_id) VALUES (?, ?, '', 0, ?, ?, ?, ?)"
    ).bind(address, generatePassword(), now, now, domain, owner.id).run();
    await db.prepare(
      "INSERT OR REPLACE INTO profile_addresses (address, profile_id, assigned_at) VALUES (?, ?, ?)"
    ).bind(address, profileId, now).run();
    generated.push(address);
  }

  if (generated.length < count) {
    throw new Error(`only generated ${generated.length}/${count} addresses`);
  }

  return generated;
}

// Return the UTC timestamp of the most recent 11:30 PM Eastern reset
function getLastEasternReset(): number {
  const now = new Date();
  const etFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = etFmt.formatToParts(now);
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value);
  const etH = get("hour"), etM = get("minute");
  const etY = get("year"), etMo = get("month") - 1, etD = get("day");

  // If before 23:30 ET today, reset was last night (yesterday 23:30 ET)
  const dayOffset = (etH < 23 || (etH === 23 && etM < 30)) ? -1 : 0;
  const resetDay = new Date(Date.UTC(etY, etMo, etD + dayOffset));
  const resetStr = `${resetDay.getUTCFullYear()}-${String(resetDay.getUTCMonth() + 1).padStart(2, "0")}-${String(resetDay.getUTCDate()).padStart(2, "0")}T23:30:00`;

  // resetStr is in ET wall-clock; find the UTC equivalent by using current ET offset
  const nowAsUTC = now.getTime();
  const nowAsET = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })).getTime();
  const etToUTCOffsetMs = nowAsUTC - nowAsET; // positive: ET is behind UTC
  return new Date(resetStr).getTime() + etToUTCOffsetMs;
}

const MAX_RAW_EMAIL_CHARS = 256 * 1024;
const MAX_STORED_BODY_CHARS = 128 * 1024;
const MAX_STORED_SUBJECT_CHARS = 500;
const STREAM_POLL_MS = 30_000;
const EMAIL_LIST_LIMIT = 40;


// ========== Email parsing ==========

function decodeQP(str: string): string {
  return str
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function parseEmailContent(rawEmail: string) {
  let textBody = "";
  let htmlBody = "";
  let subject = "";

  const subjectMatch = rawEmail.match(/^Subject:\s*(.+)$/im);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
    subject = subject.replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (_, _charset, encoding, encoded) => {
        try {
          if (encoding.toUpperCase() === "B") return atob(encoded);
          return encoded
            .replace(/_/g, " ")
            .replace(/=([0-9A-Fa-f]{2})/g, (_2: string, hex: string) =>
              String.fromCharCode(parseInt(hex, 16))
            );
        } catch { return encoded; }
      }
    );
  }

  const boundaryMatch = rawEmail.match(
    /Content-Type:\s*multipart\/\w+;\s*boundary="?([^"\s;]+)"?/i
  );

  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = rawEmail.split(`--${boundary}`);
    for (const part of parts) {
      const rnrn = part.indexOf("\r\n\r\n");
      const nn = part.indexOf("\n\n");
      const bodyStart = rnrn >= 0 ? rnrn + 4 : (nn >= 0 ? nn + 2 : -1);
      if (bodyStart === -1) continue;
      const body = part.substring(bodyStart).trim();
      const isB64 = part.includes("Content-Transfer-Encoding: base64");
      const isQP = part.includes("Content-Transfer-Encoding: quoted-printable");

      if (part.includes("Content-Type: text/plain")) {
        textBody = isB64 ? (() => { try { return atob(body.replace(/\s/g, "")); } catch { return body; } })()
          : isQP ? decodeQP(body) : body;
      }
      if (part.includes("Content-Type: text/html")) {
        htmlBody = isB64 ? (() => { try { return atob(body.replace(/\s/g, "")); } catch { return body; } })()
          : isQP ? decodeQP(body) : body;
      }
    }
  } else {
    const rnrn = rawEmail.indexOf("\r\n\r\n");
    const nn = rawEmail.indexOf("\n\n");
    const bodyStart = rnrn >= 0 ? rnrn + 4 : (nn >= 0 ? nn + 2 : -1);
    if (bodyStart > -1) {
      const body = rawEmail.substring(bodyStart);
      const isB64 = rawEmail.includes("Content-Transfer-Encoding: base64");
      const isQP = rawEmail.includes("Content-Transfer-Encoding: quoted-printable");
      if (rawEmail.includes("Content-Type: text/html")) {
        htmlBody = isB64 ? (() => { try { return atob(body.replace(/\s/g, "")); } catch { return body; } })()
          : isQP ? decodeQP(body) : body;
      } else {
        textBody = isB64 ? (() => { try { return atob(body.replace(/\s/g, "")); } catch { return body; } })()
          : isQP ? decodeQP(body) : body;
      }
    }
  }

  return {
    subject: truncateText(subject, MAX_STORED_SUBJECT_CHARS),
    textBody: truncateText(textBody, MAX_STORED_BODY_CHARS),
    htmlBody: truncateText(htmlBody, MAX_STORED_BODY_CHARS),
  };
}

// Extract the first link matching linkFilter from email content.
function extractActivationLink(htmlBody: string, textBody: string, linkFilter: string): string | null {
  if (!linkFilter) return null;
  const content = (htmlBody || "") + " " + (textBody || "");
  const re = /https?:\/\/[^\s"'<>)]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    // startsWith (not includes): the activation link must BEGIN with the trusted
    // prefix. includes() would match attacker-controlled mail like
    // https://evil.com/?next=https://auth.heygen.com/... and return the evil URL.
    if (m[0].startsWith(linkFilter)) return m[0].replace(/[.,;!?]+$/, "");
  }
  return null;
}

function extractFirstMatchingLink(htmlBody: string, textBody: string, linkFilters: string[]): string | null {
  for (const filter of linkFilters) {
    const link = extractActivationLink(htmlBody, textBody, filter);
    if (link) return link;
  }
  return null;
}

// ========== HTTP Request Handler ==========

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const headers = corsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  // GET /api/config — public, minimal branding/config for the login page
  if (url.pathname === "/api/config" && request.method === "GET") {
    const siteName = await getConfig(env.DB, "site_name");
    const autoDeleteHours = await getConfig(env.DB, "auto_delete_hours");
    const linkFilter = await getConfig(env.DB, "link_filter");
    return Response.json({
      siteName: siteName || "云端接码",
      autoDeleteHours: parseInt(autoDeleteHours) || 24,
      linkFilter: linkFilter || "auth.heygen.com",
    }, { headers });
  }

  // POST /api/login — user login {username,password} → session token
  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = JSON.parse(await request.text()) as { username?: string; password?: string };
    const username = (body.username || "").trim().toLowerCase();
    if (!username || !body.password) {
      return Response.json({ error: "用户名和密码必填" }, { status: 400, headers });
    }
    const user = await getUserByUsername(env.DB, username);
    if (!user || user.password_hash !== await sha256Hex(body.password)) {
      return Response.json({ error: "用户名或密码错误" }, { status: 401, headers });
    }
    const token = await createSession(env.DB, user.id);
    return Response.json({ ok: true, token, username: user.username, isAdmin: false }, { headers });
  }

  // Hermes integration endpoints: dedicated machine-to-machine flow scoped to one user.
  if (url.pathname.startsWith("/api/hermes/")) {
    if (!checkHermesAuth(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const hermesUser = await getUserByUsername(env.DB, getHermesUsername(env));
    if (!hermesUser) {
      return Response.json({ error: "configured hermes user not found" }, { status: 500, headers });
    }

    if (url.pathname === "/api/hermes/session" && request.method === "POST") {
      const body = JSON.parse(await request.text() || "{}") as { profile_id?: string };
      const profileId = (body.profile_id || `hermes_${generateId()}`).trim();
      if (!profileId) return Response.json({ error: "profile_id required" }, { status: 400, headers });
      return Response.json({
        ok: true,
        profileId,
        username: hermesUser.username,
        linkMatch: getHermesLinkMatch(env),
      }, { headers });
    }

    if (url.pathname === "/api/hermes/generate-address" && request.method === "POST") {
      const body = JSON.parse(await request.text() || "{}") as { profile_id?: string; count?: number };
      const profileId = (body.profile_id || "").trim();
      const count = Math.min(20, Math.max(1, parseInt(String(body.count || 1)) || 1));
      if (!profileId) return Response.json({ error: "profile_id required" }, { status: 400, headers });
      try {
        const addresses = await generateAddressForOwner(env.DB, hermesUser, profileId, count);
        return Response.json({ ok: true, profileId, addresses }, { headers });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 400, headers });
      }
    }

    if (url.pathname === "/api/hermes/profile-addresses" && request.method === "GET") {
      const profileId = (url.searchParams.get("profile_id") || "").trim();
      if (!profileId) return Response.json({ error: "profile_id required" }, { status: 400, headers });
      const rows = await env.DB.prepare(
        "SELECT address FROM profile_addresses WHERE profile_id = ? ORDER BY assigned_at DESC"
      ).bind(profileId).all();
      return Response.json({
        profileId,
        addresses: (rows.results || []).map((r: Record<string, unknown>) => r.address),
      }, { headers });
    }

    if (url.pathname === "/api/hermes/activation-links" && request.method === "GET") {
      const profileId = (url.searchParams.get("profile_id") || "").trim();
      const consume = url.searchParams.get("consume") === "1";
      if (!profileId) return Response.json({ error: "profile_id required" }, { status: 400, headers });
      const rows = await env.DB.prepare(
        "SELECT id, url, created_at FROM activation_links WHERE profile_id = ? AND consumed = 0 ORDER BY created_at ASC LIMIT 20"
      ).bind(profileId).all();
      const links = (rows.results || []) as { id: string; url: string; created_at: number }[];
      if (consume && links.length) {
        for (const row of links) {
          await env.DB.prepare("UPDATE activation_links SET consumed = 1 WHERE id = ?").bind(row.id).run();
        }
      }
      return Response.json({ profileId, links }, { headers });
    }

    if (url.pathname === "/api/hermes/config" && request.method === "GET") {
      return Response.json({
        ok: true,
        username: hermesUser.username,
        workerUrl: new URL(request.url).origin,
        linkMatch: getHermesLinkMatch(env),
      }, { headers });
    }
  }

  // POST /api/logout — invalidate current session token
  if (url.pathname === "/api/logout" && request.method === "POST") {
    const auth = request.headers.get("Authorization") || "";
    if (auth.startsWith("Bearer ")) {
      await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(auth.slice(7)).run();
    }
    return Response.json({ ok: true }, { headers });
  }

  // ── User self-service (logged-in user) ──

  // GET /api/account — my profile, quotas, owned domains
  if (url.pathname === "/api/account" && request.method === "GET") {
    const actor = await resolveActor(request, env);
    if (!actor || !actor.user) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const u = actor.user;
    const domains = await getUserDomains(env.DB, u.id);
    return Response.json({
      username: u.username,
      dailyLimit: u.daily_limit,
      hourlyLimit: u.hourly_limit,
      lifetimeLimit: u.lifetime_limit,
      domains,
    }, { headers });
  }

  // POST /api/account/password — change own password {oldPassword,newPassword}
  if (url.pathname === "/api/account/password" && request.method === "POST") {
    const actor = await resolveActor(request, env);
    if (!actor || !actor.user) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const body = JSON.parse(await request.text()) as { oldPassword?: string; newPassword?: string };
    if (!body.newPassword || body.newPassword.length < 4) {
      return Response.json({ error: "新密码至少 4 位" }, { status: 400, headers });
    }
    if (!body.oldPassword || actor.user.password_hash !== await sha256Hex(body.oldPassword)) {
      return Response.json({ error: "原密码错误" }, { status: 401, headers });
    }
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(await sha256Hex(body.newPassword), actor.user.id).run();
    return Response.json({ ok: true }, { headers });
  }

  // POST /api/account/quota — set own per-domain quotas
  if (url.pathname === "/api/account/quota" && request.method === "POST") {
    const actor = await resolveActor(request, env);
    if (!actor || !actor.user) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const body = JSON.parse(await request.text()) as { dailyLimit?: number; hourlyLimit?: number; lifetimeLimit?: number };
    const sets: string[] = [];
    const binds: number[] = [];
    for (const [key, col] of [["dailyLimit", "daily_limit"], ["hourlyLimit", "hourly_limit"], ["lifetimeLimit", "lifetime_limit"]] as const) {
      const v = body[key];
      if (v !== undefined) {
        const n = parseInt(String(v));
        if (!n || n < 1) return Response.json({ error: `${key} 必须 >= 1` }, { status: 400, headers });
        sets.push(`${col} = ?`);
        binds.push(n);
      }
    }
    if (sets.length) {
      await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, actor.user.id).run();
    }
    return Response.json({ ok: true }, { headers });
  }

  // POST /api/account/domain-toggle — enable/disable one of my own domains
  if (url.pathname === "/api/account/domain-toggle" && request.method === "POST") {
    const actor = await resolveActor(request, env);
    if (!actor || !actor.user) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const body = JSON.parse(await request.text()) as { domain?: string; enabled?: boolean };
    const domain = (body.domain || "").toLowerCase();
    if (!domain) return Response.json({ error: "domain required" }, { status: 400, headers });
    const owner = await getDomainOwner(env.DB, domain);
    if (!owner || owner.owner_id !== actor.user.id) {
      return Response.json({ error: "该域名不属于你" }, { status: 403, headers });
    }
    await env.DB.prepare("UPDATE domain_owner SET enabled = ? WHERE domain = ?")
      .bind(body.enabled ? 1 : 0, domain).run();
    return Response.json({ ok: true }, { headers });
  }

  // POST /api/admin/login
  if (url.pathname === "/api/admin/login" && request.method === "POST") {
    const body = JSON.parse(await request.text()) as { password: string };
    if (body.password === env.ADMIN_PASSWORD) {
      return Response.json({ ok: true, token: env.ADMIN_PASSWORD }, { headers });
    }
    return Response.json({ error: "密码错误" }, { status: 401, headers });
  }

  // Admin endpoints (ADMIN_PASSWORD required)
  if (url.pathname.startsWith("/api/admin/")) {
    if (!checkAuth(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }

    // GET /api/admin/config
    if (url.pathname === "/api/admin/config" && request.method === "GET") {
      const domains = await getDomains(env.DB);
      const domainsPool2 = await getDomainsPool2(env.DB);
      const forwardRules = await getForwardRules(env.DB);
      const siteName = await getConfig(env.DB, "site_name");
      const autoDeleteHours = await getConfig(env.DB, "auto_delete_hours");
      const linkFilter = await getConfig(env.DB, "link_filter");
      return Response.json({
        domains, domainsPool2, forwardRules,
        siteName: siteName || "云端接码",
        autoDeleteHours: parseInt(autoDeleteHours) || 24,
        linkFilter: linkFilter || "auth.heygen.com",
      }, { headers });
    }

    // POST /api/admin/config
    if (url.pathname === "/api/admin/config" && request.method === "POST") {
      const body = JSON.parse(await request.text()) as {
        domains?: string[];
        domainsPool2?: string[];
        forwardRules?: ForwardRule[];
        siteName?: string;
        autoDeleteHours?: number;
        linkFilter?: string;
      };
      if (body.domains !== undefined) await setConfig(env.DB, "domains", JSON.stringify(body.domains));
      if (body.domainsPool2 !== undefined) await setConfig(env.DB, "domains_pool2", JSON.stringify(body.domainsPool2));
      if (body.forwardRules !== undefined) await setConfig(env.DB, "forward_rules", JSON.stringify(body.forwardRules));
      if (body.siteName !== undefined) await setConfig(env.DB, "site_name", body.siteName);
      if (body.autoDeleteHours !== undefined) await setConfig(env.DB, "auto_delete_hours", String(body.autoDeleteHours));
      if (body.linkFilter !== undefined) await setConfig(env.DB, "link_filter", body.linkFilter);
      return Response.json({ ok: true }, { headers });
    }

    // GET /api/admin/users — list users + their domains
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      const userRows = await env.DB.prepare(
        "SELECT id, username, is_admin, daily_limit, hourly_limit, lifetime_limit, created_at FROM users ORDER BY created_at ASC"
      ).all();
      const domainRows = await env.DB.prepare(
        "SELECT domain, owner_id, enabled FROM domain_owner ORDER BY domain"
      ).all();
      const byOwner: Record<string, { domain: string; enabled: number }[]> = {};
      for (const r of (domainRows.results || []) as { domain: string; owner_id: string; enabled: number }[]) {
        (byOwner[r.owner_id] ||= []).push({ domain: r.domain, enabled: r.enabled });
      }
      const users = ((userRows.results || []) as Record<string, unknown>[]).map((u) => ({
        id: u.id, username: u.username, isAdmin: u.is_admin,
        dailyLimit: u.daily_limit, hourlyLimit: u.hourly_limit, lifetimeLimit: u.lifetime_limit,
        createdAt: u.created_at,
        domains: byOwner[u.id as string] || [],
      }));
      return Response.json({ users }, { headers });
    }

    // POST /api/admin/users — create a user
    if (url.pathname === "/api/admin/users" && request.method === "POST") {
      const body = JSON.parse(await request.text()) as {
        username?: string; password?: string;
        dailyLimit?: number; hourlyLimit?: number; lifetimeLimit?: number;
      };
      const username = (body.username || "").trim().toLowerCase();
      if (!username || !body.password) {
        return Response.json({ error: "用户名和密码必填" }, { status: 400, headers });
      }
      if (await getUserByUsername(env.DB, username)) {
        return Response.json({ error: "用户名已存在" }, { status: 409, headers });
      }
      const id = generateId();
      await env.DB.prepare(
        "INSERT INTO users (id, username, password_hash, is_admin, daily_limit, hourly_limit, lifetime_limit, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)"
      ).bind(
        id, username, await sha256Hex(body.password),
        parseInt(String(body.dailyLimit)) || DEFAULT_DAILY_LIMIT,
        parseInt(String(body.hourlyLimit)) || DEFAULT_HOURLY_LIMIT,
        parseInt(String(body.lifetimeLimit)) || DEFAULT_LIFETIME_LIMIT,
        Date.now(),
      ).run();
      return Response.json({ ok: true, id }, { headers });
    }

    // POST /api/admin/users/password — admin reset a user's password
    if (url.pathname === "/api/admin/users/password" && request.method === "POST") {
      const body = JSON.parse(await request.text()) as { username?: string; newPassword?: string };
      const username = (body.username || "").trim().toLowerCase();
      if (!username || !body.newPassword) {
        return Response.json({ error: "username and newPassword required" }, { status: 400, headers });
      }
      const user = await getUserByUsername(env.DB, username);
      if (!user) return Response.json({ error: "用户不存在" }, { status: 404, headers });
      await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(await sha256Hex(body.newPassword), user.id).run();
      return Response.json({ ok: true }, { headers });
    }

    // POST /api/admin/users/quota — admin set a user's per-domain activation-link quotas
    if (url.pathname === "/api/admin/users/quota" && request.method === "POST") {
      const body = JSON.parse(await request.text()) as {
        username?: string; dailyLimit?: number; hourlyLimit?: number; lifetimeLimit?: number;
      };
      const username = (body.username || "").trim().toLowerCase();
      const user = username ? await getUserByUsername(env.DB, username) : null;
      if (!user) return Response.json({ error: "用户不存在" }, { status: 404, headers });
      const sets: string[] = [];
      const binds: number[] = [];
      for (const [key, col] of [["dailyLimit", "daily_limit"], ["hourlyLimit", "hourly_limit"], ["lifetimeLimit", "lifetime_limit"]] as const) {
        const v = body[key];
        if (v !== undefined) {
          const n = parseInt(String(v));
          if (!n || n < 1) return Response.json({ error: `${key} 必须 >= 1` }, { status: 400, headers });
          sets.push(`${col} = ?`);
          binds.push(n);
        }
      }
      if (!sets.length) return Response.json({ error: "no quota fields provided" }, { status: 400, headers });
      await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, user.id).run();
      return Response.json({ ok: true }, { headers });
    }

    // GET /api/admin/import-requests — list domain import requests without secrets
    if (url.pathname === "/api/admin/import-requests" && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id, status, registrar, target_username, api_key_tail, domain_count, domains_text, notes, requested_by, notification_sent, notification_error, created_at, updated_at FROM domain_import_requests ORDER BY created_at DESC LIMIT 100"
      ).all();
      const requests = ((rows.results || []) as unknown as ImportRequestRow[]).map((r) => ({
        id: r.id,
        status: r.status,
        registrar: r.registrar,
        targetUsername: r.target_username,
        apiKeyTail: r.api_key_tail,
        domainCount: r.domain_count,
        domainsText: r.domains_text,
        notes: r.notes,
        requestedBy: r.requested_by,
        notificationSent: !!r.notification_sent,
        notificationError: r.notification_error || "",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      return Response.json({ requests }, { headers });
    }

    // POST /api/admin/import-requests — create a standardized registrar import request
    if (url.pathname === "/api/admin/import-requests" && request.method === "POST") {
      if (!env.IMPORT_REQUEST_SECRET) {
        return Response.json({ error: "IMPORT_REQUEST_SECRET is required to store request credentials" }, { status: 500, headers });
      }
      const body = JSON.parse(await request.text()) as {
        registrar?: string; apiKey?: string; apiSecret?: string; targetUsername?: string; targetPassword?: string;
        targetAccountsText?: string; domainsText?: string; notes?: string; requestedBy?: string;
      };
      const registrar = (body.registrar || "spaceship").trim().toLowerCase();
      const apiKey = (body.apiKey || "").trim();
      const apiSecret = (body.apiSecret || "").trim();
      const targetUsername = (body.targetUsername || "").trim();
      const targetPassword = body.targetPassword || "";
      const targetAccountsText = (body.targetAccountsText || "").trim();
      const domainsText = (body.domainsText || "").trim();
      const notes = (body.notes || "").trim();
      const requestedBy = (body.requestedBy || "").trim();
      if (!registrar || !apiKey || !apiSecret || (!targetAccountsText && (!targetUsername || !targetPassword))) {
        return Response.json({ error: "registrar, apiKey, apiSecret, and either a single target account or account details are required" }, { status: 400, headers });
      }
      const targetSummary = targetUsername || "multiple-accounts";
      if (!/^[a-z0-9_-]{2,40}$/.test(registrar) || !/^[a-zA-Z0-9_.@-]{2,80}$/.test(targetSummary)) {
        return Response.json({ error: "invalid registrar or targetUsername" }, { status: 400, headers });
      }
      if (
        apiKey.length > MAX_IMPORT_SECRET_CHARS ||
        apiSecret.length > MAX_IMPORT_SECRET_CHARS ||
        targetPassword.length > MAX_IMPORT_SECRET_CHARS ||
        targetAccountsText.length > MAX_IMPORT_TEXT_CHARS ||
        domainsText.length > MAX_IMPORT_TEXT_CHARS ||
        notes.length > MAX_IMPORT_NOTES_CHARS ||
        requestedBy.length > 200
      ) {
        return Response.json({ error: "request payload is too large" }, { status: 413, headers });
      }
      const domainCount = domainsText ? domainsText.split(/[\s,]+/).filter(Boolean).length : 0;
      const id = generateId();
      const now = Date.now();
      const encrypted_payload = await encryptImportPayload(env.IMPORT_REQUEST_SECRET, {
        apiKey, apiSecret, targetPassword, targetAccountsText,
      });
      const notify = await sendImportRequestNotification(env, {
        id, registrar, targetUsername: targetSummary, requestedBy, domainCount, notes, hasAccountDetails: !!targetAccountsText,
      });
      await env.DB.prepare(
        `INSERT INTO domain_import_requests (
          id, status, registrar, target_username, api_key_tail, encrypted_payload,
          domain_count, domains_text, notes, requested_by, notification_sent,
          notification_error, created_at, updated_at
        ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, registrar, targetSummary, apiKey.slice(-6), encrypted_payload,
        domainCount, domainsText, notes, requestedBy, notify.sent ? 1 : 0,
        notify.error || "", now, now,
      ).run();
      return Response.json({ ok: true, id, notificationSent: notify.sent, notificationError: notify.error || "" }, { headers });
    }

    // POST /api/admin/import-requests/status — admin approval workflow
    if (url.pathname === "/api/admin/import-requests/status" && request.method === "POST") {
      const body = JSON.parse(await request.text()) as { id?: string; status?: string };
      const id = (body.id || "").trim();
      const status = (body.status || "").trim().toLowerCase();
      if (!id || !["pending", "approved", "rejected", "processing", "done"].includes(status)) {
        return Response.json({ error: "invalid id or status" }, { status: 400, headers });
      }
      const result = await env.DB.prepare(
        "UPDATE domain_import_requests SET status = ?, updated_at = ? WHERE id = ?"
      ).bind(status, Date.now(), id).run();
      if (!result.meta?.changes) {
        return Response.json({ error: "request not found" }, { status: 404, headers });
      }
      return Response.json({ ok: true }, { headers });
    }

    // POST /api/admin/import-requests/reveal — reveal encrypted credentials after approval
    if (url.pathname === "/api/admin/import-requests/reveal" && request.method === "POST") {
      if (!env.IMPORT_REQUEST_SECRET) {
        return Response.json({ error: "IMPORT_REQUEST_SECRET is not configured" }, { status: 500, headers });
      }
      const body = JSON.parse(await request.text()) as { id?: string };
      const id = (body.id || "").trim();
      if (!id) return Response.json({ error: "id required" }, { status: 400, headers });
      const row = await env.DB.prepare(
        "SELECT id, status, encrypted_payload FROM domain_import_requests WHERE id = ?"
      ).bind(id).first() as { id: string; status: string; encrypted_payload: string } | null;
      if (!row) return Response.json({ error: "request not found" }, { status: 404, headers });
      if (!["approved", "processing"].includes(row.status)) {
        return Response.json({ error: "credentials can only be revealed after approval" }, { status: 409, headers });
      }
      const payload = await decryptImportPayload(env.IMPORT_REQUEST_SECRET, row.encrypted_payload);
      return Response.json({
        apiKey: payload.apiKey || "",
        apiSecret: payload.apiSecret || "",
        targetPassword: payload.targetPassword || "",
        targetAccountsText: payload.targetAccountsText || "",
      }, { headers });
    }

    // DELETE /api/admin/users — delete a user, release domains, orphan their data
    if (url.pathname === "/api/admin/users" && request.method === "DELETE") {
      const body = JSON.parse(await request.text()) as { username?: string };
      const username = (body.username || "").trim().toLowerCase();
      const user = username ? await getUserByUsername(env.DB, username) : null;
      if (!user) return Response.json({ error: "用户不存在" }, { status: 404, headers });
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run();
      await env.DB.prepare("UPDATE passwords SET owner_id = NULL WHERE owner_id = ?").bind(user.id).run();
      await env.DB.prepare("UPDATE emails SET owner_id = NULL WHERE owner_id = ?").bind(user.id).run();
      await env.DB.prepare("DELETE FROM domain_owner WHERE owner_id = ?").bind(user.id).run();
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
      return Response.json({ ok: true }, { headers });
    }

    // POST /api/admin/assign-domain — assign a configured domain to a user (exclusive)
    if (url.pathname === "/api/admin/assign-domain" && request.method === "POST") {
      const body = JSON.parse(await request.text()) as { domain?: string; username?: string; reassign?: boolean };
      const domain = (body.domain || "").toLowerCase();
      const username = (body.username || "").trim().toLowerCase();
      if (!domain || !username) {
        return Response.json({ error: "domain and username required" }, { status: 400, headers });
      }
      const configured = await getConfiguredDomains(env.DB);
      if (!configured.has(domain)) {
        return Response.json({ error: "域名未在系统配置中（需先在 Cloudflare 配好并加入域名池）" }, { status: 400, headers });
      }
      const user = await getUserByUsername(env.DB, username);
      if (!user) return Response.json({ error: "用户不存在" }, { status: 404, headers });
      const existing = await getDomainOwner(env.DB, domain);
      if (existing && existing.owner_id !== user.id && !body.reassign) {
        return Response.json({ error: "域名已被其他用户占用（传 reassign=true 可改派）" }, { status: 409, headers });
      }
      const now = Date.now();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO domain_owner (domain, owner_id, enabled, assigned_at) VALUES (?, ?, 1, ?)"
      ).bind(domain, user.id, now).run();
      // Reattribute this domain's existing mailboxes/emails to the new owner so the
      // user immediately sees their inbox (no separate manual backfill needed).
      await env.DB.prepare("UPDATE passwords SET owner_id = ? WHERE domain = ?").bind(user.id, domain).run();
      await env.DB.prepare(
        "UPDATE emails SET owner_id = ? WHERE substr(mail_to, instr(mail_to, '@') + 1) = ?"
      ).bind(user.id, domain).run();
      return Response.json({ ok: true }, { headers });
    }

    // POST /api/admin/unassign-domain — remove ownership, orphan that domain's data
    if (url.pathname === "/api/admin/unassign-domain" && request.method === "POST") {
      const body = JSON.parse(await request.text()) as { domain?: string };
      const domain = (body.domain || "").toLowerCase();
      if (!domain) return Response.json({ error: "domain required" }, { status: 400, headers });
      await env.DB.prepare("DELETE FROM domain_owner WHERE domain = ?").bind(domain).run();
      await env.DB.prepare("UPDATE passwords SET owner_id = NULL WHERE domain = ?").bind(domain).run();
      await env.DB.prepare(
        "UPDATE emails SET owner_id = NULL WHERE substr(mail_to, instr(mail_to, '@') + 1) = ?"
      ).bind(domain).run();
      return Response.json({ ok: true }, { headers });
    }

    // GET /api/admin/stats
    if (url.pathname === "/api/admin/stats" && request.method === "GET") {
      const total = await env.DB.prepare("SELECT COUNT(*) as count FROM emails").first() as { count: number } | null;
      const today = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM emails WHERE timestamp > ?"
      ).bind(Date.now() - 86400000).first() as { count: number } | null;
      return Response.json({
        totalEmails: total?.count || 0,
        todayEmails: today?.count || 0,
      }, { headers });
    }

    // GET /api/admin/emails — search across all users (exact address or substring)
    if (url.pathname === "/api/admin/emails" && request.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      const address = (url.searchParams.get("address") || "").toLowerCase();
      if (q) {
        if (q.length < 3) return Response.json({ error: "查询关键字至少 3 个字符" }, { status: 400, headers });
        const escaped = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
        const result = await env.DB.prepare(
          "SELECT id, mail_to as 'to', mail_from as 'from', subject, text_body as text, html_body as html, timestamp FROM emails WHERE mail_to LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT 50"
        ).bind(`%${escaped}%`).all();
        return Response.json({ emails: result.results || [] }, { headers });
      }
      if (address) {
        const result = await env.DB.prepare(
          "SELECT id, mail_to as 'to', mail_from as 'from', subject, text_body as text, html_body as html, timestamp FROM emails WHERE mail_to = ? ORDER BY timestamp DESC LIMIT 50"
        ).bind(address).all();
        return Response.json({ emails: result.results || [] }, { headers });
      }
      return Response.json({ error: "address or q required" }, { status: 400, headers });
    }

    // DELETE /api/admin/emails
    if (url.pathname === "/api/admin/emails" && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM emails").run();
      return Response.json({ ok: true }, { headers });
    }
  }

  // ── Mailbox / inbox endpoints (logged-in user; admin may scope via ?username) ──

  // Resolve the owner scope for a request: user → own id; admin → ?username or all.
  // Returns { ownerId: string | null, all: boolean } or null when unauthorized.
  async function ownerScope(): Promise<{ ownerId: string | null; all: boolean } | null> {
    const actor = await resolveActor(request, env);
    if (!actor) return null;
    if (actor.user) return { ownerId: actor.user.id, all: false };
    // admin
    const username = (url.searchParams.get("username") || "").trim().toLowerCase();
    if (username) {
      const u = await getUserByUsername(env.DB, username);
      return { ownerId: u ? u.id : "\0__none__", all: false };
    }
    return { ownerId: null, all: true };
  }

  // GET /api/passwords — list this owner's confirmed mailboxes
  if (url.pathname === "/api/passwords" && request.method === "GET") {
    const scope = await ownerScope();
    if (!scope) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50")));
    const start = url.searchParams.get("start") || "";
    const end = url.searchParams.get("end") || "";
    const linkDays = url.searchParams.get("linkDays") || "";
    const offset = (page - 1) * limit;

    let where = "WHERE confirmed = 1";
    const binds: (string | number)[] = [];
    if (!scope.all) { where += " AND owner_id = ?"; binds.push(scope.ownerId as string); }
    if (start) { where += " AND created_at >= ?"; binds.push(parseInt(start)); }
    if (end) { where += " AND created_at <= ?"; binds.push(parseInt(end)); }
    if (linkDays) {
      const cutoff = Date.now() - parseInt(linkDays) * 86400000;
      where += " AND last_link_received_at IS NOT NULL AND last_link_received_at <= ?";
      binds.push(cutoff);
    }

    const countRow = await env.DB.prepare(`SELECT COUNT(*) as total FROM passwords ${where}`).bind(...binds).first() as { total: number } | null;
    const total = countRow?.total || 0;
    const rows = await env.DB.prepare(
      `SELECT address, password, label, created_at, updated_at, last_link_received_at FROM passwords ${where} ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all();
    return Response.json({ passwords: rows.results || [], total, page, limit }, { headers });
  }

  // POST /api/passwords — reserve a mailbox (confirmed=0, no quota consumed yet)
  if (url.pathname === "/api/passwords" && request.method === "POST") {
    const actor = await resolveActor(request, env);
    if (!actor) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const body = JSON.parse(await request.text()) as { address: string; password: string };
    if (!body.address || !body.password) {
      return Response.json({ error: "address and password required" }, { status: 400, headers });
    }
    const address = body.address.toLowerCase();
    const addrDomain = address.includes("@") ? address.slice(address.indexOf("@") + 1) : "";
    const owner = await getDomainOwner(env.DB, addrDomain);

    // A user may only reserve on a domain they own and have enabled.
    if (actor.user) {
      if (!owner || owner.owner_id !== actor.user.id) {
        return Response.json({ error: "该域名不属于你" }, { status: 403, headers });
      }
      if (!owner.enabled) {
        return Response.json({ error: "该域名已被你停用" }, { status: 403, headers });
      }
    }

    const ownerId = owner?.owner_id || null;
    const limitUser = actor.user ?? (ownerId ? await getUserById(env.DB, ownerId) : null);
    const quotaUser = limitUser ?? {
      daily_limit: DEFAULT_DAILY_LIMIT,
      hourly_limit: DEFAULT_HOURLY_LIMIT,
      lifetime_limit: DEFAULT_LIFETIME_LIMIT,
    };

    const [existingPassword, existingEmail, quotaCounts] = await Promise.all([
      env.DB.prepare("SELECT address FROM passwords WHERE address = ? LIMIT 1").bind(address).first(),
      env.DB.prepare("SELECT mail_to FROM emails WHERE mail_to = ? LIMIT 1").bind(address).first(),
      getDomainCounts(env.DB, addrDomain),
    ]);
    if (existingPassword || existingEmail) {
      return Response.json({ error: "address already exists" }, { status: 409, headers });
    }
    if (!domainWithinQuota(quotaCounts, quotaUser)) {
      return Response.json({ error: "domain activation-link quota exceeded" }, { status: 429, headers });
    }
    const now = Date.now();
    // Saved as unconfirmed; quota is consumed only when an activation link arrives.
    await env.DB.prepare(
      "INSERT INTO passwords (address, password, label, confirmed, created_at, updated_at, domain, owner_id) VALUES (?, ?, '', 0, ?, ?, ?, ?)"
    ).bind(address, body.password, now, now, addrDomain, ownerId).run();
    return Response.json({ ok: true }, { headers });
  }

  // DELETE /api/passwords — remove a mailbox (own, or admin any)
  if (url.pathname === "/api/passwords" && request.method === "DELETE") {
    const actor = await resolveActor(request, env);
    if (!actor) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const body = JSON.parse(await request.text()) as { address: string };
    const address = body.address.toLowerCase();
    if (actor.user) {
      await env.DB.prepare("DELETE FROM passwords WHERE address = ? AND owner_id = ?").bind(address, actor.user.id).run();
    } else {
      await env.DB.prepare("DELETE FROM passwords WHERE address = ?").bind(address).run();
    }
    return Response.json({ ok: true }, { headers });
  }

  // GET /api/inbox — this owner's received emails (metadata + activation link).
  // Optional ?address= (exact) or ?q= (substring >=3) narrows within the owner's
  // own mail only — owner_id equality keeps it indexed (idx_emails_owner_ts); the
  // optional mail_to filter runs over just this user's rows, not a global scan.
  if (url.pathname === "/api/inbox" && request.method === "GET") {
    const scope = await ownerScope();
    if (!scope || scope.all || !scope.ownerId) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const address = (url.searchParams.get("address") || "").toLowerCase();
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    let where = "WHERE owner_id = ?";
    const binds: (string | number)[] = [scope.ownerId];
    if (address) {
      where += " AND mail_to = ?";
      binds.push(address);
    } else if (q) {
      if (q.length < 3) return Response.json({ error: "查询关键字至少 3 个字符" }, { status: 400, headers });
      const escaped = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      where += " AND mail_to LIKE ? ESCAPE '\\'";
      binds.push(`%${escaped}%`);
    }
    const rows = await env.DB.prepare(
      `SELECT id, mail_to as 'to', mail_from as 'from', subject, text_body, html_body, timestamp FROM emails ${where} ORDER BY timestamp DESC LIMIT ?`
    ).bind(...binds, EMAIL_LIST_LIMIT).all();
    const linkFilter = (await getConfig(env.DB, "link_filter")) || "auth.heygen.com";
    const emails = ((rows.results || []) as Record<string, unknown>[]).map((row) => ({
      id: row.id, to: row.to, from: row.from, subject: row.subject, timestamp: row.timestamp,
      activationLink: extractActivationLink(row.html_body as string, row.text_body as string, linkFilter),
    }));
    return Response.json({ emails }, { headers });
  }

  // GET /api/email-detail?id=xxx — full email; user may only read own, admin any
  if (url.pathname === "/api/email-detail" && request.method === "GET") {
    const actor = await resolveActor(request, env);
    if (!actor) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const id = url.searchParams.get("id") || "";
    if (!id) return Response.json({ error: "id required" }, { status: 400, headers });
    const row = await env.DB.prepare(
      "SELECT id, mail_to as 'to', mail_from as 'from', subject, text_body as text, html_body as html, timestamp, owner_id FROM emails WHERE id = ?"
    ).bind(id).first() as Record<string, unknown> | null;
    if (!row) return Response.json({ error: "not found" }, { status: 404, headers });
    if (actor.user && row.owner_id !== actor.user.id) {
      return Response.json({ error: "unauthorized" }, { status: 403, headers });
    }
    delete row.owner_id;
    return Response.json({ email: row }, { headers });
  }

  // POST /api/generate-address — admin automation: generate + register for a profile
  if (url.pathname === "/api/generate-address" && request.method === "POST") {
    if (!checkAuth(request, env)) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const body = await request.json() as { profile_id: string };
    if (!body.profile_id) return Response.json({ error: "profile_id required" }, { status: 400, headers });

    const NAMES = ["james","john","robert","michael","william","david","richard","joseph","thomas","charles",
      "mary","patricia","jennifer","linda","barbara","elizabeth","susan","jessica","sarah","karen",
      "alex","chris","jordan","taylor","morgan","casey","riley","jamie","avery","skyler",
      "emma","liam","noah","olivia","sophia","lucas","mason","ethan","ava","isabella",
      "jack","lily","ryan","grace","owen","zoe","evan","chloe","sean","maya"];
    const allDomains = await getDomains(env.DB);
    if (!allDomains.length) return Response.json({ error: "no domains" }, { status: 500, headers });

    // Exclude domains already assigned to this profile
    const usedRows = await env.DB.prepare(
      "SELECT address FROM profile_addresses WHERE profile_id = ?"
    ).bind(body.profile_id).all();
    const usedDomains = new Set(
      (usedRows.results || []).map((r: Record<string, unknown>) => (r.address as string).split("@")[1])
    );
    const preferredDomains = allDomains.filter(d => !usedDomains.has(d));
    const candidateDomains = preferredDomains.length > 0 ? preferredDomains : allDomains;

    // Per-domain quota = owner's limits if owned, else defaults.
    const ownerRows = await env.DB.prepare(
      "SELECT do.domain as domain, do.owner_id as owner_id, u.hourly_limit as hourly_limit, u.daily_limit as daily_limit, u.lifetime_limit as lifetime_limit FROM domain_owner do JOIN users u ON u.id = do.owner_id"
    ).all();
    const ownerByDomain = new Map<string, { ownerId: string; hourly: number; daily: number; lifetime: number }>();
    for (const r of (ownerRows.results || []) as { domain: string; owner_id: string; hourly_limit: number; daily_limit: number; lifetime_limit: number }[]) {
      ownerByDomain.set(r.domain.toLowerCase(), { ownerId: r.owner_id, hourly: r.hourly_limit, daily: r.daily_limit, lifetime: r.lifetime_limit });
    }
    const quotaCounts = await Promise.all(
      candidateDomains.map(d => getDomainCounts(env.DB, d).then(counts => ({ d, counts })))
    );
    const domains = quotaCounts
      .filter(({ d, counts }) => {
        const ownerConfig = ownerByDomain.get(d.toLowerCase());
        const quotaUser = {
          hourly_limit: ownerConfig?.hourly ?? DEFAULT_HOURLY_LIMIT,
          daily_limit: ownerConfig?.daily ?? DEFAULT_DAILY_LIMIT,
          lifetime_limit: ownerConfig?.lifetime ?? DEFAULT_LIFETIME_LIMIT,
        };
        return domainWithinQuota(counts, quotaUser);
      })
      .map(({ d }) => d);
    if (!domains.length) return Response.json({ error: "all domains have reached activation-link quota" }, { status: 429, headers });

    let address = "";
    let chosenDomain = "";
    for (let i = 0; i < 10; i++) {
      const name = NAMES[Math.floor(Math.random() * NAMES.length)];
      const num = Math.floor(Math.random() * 900) + 10;
      const domain = domains[Math.floor(Math.random() * domains.length)];
      const candidate = `${name}${num}@${domain}`;
      const existing = await env.DB.prepare("SELECT address FROM passwords WHERE address = ?").bind(candidate).first();
      if (!existing) { address = candidate; chosenDomain = domain; break; }
    }
    if (!address) return Response.json({ error: "could not generate unique address" }, { status: 500, headers });

    const now = Date.now();
    const ownerId = ownerByDomain.get(chosenDomain.toLowerCase())?.ownerId || null;
    await env.DB.prepare(
      "INSERT INTO passwords (address, password, label, confirmed, created_at, updated_at, domain, owner_id) VALUES (?, ?, '', 0, ?, ?, ?, ?)"
    ).bind(address, generatePassword(), now, now, chosenDomain, ownerId).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO profile_addresses (address, profile_id, assigned_at) VALUES (?, ?, ?)"
    ).bind(address, body.profile_id, now).run();

    return Response.json({ ok: true, address }, { headers });
  }

  // POST /api/profile-address — assign addresses to a profile (admin only)
  if (url.pathname === "/api/profile-address" && request.method === "POST") {
    if (!checkAuth(request, env)) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const body = await request.json() as { profile_id: string; addresses: string[] };
    if (!body.profile_id || !Array.isArray(body.addresses)) {
      return Response.json({ error: "profile_id and addresses required" }, { status: 400, headers });
    }
    const now = Date.now();
    for (const addr of body.addresses) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO profile_addresses (address, profile_id, assigned_at) VALUES (?, ?, ?)"
      ).bind(addr.toLowerCase(), body.profile_id, now).run();
    }
    return Response.json({ ok: true }, { headers });
  }

  // GET /api/profile-address?profile_id=xxx — addresses assigned to a profile
  if (url.pathname === "/api/profile-address" && request.method === "GET") {
    const profileId = url.searchParams.get("profile_id") || "";
    if (!profileId) return Response.json({ error: "profile_id required" }, { status: 400, headers });
    const rows = await env.DB.prepare(
      "SELECT address FROM profile_addresses WHERE profile_id = ? ORDER BY assigned_at DESC"
    ).bind(profileId).all();
    return Response.json({ addresses: (rows.results || []).map((r: Record<string, unknown>) => r.address) }, { headers });
  }

  // POST /api/activation-link — push a link for a profile (admin only)
  if (url.pathname === "/api/activation-link" && request.method === "POST") {
    if (!checkAuth(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const body = await request.json() as { profile_id: string; url: string };
    if (!body.profile_id || !body.url) {
      return Response.json({ error: "profile_id and url required" }, { status: 400, headers });
    }
    const id = generateId();
    await env.DB.prepare(
      "INSERT INTO activation_links (id, profile_id, url, created_at, consumed) VALUES (?, ?, ?, ?, 0)"
    ).bind(id, body.profile_id, body.url, Date.now()).run();
    return Response.json({ ok: true, id }, { headers });
  }

  // GET /api/activation-link?profile_id=xxx — poll for pending links (profile_id is the token)
  if (url.pathname === "/api/activation-link" && request.method === "GET") {
    const profileId = url.searchParams.get("profile_id") || "";
    if (!profileId) return Response.json({ error: "profile_id required" }, { status: 400, headers });
    const rows = await env.DB.prepare(
      "SELECT id, url FROM activation_links WHERE profile_id = ? AND consumed = 0 ORDER BY created_at ASC LIMIT 10"
    ).bind(profileId).all();
    return Response.json({ links: rows.results || [] }, { headers });
  }

  // POST /api/activation-link/:id/consume — mark as consumed
  if (url.pathname.match(/^\/api\/activation-link\/[^/]+\/consume$/) && request.method === "POST") {
    const id = url.pathname.split("/")[3];
    await env.DB.prepare("UPDATE activation_links SET consumed = 1 WHERE id = ?").bind(id).run();
    return Response.json({ ok: true }, { headers });
  }

  // GET /api/domain-quotas — this user's per-domain hourly/daily/lifetime usage + limits
  if (url.pathname === "/api/domain-quotas" && request.method === "GET") {
    const actor = await resolveActor(request, env);
    if (!actor || !actor.user) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const u = actor.user;
    const userDomains = await getUserDomains(env.DB, u.id);
    const daily: Record<string, number> = {};
    const hourly: Record<string, number> = {};
    const lifetime: Record<string, number> = {};
    const enabled: Record<string, boolean> = {};
    await Promise.all(userDomains.map(async ({ domain, enabled: en }) => {
      const c = await getDomainCounts(env.DB, domain);
      daily[domain] = c.daily; hourly[domain] = c.hourly; lifetime[domain] = c.lifetime;
      enabled[domain] = !!en;
    }));
    return Response.json({
      daily, hourly, lifetime, enabled,
      hourlyLimit: u.hourly_limit, dailyLimit: u.daily_limit, lifetimeLimit: u.lifetime_limit,
    }, { headers });
  }

  // Cleanup
  if (url.pathname === "/api/cleanup") {
    const hoursStr = await getConfig(env.DB, "auto_delete_hours");
    const hours = parseInt(hoursStr) || 24;
    await env.DB.prepare("DELETE FROM emails WHERE timestamp < ?")
      .bind(Date.now() - hours * 3600000).run();
    return Response.json({ ok: true }, { headers });
  }

  // GET /api/stream?token=xxx&since=timestamp — SSE push for this user's new emails
  if (url.pathname === "/api/stream" && request.method === "GET") {
    const actor = await resolveActorByToken(env, url.searchParams.get("token") || "");
    if (!actor || !actor.user) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const ownerId = actor.user.id;
    const since = parseInt(url.searchParams.get("since") || "0") || (Date.now() - 5000);
    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream({
      async start(controller) {
        let lastTs = since;
        const send = (data: object): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            return true;
          } catch { closed = true; return false; }
        };

        if (!send({ type: "connected" })) return;
        const linkFilter = await getConfig(env.DB, "link_filter");

        while (!closed) {
          await new Promise<void>(r => setTimeout(r, STREAM_POLL_MS));
          if (closed) break;
          try {
            const rows = await env.DB.prepare(
              "SELECT id, mail_to as 'to', mail_from as 'from', subject, html_body, text_body, timestamp " +
              "FROM emails WHERE owner_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT 10"
            ).bind(ownerId, lastTs).all();

            for (const row of (rows.results || []) as Record<string, unknown>[]) {
              const activationLink = extractActivationLink(row.html_body as string, row.text_body as string, linkFilter);
              if (!send({ type: "email", email: { id: row.id, to: row.to, from: row.from, subject: row.subject, timestamp: row.timestamp, activationLink } })) break;
              if ((row.timestamp as number) > lastTs) lastTs = row.timestamp as number;
            }
            send({ type: "ping" });
          } catch { break; }
        }
      },
      cancel() { closed = true; }
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders(request, env),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      }
    });
  }

  return Response.json({ error: "not found" }, { status: 404, headers });
}

// ========== Main Export ==========

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const to = message.to.toLowerCase();
    const domain = to.split("@")[1];

    const [configured, forwardRules] = await Promise.all([
      getConfiguredDomains(env.DB),
      getForwardRules(env.DB),
    ]);
    if (!configured.has(domain)) {
      message.setReject("Unknown domain");
      return;
    }

    // Forward by subdomain rule (domain-level forwarding)
    const subdomainRule = forwardRules.find((r) => r.subdomain.toLowerCase() === domain);
    if (subdomainRule && subdomainRule.target) {
      try { await message.forward(subdomainRule.target); } catch { /* ignore forward failure */ }
    }

    // Only mailboxes we generated (pre-registered) receive mail. Tags are retired,
    // so there is no auto-create path for arbitrary catch-all addresses.
    const preRegistered = await env.DB.prepare(
      "SELECT address, confirmed, owner_id, last_link_received_at FROM passwords WHERE address = ?"
    ).bind(to).first() as { address: string; confirmed: number; owner_id: string | null; last_link_received_at: number | null } | null;
    if (!preRegistered) return;

    const ownerRow = await getDomainOwner(env.DB, domain);
    const ownerId = ownerRow?.owner_id || null;
    const owner = ownerId ? await getUserById(env.DB, ownerId) : null;

    const rawEmail = await streamToText(message.raw);
    const { subject, textBody, htmlBody } = parseEmailContent(rawEmail);
    const now = Date.now();
    const linkFilter = (await getConfig(env.DB, "link_filter")) || "auth.heygen.com";
    const uiLink = extractActivationLink(htmlBody, textBody, linkFilter);
    const hermesLink = extractFirstMatchingLink(htmlBody, textBody, getHermesLinkMatches(env));
    const hasActivationLink = !!(uiLink || hermesLink);
    const isFirstActivationLink = hasActivationLink && !preRegistered.last_link_received_at;

    if (owner && isFirstActivationLink) {
      const c = await getDomainCounts(env.DB, domain);
      if (!domainWithinQuota(c, owner)) {
        return; // quota full → drop silently (no quota consumed, no email stored)
      }
    }

    if (!preRegistered.confirmed) {
      // First email confirms the mailbox, but quota is consumed only by the
      // first activation link receipt.
      await env.DB.prepare(
        "UPDATE passwords SET confirmed = 1, owner_id = ?, updated_at = ? WHERE address = ?"
      ).bind(ownerId, now, to).run();
    } else {
      // Already confirmed; just refresh updated_at and backfill owner_id if missing.
      await env.DB.prepare(
        "UPDATE passwords SET updated_at = ?, owner_id = COALESCE(owner_id, ?) WHERE address = ?"
      ).bind(now, ownerId, to).run();
    }

    // Store the email (denormalized owner_id → indexed inbox reads, no JOIN/LIKE)
    await env.DB.prepare(
      "INSERT INTO emails (id, mail_to, mail_from, subject, text_body, html_body, timestamp, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(generateId(), to, message.from, subject, textBody, htmlBody, now, ownerId).run();

    // Record activation-link receipt + push to profile automation if applicable
    if (isFirstActivationLink) {
      await env.DB.prepare(
        "UPDATE passwords SET last_link_received_at = ? WHERE address = ?"
      ).bind(now, to).run();

      const profileRow = await env.DB.prepare(
        "SELECT profile_id FROM profile_addresses WHERE address = ?"
      ).bind(to).first() as { profile_id: string } | null;
      if (profileRow && hermesLink) {
        const existing = await env.DB.prepare(
          "SELECT id FROM activation_links WHERE profile_id = ? AND url = ? AND consumed = 0 LIMIT 1"
        ).bind(profileRow.profile_id, hermesLink).first();
        if (!existing) {
        await env.DB.prepare(
          "INSERT INTO activation_links (id, profile_id, url, created_at, consumed) VALUES (?, ?, ?, ?, 0)"
        ).bind(generateId(), profileRow.profile_id, hermesLink, now).run();
        }
      }
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      const headers = corsHeaders(request, env);
      return Response.json(
        { error: "internal error", detail: String(err) },
        { status: 500, headers }
      );
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const hoursStr = await getConfig(env.DB, "auto_delete_hours");
    const hours = parseInt(hoursStr) || 24;
    await env.DB.prepare("DELETE FROM emails WHERE timestamp < ?")
      .bind(Date.now() - hours * 3600000).run();
    // Clean up unconfirmed addresses older than 48 hours (generated but never received email)
    await env.DB.prepare("DELETE FROM passwords WHERE confirmed = 0 AND created_at < ?")
      .bind(Date.now() - 48 * 3600000).run();
    // Clean up expired sessions
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();
  },
};
