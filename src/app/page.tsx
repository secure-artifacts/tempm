"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { generateNamePrefix } from "@/lib/utils";
import { WORKER_URL } from "@/lib/config";

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*";
  // Rejection sampling: plain `byte % chars.length` biases toward the first
  // (256 % chars.length) characters. Discard bytes in the non-uniform tail.
  const limit = 256 - (256 % chars.length);
  const out: string[] = [];
  while (out.length < 12) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b < limit) out.push(chars[b % chars.length]);
  }
  return out.join("");
}

interface PwEntry {
  address: string;
  password: string;
  label: string;
  created_at: number;
  updated_at: number;
  last_link_received_at: number | null;
}
interface OwnedDomain { domain: string; enabled: number; }
interface Account {
  username: string;
  dailyLimit: number;
  hourlyLimit: number;
  lifetimeLimit: number;
  domains: OwnedDomain[];
}
interface EmailMeta { id: string; to: string; from: string; subject: string; timestamp: number; activationLink: string | null; }

function formatTime(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

type ConnState = "connecting" | "connected" | "reconnecting" | "sleeping";
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// ── Account settings modal (change password + per-domain quotas) ────────────
function SettingsModal({ token, account, onClose, onSaved }: { token: string; account: Account; onClose: () => void; onSaved: () => void }) {
  const [daily, setDaily] = useState(account.dailyLimit);
  const [hourly, setHourly] = useState(account.hourlyLimit);
  const [lifetime, setLifetime] = useState(account.lifetimeLimit);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saveQuota = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`${WORKER_URL}/api/account/quota`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ dailyLimit: daily, hourlyLimit: hourly, lifetimeLimit: lifetime }),
      });
      if (res.ok) { setMsg("✅ 配额已保存"); onSaved(); }
      else setMsg("❌ " + ((await res.json()).error || "保存失败"));
    } catch { setMsg("❌ 网络错误"); } finally { setBusy(false); }
  };

  const changePw = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`${WORKER_URL}/api/account/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
      });
      if (res.ok) { setMsg("✅ 密码已修改"); setOldPw(""); setNewPw(""); }
      else setMsg("❌ " + ((await res.json()).error || "修改失败"));
    } catch { setMsg("❌ 网络错误"); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <div className="card max-w-md w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold" style={{ color: "var(--primary)" }}>⚙️ 账号设置</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        {msg && <p className="text-sm mb-3">{msg}</p>}

        <div className="mb-5">
          <div className="text-sm font-semibold text-gray-700 mb-2">配额（应用到你名下每个域名）</div>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs text-gray-500">每小时上限
              <input type="number" min={1} value={hourly} onChange={e => setHourly(parseInt(e.target.value) || 1)}
                className="email-input mt-1" style={{ textAlign: "left", fontSize: "14px" }} /></label>
            <label className="text-xs text-gray-500">每日上限
              <input type="number" min={1} value={daily} onChange={e => setDaily(parseInt(e.target.value) || 1)}
                className="email-input mt-1" style={{ textAlign: "left", fontSize: "14px" }} /></label>
            <label className="text-xs text-gray-500">终身上限
              <input type="number" min={1} value={lifetime} onChange={e => setLifetime(parseInt(e.target.value) || 1)}
                className="email-input mt-1" style={{ textAlign: "left", fontSize: "14px" }} /></label>
          </div>
          <p className="text-xs text-gray-400 mt-1">只按收到激活链接的邮箱计数，普通邮件不算</p>
          <button onClick={saveQuota} disabled={busy} className="btn-primary w-full mt-2 text-sm">保存配额</button>
        </div>

        <div>
          <div className="text-sm font-semibold text-gray-700 mb-2">修改登录密码</div>
          <input type="password" placeholder="原密码" value={oldPw} onChange={e => setOldPw(e.target.value)}
            className="email-input mb-2" style={{ textAlign: "left", fontSize: "14px" }} />
          <input type="password" placeholder="新密码（≥4 位）" value={newPw} onChange={e => setNewPw(e.target.value)}
            className="email-input mb-2" style={{ textAlign: "left", fontSize: "14px" }} />
          <button onClick={changePw} disabled={busy} className="btn-primary w-full text-sm">修改密码</button>
        </div>
      </div>
    </div>
  );
}

// ── Generate Email Panel (over the user's owned + enabled domains) ──────────
function GenerateEmailPanel({ token, domains, onToggled }: { token: string; domains: OwnedDomain[]; onToggled: () => void }) {
  const [quotas, setQuotas] = useState<{ daily: Record<string, number>; hourly: Record<string, number>; lifetime: Record<string, number>; dailyLimit: number; hourlyLimit: number; lifetimeLimit: number } | null>(null);
  const [generated, setGenerated] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [poolOpen, setPoolOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2500); };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); showToast("✅ 邮箱已复制"); }
    catch { showToast("❌ 复制失败"); }
  };

  const loadQuotas = useCallback(async () => {
    try {
      const res = await fetch(`${WORKER_URL}/api/domain-quotas`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) { setQuotas(await res.json()); setLoaded(true); }
    } catch { /* ignore */ }
  }, [token]);

  useEffect(() => { loadQuotas(); }, [loadQuotas]);

  const toggleDomain = async (d: string, enabled: boolean) => {
    try {
      await fetch(`${WORKER_URL}/api/account/domain-toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ domain: d, enabled }),
      });
      onToggled();
      loadQuotas();
    } catch { showToast("❌ 操作失败"); }
  };

  const domainFull = (d: string): "lifetime" | "rate" | null => {
    if (!quotas) return null;
    const dl = d.toLowerCase();
    if ((quotas.lifetime[dl] || 0) >= quotas.lifetimeLimit) return "lifetime";
    if ((quotas.daily[dl] || 0) >= quotas.dailyLimit || (quotas.hourly[dl] || 0) >= quotas.hourlyLimit) return "rate";
    return null;
  };

  const enabledDomains = domains.filter(d => d.enabled).map(d => d.domain);
  const available = enabledDomains.filter(d => domainFull(d) === null);
  const allFull = loaded && enabledDomains.length > 0 && available.length === 0;

  const generate = async () => {
    if (available.length === 0) { showToast("⚠️ 可用域名都已达配额"); return; }
    for (let attempt = 0; attempt < 10; attempt++) {
      const picked = available[Math.floor(Math.random() * available.length)];
      const addr = `${generateNamePrefix()}@${picked}`;
      try {
        const res = await fetch(`${WORKER_URL}/api/passwords`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ address: addr, password: generatePassword() }),
        });
        if (res.status === 409) continue;
        if (!res.ok) { showToast("❌ " + ((await res.json()).error || "生成失败")); return; }
        setGenerated(addr);
        loadQuotas();
        copy(addr);
        return;
      } catch { showToast("❌ 网络错误"); return; }
    }
    showToast("⚠️ 邮箱名重复，请再试一次");
  };

  const disabled = !loaded || allFull || enabledDomains.length === 0;

  return (
    <div className="card mb-4" style={{ borderLeft: "3px solid #4caf50" }}>
      {toast && <div className="toast">{toast}</div>}
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold" style={{ color: "var(--primary)" }}>📧 生成新邮箱</div>
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <button onClick={generate} disabled={disabled}
          className="px-4 py-2 rounded-xl text-sm font-medium text-white flex-1"
          style={{ background: disabled ? "#ccc" : "var(--primary)", cursor: disabled ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>
          {!loaded ? "⏳ 加载中..." : enabledDomains.length === 0 ? "无可用域名" : allFull ? "域名配额已满" : "🎲 随机生成"}
        </button>
        <button onClick={loadQuotas} className="text-xs text-gray-400 hover:text-gray-600" title="刷新配额">🔄</button>
      </div>

      {generated && (
        <div className="mb-3 flex items-center gap-2">
          <span className="font-mono text-sm flex-1 truncate" style={{ color: "var(--primary-dark)" }}>{generated}</span>
          <button onClick={() => copy(generated)} className="text-xs px-3 py-1 rounded-lg shrink-0" style={{ background: "var(--primary)", color: "white" }}>📋 复制</button>
        </div>
      )}

      <div>
        <button onClick={() => setPoolOpen(o => !o)} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
          {poolOpen ? "▲" : "▶"} 我的域名 ({enabledDomains.length}/{domains.length} 启用)
        </button>
        {poolOpen && (
          <div className="mt-2 space-y-1">
            {domains.length === 0 && <p className="text-xs text-gray-400">管理员还未给你分配域名</p>}
            {domains.map(({ domain: d, enabled }) => {
              const dl = d.toLowerCase();
              const full = domainFull(d);
              return (
                <label key={d} className="flex items-center gap-2 select-none cursor-pointer">
                  <input type="checkbox" checked={!!enabled} onChange={() => toggleDomain(d, !enabled)} className="accent-green-500" />
                  <span className={`text-xs font-mono ${!enabled ? "text-gray-400 line-through" : full === "lifetime" ? "text-red-400" : "text-gray-700"}`}>{d}</span>
                  {quotas && enabled ? (
                    full === "lifetime"
                      ? <span className="text-xs text-red-400 font-medium">终身已满</span>
                      : <span className="text-xs text-gray-400">
                          今日 {quotas.daily[dl] || 0}/{quotas.dailyLimit} · 本时 {quotas.hourly[dl] || 0}/{quotas.hourlyLimit} · 终身 {quotas.lifetime[dl] || 0}/{quotas.lifetimeLimit}
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

// ── Shared email-detail loader/renderer ─────────────────────────────────────
function useEmailDetail(token: string) {
  const [detail, setDetail] = useState<Record<string, { html: string; text: string }>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const load = useCallback(async (id: string) => {
    if (detail[id]) return;
    setLoading(id);
    try {
      const res = await fetch(`${WORKER_URL}/api/email-detail?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const d = await res.json() as { email: { html: string; text: string } };
      setDetail(prev => ({ ...prev, [id]: { html: d.email.html || "", text: d.email.text || "" } }));
    } finally { setLoading(null); }
  }, [detail, token]);
  return { detail, loading, load };
}

function EmailBody({ detail }: { detail: { html: string; text: string } }) {
  return (
    <div className="mt-2 rounded border overflow-hidden" style={{ borderColor: "var(--primary-light)" }}>
      {detail.html ? (
        <iframe srcDoc={detail.html} sandbox="" className="w-full border-0" style={{ minHeight: "200px", maxHeight: "500px" }}
          onLoad={(e) => { const f = e.target as HTMLIFrameElement; if (f.contentDocument) f.style.height = Math.min(f.contentDocument.body.scrollHeight + 20, 500) + "px"; }} />
      ) : detail.text ? (
        <div className="text-xs text-gray-600 whitespace-pre-wrap p-3 max-h-96 overflow-y-auto bg-gray-50">{detail.text}</div>
      ) : (
        <div className="text-xs text-gray-400 p-3">无邮件内容</div>
      )}
    </div>
  );
}

// ── Per-address / search inbox (owner-scoped, no SSE) ───────────────────────
function EmailPanel({ token, address, query, onClose }: { token: string; address?: string; query?: string; onClose: () => void }) {
  const [emails, setEmails] = useState<EmailMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [contentOpen, setContentOpen] = useState<string | null>(null);
  const { detail, loading: detailLoading, load: loadDetail } = useEmailDetail(token);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = address ? `address=${encodeURIComponent(address)}` : `q=${encodeURIComponent(query || "")}`;
      const res = await fetch(`${WORKER_URL}/api/inbox?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const d = await res.json() as { emails: EmailMeta[] };
        setEmails(d.emails || []);
        if ((d.emails || []).length > 0) setExpanded(d.emails[0].id);
      }
    } finally { setLoading(false); }
  }, [address, query, token]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mt-3 rounded-xl border" style={{ background: "#f8faff", borderColor: "var(--primary-light)" }}>
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
        return (
          <div key={email.id} className="border-b last:border-b-0" style={{ borderColor: "var(--primary-light)" }}>
            <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white transition-colors"
              onClick={() => { const n = isOpen ? null : email.id; setExpanded(n); if (n) loadDetail(email.id); }}>
              <span className="text-xs">{isOpen ? "▼" : "▶"}</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold truncate text-gray-700">{email.subject || "(无主题)"}</div>
                <div className="text-xs text-gray-400 truncate">
                  {query && <span className="font-mono" style={{ color: "var(--primary-dark)" }}>→ {email.to}　</span>}
                  {email.from} · {formatTime(email.timestamp)}
                </div>
              </div>
            </div>
            {isOpen && (
              <div className="px-3 pb-3">
                {detailLoading === email.id && <p className="text-xs text-gray-400 py-2">加载中...</p>}
                {detail[email.id] && (
                  <>
                    <button onClick={() => setContentOpen(contentOpen === email.id ? null : email.id)}
                      className="text-xs px-2 py-1 rounded transition-colors" style={{ background: "var(--primary-light)", color: "var(--primary-dark)" }}>
                      {contentOpen === email.id ? "▲ 收起邮件原文" : "▼ 查看邮件原文"}
                    </button>
                    {contentOpen === email.id && <EmailBody detail={detail[email.id]} />}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Unified real-time inbox (the user's whole inbox, SSE push) ──────────────
function InboxPanel({ token }: { token: string }) {
  const [emails, setEmails] = useState<EmailMeta[]>([]);
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [contentOpenId, setContentOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [wakeTrigger, setWakeTrigger] = useState(0);
  const { detail, loading: detailLoading, load: loadDetail } = useEmailDetail(token);
  const [usedIds, setUsedIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try { const s = localStorage.getItem("usedEmailIds"); return new Set(s ? JSON.parse(s) as string[] : []); }
    catch { return new Set(); }
  });

  const lastTsRef = useRef(Date.now());
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const connStateRef = useRef<ConnState>("connecting");
  const lastActivityRef = useRef(Date.now());
  useEffect(() => { connStateRef.current = connState; }, [connState]);

  // Track activity for idle-sleep
  useEffect(() => {
    const reset = () => { lastActivityRef.current = Date.now(); };
    for (const ev of ["mousemove", "click", "keydown", "scroll"]) window.addEventListener(ev, reset, { passive: true });
    return () => { for (const ev of ["mousemove", "click", "keydown", "scroll"]) window.removeEventListener(ev, reset); };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (connStateRef.current !== "connected") return;
      if (Date.now() - lastActivityRef.current > IDLE_TIMEOUT_MS) {
        cancelledRef.current = true;
        esRef.current?.close(); esRef.current = null;
        if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
        setConnState("sleeping");
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const wakeUp = useCallback(() => { lastActivityRef.current = Date.now(); setConnState("connecting"); setWakeTrigger(t => t + 1); }, []);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2000); };
  const copy = async (text: string, label = "已复制") => {
    try { await navigator.clipboard.writeText(text); showToast(`✅ ${label}`); }
    catch { showToast("❌ 复制失败"); }
  };
  const markUsed = useCallback((id: string) => {
    setUsedIds(prev => { const next = new Set(prev); next.add(id); try { localStorage.setItem("usedEmailIds", JSON.stringify([...next])); } catch {} return next; });
  }, []);

  const fetchList = useCallback(async () => {
    const res = await fetch(`${WORKER_URL}/api/inbox`, { cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return await res.json() as { emails: EmailMeta[] };
  }, [token]);

  const manualRefresh = useCallback(async () => {
    try {
      const d = await fetchList();
      if (!d) return;
      setEmails(d.emails || []);
      setLastUpdated(new Date());
      if ((d.emails || []).length > 0) { const maxTs = Math.max(...d.emails.map(e => e.timestamp)); if (maxTs > lastTsRef.current) lastTsRef.current = maxTs; }
    } catch {}
  }, [fetchList]);

  useEffect(() => {
    cancelledRef.current = false;
    lastTsRef.current = Date.now();

    const connect = () => {
      if (cancelledRef.current) return;
      const es = new EventSource(`${WORKER_URL}/api/stream?since=${lastTsRef.current}&token=${encodeURIComponent(token)}`);
      esRef.current = es;
      es.onopen = () => { if (!cancelledRef.current) setConnState("connected"); };
      es.onmessage = (event) => {
        if (cancelledRef.current) return;
        try {
          const data = JSON.parse(event.data) as { type: string; email?: EmailMeta };
          if (data.type === "email" && data.email) {
            const email = data.email;
            setEmails(prev => prev.find(e => e.id === email.id) ? prev : [email, ...prev]);
            if (email.timestamp > lastTsRef.current) lastTsRef.current = email.timestamp;
            setLastUpdated(new Date());
          } else if (data.type === "ping" || data.type === "connected") {
            setLastUpdated(new Date());
          }
        } catch {}
      };
      es.onerror = () => {
        if (cancelledRef.current) return;
        setConnState("reconnecting");
        es.close(); esRef.current = null;
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };
    };

    fetchList()
      .then((d) => {
        if (cancelledRef.current || !d) { if (!cancelledRef.current) connect(); return; }
        setEmails(d.emails || []);
        setLastUpdated(new Date());
        if ((d.emails || []).length > 0) lastTsRef.current = Math.max(...d.emails.map(e => e.timestamp));
        connect();
      })
      .catch(() => { if (!cancelledRef.current) connect(); });

    return () => {
      cancelledRef.current = true;
      esRef.current?.close(); esRef.current = null;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [fetchList, token, wakeTrigger]);

  return (
    <div className="card mb-6" style={{ borderLeft: "3px solid var(--primary)" }}>
      {toast && <div className="toast">{toast}</div>}

      {connState === "sleeping" && (
        <div className="flex items-center justify-between px-3 py-2 mb-3 rounded-lg" style={{ background: "#fef3c7", border: "1px solid #f59e0b" }}>
          <span className="text-xs" style={{ color: "#92400e" }}>😴 5 分钟无操作已休眠，新邮件推送已暂停</span>
          <button onClick={wakeUp} className="text-xs px-3 py-1 rounded-lg font-medium ml-3 shrink-0" style={{ background: "#f59e0b", color: "white" }}>唤醒</button>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold text-sm" style={{ color: "var(--primary)" }}>
          📨 我的收件箱{emails.length > 0 && <span className="badge ml-1">{emails.length}</span>}
        </span>
        <div className="flex items-center gap-2">
          {connState === "connected" ? <span style={{ color: "#22c55e", fontSize: 10 }}>● 实时监听中</span>
            : connState === "sleeping" ? <span style={{ color: "#f59e0b", fontSize: 10 }}>😴 已休眠</span>
            : <span style={{ color: "#f59e0b", fontSize: 10 }}>◌ 重连中...</span>}
          {lastUpdated && <span className="text-xs text-gray-400">{lastUpdated.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
          <button onClick={manualRefresh} className="text-xs text-gray-400 hover:text-gray-600" title="立即刷新">🔄</button>
        </div>
      </div>

      <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--primary-light)" }}>
        {emails.length === 0 && (
          <p className="text-center text-gray-400 py-4 text-sm">
            {connState === "connecting" ? "连接中..." : connState === "sleeping" ? "已休眠，点击唤醒后继续接收" : "暂无邮件，实时等待中..."}
          </p>
        )}
        {emails.map((email) => {
          const isOpen = expandedId === email.id;
          const isUsed = usedIds.has(email.id);
          return (
            <div key={email.id} className="border-b last:border-b-0" style={{ borderColor: "var(--primary-light)", background: isUsed ? "#f5f5f5" : "#f8faff" }}>
              <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white transition-colors" style={{ opacity: isUsed ? 0.65 : 1 }}
                onClick={() => { const n = isOpen ? null : email.id; setExpandedId(n); if (n) loadDetail(email.id); }}>
                <span className="text-xs text-gray-400">{isOpen ? "▼" : "▶"}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold truncate text-gray-700">{email.subject || "(无主题)"}{isUsed && <span className="ml-2 text-gray-400 font-normal">已使用</span>}</div>
                  <div className="text-xs text-gray-400 truncate">{email.to} · {formatTime(email.timestamp)}</div>
                </div>
                {email.activationLink && (
                  <button onClick={(e) => { e.stopPropagation(); copy(email.activationLink!, "激活链接已复制"); markUsed(email.id); }}
                    className="text-xs px-2 py-1 rounded shrink-0 font-medium" style={{ background: isUsed ? "#9ca3af" : "var(--primary)", color: "white" }}>
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
                        <span className="text-xs text-blue-600 truncate flex-1 font-mono" draggable onDragStart={() => markUsed(email.id)}>{email.activationLink}</span>
                        <button onClick={() => { copy(email.activationLink!, "激活链接已复制"); markUsed(email.id); }}
                          className="text-xs px-2 py-0.5 rounded shrink-0 font-medium" style={{ background: "var(--primary)", color: "white" }}>复制</button>
                      </div>
                    </div>
                  )}
                  {detail[email.id] && (
                    <button onClick={() => setContentOpenId(contentOpenId === email.id ? null : email.id)}
                      className="text-xs px-2 py-1 rounded transition-colors" style={{ background: "var(--primary-light)", color: "var(--primary-dark)" }}>
                      {contentOpenId === email.id ? "▲ 收起邮件原文" : "▼ 查看邮件原文"}
                    </button>
                  )}
                  {contentOpenId === email.id && detail[email.id] && <EmailBody detail={detail[email.id]} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Search own inbox ────────────────────────────────────────────────────────
function SearchInboxPanel({ token }: { token: string }) {
  const [input, setInput] = useState("");
  const [active, setActive] = useState<{ mode: "exact" | "partial"; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    const raw = input.trim().toLowerCase();
    if (!raw) { setError("请输入邮箱名、部分地址或完整地址"); return; }
    if (raw.includes("@")) {
      if (!/^[a-z0-9._-]+@[a-z0-9.-]+$/.test(raw)) { setError("邮箱格式不正确"); return; }
      setActive({ mode: "exact", value: raw });
    } else {
      if (raw.length < 3) { setError("部分匹配至少输入 3 个字符"); return; }
      setActive({ mode: "partial", value: raw });
    }
  };

  return (
    <div className="card mb-6">
      <h2 className="text-base font-semibold text-gray-700 mb-3">🔍 在我的邮件中查询</h2>
      <div className="flex items-center gap-2 flex-wrap">
        <input type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()}
          placeholder="部分地址（≥3 字符）或完整地址"
          className="flex-1 min-w-[200px] border rounded-xl px-3 py-2 text-sm outline-none font-mono" style={{ borderColor: "#e0e0e0" }} />
        <button onClick={submit} className="btn-primary text-sm px-4 py-2">📬 查看收件箱</button>
      </div>
      {error && <p className="text-red-500 text-xs mt-2">{error}</p>}
      {active && (
        <EmailPanel key={`${active.mode}:${active.value}`} token={token}
          address={active.mode === "exact" ? active.value : undefined}
          query={active.mode === "partial" ? active.value : undefined}
          onClose={() => setActive(null)} />
      )}
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────
export default function Home() {
  const [token, setToken] = useState("");
  const [siteName, setSiteName] = useState("云端接码");
  const [account, setAccount] = useState<Account | null>(null);
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  const [entries, setEntries] = useState<PwEntry[]>([]);
  const [totalEntries, setTotalEntries] = useState(0);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [linkDays, setLinkDays] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 40;

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2200); };
  const copy = async (text: string, label = "已复制") => {
    try { await navigator.clipboard.writeText(text); showToast(`✅ ${label}`); }
    catch { showToast("❌ 复制失败"); }
  };

  const logout = useCallback(async () => {
    if (token) { try { await fetch(`${WORKER_URL}/api/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }); } catch {} }
    sessionStorage.removeItem("user_token");
    setToken(""); setAccount(null);
  }, [token]);

  useEffect(() => { fetch(`${WORKER_URL}/api/config`).then(r => r.json()).then(d => setSiteName(d.siteName || "云端接码")).catch(() => {}); }, []);
  useEffect(() => { const saved = sessionStorage.getItem("user_token"); if (saved) setToken(saved); }, []);

  const loadAccount = useCallback(async () => {
    if (!token) return;
    const res = await fetch(`${WORKER_URL}/api/account`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { sessionStorage.removeItem("user_token"); setToken(""); return; }
    if (res.ok) setAccount(await res.json());
  }, [token]);
  useEffect(() => { loadAccount(); }, [loadAccount]);

  const handleLogin = async () => {
    setLoginError("");
    try {
      const res = await fetch(`${WORKER_URL}/api/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: usernameInput.trim(), password: passwordInput }),
      });
      const data = await res.json();
      if (res.ok && data.token) { sessionStorage.setItem("user_token", data.token); setToken(data.token); setPasswordInput(""); }
      else setLoginError(data.error || "登录失败");
    } catch { setLoginError("无法连接服务器"); }
  };

  const loadEntries = useCallback(async (p = page) => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(PAGE_SIZE) });
      if (startDate) params.set("start", String(new Date(startDate + "T00:00:00").getTime()));
      if (endDate) params.set("end", String(new Date(endDate + "T23:59:59").getTime()));
      if (linkDays) params.set("linkDays", linkDays);
      const res = await fetch(`${WORKER_URL}/api/passwords?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { sessionStorage.removeItem("user_token"); setToken(""); return; }
      if (res.ok) {
        const d = await res.json() as { passwords: PwEntry[]; total: number };
        setEntries(d.passwords || []);
        setTotalEntries(d.total || 0);
      }
    } finally { setLoading(false); }
  }, [token, startDate, endDate, linkDays, page]);

  useEffect(() => { loadEntries(); }, [loadEntries]);
  useEffect(() => { setPage(1); }, [startDate, endDate, linkDays]);

  const totalPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));
  const toggleInbox = (address: string) => setExpanded((prev) => ({ ...prev, [address]: !prev[address] }));
  const hasDateFilter = startDate || endDate;

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg)" }}>
        <div className="card max-w-sm w-full mx-4">
          <h1 className="text-lg font-semibold mb-4" style={{ color: "var(--primary)" }}>☁️ {siteName}</h1>
          <input type="text" autoComplete="off" placeholder="用户名" value={usernameInput}
            onChange={e => setUsernameInput(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()}
            className="w-full border rounded-xl px-4 py-2 mb-3 text-sm outline-none" style={{ borderColor: "#e0e0e0" }} />
          <input type="password" autoComplete="off" data-lpignore="true" data-1p-ignore="true" placeholder="密码" value={passwordInput}
            onChange={e => setPasswordInput(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()}
            className="w-full border rounded-xl px-4 py-2 mb-3 text-sm outline-none" style={{ borderColor: "#e0e0e0" }} />
          {loginError && <p className="text-red-500 text-sm mb-3">{loginError}</p>}
          <button onClick={handleLogin} className="btn-primary w-full">进入</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      {toast && <div className="toast">{toast}</div>}
      {showSettings && account && (
        <SettingsModal token={token} account={account} onClose={() => setShowSettings(false)} onSaved={loadAccount} />
      )}

      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold" style={{ color: "var(--primary)" }}>☁️ {siteName}</h1>
          <div className="flex items-center gap-3 text-sm">
            {account && <span className="text-gray-500">👤 {account.username}</span>}
            <button onClick={() => setShowSettings(true)} className="text-gray-400 hover:text-gray-600 text-lg" title="账号设置">⚙️</button>
            <button onClick={logout} className="text-red-400 hover:text-red-600">退出</button>
          </div>
        </div>

        {account && <GenerateEmailPanel token={token} domains={account.domains} onToggled={loadAccount} />}

        <InboxPanel token={token} />

        <SearchInboxPanel token={token} />

        {/* Saved mailboxes */}
        <div className="mb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
            <h2 className="text-base font-semibold text-gray-700">已保存账号{totalEntries > 0 && <span className="badge ml-1">{totalEntries}</span>}</h2>
            <button onClick={() => loadEntries()} className="text-sm text-gray-400 hover:text-gray-600">🔄 刷新</button>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500 shrink-0 w-20">创建日期：</span>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="text-xs rounded-lg border px-2 py-1.5 outline-none" style={{ borderColor: "#e0e0e0", color: "var(--primary-dark)" }} />
              <span className="text-xs text-gray-400">—</span>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="text-xs rounded-lg border px-2 py-1.5 outline-none" style={{ borderColor: "#e0e0e0", color: "var(--primary-dark)" }} />
              {hasDateFilter && <button onClick={() => { setStartDate(""); setEndDate(""); }} className="text-xs text-gray-400 hover:text-red-400">✕ 清除</button>}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500 shrink-0 w-20">链接超过：</span>
              <input type="number" min="1" value={linkDays} onChange={e => setLinkDays(e.target.value)} placeholder="天数" className="text-xs rounded-lg border px-2 py-1.5 outline-none w-20" style={{ borderColor: "#e0e0e0", color: "var(--primary-dark)" }} />
              <span className="text-xs text-gray-400">天未使用</span>
              {linkDays && <button onClick={() => setLinkDays("")} className="text-xs text-gray-400 hover:text-red-400">✕ 清除</button>}
            </div>
          </div>
        </div>

        <div>
          {loading && <p className="text-center text-gray-400 py-8">加载中...</p>}
          {!loading && entries.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <div className="text-4xl mb-3">🗃️</div>
              <p>{totalEntries === 0 ? "暂无记录" : "该时间段内无记录"}</p>
              {totalEntries === 0 && <p className="text-sm mt-1">生成邮箱并收到邮件后会出现在这里</p>}
            </div>
          )}

          {entries.map((entry) => (
            <div key={entry.address} className="card mb-3">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="font-mono text-sm font-semibold truncate" style={{ color: "var(--primary-dark)" }}>{entry.address}</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    创建于 {formatTime(entry.created_at)}
                    {entry.last_link_received_at ? <span className="ml-2">· 收到链接 {formatTime(entry.last_link_received_at)}</span> : <span className="ml-2">· 未收到链接</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => toggleInbox(entry.address)} className="icon-btn" title="查看收件箱"
                    style={{ background: expanded[entry.address] ? "var(--primary)" : undefined, color: expanded[entry.address] ? "white" : undefined }}>📬</button>
                  <button onClick={() => copy(entry.address, "地址已复制")} className="icon-btn" title="复制邮箱地址">📋</button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <input readOnly type={revealed[entry.address] ? "text" : "password"} value={entry.password}
                    className="email-input w-full font-mono" style={{ textAlign: "left", fontSize: "13px", paddingRight: "72px", cursor: "default" }} />
                  <button onClick={() => setRevealed((r) => ({ ...r, [entry.address]: !r[entry.address] }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-2 py-1 rounded" style={{ background: "var(--primary-light)", color: "var(--primary-dark)", fontSize: "11px" }}>
                    {revealed[entry.address] ? "隐藏" : "显示"}
                  </button>
                </div>
                <button onClick={() => copy(entry.password, "密码已复制")} className="icon-btn shrink-0" title="复制密码">📋</button>
              </div>
              {expanded[entry.address] && (
                <EmailPanel token={token} address={entry.address} onClose={() => setExpanded((p) => ({ ...p, [entry.address]: false }))} />
              )}
            </div>
          ))}

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-4 mb-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-30" style={{ background: "var(--primary-light)", color: "var(--primary-dark)" }}>‹ 上一页</button>
              <span className="text-xs text-gray-500">{page} / {totalPages}<span className="text-gray-400 ml-1">（共 {totalEntries} 条）</span></span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-30" style={{ background: "var(--primary-light)", color: "var(--primary-dark)" }}>下一页 ›</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
