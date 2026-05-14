"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { generateNamePrefix } from "@/lib/utils";

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL || "http://localhost:8787";

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*";
  return Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map(b => chars[b % chars.length]).join("");
}

interface TagRule { tag: string; target: string; label?: string; }
interface PwEntry {
  address: string;
  password: string;
  label: string;
  created_at: number;
  updated_at: number;
  last_link_received_at: number | null;
}
interface Email {
  id: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  timestamp: number;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function extractLinks(html: string, text: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s"'<>)]+/g;
  for (const src of [html, text]) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const url = m[0].replace(/[.,;!?]+$/, "");
      if (!seen.has(url)) { seen.add(url); links.push(url); }
    }
  }
  return links;
}


// ── Generate Email Panel (per-tag address generator) ───────────────────────
function GenerateEmailPanel({ tag, allDomains, adminToken, sseDisabled }: { tag: string; allDomains: string[]; adminToken: string; sseDisabled?: boolean }) {
  const [domainQuotas, setDomainQuotas] = useState<Record<string, { used: number; limit: number; hourlyUsed: number; hourlyLimit: number }>>({});
  const [tagQuota, setTagQuota] = useState<{ used: number; limit: number; remaining: number } | null>(null);
  const [generated, setGenerated] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [poolOpen, setPoolOpen] = useState(false);
  // Which domains are enabled in the random pool (localStorage-backed, per tag)
  const [enabledDomains, setEnabledDomains] = useState<Set<string>>(new Set());
  const [poolReady, setPoolReady] = useState(false);
  const [quotasLoaded, setQuotasLoaded] = useState(false);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2500); };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); showToast("✅ 邮箱已复制"); }
    catch { showToast("❌ 复制失败"); }
  };

  const loadDomainQuotas = useCallback(async (domainList: string[]) => {
    try {
      const res = await fetch(`${WORKER_URL}/api/domain-quotas`);
      if (!res.ok) return;
      const data = await res.json() as { daily: Record<string, number>; hourly: Record<string, number>; hourlyLimit: number; dailyLimit: number };
      const q: Record<string, { used: number; limit: number; hourlyUsed: number; hourlyLimit: number }> = {};
      for (const d of domainList) {
        q[d] = {
          used: data.daily[d.toLowerCase()] || 0,
          limit: data.dailyLimit,
          hourlyUsed: data.hourly[d.toLowerCase()] || 0,
          hourlyLimit: data.hourlyLimit,
        };
      }
      setDomainQuotas(q);
      setQuotasLoaded(true);
    } catch { /* ignore */ }
  }, []);

  const loadTagQuota = useCallback(async () => {
    try {
      const res = await fetch(`${WORKER_URL}/api/tag-quota?label=${encodeURIComponent(tag)}`);
      if (res.ok) setTagQuota(await res.json());
    } catch { /* ignore */ }
  }, [tag]);

  // Initialize domain pool from localStorage once allDomains is known
  useEffect(() => {
    if (allDomains.length === 0 || poolReady) return;
    try {
      const stored = localStorage.getItem(`domainPool_${tag}`);
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        // Keep only domains that still exist; always add newly seen domains as enabled
        const storedSet = new Set(parsed);
        const merged = new Set([
          ...parsed.filter(d => allDomains.includes(d)),
          ...allDomains.filter(d => !storedSet.has(d)), // newly added domains default to ON
        ]);
        setEnabledDomains(merged);
      } else {
        setEnabledDomains(new Set(allDomains));
      }
    } catch {
      setEnabledDomains(new Set(allDomains));
    }
    setPoolReady(true);
    loadDomainQuotas(allDomains);
    loadTagQuota();
  }, [allDomains, tag, poolReady, loadDomainQuotas, loadTagQuota]);

  const toggleDomain = (d: string) => {
    setEnabledDomains(prev => {
      const next = new Set(prev);
      if (next.has(d)) {
        if (next.size <= 1) return prev; // must keep at least one
        next.delete(d);
      } else {
        next.add(d);
      }
      localStorage.setItem(`domainPool_${tag}`, JSON.stringify([...next]));
      return next;
    });
  };

  const generate = async () => {
    // Pick randomly from enabled + quota-available domains
    const available = allDomains.filter(d => {
      if (!enabledDomains.has(d)) return false;
      const q = domainQuotas[d];
      if (!q) return false;
      return q.used < q.limit && q.hourlyUsed < q.hourlyLimit;
    });
    if (available.length === 0) {
      const anyDailyLeft = allDomains.some(d => {
        if (!enabledDomains.has(d)) return false;
        const q = domainQuotas[d]; return !q || q.used < q.limit;
      });
      showToast(anyDailyLeft ? "⚠️ 本小时配额已满（每域名每小时最多5个）" : "⚠️ 所选域名今日配额已满");
      return;
    }
    const picked = available[Math.floor(Math.random() * available.length)];
    const addr = `${generateNamePrefix()}@${picked}`;
    setGenerated(addr);

    // Pre-save to DB as unconfirmed (confirmed=0) so worker knows the tag when email arrives.
    // Quota is NOT consumed here — only when the first email arrives.
    try {
      await fetch(`${WORKER_URL}/api/passwords`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${adminToken}` },
        body: JSON.stringify({ address: addr, password: generatePassword(), label: tag }),
      });
      loadDomainQuotas(allDomains);
    } catch { /* ignore */ }

    copy(addr);
  };

  const allDomainsFull = quotasLoaded && allDomains.length > 0 && allDomains
    .filter(d => enabledDomains.has(d))
    .every(d => { const q = domainQuotas[d]; return !q || q.used >= q.limit || q.hourlyUsed >= q.hourlyLimit; });
  const disabled = !poolReady || !quotasLoaded || allDomainsFull || !!sseDisabled;

  return (
    <div className="card mb-4" style={{ borderLeft: "3px solid #4caf50" }}>
      {toast && <div className="toast">{toast}</div>}
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold" style={{ color: "var(--primary)" }}>📧 生成新邮箱</div>
        {tagQuota && (
          <div className="text-xs text-gray-500 flex items-center gap-1">
            今日已收
            <span className={`font-medium ${tagQuota.remaining <= 5 ? "text-red-500" : "text-gray-600"}`}>
              {tagQuota.used}/{tagQuota.limit}
            </span>
            <span className="text-gray-400">（美东23:30重置）</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <button
          onClick={generate}
          disabled={disabled}
          className="px-4 py-2 rounded-xl text-sm font-medium text-white flex-1"
          style={{
            background: disabled ? "#ccc" : "var(--primary)",
            cursor: disabled ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {!quotasLoaded ? "⏳ 加载中..." : sseDisabled ? "⚠️ 连接断开中" : allDomainsFull ? "域名配额已满" : "🎲 随机生成"}
        </button>
        <button
          onClick={() => { loadDomainQuotas(allDomains); loadTagQuota(); }}
          className="text-xs text-gray-400 hover:text-gray-600"
          title="刷新配额"
        >🔄</button>
      </div>

      {generated && (
        <div className="mb-3 flex items-center gap-2">
          <span className="font-mono text-sm flex-1 truncate" style={{ color: "var(--primary-dark)" }}>
            {generated}
          </span>
          <button
            onClick={() => copy(generated)}
            className="text-xs px-3 py-1 rounded-lg shrink-0"
            style={{ background: "var(--primary)", color: "white" }}
          >
            📋 复制
          </button>
        </div>
      )}

      {/* Domain pool selector */}
      <div>
        <button
          onClick={() => setPoolOpen(o => !o)}
          className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
        >
          {poolOpen ? "▲" : "▶"} 随机域名池设置 ({enabledDomains.size}/{allDomains.length} 已选)
        </button>
        {poolOpen && (
          <div className="mt-2 space-y-1">
            {allDomains.map(d => {
              const q = domainQuotas[d];
              const dailyRem = q ? q.limit - q.used : null;
              const hourlyRem = q ? q.hourlyLimit - q.hourlyUsed : null;
              const full = (dailyRem !== null && dailyRem <= 0) || (hourlyRem !== null && hourlyRem <= 0);
              return (
                <label key={d} className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={enabledDomains.has(d)}
                    onChange={() => toggleDomain(d)}
                    className="accent-green-500"
                  />
                  <span className={`text-xs font-mono ${full ? "text-gray-400 line-through" : "text-gray-700"}`}>
                    {d}
                  </span>
                  {!quotasLoaded ? (
                    <span className="text-xs text-gray-300">···</span>
                  ) : q ? (
                    <span className="text-xs text-gray-400">
                      今日剩 {dailyRem}/{q.limit} · 本时剩 {hourlyRem}/{q.hourlyLimit}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── EmailPanel (single address inbox) ──────────────────────────────────────
function EmailPanel({ address, adminToken, onClose }: { address: string; adminToken: string; onClose: () => void }) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [contentExpanded, setContentExpanded] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2000); };
  const copy = async (text: string, label = "已复制") => {
    try { await navigator.clipboard.writeText(text); showToast(`✅ ${label}`); }
    catch { showToast("❌ 复制失败"); }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${WORKER_URL}/api/emails?address=${encodeURIComponent(address)}`, {
        headers: { "Authorization": `Bearer ${adminToken}` },
      });
      if (res.ok) {
        const d = await res.json();
        const list = d.emails || [];
        setEmails(list);
        if (list.length > 0) setExpanded(list[0].id);
      }
    } finally { setLoading(false); }
  }, [address, adminToken]);

  useEffect(() => { load(); }, [load]);

  // 展开 10s 后开始每 5s 刷新，共刷 6 次（30s）后停止
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const startTimer = setTimeout(() => {
      let count = 0;
      interval = setInterval(() => {
        loadRef.current();
        count++;
        if (count >= 6) { clearInterval(interval!); interval = null; }
      }, 5000);
    }, 10000);
    return () => {
      clearTimeout(startTimer);
      if (interval) clearInterval(interval);
    };
  }, []);

  return (
    <div className="mt-3 rounded-xl border" style={{ background: "#f8faff", borderColor: "var(--primary-light)" }}>
      {toast && <div className="toast">{toast}</div>}
      <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: "var(--primary-light)" }}>
        <span className="text-xs font-semibold" style={{ color: "var(--primary)" }}>📬 收件箱</span>
        <div className="flex gap-2">
          <button onClick={load} className="text-xs text-gray-400 hover:text-gray-600">🔄</button>
          <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
        </div>
      </div>

      {loading && <p className="text-center text-gray-400 py-4 text-sm">加载中...</p>}
      {!loading && emails.length === 0 && <p className="text-center text-gray-400 py-4 text-sm">暂无邮件</p>}

      {emails.map((email) => {
        const isOpen = expanded === email.id;
        const links = extractLinks(email.html || "", email.text || "");
        return (
          <div key={email.id} className="border-b last:border-b-0" style={{ borderColor: "var(--primary-light)" }}>
            <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white transition-colors"
              onClick={() => setExpanded(isOpen ? null : email.id)}>
              <span className="text-xs">{isOpen ? "▼" : "▶"}</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold truncate text-gray-700">{email.subject || "(无主题)"}</div>
                <div className="text-xs text-gray-400 truncate">{email.from} · {formatTime(email.timestamp)}</div>
              </div>
            </div>
            {isOpen && (
              <div className="px-3 pb-3">
                <button
                  onClick={() => setContentExpanded(contentExpanded === email.id ? null : email.id)}
                  className="text-xs px-2 py-1 rounded transition-colors"
                  style={{ background: "var(--primary-light)", color: "var(--primary-dark)" }}>
                  {contentExpanded === email.id ? "▲ 收起邮件原文" : "▼ 查看邮件原文"}
                </button>
                {contentExpanded === email.id && (
                  <div className="mt-2 rounded border overflow-hidden" style={{ borderColor: "var(--primary-light)" }}>
                    {email.html ? (
                      <iframe
                        srcDoc={email.html}
                        sandbox=""
                        className="w-full border-0"
                        style={{ minHeight: "200px", maxHeight: "500px" }}
                        onLoad={(e) => {
                          const f = e.target as HTMLIFrameElement;
                          if (f.contentDocument) f.style.height = Math.min(f.contentDocument.body.scrollHeight + 20, 500) + "px";
                        }}
                      />
                    ) : email.text ? (
                      <div className="text-xs text-gray-600 whitespace-pre-wrap p-3 max-h-96 overflow-y-auto bg-gray-50">
                        {email.text}
                      </div>
                    ) : (
                      <div className="text-xs text-gray-400 p-3">无邮件内容</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// ── TagEmailsPanel (all emails for all addresses under a tag) ───────────────
interface TagEmailMeta { id: string; to: string; from: string; subject: string; timestamp: number; toAddress: string; activationLink: string | null; }

type ConnState = "connecting" | "connected" | "reconnecting" | "sleeping";

function TagEmailsPanel({ tag, adminToken, allMode = false, onConnStateChange }: { tag: string; adminToken: string; allMode?: boolean; onConnStateChange?: (state: ConnState) => void }) {
  const [allEmails, setAllEmails] = useState<TagEmailMeta[]>([]);
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [open, setOpen] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [contentExpandedId, setContentExpandedId] = useState<string | null>(null);
  const [emailDetail, setEmailDetail] = useState<Record<string, { html: string; text: string }>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [wakeTrigger, setWakeTrigger] = useState(0);
  const [usedIds, setUsedIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const s = localStorage.getItem("usedEmailIds");
      return new Set(s ? JSON.parse(s) as string[] : []);
    } catch { return new Set(); }
  });

  const lastTsRef = useRef(Date.now());
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const connStateRef = useRef<ConnState>("connecting");
  const lastActivityRef = useRef(Date.now());
  const onConnStateChangeRef = useRef(onConnStateChange);
  useEffect(() => { onConnStateChangeRef.current = onConnStateChange; }, [onConnStateChange]);
  useEffect(() => { connStateRef.current = connState; }, [connState]);

  useEffect(() => {
    if (connState === "connecting") return;
    onConnStateChangeRef.current?.(connState);
  }, [connState]);

  // Track user activity
  useEffect(() => {
    const reset = () => { lastActivityRef.current = Date.now(); };
    window.addEventListener("mousemove", reset, { passive: true });
    window.addEventListener("click", reset, { passive: true });
    window.addEventListener("keydown", reset, { passive: true });
    window.addEventListener("scroll", reset, { passive: true });
    return () => {
      window.removeEventListener("mousemove", reset);
      window.removeEventListener("click", reset);
      window.removeEventListener("keydown", reset);
      window.removeEventListener("scroll", reset);
    };
  }, []);

  // Idle check — single interval for component lifetime
  useEffect(() => {
    const interval = setInterval(() => {
      if (connStateRef.current !== "connected") return;
      if (Date.now() - lastActivityRef.current > IDLE_TIMEOUT_MS) {
        cancelledRef.current = true;
        esRef.current?.close();
        esRef.current = null;
        if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
        setConnState("sleeping");
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const wakeUp = useCallback(() => {
    lastActivityRef.current = Date.now();
    setConnState("connecting");
    setWakeTrigger(t => t + 1);
  }, []);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2000); };
  const copy = async (text: string, label = "已复制") => {
    try { await navigator.clipboard.writeText(text); showToast(`✅ ${label}`); }
    catch { showToast("❌ 复制失败"); }
  };

  const markUsed = useCallback((id: string) => {
    setUsedIds(prev => {
      const next = new Set(prev);
      next.add(id);
      try { localStorage.setItem("usedEmailIds", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (emailDetail[id]) return;
    setDetailLoading(id);
    try {
      const res = await fetch(`${WORKER_URL}/api/email-detail?id=${encodeURIComponent(id)}`, {
        headers: { "Authorization": `Bearer ${adminToken}` },
      });
      if (!res.ok) return;
      const d = await res.json() as { email: { html: string; text: string } };
      setEmailDetail(prev => ({ ...prev, [id]: { html: d.email.html || "", text: d.email.text || "" } }));
    } finally { setDetailLoading(null); }
  }, [adminToken, emailDetail]);

  const fetchEmailList = useCallback(async () => {
    const url = allMode
      ? `${WORKER_URL}/api/all-emails`
      : `${WORKER_URL}/api/tag-emails?tag=${encodeURIComponent(tag)}`;
    const init: RequestInit = { cache: "no-store" };
    init.headers = { "Authorization": `Bearer ${adminToken}` };
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return await res.json() as { emails: Array<{ id: string; to: string; from: string; subject: string; timestamp: number; activationLink: string | null }> };
  }, [adminToken, allMode, tag]);

  const manualRefresh = useCallback(async () => {
    try {
      const d = await fetchEmailList();
      if (!d) return;
      const emails = (d.emails || []).map(e => ({ ...e, toAddress: e.to }));
      setAllEmails(emails);
      setLastUpdated(new Date());
      if (emails.length > 0) {
        const maxTs = Math.max(...emails.map(e => e.timestamp));
        if (maxTs > lastTsRef.current) lastTsRef.current = maxTs;
      }
    } catch {}
  }, [fetchEmailList]);

  // SSE setup: initial fetch to get existing emails, then persistent push connection
  // wakeTrigger increments on manual wake-up to re-run this effect
  useEffect(() => {
    cancelledRef.current = false;
    lastTsRef.current = Date.now();

    if (allMode) {
      fetchEmailList()
        .then((d) => {
          if (cancelledRef.current || !d) return;
          const emails = (d.emails || []).map(e => ({ ...e, toAddress: e.to }));
          setAllEmails(emails);
          setLastUpdated(new Date());
          setConnState("connected");
        })
        .catch(() => { if (!cancelledRef.current) setConnState("connected"); });

      return () => {
        cancelledRef.current = true;
      };
    }

    const connect = () => {
      if (cancelledRef.current) return;
      const es = new EventSource(`${WORKER_URL}/api/stream?tag=${encodeURIComponent(tag)}&since=${lastTsRef.current}&token=${encodeURIComponent(adminToken)}`);
      esRef.current = es;

      es.onopen = () => {
        if (!cancelledRef.current) setConnState("connected");
      };

      es.onmessage = (event) => {
        if (cancelledRef.current) return;
        try {
          const data = JSON.parse(event.data) as { type: string; email?: { id: string; to: string; from: string; subject: string; timestamp: number; activationLink: string | null } };
          if (data.type === "email" && data.email) {
            const email: TagEmailMeta = { ...data.email, toAddress: data.email.to };
            setAllEmails(prev => prev.find(e => e.id === email.id) ? prev : [email, ...prev]);
            if (data.email.timestamp > lastTsRef.current) lastTsRef.current = data.email.timestamp;
            setLastUpdated(new Date());
          } else if (data.type === "ping" || data.type === "connected") {
            setLastUpdated(new Date());
          }
        } catch {}
      };

      es.onerror = () => {
        if (cancelledRef.current) return;
        setConnState("reconnecting");
        es.close();
        esRef.current = null;
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };
    };

    fetchEmailList()
      .then((d) => {
        if (cancelledRef.current) return;
        if (!d) return;
        const emails = (d.emails || []).map(e => ({ ...e, toAddress: e.to }));
        setAllEmails(emails);
        setLastUpdated(new Date());
        if (emails.length > 0) lastTsRef.current = Math.max(...emails.map(e => e.timestamp));
        connect();
      })
      .catch(() => { if (!cancelledRef.current) connect(); });

    return () => {
      cancelledRef.current = true;
      esRef.current?.close();
      esRef.current = null;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [allMode, fetchEmailList, tag, wakeTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card mb-6" style={{ borderLeft: "3px solid var(--primary)" }}>
      {toast && <div className="toast">{toast}</div>}

      {connState === "sleeping" && (
        <div className="flex items-center justify-between px-3 py-2 mb-3 rounded-lg"
          style={{ background: "#fef3c7", border: "1px solid #f59e0b" }}>
          <span className="text-xs" style={{ color: "#92400e" }}>😴 5 分钟无操作已休眠，新邮件推送已暂停</span>
          <button onClick={wakeUp}
            className="text-xs px-3 py-1 rounded-lg font-medium ml-3 shrink-0"
            style={{ background: "#f59e0b", color: "white" }}>
            唤醒
          </button>
        </div>
      )}

      <div className="flex items-center justify-between cursor-pointer" onClick={() => setOpen(o => !o)}>
        <span className="font-semibold text-sm" style={{ color: "var(--primary)" }}>
          📨 {allMode ? "全部收件" : `-${tag} 全部收件`}
          {allEmails.length > 0 && open && <span className="badge ml-1">{allEmails.length}</span>}
        </span>
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
          {open && (
            <>
              {allMode
                ? <span style={{ color: "#22c55e", fontSize: 10 }}>● 已加载</span>
                : connState === "connected"
                ? <span style={{ color: "#22c55e", fontSize: 10 }}>● 实时监听中</span>
                : connState === "sleeping"
                ? <span style={{ color: "#f59e0b", fontSize: 10 }}>😴 已休眠</span>
                : <span style={{ color: "#f59e0b", fontSize: 10 }}>◌ 重连中...</span>
              }
              {lastUpdated && (
                <span className="text-xs text-gray-400">
                  {lastUpdated.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              )}
              <button onClick={manualRefresh} className="text-xs text-gray-400 hover:text-gray-600" title="立即刷新">🔄</button>
            </>
          )}
          <span className="text-xs text-gray-400">{open ? "▲" : "▼"}</span>
        </div>
      </div>

      {open && (
        <div className="mt-3 rounded-xl border overflow-hidden" style={{ borderColor: "var(--primary-light)" }}>
          {allEmails.length === 0 && (
            <p className="text-center text-gray-400 py-4 text-sm">
              {connState === "connecting" ? "连接中..."
                : connState === "sleeping" ? "已休眠，点击唤醒后继续接收"
                : allMode ? "暂无邮件" : "暂无邮件，实时等待中..."}
            </p>
          )}

          {allEmails.map((email) => {
            const isOpen = expandedId === email.id;
            const detail = emailDetail[email.id];
            const isUsed = usedIds.has(email.id);
            return (
              <div key={email.id} className="border-b last:border-b-0"
                style={{ borderColor: "var(--primary-light)", background: isUsed ? "#f5f5f5" : "#f8faff" }}>
                <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white transition-colors"
                  style={{ opacity: isUsed ? 0.65 : 1 }}
                  onClick={() => { const next = isOpen ? null : email.id; setExpandedId(next); if (next) loadDetail(email.id); }}>
                  <span className="text-xs text-gray-400">{isOpen ? "▼" : "▶"}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate text-gray-700">
                      {email.subject || "(无主题)"}
                      {isUsed && <span className="ml-2 text-gray-400 font-normal">已使用</span>}
                    </div>
                    <div className="text-xs text-gray-400 truncate">
                      {email.toAddress} · {formatTime(email.timestamp)}
                    </div>
                  </div>
                  {email.activationLink && (
                    <button
                      onClick={(e) => { e.stopPropagation(); copy(email.activationLink!, "激活链接已复制"); markUsed(email.id); }}
                      className="text-xs px-2 py-1 rounded shrink-0 font-medium"
                      style={{ background: isUsed ? "#9ca3af" : "var(--primary)", color: "white" }}>
                      {isUsed ? "✓ 已使用" : "一键复制激活链接"}
                    </button>
                  )}
                </div>

                {isOpen && (
                  <div className="px-3 pb-3 bg-white">
                    {detailLoading === email.id && <p className="text-xs text-gray-400 py-2">加载中...</p>}
                    {email.activationLink && (
                      <div className="mb-2">
                        <div className="text-xs font-semibold mb-1" style={{ color: "var(--primary)" }}>🔑 激活链接</div>
                        <div className="flex items-center gap-1 mb-1">
                          <span
                            className="text-xs text-blue-600 truncate flex-1 font-mono"
                            draggable
                            onDragStart={() => markUsed(email.id)}
                          >{email.activationLink}</span>
                          <button
                            onClick={() => { copy(email.activationLink!, "激活链接已复制"); markUsed(email.id); }}
                            className="text-xs px-2 py-0.5 rounded shrink-0 font-medium"
                            style={{ background: "var(--primary)", color: "white" }}>复制</button>
                        </div>
                      </div>
                    )}
                    {detail && (
                      <button
                        onClick={() => setContentExpandedId(contentExpandedId === email.id ? null : email.id)}
                        className="text-xs px-2 py-1 rounded transition-colors"
                        style={{ background: "var(--primary-light)", color: "var(--primary-dark)" }}>
                        {contentExpandedId === email.id ? "▲ 收起邮件原文" : "▼ 查看邮件原文"}
                      </button>
                    )}
                    {contentExpandedId === email.id && detail && (
                      <div className="mt-2 rounded border overflow-hidden" style={{ borderColor: "var(--primary-light)" }}>
                        {detail.html ? (
                          <iframe
                            srcDoc={detail.html}
                            sandbox=""
                            className="w-full border-0"
                            style={{ minHeight: "200px", maxHeight: "500px" }}
                            onLoad={(e) => {
                              const f = e.target as HTMLIFrameElement;
                              if (f.contentDocument) f.style.height = Math.min(f.contentDocument.body.scrollHeight + 20, 500) + "px";
                            }}
                          />
                        ) : detail.text ? (
                          <div className="text-xs text-gray-600 whitespace-pre-wrap p-3 max-h-96 overflow-y-auto bg-gray-50">
                            {detail.text}
                          </div>
                        ) : (
                          <div className="text-xs text-gray-400 p-3">无邮件内容</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────
export default function Home() {
  const [adminToken,    setAdminToken]    = useState("");
  const [tokenInput,    setTokenInput]    = useState("");
  const [loginError,    setLoginError]    = useState("");
  const [tagRules,   setTagRules]   = useState<TagRule[]>([]);
  const [allDomains, setAllDomains] = useState<string[]>([]);
  const [activeTag,  setActiveTag]  = useState<string>("all");
  const [entries,    setEntries]    = useState<PwEntry[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [toast,      setToast]      = useState<string | null>(null);
  const [revealed,   setRevealed]   = useState<Record<string, boolean>>({});
  const [expanded,   setExpanded]   = useState<Record<string, boolean>>({});
  const [sseState, setSseState] = useState<ConnState>("connecting");

  useEffect(() => {
    if (activeTag === "all") setSseState("connected");
  }, [activeTag]);

  useEffect(() => {
    const saved = sessionStorage.getItem("accounts_admin_token");
    if (saved) setAdminToken(saved);
  }, []);

  const handleLogin = async () => {
    setLoginError("");
    const res = await fetch(`${WORKER_URL}/api/site-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: tokenInput }),
    });
    if (res.ok) {
      sessionStorage.setItem("accounts_admin_token", tokenInput);
      setAdminToken(tokenInput);
    } else {
      setLoginError("密码错误");
    }
  };

  // Date range filters
  const [startDate, setStartDate] = useState("");
  const [endDate,   setEndDate]   = useState("");
  const [linkStartDate, setLinkStartDate] = useState("");
  const [linkEndDate,   setLinkEndDate]   = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2200); };
  const copy = async (text: string, label = "已复制") => {
    try { await navigator.clipboard.writeText(text); showToast(`✅ ${label}`); }
    catch { showToast("❌ 复制失败"); }
  };

  useEffect(() => {
    // Fetch tags and domains in parallel — one time on mount
    Promise.all([
      fetch(`${WORKER_URL}/api/tags`).then(r => r.json()),
      fetch(`${WORKER_URL}/api/config`).then(r => r.json()),
    ]).then(([tagsData, configData]) => {
      setTagRules(tagsData.tagRules || []);
      const all = [
        ...(configData.domains || []),
        ...(configData.forwardDomains || []),
        ...(configData.domainsPool2 || []),
      ];
      setAllDomains([...new Set(all)] as string[]);
    }).catch(() => {});
  }, []);

  const [totalEntries, setTotalEntries] = useState(0);

  const loadEntries = useCallback(async (p = page) => {
    if (!adminToken) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(PAGE_SIZE) });
      if (activeTag !== "all") params.set("tag", activeTag);
      if (startDate) params.set("start", String(new Date(startDate + "T00:00:00").getTime()));
      if (endDate) params.set("end", String(new Date(endDate + "T23:59:59").getTime()));
      if (linkStartDate) params.set("linkStart", String(new Date(linkStartDate + "T00:00:00").getTime()));
      if (linkEndDate) params.set("linkEnd", String(new Date(linkEndDate + "T23:59:59").getTime()));
      const res = await fetch(`${WORKER_URL}/api/passwords?${params}`, {
        headers: { "Authorization": `Bearer ${adminToken}` },
      });
      if (res.status === 401) { sessionStorage.removeItem("accounts_admin_token"); setAdminToken(""); return; }
      if (res.ok) {
        const d = await res.json() as { passwords: PwEntry[]; total: number };
        setEntries(d.passwords || []);
        setTotalEntries(d.total || 0);
      }
    } finally { setLoading(false); }
  }, [adminToken, activeTag, startDate, endDate, linkStartDate, linkEndDate, page]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  // Reset to page 1 when filter/tag changes
  useEffect(() => { setPage(1); }, [activeTag, startDate, endDate, linkStartDate, linkEndDate]);

  // Auto-refresh every 10s when 未收到链接 filter is active
  const loadEntriesRef = useRef(loadEntries);
  useEffect(() => { loadEntriesRef.current = loadEntries; }, [loadEntries]);
  useEffect(() => {
    if (!linkStartDate && !linkEndDate) return;
    const id = setInterval(() => { loadEntriesRef.current(); }, 10000);
    return () => clearInterval(id);
  }, [linkStartDate, linkEndDate]);

  const totalPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));

  const tabs = [
    { key: "all", label: "全部" },
    ...tagRules.map((r) => ({
      key: r.tag,
      label: r.label ? `${r.tag} · ${r.label}` : `-${r.tag}`,
    })),
  ];

  const toggleInbox = (address: string) =>
    setExpanded((prev) => ({ ...prev, [address]: !prev[address] }));

  const hasDateFilter = startDate || endDate;
  const hasLinkFilter = linkStartDate || linkEndDate;

  if (!adminToken) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg)" }}>
        <div className="card max-w-sm w-full mx-4">
          <h1 className="text-lg font-semibold mb-4" style={{ color: "var(--primary)" }}>☁️ Number One</h1>
          <input
            type="password"
            placeholder="访问密码"
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleLogin()}
            className="w-full border rounded-xl px-4 py-2 mb-3 text-sm outline-none"
            style={{ borderColor: "#e0e0e0" }}
          />
          {loginError && <p className="text-red-500 text-sm mb-3">{loginError}</p>}
          <button onClick={handleLogin} className="btn-primary w-full">进入</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      {toast && <div className="toast">{toast}</div>}
      {activeTag !== "all" && sseState === "reconnecting" && (
        <div className="fixed top-0 left-0 right-0 z-50 text-center py-2.5 text-sm font-medium text-white"
          style={{ background: "#dc2626" }}>
          ⚠️ 连接已断开，正在重连中… 请勿生成新邮箱
        </div>
      )}

      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold" style={{ color: "var(--primary)" }}>☁️ Number One</h1>
          <a href="/admin" className="text-gray-400 hover:text-gray-600 text-lg" title="管理后台">⚙️</a>
        </div>

        {/* Tag tabs */}
        <div className="flex gap-2 mb-6 flex-wrap">
          {tabs.map(({ key, label }) => (
            <button key={key} onClick={() => setActiveTag(key)}
              className="px-4 py-2 rounded-xl text-sm font-medium transition-colors"
              style={{
                background: activeTag === key ? "var(--primary)" : "white",
                color:      activeTag === key ? "white"           : "var(--primary)",
                border:     `1px solid ${activeTag === key ? "var(--primary)" : "#e0e0e0"}`,
              }}>
              {label}
            </button>
          ))}
        </div>

        {/* Inbox panels */}
        {activeTag === "all" && (
          <TagEmailsPanel key="inbox-all" tag="all" adminToken={adminToken} allMode />
        )}
        {activeTag !== "all" && (
          <>
            <GenerateEmailPanel key={`gen-${activeTag}`} tag={activeTag} allDomains={allDomains} adminToken={adminToken} sseDisabled={sseState !== "connected"} />
            <TagEmailsPanel key={`inbox-${activeTag}`} tag={activeTag} adminToken={adminToken} onConnStateChange={setSseState} />
          </>
        )}

        {/* Entry list header */}
        <div className="mb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
            <h2 className="text-base font-semibold text-gray-700">
              已保存账号
              {totalEntries > 0 && <span className="badge ml-1">{totalEntries}</span>}
            </h2>
            <button onClick={() => loadEntries()} className="text-sm text-gray-400 hover:text-gray-600">🔄 刷新</button>
          </div>

          {/* Date filters */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500 shrink-0 w-20">创建日期：</span>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                className="text-xs rounded-lg border px-2 py-1.5 outline-none"
                style={{ borderColor: "#e0e0e0", color: "var(--primary-dark)" }} />
              <span className="text-xs text-gray-400">—</span>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                className="text-xs rounded-lg border px-2 py-1.5 outline-none"
                style={{ borderColor: "#e0e0e0", color: "var(--primary-dark)" }} />
              {hasDateFilter && (
                <button onClick={() => { setStartDate(""); setEndDate(""); }}
                  className="text-xs text-gray-400 hover:text-red-400">✕ 清除</button>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500 shrink-0 w-20">未收到链接：</span>
              <input type="date" value={linkStartDate} onChange={e => setLinkStartDate(e.target.value)}
                className="text-xs rounded-lg border px-2 py-1.5 outline-none"
                style={{ borderColor: "#e0e0e0", color: "var(--primary-dark)" }} />
              <span className="text-xs text-gray-400">—</span>
              <input type="date" value={linkEndDate} onChange={e => setLinkEndDate(e.target.value)}
                className="text-xs rounded-lg border px-2 py-1.5 outline-none"
                style={{ borderColor: "#e0e0e0", color: "var(--primary-dark)" }} />
              {hasLinkFilter && (
                <button onClick={() => { setLinkStartDate(""); setLinkEndDate(""); }}
                  className="text-xs text-gray-400 hover:text-red-400">✕ 清除</button>
              )}
            </div>
          </div>
        </div>

        {/* Entry list */}
        <div>
          {loading && <p className="text-center text-gray-400 py-8">加载中...</p>}

          {!loading && entries.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <div className="text-4xl mb-3">🗃️</div>
              <p>{totalEntries === 0 ? "暂无记录" : "该时间段内无记录"}</p>
              {totalEntries === 0 && <p className="text-sm mt-1">使用临时邮箱收到邮件后会自动出现在这里</p>}
            </div>
          )}

          {entries.map((entry) => (
            <div key={entry.address} className="card mb-3">
              {/* Address row */}
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="font-mono text-sm font-semibold truncate" style={{ color: "var(--primary-dark)" }}>
                    {entry.address}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    创建于 {formatTime(entry.created_at)}
                    {entry.last_link_received_at
                      ? <span className="ml-2">· 收到链接 {formatTime(entry.last_link_received_at)}</span>
                      : <span className="ml-2">· 未收到链接</span>
                    }
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => toggleInbox(entry.address)} className="icon-btn" title="查看收件箱"
                    style={{
                      background: expanded[entry.address] ? "var(--primary)" : undefined,
                      color:      expanded[entry.address] ? "white"          : undefined,
                    }}>📬</button>
                  <button onClick={() => copy(entry.address, "地址已复制")} className="icon-btn" title="复制邮箱地址">📋</button>
                </div>
              </div>

              {/* Password row */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <input readOnly type={revealed[entry.address] ? "text" : "password"} value={entry.password}
                    className="email-input w-full font-mono"
                    style={{ textAlign: "left", fontSize: "13px", paddingRight: "72px", cursor: "default" }}
                  />
                  <button
                    onClick={() => setRevealed((r) => ({ ...r, [entry.address]: !r[entry.address] }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-2 py-1 rounded"
                    style={{ background: "var(--primary-light)", color: "var(--primary-dark)", fontSize: "11px" }}>
                    {revealed[entry.address] ? "隐藏" : "显示"}
                  </button>
                </div>
                <button onClick={() => copy(entry.password, "密码已复制")} className="icon-btn shrink-0" title="复制密码">📋</button>
              </div>

              {/* Inbox panel */}
              {expanded[entry.address] && (
                <EmailPanel address={entry.address} adminToken={adminToken}
                  onClose={() => setExpanded((p) => ({ ...p, [entry.address]: false }))} />
              )}
            </div>
          ))}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-4 mb-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-30"
                style={{ background: "var(--primary-light)", color: "var(--primary-dark)" }}>
                ‹ 上一页
              </button>
              <span className="text-xs text-gray-500">
                {page} / {totalPages}
                <span className="text-gray-400 ml-1">（共 {totalEntries} 条）</span>
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-30"
                style={{ background: "var(--primary-light)", color: "var(--primary-dark)" }}>
                下一页 ›
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
