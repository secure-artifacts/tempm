"use client";

import { useState, useEffect, useCallback } from "react";
import { WORKER_URL } from "@/lib/config";

interface ForwardRule { subdomain: string; target: string; }
interface AdminConfig {
  domains: string[];
  domainsPool2: string[];
  forwardRules: ForwardRule[];
  siteName: string;
  autoDeleteHours: number;
  linkFilter: string;
}
interface Stats { totalEmails: number; todayEmails: number; }
interface AdminUser {
  id: string; username: string; isAdmin: number;
  dailyLimit: number; hourlyLimit: number; lifetimeLimit: number;
  domains: { domain: string; enabled: number }[];
}

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [config, setConfig] = useState<AdminConfig>({
    domains: [], domainsPool2: [], forwardRules: [],
    siteName: "云端接码", autoDeleteHours: 24, linkFilter: "",
  });
  const [stats, setStats] = useState<Stats>({ totalEmails: 0, todayEmails: 0 });
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [newDomain, setNewDomain] = useState("");
  const [newPool2, setNewPool2] = useState("");
  const [newFwdSubdomain, setNewFwdSubdomain] = useState("");
  const [newFwdTarget, setNewFwdTarget] = useState("");

  // New user inputs
  const [nuName, setNuName] = useState("");
  const [nuPass, setNuPass] = useState("");
  const [nuDaily, setNuDaily] = useState(20);
  const [nuHourly, setNuHourly] = useState(5);
  const [nuLifetime, setNuLifetime] = useState(500);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2500); };
  const authHeaders = useCallback(() => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }), [token]);

  const handleLogin = async () => {
    setLoginError("");
    try {
      const res = await fetch(`${WORKER_URL}/api/admin/login`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (res.ok && data.token) { setToken(data.token); localStorage.setItem("admin_token", data.token); }
      else setLoginError(data.error || "登录失败");
    } catch { setLoginError("无法连接 Worker，请检查 WORKER_URL 配置"); }
  };

  const loadConfig = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${WORKER_URL}/api/admin/config`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { setToken(null); localStorage.removeItem("admin_token"); return; }
      const data = await res.json();
      setConfig({
        domains: data.domains || [], domainsPool2: data.domainsPool2 || [], forwardRules: data.forwardRules || [],
        siteName: data.siteName || "云端接码", autoDeleteHours: data.autoDeleteHours || 24, linkFilter: data.linkFilter || "",
      });
    } catch { showToast("❌ 加载配置失败"); }
  }, [token]);

  const loadStats = useCallback(async () => {
    if (!token) return;
    try { const res = await fetch(`${WORKER_URL}/api/admin/stats`, { headers: { Authorization: `Bearer ${token}` } }); if (res.ok) setStats(await res.json()); }
    catch { /* ignore */ }
  }, [token]);

  const loadUsers = useCallback(async () => {
    if (!token) return;
    try { const res = await fetch(`${WORKER_URL}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } }); if (res.ok) setUsers((await res.json()).users || []); }
    catch { /* ignore */ }
  }, [token]);

  useEffect(() => { const saved = localStorage.getItem("admin_token"); if (saved) setToken(saved); }, []);
  useEffect(() => { if (token) { loadConfig(); loadStats(); loadUsers(); } }, [token, loadConfig, loadStats, loadUsers]);

  const saveConfig = async () => {
    if (!token) return;
    setSaving(true);
    try {
      const res = await fetch(`${WORKER_URL}/api/admin/config`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({
          domains: config.domains, domainsPool2: config.domainsPool2, forwardRules: config.forwardRules,
          siteName: config.siteName, autoDeleteHours: config.autoDeleteHours, linkFilter: config.linkFilter,
        }),
      });
      showToast(res.ok ? "✅ 配置已保存" : "❌ 保存失败");
    } catch { showToast("❌ 保存失败，请检查网络"); } finally { setSaving(false); }
  };

  const clearEmails = async () => {
    if (!confirm("确定清空所有邮件？此操作不可恢复。")) return;
    try { await fetch(`${WORKER_URL}/api/admin/emails`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); showToast("✅ 已清空所有邮件"); loadStats(); }
    catch { showToast("❌ 操作失败"); }
  };

  // ── Domain pools / forward rules (saved via saveConfig) ──
  const addDomain = () => {
    const d = newDomain.trim().toLowerCase(); if (!d) return;
    if (config.domains.includes(d)) { showToast("⚠️ 域名已存在"); return; }
    setConfig({ ...config, domains: [...config.domains, d] }); setNewDomain("");
  };
  const removeDomain = (domain: string) => setConfig({ ...config, domains: config.domains.filter(d => d !== domain) });
  const addPool2 = () => {
    const d = newPool2.trim().toLowerCase(); if (!d) return;
    if (config.domainsPool2.includes(d)) { showToast("⚠️ 域名已存在"); return; }
    setConfig({ ...config, domainsPool2: [...config.domainsPool2, d] }); setNewPool2("");
  };
  const removePool2 = (domain: string) => setConfig({ ...config, domainsPool2: config.domainsPool2.filter(d => d !== domain) });
  const addForwardRule = () => {
    const sub = newFwdSubdomain.trim().toLowerCase(); const target = newFwdTarget.trim().toLowerCase();
    if (!sub || !target) return;
    if (!target.includes("@")) { showToast("⚠️ 请输入有效的目标邮箱"); return; }
    if (config.forwardRules.some(r => r.subdomain === sub)) { showToast("⚠️ 该子域名规则已存在"); return; }
    setConfig({ ...config, forwardRules: [...config.forwardRules, { subdomain: sub, target }] });
    setNewFwdSubdomain(""); setNewFwdTarget("");
  };
  const removeForwardRule = (subdomain: string) => setConfig({ ...config, forwardRules: config.forwardRules.filter(r => r.subdomain !== subdomain) });

  // ── Users (immediate actions) ──
  const createUser = async () => {
    const username = nuName.trim().toLowerCase();
    if (!username || !nuPass) { showToast("⚠️ 用户名和密码必填"); return; }
    const res = await fetch(`${WORKER_URL}/api/admin/users`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ username, password: nuPass, dailyLimit: nuDaily, hourlyLimit: nuHourly, lifetimeLimit: nuLifetime }),
    });
    if (res.ok) { showToast("✅ 用户已创建"); setNuName(""); setNuPass(""); loadUsers(); }
    else showToast("❌ " + ((await res.json()).error || "创建失败"));
  };
  const resetUserPw = async (username: string) => {
    const np = prompt(`为用户 ${username} 设置新密码：`); if (!np) return;
    const res = await fetch(`${WORKER_URL}/api/admin/users/password`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ username, newPassword: np }) });
    showToast(res.ok ? "✅ 密码已重置" : "❌ 重置失败");
  };
  const deleteUser = async (username: string) => {
    if (!confirm(`确定删除用户 ${username}？其域名将被释放，名下邮件归属清空。`)) return;
    const res = await fetch(`${WORKER_URL}/api/admin/users`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ username }) });
    if (res.ok) { showToast("✅ 用户已删除"); loadUsers(); } else showToast("❌ 删除失败");
  };

  // ── Domain assignment (immediate) ──
  const assignableDomains = [...new Set([...config.domains, ...config.domainsPool2])];
  const ownerOf = (domain: string) => users.find(u => u.domains.some(d => d.domain === domain))?.username || null;

  const assignDomain = async (domain: string, username: string) => {
    if (!username) return;
    const current = ownerOf(domain);
    const res = await fetch(`${WORKER_URL}/api/admin/assign-domain`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ domain, username, reassign: !!current && current !== username }),
    });
    if (res.ok) { showToast(`✅ ${domain} → ${username}`); loadUsers(); } else showToast("❌ " + ((await res.json()).error || "分配失败"));
  };
  const unassignDomain = async (domain: string) => {
    const res = await fetch(`${WORKER_URL}/api/admin/unassign-domain`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ domain }) });
    if (res.ok) { showToast(`✅ ${domain} 已解除归属`); loadUsers(); } else showToast("❌ 操作失败");
  };

  const logout = () => { setToken(null); localStorage.removeItem("admin_token"); };

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg)" }}>
        <div className="card w-full max-w-sm">
          <h1 className="text-xl font-bold mb-6 text-center" style={{ color: "var(--primary)" }}>🔐 管理后台</h1>
          <input type="password" autoComplete="off" data-lpignore="true" data-1p-ignore="true" placeholder="输入管理密码"
            value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()}
            className="email-input mb-4" style={{ textAlign: "left", fontSize: "15px" }} />
          {loginError && <p className="text-red-500 text-sm mb-3 text-center">{loginError}</p>}
          <button className="btn-primary" onClick={handleLogin}>登录</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      {toast && <div className="toast">{toast}</div>}
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold" style={{ color: "var(--primary)" }}>⚙️ 管理后台</h1>
          <div className="flex items-center gap-3">
            <a href="/" className="text-sm text-gray-500 hover:text-gray-700 underline">返回首页</a>
            <button onClick={logout} className="text-sm text-red-500 hover:text-red-700 underline">退出登录</button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          <div className="card text-center"><div className="text-3xl font-bold" style={{ color: "var(--primary)" }}>{stats.totalEmails}</div><div className="text-sm text-gray-500 mt-1">总邮件数</div></div>
          <div className="card text-center"><div className="text-3xl font-bold" style={{ color: "var(--primary)" }}>{stats.todayEmails}</div><div className="text-sm text-gray-500 mt-1">今日邮件</div></div>
        </div>

        {/* Users */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--primary)" }}>👥 用户管理</h2>
          <div className="space-y-2 mb-4">
            {users.length === 0 && <p className="text-gray-400 text-sm py-2">还没有用户</p>}
            {users.map(u => (
              <div key={u.id} className="bg-gray-50 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{u.username}</span>
                    <span className="text-xs text-gray-400">时 {u.hourlyLimit} / 日 {u.dailyLimit} / 终身 {u.lifetimeLimit}</span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => resetUserPw(u.username)} className="text-xs text-blue-500 hover:text-blue-700">重置密码</button>
                    <button onClick={() => deleteUser(u.username)} className="text-xs text-red-400 hover:text-red-600">删除</button>
                  </div>
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  域名：{u.domains.length === 0 ? <span className="text-gray-400">未分配</span> : u.domains.map(d => (
                    <span key={d.domain} className={`font-mono mr-2 ${d.enabled ? "" : "line-through text-gray-400"}`}>{d.domain}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2 flex-wrap items-end">
            <input type="text" placeholder="用户名" value={nuName} onChange={e => setNuName(e.target.value)} className="email-input" style={{ textAlign: "left", fontSize: "14px", flex: "1 1 120px", minWidth: 100 }} />
            <input type="text" placeholder="初始密码" value={nuPass} onChange={e => setNuPass(e.target.value)} className="email-input" style={{ textAlign: "left", fontSize: "14px", flex: "1 1 120px", minWidth: 100 }} />
            <label className="text-xs text-gray-500">时<input type="number" min={1} value={nuHourly} onChange={e => setNuHourly(parseInt(e.target.value) || 1)} className="email-input" style={{ textAlign: "left", fontSize: "14px", width: 60 }} /></label>
            <label className="text-xs text-gray-500">日<input type="number" min={1} value={nuDaily} onChange={e => setNuDaily(parseInt(e.target.value) || 1)} className="email-input" style={{ textAlign: "left", fontSize: "14px", width: 60 }} /></label>
            <label className="text-xs text-gray-500">终身<input type="number" min={1} value={nuLifetime} onChange={e => setNuLifetime(parseInt(e.target.value) || 1)} className="email-input" style={{ textAlign: "left", fontSize: "14px", width: 70 }} /></label>
            <button onClick={createUser} className="px-6 py-2 rounded-lg font-medium text-white text-sm" style={{ background: "var(--primary)" }}>创建用户</button>
          </div>
        </div>

        {/* Domain assignment */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--primary)" }}>🔗 域名归属（独占）</h2>
          <p className="text-sm text-gray-500 mb-3">每个域名只能归一个用户。改派会把该域名下已有邮件一并转到新用户名下。</p>
          <div className="space-y-2">
            {assignableDomains.length === 0 && <p className="text-gray-400 text-sm py-2">先在下方添加域名，保存配置后这里才能分配</p>}
            {assignableDomains.map(d => {
              const owner = ownerOf(d);
              return (
                <div key={d} className="flex items-center justify-between gap-2 bg-gray-50 rounded-lg px-4 py-2 flex-wrap">
                  <span className="font-mono text-sm">{d}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">当前：{owner ? <span className="font-mono text-green-600">{owner}</span> : <span className="text-gray-400">未分配</span>}</span>
                    <select defaultValue="" onChange={e => { assignDomain(d, e.target.value); e.target.value = ""; }}
                      className="text-xs border rounded px-2 py-1" style={{ borderColor: "#e0e0e0" }}>
                      <option value="">分配给…</option>
                      {users.map(u => <option key={u.id} value={u.username}>{u.username}</option>)}
                    </select>
                    {owner && <button onClick={() => unassignDomain(d)} className="text-xs text-red-400 hover:text-red-600">解除</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Site Settings */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--primary)" }}>📝 站点设置</h2>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">站点名称</label>
              <input type="text" value={config.siteName} onChange={e => setConfig({ ...config, siteName: e.target.value })} className="email-input" style={{ textAlign: "left", fontSize: "14px" }} />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">邮件自动删除（小时）</label>
              <input type="number" value={config.autoDeleteHours} onChange={e => setConfig({ ...config, autoDeleteHours: parseInt(e.target.value) || 24 })} className="email-input" style={{ textAlign: "left", fontSize: "14px" }} min={1} />
            </div>
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">🔍 链接过滤（只提取 URL 包含此内容的激活链接）</label>
            <input type="text" value={config.linkFilter} onChange={e => setConfig({ ...config, linkFilter: e.target.value })} placeholder="如：auth.example.com  留空则不提取激活链接" className="email-input" style={{ textAlign: "left", fontSize: "14px" }} />
          </div>
        </div>

        {/* Domains pool 1 */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--primary)" }}>🌐 邮箱域名池</h2>
          <p className="text-sm text-gray-500 mb-3">需先在 Cloudflare 配好 Email Routing。加入这里后才能在上方分配给用户。</p>
          <div className="space-y-2 mb-4">
            {config.domains.length === 0 && <p className="text-gray-400 text-sm py-2">还没有添加域名</p>}
            {config.domains.map(d => (
              <div key={d} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3">
                <span className="font-mono text-sm">{d}</span>
                <button onClick={() => removeDomain(d)} className="text-red-400 hover:text-red-600 text-sm">删除</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" placeholder="输入域名，如 example.com" value={newDomain} onChange={e => setNewDomain(e.target.value)} onKeyDown={e => e.key === "Enter" && addDomain()} className="email-input flex-1" style={{ textAlign: "left", fontSize: "14px" }} />
            <button onClick={addDomain} className="px-6 py-2 rounded-lg font-medium text-white text-sm" style={{ background: "var(--primary)" }}>添加</button>
          </div>
        </div>

        {/* Domains pool 2 */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--primary)" }}>🌐 备用域名池</h2>
          <div className="space-y-2 mb-4">
            {config.domainsPool2.length === 0 && <p className="text-gray-400 text-sm py-2">空</p>}
            {config.domainsPool2.map(d => (
              <div key={d} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3">
                <span className="font-mono text-sm">{d}</span>
                <button onClick={() => removePool2(d)} className="text-red-400 hover:text-red-600 text-sm">删除</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" placeholder="输入备用域名" value={newPool2} onChange={e => setNewPool2(e.target.value)} onKeyDown={e => e.key === "Enter" && addPool2()} className="email-input flex-1" style={{ textAlign: "left", fontSize: "14px" }} />
            <button onClick={addPool2} className="px-6 py-2 rounded-lg font-medium text-white text-sm" style={{ background: "var(--primary)" }}>添加</button>
          </div>
        </div>

        {/* Forward Rules */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--primary)" }}>📨 子域名转发规则</h2>
          <p className="text-sm text-gray-500 mb-3">发到这些子域名的邮件会自动转发到指定邮箱，同时保存到网页端。</p>
          <div className="space-y-2 mb-4">
            {config.forwardRules.length === 0 && <p className="text-gray-400 text-sm py-2">还没有添加转发规则</p>}
            {config.forwardRules.map(rule => (
              <div key={rule.subdomain} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3">
                <div className="flex-1"><span className="font-mono text-sm">*@{rule.subdomain}</span><span className="mx-2 text-gray-400">→</span><span className="font-mono text-sm text-blue-600">{rule.target}</span></div>
                <button onClick={() => removeForwardRule(rule.subdomain)} className="text-red-400 hover:text-red-600 text-sm">删除</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" placeholder="子域名，如 fwd.example.com" value={newFwdSubdomain} onChange={e => setNewFwdSubdomain(e.target.value)} className="email-input flex-1" style={{ textAlign: "left", fontSize: "14px" }} />
            <input type="email" placeholder="转发到，如 you@gmail.com" value={newFwdTarget} onChange={e => setNewFwdTarget(e.target.value)} onKeyDown={e => e.key === "Enter" && addForwardRule()} className="email-input flex-1" style={{ textAlign: "left", fontSize: "14px" }} />
            <button onClick={addForwardRule} className="px-6 py-2 rounded-lg font-medium text-white text-sm whitespace-nowrap" style={{ background: "var(--primary)" }}>添加</button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-4 mb-8">
          <button className="btn-primary flex-1" onClick={saveConfig} disabled={saving}>{saving ? "保存中..." : "💾 保存域名/转发/站点配置"}</button>
          <button onClick={clearEmails} className="px-6 py-4 rounded-xl font-medium text-red-600 border-2 border-red-200 hover:bg-red-50 transition-colors">🗑️ 清空邮件</button>
        </div>
        <p className="text-xs text-gray-400 mb-8">注：用户、配额、域名归属为即时生效，无需点保存；上面的保存按钮只用于域名池/转发/站点设置。</p>
      </div>
    </div>
  );
}
