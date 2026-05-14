export interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS: string;
  ADMIN_PASSWORD: string;
}

interface ForwardRule {
  subdomain: string;
  target: string;
}

// e.g. { tag: "vip", target: "you@gmail.com" }
// triggers when email arrives at anything+vip@domain
interface TagRule {
  tag: string;
  target: string;
  label?: string; // optional display name
}

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

async function getTagRules(db: D1Database): Promise<TagRule[]> {
  const raw = await getConfig(db, "tag_rules");
  try { return JSON.parse(raw); } catch { return []; }
}

// Parse -tag suffix from email local part using last dash segment
// "john42-ck" → { local: "john42", tag: "ck" }
// "smith-jones" (no matching tag) → { local: "smith-jones", tag: null }
// Only strips the suffix if it matches a known tag; otherwise keeps whole string
function parseDashTag(localPart: string, knownTags: string[]): { local: string; tag: string | null } {
  const idx = localPart.lastIndexOf("-");
  if (idx === -1) return { local: localPart, tag: null };
  const suffix = localPart.substring(idx + 1);
  const prefix = localPart.substring(0, idx);
  if (knownTags.includes(suffix.toLowerCase())) {
    return { local: prefix, tag: suffix.toLowerCase() };
  }
  return { local: localPart, tag: null };
}

function checkAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.ADMIN_PASSWORD}`;
}

async function checkAuthFull(request: Request, env: Env): Promise<boolean> {
  if (checkAuth(request, env)) return true;
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return await checkPassword(auth.slice(7), env);
}

async function checkPassword(password: string, env: Env): Promise<boolean> {
  if (password === env.ADMIN_PASSWORD) return true;
  const storedHash = await getConfig(env.DB, "site_password_hash");
  if (!storedHash) return false;
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  return hashHex === storedHash;
}

async function checkAuthFullOrQueryToken(request: Request, env: Env, url: URL): Promise<boolean> {
  if (await checkAuthFull(request, env)) return true;
  const token = url.searchParams.get("token") || "";
  return token ? await checkPassword(token, env) : false;
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

const TAG_DAILY_LIMIT = 30;
const MAX_RAW_EMAIL_CHARS = 256 * 1024;
const MAX_STORED_BODY_CHARS = 128 * 1024;
const MAX_STORED_SUBJECT_CHARS = 500;
const STREAM_POLL_MS = 15_000;
const EMAIL_LIST_LIMIT = 200;

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

// ========== HTTP Request Handler ==========

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const headers = corsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  // GET /api/config
  if (url.pathname === "/api/config" && request.method === "GET") {
    const domains = await getDomains(env.DB);
    const domainsPool2 = await getDomainsPool2(env.DB);
    const forwardRules = await getForwardRules(env.DB);
    const siteName = await getConfig(env.DB, "site_name");
    const autoDeleteHours = await getConfig(env.DB, "auto_delete_hours");
    const linkFilter = await getConfig(env.DB, "link_filter");
    const sitePasswordHash = await getConfig(env.DB, "site_password_hash");
    return Response.json({
      domains,
      domainsPool2,
      forwardDomains: forwardRules.map((r) => r.subdomain),
      siteName: siteName || "云端接码",
      autoDeleteHours: parseInt(autoDeleteHours) || 24,
      linkFilter: linkFilter || "auth.heygen.com",
      hasPassword: sitePasswordHash !== "",
    }, { headers });
  }

  // POST /api/site-login
  if (url.pathname === "/api/site-login" && request.method === "POST") {
    const raw = await request.text();
    const body = JSON.parse(raw) as { password: string };
    const storedHash = await getConfig(env.DB, "site_password_hash");
    if (!storedHash) {
      return Response.json({ ok: true }, { headers });
    }
    const encoder = new TextEncoder();
    const data = encoder.encode(body.password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hashHex === storedHash) {
      return Response.json({ ok: true }, { headers });
    }
    return Response.json({ error: "密码错误" }, { status: 401, headers });
  }

  // GET /api/emails?address=xxx@domain.com
  if (url.pathname === "/api/emails" && request.method === "GET") {
    if (!await checkAuthFull(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const address = (url.searchParams.get("address") || "").toLowerCase();
    if (!address) {
      return Response.json({ error: "address required" }, { status: 400, headers });
    }
    const domain = address.split("@")[1];
    const domains = await getDomains(env.DB);
    const domainsPool2 = await getDomainsPool2(env.DB);
    const forwardRules = await getForwardRules(env.DB);
    const allDomains = [
      ...domains.map((d) => d.toLowerCase()),
      ...domainsPool2.map((d) => d.toLowerCase()),
      ...forwardRules.map((r) => r.subdomain.toLowerCase()),
    ];
    if (!allDomains.includes(domain)) {
      return Response.json({ error: "invalid domain" }, { status: 400, headers });
    }
    const result = await env.DB.prepare(
      "SELECT id, mail_to as 'to', mail_from as 'from', subject, text_body as text, html_body as html, timestamp FROM emails WHERE mail_to = ? ORDER BY timestamp DESC LIMIT 50"
    ).bind(address).all();
    return Response.json({ emails: result.results || [] }, { headers });
  }

  // POST /api/admin/login
  if (url.pathname === "/api/admin/login" && request.method === "POST") {
    const raw = await request.text();
    const body = JSON.parse(raw) as { password: string };
    if (body.password === env.ADMIN_PASSWORD) {
      return Response.json({ ok: true, token: env.ADMIN_PASSWORD }, { headers });
    }
    return Response.json({ error: "密码错误" }, { status: 401, headers });
  }

  // Admin endpoints (auth required)
  if (url.pathname.startsWith("/api/admin/")) {
    if (!checkAuth(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }

    // GET /api/admin/config
    if (url.pathname === "/api/admin/config" && request.method === "GET") {
      const domains = await getDomains(env.DB);
      const domainsPool2 = await getDomainsPool2(env.DB);
      const forwardRules = await getForwardRules(env.DB);
      const tagRules = await getTagRules(env.DB);
      const siteName = await getConfig(env.DB, "site_name");
      const autoDeleteHours = await getConfig(env.DB, "auto_delete_hours");
      const linkFilter = await getConfig(env.DB, "link_filter");
      const hasSitePassword = (await getConfig(env.DB, "site_password_hash")) !== "";
      return Response.json({
        domains, domainsPool2, forwardRules, tagRules,
        siteName: siteName || "云端接码",
        autoDeleteHours: parseInt(autoDeleteHours) || 24,
        linkFilter: linkFilter || "auth.heygen.com",
        hasSitePassword,
      }, { headers });
    }

    // POST /api/admin/config
    if (url.pathname === "/api/admin/config" && request.method === "POST") {
      const raw = await request.text();
      const body = JSON.parse(raw) as {
        domains?: string[];
        domainsPool2?: string[];
        forwardRules?: ForwardRule[];
        tagRules?: TagRule[];
        siteName?: string;
        autoDeleteHours?: number;
        linkFilter?: string;
        sitePassword?: string;
        clearSitePassword?: boolean;
      };
      if (body.domains !== undefined) await setConfig(env.DB, "domains", JSON.stringify(body.domains));
      if (body.domainsPool2 !== undefined) await setConfig(env.DB, "domains_pool2", JSON.stringify(body.domainsPool2));
      if (body.forwardRules !== undefined) await setConfig(env.DB, "forward_rules", JSON.stringify(body.forwardRules));
      if (body.tagRules !== undefined) await setConfig(env.DB, "tag_rules", JSON.stringify(body.tagRules));
      if (body.siteName !== undefined) await setConfig(env.DB, "site_name", body.siteName);
      if (body.autoDeleteHours !== undefined) await setConfig(env.DB, "auto_delete_hours", String(body.autoDeleteHours));
      if (body.linkFilter !== undefined) await setConfig(env.DB, "link_filter", body.linkFilter);
      if (body.clearSitePassword) await setConfig(env.DB, "site_password_hash", "");
      if (body.sitePassword) {
        const encoder = new TextEncoder();
        const data = encoder.encode(body.sitePassword);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
        await setConfig(env.DB, "site_password_hash", hashHex);
      }
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

    // DELETE /api/admin/emails
    if (url.pathname === "/api/admin/emails" && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM emails").run();
      return Response.json({ ok: true }, { headers });
    }
  }

  // ── Password Manager endpoints ──

  // GET /api/passwords?tag=ck&page=1&limit=50&start=timestamp&end=timestamp&linkStart=timestamp&linkEnd=timestamp
  if (url.pathname === "/api/passwords" && request.method === "GET") {
    if (!await checkAuthFull(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const tag = url.searchParams.get("tag") || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50")));
    const start = url.searchParams.get("start") || "";
    const end = url.searchParams.get("end") || "";
    const linkStart = url.searchParams.get("linkStart") || "";
    const linkEnd = url.searchParams.get("linkEnd") || "";
    const offset = (page - 1) * limit;

    let where = tag ? "WHERE confirmed = 1 AND (label = ? OR address LIKE ?)" : "WHERE confirmed = 1";
    const binds: (string | number)[] = tag ? [tag, `%-${tag}@%`] : [];
    if (start) { where += " AND created_at >= ?"; binds.push(parseInt(start)); }
    if (end) { where += " AND created_at <= ?"; binds.push(parseInt(end)); }
    if (linkStart) { where += " AND (last_link_received_at IS NULL OR last_link_received_at < ?)"; binds.push(parseInt(linkStart)); }
    if (linkEnd) { where += " AND (last_link_received_at IS NULL OR last_link_received_at > ?)"; binds.push(parseInt(linkEnd)); }

    const countRow = await env.DB.prepare(`SELECT COUNT(*) as total FROM passwords ${where}`).bind(...binds).first() as { total: number } | null;
    const total = countRow?.total || 0;

    const rows = await env.DB.prepare(
      `SELECT address, password, label, created_at, updated_at, last_link_received_at FROM passwords ${where} ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all();

    return Response.json({ passwords: rows.results || [], total, page, limit }, { headers });
  }

  // POST /api/passwords — reserve a password for a new address
  // When called from the generate button, saves as confirmed=0 (no quota consumed, hidden from list).
  // confirmed=1 is set only when the first email arrives.
  if (url.pathname === "/api/passwords" && request.method === "POST") {
    if (!await checkAuthFull(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const raw = await request.text();
    const body = JSON.parse(raw) as { address: string; password: string; label?: string };
    if (!body.address || !body.password) {
      return Response.json({ error: "address and password required" }, { status: 400, headers });
    }
    const address = body.address.toLowerCase();
    const [existingPassword, existingEmail] = await Promise.all([
      env.DB.prepare("SELECT address FROM passwords WHERE address = ? LIMIT 1").bind(address).first(),
      env.DB.prepare("SELECT mail_to FROM emails WHERE mail_to = ? LIMIT 1").bind(address).first(),
    ]);
    if (existingPassword || existingEmail) {
      return Response.json({ error: "address already exists" }, { status: 409, headers });
    }
    const now = Date.now();
    // Save as unconfirmed (confirmed=0); quota is checked and consumed only when email arrives
    await env.DB.prepare(
      "INSERT INTO passwords (address, password, label, confirmed, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)"
    ).bind(address, body.password, body.label || "", now, now).run();
    return Response.json({ ok: true }, { headers });
  }

  // DELETE /api/passwords — remove an address entry (admin only)
  if (url.pathname === "/api/passwords" && request.method === "DELETE") {
    if (!await checkAuthFull(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const raw = await request.text();
    const body = JSON.parse(raw) as { address: string };
    await env.DB.prepare("DELETE FROM passwords WHERE address = ?").bind(body.address.toLowerCase()).run();
    return Response.json({ ok: true }, { headers });
  }

  // GET /api/tag-emails?tag=ck — metadata + activation link (supports both new label-based and old dash-tag format)
  if (url.pathname === "/api/tag-emails" && request.method === "GET") {
    if (!await checkAuthFull(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const tag = (url.searchParams.get("tag") || "").toLowerCase();
    if (!tag) return Response.json({ error: "tag required" }, { status: 400, headers });

    // New format: address has no tag, tag stored in passwords.label
    const newRows = await env.DB.prepare(
      "SELECT e.id, e.mail_to as 'to', e.mail_from as 'from', e.subject, e.text_body, e.html_body, e.timestamp FROM emails e INNER JOIN passwords p ON p.address = e.mail_to WHERE p.label = ? ORDER BY e.timestamp DESC LIMIT ?"
    ).bind(tag, EMAIL_LIST_LIMIT).all();

    // Old format: tag embedded in address as -tag@ (backwards compat)
    const oldRows = await env.DB.prepare(
      "SELECT id, mail_to as 'to', mail_from as 'from', subject, text_body, html_body, timestamp FROM emails WHERE mail_to LIKE ? ORDER BY timestamp DESC LIMIT ?"
    ).bind(`%-${tag}@%`, EMAIL_LIST_LIMIT).all();

    // Merge, deduplicate by id, sort by timestamp desc
    const seen = new Set<unknown>();
    const merged = [...(newRows.results || []), ...(oldRows.results || [])]
      .filter(r => { if (seen.has((r as Record<string, unknown>).id)) return false; seen.add((r as Record<string, unknown>).id); return true; })
      .sort((a, b) => ((b as Record<string, unknown>).timestamp as number) - ((a as Record<string, unknown>).timestamp as number))
      .slice(0, EMAIL_LIST_LIMIT);

    const linkFilter = (await getConfig(env.DB, "link_filter")) || "auth.heygen.com";
    const emails = merged.map((row: Record<string, unknown>) => {
      const content = ((row.html_body as string) || "") + " " + ((row.text_body as string) || "");
      let activationLink: string | null = null;
      if (linkFilter) {
        const re = /https?:\/\/[^\s"'<>)]+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          if (m[0].includes(linkFilter)) { activationLink = m[0].replace(/[.,;!?]+$/, ""); break; }
        }
      }
      return {
        id: row.id, to: row.to, from: row.from, subject: row.subject, timestamp: row.timestamp,
        activationLink,
      };
    });
    return Response.json({ emails }, { headers });
  }

  // GET /api/all-emails — metadata + activation link for all received emails
  if (url.pathname === "/api/all-emails" && request.method === "GET") {
    if (!await checkAuthFull(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }

    const rows = await env.DB.prepare(
      "SELECT id, mail_to as 'to', mail_from as 'from', subject, text_body, html_body, timestamp FROM emails ORDER BY timestamp DESC LIMIT ?"
    ).bind(EMAIL_LIST_LIMIT).all();

    const linkFilter = (await getConfig(env.DB, "link_filter")) || "auth.heygen.com";
    const emails = ((rows.results || []) as Record<string, unknown>[]).map((row) => {
      const content = ((row.html_body as string) || "") + " " + ((row.text_body as string) || "");
      let activationLink: string | null = null;
      if (linkFilter) {
        const re = /https?:\/\/[^\s"'<>)]+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          if (m[0].includes(linkFilter)) { activationLink = m[0].replace(/[.,;!?]+$/, ""); break; }
        }
      }
      return {
        id: row.id, to: row.to, from: row.from, subject: row.subject, timestamp: row.timestamp,
        activationLink,
      };
    });
    return Response.json({ emails }, { headers });
  }

  // GET /api/email-detail?id=xxx — full email content (html + text) on demand
  if (url.pathname === "/api/email-detail" && request.method === "GET") {
    if (!await checkAuthFull(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const id = url.searchParams.get("id") || "";
    if (!id) return Response.json({ error: "id required" }, { status: 400, headers });
    const row = await env.DB.prepare(
      "SELECT id, mail_to as 'to', mail_from as 'from', subject, text_body as text, html_body as html, timestamp FROM emails WHERE id = ?"
    ).bind(id).first();
    if (!row) return Response.json({ error: "not found" }, { status: 404, headers });
    return Response.json({ email: row }, { headers });
  }

  // GET /api/domain-quota?domain=xxx — single domain quota (kept for backwards compat)
  if (url.pathname === "/api/domain-quota" && request.method === "GET") {
    const domain = (url.searchParams.get("domain") || "").toLowerCase();
    if (!domain) return Response.json({ error: "domain required" }, { status: 400, headers });
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const result = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM passwords WHERE address LIKE ? AND created_at >= ?"
    ).bind(`%@${domain}`, todayStart.getTime()).first() as { count: number } | null;
    const used = result?.count || 0;
    const limit = 30;
    return Response.json({ domain, used, limit, remaining: Math.max(0, limit - used) }, { headers });
  }

  // GET /api/domain-quotas — batch: hourly + daily counts for all domains
  if (url.pathname === "/api/domain-quotas" && request.method === "GET") {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);

    const [dailyRows, hourlyRows] = await Promise.all([
      env.DB.prepare(
        "SELECT LOWER(SUBSTR(address, INSTR(address, '@') + 1)) as domain, COUNT(*) as count FROM passwords WHERE confirmed = 1 AND created_at >= ? GROUP BY domain"
      ).bind(todayStart.getTime()).all(),
      env.DB.prepare(
        "SELECT LOWER(SUBSTR(address, INSTR(address, '@') + 1)) as domain, COUNT(*) as count FROM passwords WHERE confirmed = 1 AND created_at >= ? GROUP BY domain"
      ).bind(hourStart.getTime()).all(),
    ]);

    const daily: Record<string, number> = {};
    const hourly: Record<string, number> = {};
    for (const r of (dailyRows.results || []) as { domain: string; count: number }[]) daily[r.domain] = r.count;
    for (const r of (hourlyRows.results || []) as { domain: string; count: number }[]) hourly[r.domain] = r.count;

    return Response.json({ daily, hourly, hourlyLimit: 5, dailyLimit: 20 }, { headers });
  }

  // GET /api/tag-quota?label=xxx — confirmed (received email) addresses for a tag today (resets 23:30 ET)
  if (url.pathname === "/api/tag-quota" && request.method === "GET") {
    const label = (url.searchParams.get("label") || "").toLowerCase();
    if (!label) return Response.json({ error: "label required" }, { status: 400, headers });
    const resetTs = getLastEasternReset();
    const result = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM passwords WHERE label = ? AND confirmed = 1 AND created_at >= ?"
    ).bind(label, resetTs).first() as { count: number } | null;
    const used = result?.count || 0;
    return Response.json({
      label, used, limit: TAG_DAILY_LIMIT, remaining: Math.max(0, TAG_DAILY_LIMIT - used),
    }, { headers });
  }

  // GET /api/tags — public, returns tag rules for frontend display
  if (url.pathname === "/api/tags" && request.method === "GET") {
    const tagRules = await getTagRules(env.DB);
    return Response.json({ tagRules }, { headers });
  }

  // POST /api/tags — site-password protected, allows frontend users to manage tags
  if (url.pathname === "/api/tags" && request.method === "POST") {
    const raw = await request.text();
    const body = JSON.parse(raw) as { password?: string; tagRules?: TagRule[] };

    // Accept either site password or admin password
    const siteHash = await getConfig(env.DB, "site_password_hash");
    let authed = false;
    if (body.password === env.ADMIN_PASSWORD) {
      authed = true;
    } else if (siteHash && body.password) {
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(body.password));
      const hashHex = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
      authed = hashHex === siteHash;
    }
    if (!authed) {
      return Response.json({ error: "密码错误" }, { status: 401, headers });
    }

    if (body.tagRules !== undefined) {
      await setConfig(env.DB, "tag_rules", JSON.stringify(body.tagRules));
    }
    return Response.json({ ok: true }, { headers });
  }

  // Cleanup
  if (url.pathname === "/api/cleanup") {
    const hoursStr = await getConfig(env.DB, "auto_delete_hours");
    const hours = parseInt(hoursStr) || 24;
    await env.DB.prepare("DELETE FROM emails WHERE timestamp < ?")
      .bind(Date.now() - hours * 3600000).run();
    return Response.json({ ok: true }, { headers });
  }

  // GET /api/stream?tag=xxx&since=timestamp — SSE push for new emails
  if (url.pathname === "/api/stream" && request.method === "GET") {
    if (!await checkAuthFullOrQueryToken(request, env, url)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const tag = (url.searchParams.get("tag") || "").toLowerCase();
    if (!tag) return Response.json({ error: "tag required" }, { status: 400, headers });

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
              "SELECT e.id, e.mail_to as 'to', e.mail_from as 'from', e.subject, e.html_body, e.text_body, e.timestamp " +
              "FROM emails e INNER JOIN passwords p ON p.address = e.mail_to " +
              "WHERE p.label = ? AND e.timestamp > ? ORDER BY e.timestamp ASC LIMIT 10"
            ).bind(tag, lastTs).all();

            for (const row of (rows.results || []) as Record<string, unknown>[]) {
              const content = ((row.html_body as string) || "") + " " + ((row.text_body as string) || "");
              let activationLink: string | null = null;
              if (linkFilter) {
                const re = /https?:\/\/[^\s"'<>)]+/g;
                let m: RegExpExecArray | null;
                while ((m = re.exec(content)) !== null) {
                  if (m[0].includes(linkFilter)) { activationLink = m[0].replace(/[.,;!?]+$/, ""); break; }
                }
              }
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
    const [localPart, domain] = to.split("@");

    const [domains, domainsPool2, forwardRules, tagRules] = await Promise.all([
      getDomains(env.DB),
      getDomainsPool2(env.DB),
      getForwardRules(env.DB),
      getTagRules(env.DB),
    ]);

    const knownTags = tagRules.map((r) => r.tag.toLowerCase());

    const allDomains = [
      ...domains.map((d) => d.toLowerCase()),
      ...domainsPool2.map((d) => d.toLowerCase()),
      ...forwardRules.map((r) => r.subdomain.toLowerCase()),
    ];
    if (!allDomains.includes(domain)) {
      message.setReject("Unknown domain");
      return;
    }

    // Forward by subdomain rule
    const subdomainRule = forwardRules.find((r) => r.subdomain.toLowerCase() === domain);
    if (subdomainRule && subdomainRule.target) {
      try { await message.forward(subdomainRule.target); } catch { /* ignore forward failure */ }
    }

    const rawEmail = await streamToText(message.raw);
    const { subject, textBody, htmlBody } = parseEmailContent(rawEmail);
    const now = Date.now();

    // Determine tag: first check if address was pre-registered (new format, tag in label)
    // then fall back to dash-tag parsing (old format)
    const preRegistered = await env.DB.prepare(
      "SELECT address, label, confirmed FROM passwords WHERE address = ?"
    ).bind(to).first() as { address: string; label: string; confirmed: number } | null;

    let tag: string | null = null;
    let accountAddress: string = to;

    if (preRegistered) {
      // New format: address stored cleanly, tag in label
      tag = preRegistered.label || null;
      accountAddress = to;
    } else {
      // Old format: tag embedded in address as -tag
      const parsed = parseDashTag(localPart, knownTags);
      tag = parsed.tag;
      accountAddress = tag ? `${parsed.local}-${tag}@${domain}` : to;
    }

    // Forward by tag rule
    if (tag) {
      const tagRule = tagRules.find((r) => r.tag.toLowerCase() === tag);
      if (tagRule && tagRule.target) {
        try { await message.forward(tagRule.target); } catch { /* ignore forward failure */ }
      }
    }

    // Drop emails to unknown tagless addresses (no tag + not pre-registered)
    if (!tag && !preRegistered) return;

    // On first email: confirm the address (quota is consumed here, not at generation time)
    if (preRegistered) {
      if (!preRegistered.confirmed) {
        // First email for this address — enforce tag daily quota before confirming
        if (tag) {
          const resetTs = getLastEasternReset();
          const tagCount = await env.DB.prepare(
            "SELECT COUNT(*) as count FROM passwords WHERE label = ? AND confirmed = 1 AND created_at >= ?"
          ).bind(tag, resetTs).first() as { count: number } | null;
          if ((tagCount?.count || 0) >= TAG_DAILY_LIMIT) return; // quota full, drop email silently
        }
        await env.DB.prepare(
          "UPDATE passwords SET confirmed = 1, updated_at = ? WHERE address = ?"
        ).bind(now, accountAddress).run();
      } else {
        await env.DB.prepare(
          "UPDATE passwords SET updated_at = ? WHERE address = ?"
        ).bind(now, accountAddress).run();
      }
    } else {
      const existing = await env.DB.prepare(
        "SELECT address, confirmed FROM passwords WHERE address = ?"
      ).bind(accountAddress).first() as { address: string; confirmed: number } | null;
      if (existing) {
        if (!existing.confirmed) {
          // First email — enforce tag quota
          if (tag) {
            const resetTs = getLastEasternReset();
            const tagCount = await env.DB.prepare(
              "SELECT COUNT(*) as count FROM passwords WHERE label = ? AND confirmed = 1 AND created_at >= ?"
            ).bind(tag, resetTs).first() as { count: number } | null;
            if ((tagCount?.count || 0) >= TAG_DAILY_LIMIT) return;
          }
          await env.DB.prepare(
            "UPDATE passwords SET confirmed = 1, updated_at = ? WHERE address = ?"
          ).bind(now, accountAddress).run();
        } else {
          await env.DB.prepare(
            "UPDATE passwords SET updated_at = ? WHERE address = ?"
          ).bind(now, accountAddress).run();
        }
      } else {
        // Old-format dash-tag fallback: enforce domain quota then auto-create as confirmed
        const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
        const hourStart = new Date(); hourStart.setMinutes(0, 0, 0);
        const [dailyRow, hourlyRow] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) as count FROM passwords WHERE confirmed = 1 AND address LIKE ? AND created_at >= ?").bind(`%@${domain}`, todayStart.getTime()).first() as Promise<{ count: number } | null>,
          env.DB.prepare("SELECT COUNT(*) as count FROM passwords WHERE confirmed = 1 AND address LIKE ? AND created_at >= ?").bind(`%@${domain}`, hourStart.getTime()).first() as Promise<{ count: number } | null>,
        ]);
        if ((dailyRow?.count || 0) >= 20 || (hourlyRow?.count || 0) >= 5) return;
        await env.DB.prepare(
          "INSERT INTO passwords (address, password, label, confirmed, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
        ).bind(accountAddress, generatePassword(), tag, now, now).run();
      }
    }

    // Save email to inbox
    await env.DB.prepare(
      "INSERT INTO emails (id, mail_to, mail_from, subject, text_body, html_body, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(generateId(), accountAddress, message.from, subject, textBody, htmlBody, now).run();

    // Update last_link_received_at if email contains a link matching linkFilter
    const linkFilter = (await getConfig(env.DB, "link_filter")) || "auth.heygen.com";
    if (linkFilter) {
      const content = htmlBody + textBody;
      const re = /https?:\/\/[^\s"'<>)]+/g;
      let m: RegExpExecArray | null;
      let hasMatch = false;
      while ((m = re.exec(content)) !== null) {
        if (m[0].includes(linkFilter)) { hasMatch = true; break; }
      }
      if (hasMatch) {
        await env.DB.prepare(
          "UPDATE passwords SET last_link_received_at = ? WHERE address = ?"
        ).bind(now, accountAddress).run();
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
  },
};
