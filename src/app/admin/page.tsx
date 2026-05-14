"use client";

import { useState, useEffect, useCallback } from "react";

const WORKER_URL =
  process.env.NEXT_PUBLIC_WORKER_URL || "http://localhost:8787";

interface ForwardRule {
  subdomain: string;
  target: string;
}

interface TagRule {
  tag: string;
  target: string;
  label?: string;
}

interface AdminConfig {
  domains: string[];
  forwardRules: ForwardRule[];
  tagRules: TagRule[];
  siteName: string;
  autoDeleteHours: number;
  linkFilter: string;
  hasSitePassword: boolean;
}

interface Stats {
  totalEmails: number;
  todayEmails: number;
}

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [config, setConfig] = useState<AdminConfig>({
    domains: [],
    forwardRules: [],
    tagRules: [],
    siteName: "云端接码",
    autoDeleteHours: 24,
    linkFilter: "auth.heygen.com",
    hasSitePassword: false,
  });
  const [newSitePassword, setNewSitePassword] = useState("");
  const [stats, setStats] = useState<Stats>({ totalEmails: 0, todayEmails: 0 });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // New domain / forward rule / tag rule inputs
  const [newDomain, setNewDomain] = useState("");
  const [newFwdSubdomain, setNewFwdSubdomain] = useState("");
  const [newFwdTarget, setNewFwdTarget] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagTarget, setNewTagTarget] = useState("");
  const [newTagLabel, setNewTagLabel] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  // Login
  const handleLogin = async () => {
    setLoginError("");
    try {
      const res = await fetch(`${WORKER_URL}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        setToken(data.token);
        localStorage.setItem("admin_token", data.token);
      } else {
        setLoginError(data.error || "登录失败");
      }
    } catch {
      setLoginError("无法连接 Worker，请检查 WORKER_URL 配置");
    }
  };

  // Load config
  const loadConfig = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${WORKER_URL}/api/admin/config`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setToken(null);
        localStorage.removeItem("admin_token");
        return;
      }
      const data = await res.json();
      setConfig(data);
    } catch {
      showToast("❌ 加载配置失败");
    }
  }, [token]);

  // Load stats
  const loadStats = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${WORKER_URL}/api/admin/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setStats(await res.json());
      }
    } catch { /* ignore */ }
  }, [token]);

  useEffect(() => {
    const saved = localStorage.getItem("admin_token");
    if (saved) setToken(saved);
  }, []);

  useEffect(() => {
    if (token) {
      loadConfig();
      loadStats();
    }
  }, [token, loadConfig, loadStats]);

  // Save config
  const saveConfig = async () => {
    if (!token) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { ...config };
      if (newSitePassword) {
        body.sitePassword = newSitePassword;
      }
      const res = await fetch(`${WORKER_URL}/api/admin/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        showToast("✅ 配置已保存");
        setNewSitePassword("");
        if (newSitePassword) {
          setConfig((c) => ({ ...c, hasSitePassword: true }));
        }
      } else {
        showToast("❌ 保存失败");
      }
    } catch {
      showToast("❌ 保存失败，请检查网络");
    } finally {
      setSaving(false);
    }
  };

  const clearSitePassword = async () => {
    if (!token) return;
    if (!confirm("确定移除首页访问密码？移除后所有人可直接访问。")) return;
    try {
      const res = await fetch(`${WORKER_URL}/api/admin/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ clearSitePassword: true }),
      });
      if (res.ok) {
        setConfig((c) => ({ ...c, hasSitePassword: false }));
        showToast("✅ 已移除首页密码");
      }
    } catch {
      showToast("❌ 操作失败");
    }
  };

  // Clear all emails
  const clearEmails = async () => {
    if (!confirm("确定清空所有邮件？此操作不可恢复。")) return;
    try {
      await fetch(`${WORKER_URL}/api/admin/emails`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      showToast("✅ 已清空所有邮件");
      loadStats();
    } catch {
      showToast("❌ 操作失败");
    }
  };

  // Add domain
  const addDomain = () => {
    const d = newDomain.trim().toLowerCase();
    if (!d) return;
    if (config.domains.includes(d)) {
      showToast("⚠️ 域名已存在");
      return;
    }
    setConfig({ ...config, domains: [...config.domains, d] });
    setNewDomain("");
  };

  // Remove domain
  const removeDomain = (domain: string) => {
    setConfig({
      ...config,
      domains: config.domains.filter((d) => d !== domain),
    });
  };

  // Add forward rule
  const addForwardRule = () => {
    const sub = newFwdSubdomain.trim().toLowerCase();
    const target = newFwdTarget.trim().toLowerCase();
    if (!sub || !target) return;
    if (!target.includes("@")) {
      showToast("⚠️ 请输入有效的目标邮箱");
      return;
    }
    if (config.forwardRules.some((r) => r.subdomain === sub)) {
      showToast("⚠️ 该子域名规则已存在");
      return;
    }
    setConfig({
      ...config,
      forwardRules: [...config.forwardRules, { subdomain: sub, target }],
    });
    setNewFwdSubdomain("");
    setNewFwdTarget("");
  };

  // Remove forward rule
  const removeForwardRule = (subdomain: string) => {
    setConfig({
      ...config,
      forwardRules: config.forwardRules.filter((r) => r.subdomain !== subdomain),
    });
  };

  // Add tag rule
  const addTagRule = () => {
    const tag = newTagName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const target = newTagTarget.trim();
    if (!tag) { showToast("⚠️ 请填写标签名"); return; }
    if (config.tagRules.some((r) => r.tag === tag)) { showToast("⚠️ 该标签已存在"); return; }
    setConfig({
      ...config,
      tagRules: [...config.tagRules, { tag, target, label: newTagLabel.trim() || undefined }],
    });
    setNewTagName(""); setNewTagTarget(""); setNewTagLabel("");
  };

  // Remove tag rule
  const removeTagRule = (tag: string) => {
    setConfig({ ...config, tagRules: config.tagRules.filter((r) => r.tag !== tag) });
  };

  const logout = () => {
    setToken(null);
    localStorage.removeItem("admin_token");
  };

  // ==================== Login Page ====================
  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg)" }}>
        <div className="card w-full max-w-sm">
          <h1 className="text-xl font-bold mb-6 text-center" style={{ color: "var(--primary)" }}>
            🔐 管理后台
          </h1>
          <input
            type="password"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            placeholder="输入管理密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            className="email-input mb-4"
            style={{ textAlign: "left", fontSize: "15px" }}
          />
          {loginError && (
            <p className="text-red-500 text-sm mb-3 text-center">{loginError}</p>
          )}
          <button className="btn-primary" onClick={handleLogin}>
            登录
          </button>
        </div>
      </div>
    );
  }

  // ==================== Admin Panel ====================
  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      {toast && <div className="toast">{toast}</div>}

      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold" style={{ color: "var(--primary)" }}>
            ⚙️ 管理后台
          </h1>
          <div className="flex items-center gap-3">
            <a href="/" className="text-sm text-gray-500 hover:text-gray-700 underline">
              返回首页
            </a>
            <button
              onClick={logout}
              className="text-sm text-red-500 hover:text-red-700 underline"
            >
              退出登录
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          <div className="card text-center">
            <div className="text-3xl font-bold" style={{ color: "var(--primary)" }}>
              {stats.totalEmails}
            </div>
            <div className="text-sm text-gray-500 mt-1">总邮件数</div>
          </div>
          <div className="card text-center">
            <div className="text-3xl font-bold" style={{ color: "var(--primary)" }}>
              {stats.todayEmails}
            </div>
            <div className="text-sm text-gray-500 mt-1">今日邮件</div>
          </div>
        </div>

        {/* Site Settings */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--primary)" }}>
            📝 站点设置
          </h2>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">站点名称</label>
              <input
                type="text"
                value={config.siteName}
                onChange={(e) => setConfig({ ...config, siteName: e.target.value })}
                className="email-input"
                style={{ textAlign: "left", fontSize: "14px" }}
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">邮件自动删除（小时）</label>
              <input
                type="number"
                value={config.autoDeleteHours}
                onChange={(e) => setConfig({ ...config, autoDeleteHours: parseInt(e.target.value) || 24 })}
                className="email-input"
                style={{ textAlign: "left", fontSize: "14px" }}
                min={1}
              />
            </div>
          </div>

          {/* Link Filter */}
          <div className="mb-4">
            <label className="block text-sm text-gray-600 mb-1">
              🔍 链接过滤（只显示 URL 包含此内容的链接）
            </label>
            <input
              type="text"
              value={config.linkFilter}
              onChange={(e) => setConfig({ ...config, linkFilter: e.target.value })}
              placeholder="如：auth.heygen.com  留空则不提取激活链接"
              className="email-input"
              style={{ textAlign: "left", fontSize: "14px" }}
            />
          </div>

          {/* Site Password */}
          <div>
            <label className="block text-sm text-gray-600 mb-1">
              🔒 首页访问密码{config.hasSitePassword && <span className="ml-2 text-green-600 font-medium">（已设置）</span>}
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={newSitePassword}
                onChange={(e) => setNewSitePassword(e.target.value)}
                placeholder={config.hasSitePassword ? "输入新密码以修改" : "设置后首页需要密码才能访问"}
                className="email-input flex-1"
                style={{ textAlign: "left", fontSize: "14px" }}
              />
              {config.hasSitePassword && (
                <button
                  onClick={clearSitePassword}
                  className="px-4 py-2 rounded-lg text-sm text-red-500 border border-red-200 hover:bg-red-50 whitespace-nowrap"
                >
                  移除密码
                </button>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1">留空则不修改密码；管理后台有独立密码，不受此影响</p>
          </div>
        </div>

        {/* Domains */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--primary)" }}>
            🌐 临时邮箱域名
          </h2>
          <p className="text-sm text-gray-500 mb-3">
            这些域名会随机分配给用户作为临时邮箱使用
          </p>

          {/* Domain list */}
          <div className="space-y-2 mb-4">
            {config.domains.length === 0 && (
              <p className="text-gray-400 text-sm py-2">还没有添加域名</p>
            )}
            {config.domains.map((d) => (
              <div
                key={d}
                className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3"
              >
                <span className="font-mono text-sm">{d}</span>
                <button
                  onClick={() => removeDomain(d)}
                  className="text-red-400 hover:text-red-600 text-sm"
                >
                  删除
                </button>
              </div>
            ))}
          </div>

          {/* Add domain */}
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="输入域名，如 example.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addDomain()}
              className="email-input flex-1"
              style={{ textAlign: "left", fontSize: "14px" }}
            />
            <button
              onClick={addDomain}
              className="px-6 py-2 rounded-lg font-medium text-white text-sm"
              style={{ background: "var(--primary)" }}
            >
              添加
            </button>
          </div>
        </div>

        {/* Forward Rules */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4" style={{ color: "var(--primary)" }}>
            📨 邮件转发规则
          </h2>
          <p className="text-sm text-gray-500 mb-3">
            发送到这些子域名的邮件会自动转发到指定邮箱，同时保存到网页端
          </p>

          {/* Rules list */}
          <div className="space-y-2 mb-4">
            {config.forwardRules.length === 0 && (
              <p className="text-gray-400 text-sm py-2">还没有添加转发规则</p>
            )}
            {config.forwardRules.map((rule) => (
              <div
                key={rule.subdomain}
                className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3"
              >
                <div className="flex-1">
                  <span className="font-mono text-sm">*@{rule.subdomain}</span>
                  <span className="mx-2 text-gray-400">→</span>
                  <span className="font-mono text-sm text-blue-600">{rule.target}</span>
                </div>
                <button
                  onClick={() => removeForwardRule(rule.subdomain)}
                  className="text-red-400 hover:text-red-600 text-sm"
                >
                  删除
                </button>
              </div>
            ))}
          </div>

          {/* Add rule */}
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="子域名，如 fwd.example.com"
              value={newFwdSubdomain}
              onChange={(e) => setNewFwdSubdomain(e.target.value)}
              className="email-input flex-1"
              style={{ textAlign: "left", fontSize: "14px" }}
            />
            <input
              type="email"
              placeholder="转发到，如 you@gmail.com"
              value={newFwdTarget}
              onChange={(e) => setNewFwdTarget(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addForwardRule()}
              className="email-input flex-1"
              style={{ textAlign: "left", fontSize: "14px" }}
            />
            <button
              onClick={addForwardRule}
              className="px-6 py-2 rounded-lg font-medium text-white text-sm whitespace-nowrap"
              style={{ background: "var(--primary)" }}
            >
              添加
            </button>
          </div>
        </div>

        {/* Tag Rules */}
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--primary)" }}>
            🏷️ 标签转发规则
          </h2>
          <p className="text-sm text-gray-500 mb-1">
            在邮箱前缀加 <code className="bg-gray-100 px-1 rounded">-标签</code> 即可触发转发，同时邮件也保存到网页端
          </p>
          <p className="text-xs text-gray-400 mb-4">
            例：设置标签 <strong>vip</strong> → 发到 <code>任意-vip@zxjbf.site</code> 会自动转发到指定邮箱
          </p>

          {/* Tag list */}
          <div className="space-y-2 mb-4">
            {(config.tagRules || []).length === 0 && (
              <p className="text-gray-400 text-sm py-2">还没有添加标签规则</p>
            )}
            {(config.tagRules || []).map((rule) => (
              <div
                key={rule.tag}
                className="flex items-center justify-between rounded-lg px-4 py-3"
                style={{ background: "var(--primary-light)", border: "1px solid #c8e6c9" }}
              >
                <div className="flex-1 flex items-center gap-3 flex-wrap">
                  <span
                    className="font-mono text-sm font-bold px-2 py-0.5 rounded"
                    style={{ background: "var(--primary)", color: "white" }}
                  >
                    +{rule.tag}
                  </span>
                  {rule.label && (
                    <span className="text-sm text-gray-600">{rule.label}</span>
                  )}
                  {rule.target && <>
                    <span className="text-gray-400 text-sm">→</span>
                    <span className="font-mono text-sm text-blue-600">{rule.target}</span>
                  </>}
                </div>
                <button
                  onClick={() => removeTagRule(rule.tag)}
                  className="text-red-400 hover:text-red-600 text-sm ml-4"
                >
                  删除
                </button>
              </div>
            ))}
          </div>

          {/* Add tag rule */}
          <div className="flex gap-2 flex-wrap">
            <input
              type="text"
              placeholder="标签名，如 vip"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              className="email-input"
              style={{ textAlign: "left", fontSize: "14px", flex: "1 1 80px", minWidth: "80px" }}
            />
            <input
              type="text"
              placeholder="备注（可选），如 重要客户"
              value={newTagLabel}
              onChange={(e) => setNewTagLabel(e.target.value)}
              className="email-input"
              style={{ textAlign: "left", fontSize: "14px", flex: "2 1 120px", minWidth: "120px" }}
            />
            <input
              type="email"
              placeholder="转发到，如 you@gmail.com"
              value={newTagTarget}
              onChange={(e) => setNewTagTarget(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTagRule()}
              className="email-input"
              style={{ textAlign: "left", fontSize: "14px", flex: "2 1 160px", minWidth: "160px" }}
            />
            <button
              onClick={addTagRule}
              className="px-6 py-2 rounded-lg font-medium text-white text-sm whitespace-nowrap"
              style={{ background: "var(--primary)" }}
            >
              添加
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-4 mb-8">
          <button
            className="btn-primary flex-1"
            onClick={saveConfig}
            disabled={saving}
          >
            {saving ? "保存中..." : "💾 保存所有配置"}
          </button>
          <button
            onClick={clearEmails}
            className="px-6 py-4 rounded-xl font-medium text-red-600 border-2 border-red-200 hover:bg-red-50 transition-colors"
          >
            🗑️ 清空邮件
          </button>
        </div>

        {/* Help */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-3" style={{ color: "var(--primary)" }}>
            📖 配置说明
          </h2>
          <div className="text-sm text-gray-600 space-y-2">
            <p>
              <strong>1. 临时邮箱域名</strong>：你拥有的域名，需要在
              Cloudflare 开启 Email Routing 并设置 Catch-all 指向 Worker。
            </p>
            <p>
              <strong>2. 转发规则</strong>：子域名下的邮件会同时转发到你的 Gmail
              并保存到网页端。需要在 Cloudflare DNS 中添加子域名的 MX 记录。
            </p>
            <p>
              <strong>3. 自动删除</strong>：超过设定时间的邮件会被自动清理。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
