# 云端接码 — 自托管临时邮箱

一个完全免费、可自托管的临时邮箱服务。用户可以随机生成邮箱地址，实时接收验证邮件，自动提取验证码和激活链接。支持多用户/多租户：管理员创建用户并按域名独占分配，每个用户只看到自己域名下的邮件。

**技术栈**：Next.js 16（前端）+ Cloudflare Workers（后端）+ Cloudflare D1（数据库）

**托管费用**：全部使用免费套餐，零成本运行。

---

## 目录

- [功能介绍](#功能介绍)
- [架构总览](#架构总览)
- [前置条件](#前置条件)
- [部署步骤](#部署步骤)
  - [第一步：克隆代码并安装依赖](#第一步克隆代码并安装依赖)
  - [第二步：部署后端 Worker](#第二步部署后端-worker)
  - [第三步：配置域名收信](#第三步配置域名收信)
  - [第四步：部署前端到 Vercel](#第四步部署前端到-vercel)
  - [第五步：连通前后端](#第五步连通前后端)
  - [第六步：管理员面板初始配置](#第六步管理员面板初始配置)
- [（可选）Landing Worker](#可选landing-worker)
- [（可选）Warmup Worker](#可选warmup-worker)
- [本地开发](#本地开发)
- [项目结构](#项目结构)
- [常见问题](#常见问题)

---

## 功能介绍

- **随机生成临时邮箱** — 一键生成随机用户名，选择域名，即得一个可用邮箱地址
- **实时收信** — 轮询刷新，邮件几秒内可见
- **自动提取链接/验证码** — 正则匹配邮件正文，提取激活链接和验证码，一键复制
- **多用户 / 多租户** — 管理员创建登录用户，并把域名**独占分配**给某个用户；用户登录后只能看到自己名下域名收到的邮件，互不可见
- **按域名配额** — 默认每域名每小时 2 个、每日 5 个、累计 50 个成功激活邮箱；只按首次收到激活链接计数，普通邮件和仅生成未激活地址不计数。管理员和用户均可调整自己的配额
- **密码管理器** — 记录每个临时邮箱生成的密码，管理账号池
- **标签分组（Tag）** — 给邮箱打标签，批量管理同类账号
- **转发规则** — 指定子域名的来信自动转发到你的真实邮箱
- **管理员面板** — 在线管理用户、域名分配、全局域名列表、转发规则、自动清理周期、站点密码等
- **域名接入申请（可选）** — 在管理员面板标准化提交注册商 API 接入请求，支持单账号或多账号接入明细，敏感凭据加密保存，并可发送不含密钥的邮件通知
- **访问密码** — 可为网站设置访问密码，防止陌生人使用
- **自动清理** — 定时删除过期邮件，避免数据库膨胀
- **Hermes 机器对机器集成（可选）** — 通过共享密钥的专用接口，供自动化程序按用户领取地址、拉取激活链接

---

## 架构总览

```
用户浏览器
    │
    ▼
Next.js 前端（Vercel）
    │  API 请求
    ▼
Cloudflare Worker（后端 API）
    │
    ├── Cloudflare D1（SQLite 数据库）
    │     ├── emails 表（收到的邮件，含 owner_id 归属）
    │     ├── passwords 表（账号密码记录，含 owner_id 归属）
    │     ├── config 表（站点配置）
    │     ├── users 表（登录用户 + 每域名配额）
    │     ├── domain_owner 表（域名独占归属）
    │     ├── sessions 表（用户登录会话）
    │     └── domain_import_requests 表（可选：域名接入申请，凭据加密保存）
    │
    └── Cloudflare Email Routing
          └── 收到发往你域名的邮件 → 触发 Worker → 写入 D1
```

共有 3 个 Worker（分布在不同目录）：

| 目录 | 名称 | 作用 |
|------|------|------|
| `worker/` | `temp-mail-worker` | 核心：处理收信 + 提供 API |
| `landing-worker/` | `landing-worker` | 可选：为每个收信域名提供一个简单落地页 |
| `warmup-worker/` | `warmup-worker` | 可选：每天定时发一封邮件，防止 Worker 冷启动过慢 |

---

## 前置条件

在开始之前，你需要准备：

1. **一个域名**（如 `yourdomain.top`），用于接收邮件。可在 Namecheap、Porkbun 等平台购买，一般 $1–5/年。
2. **Cloudflare 账号**（免费）— [注册地址](https://dash.cloudflare.com/sign-up)
3. **Vercel 账号**（免费）— [注册地址](https://vercel.com)
4. **GitHub 账号**（免费）— 用于连接 Vercel 自动部署
5. **本地安装 Node.js 20+** — [下载地址](https://nodejs.org)（Next.js 16 要求 Node 20.9 及以上；安装后在终端运行 `node -v` 确认版本）

---

## 部署步骤

### 第一步：克隆代码并安装依赖

```bash
# 克隆仓库
git clone https://github.com/你的用户名/temp-mail.git
cd temp-mail

# 安装前端依赖
npm install

# 安装 Worker 依赖
cd worker && npm install && cd ..
```

---

### 第二步：部署后端 Worker

后端 Worker 负责接收邮件和提供 API，是整个系统的核心。

#### 2.1 登录 Cloudflare CLI

```bash
cd worker
npx wrangler login
```

浏览器会弹出 Cloudflare 登录页面，授权后返回终端即可。

#### 2.2 创建 D1 数据库

```bash
npm run db:create
```

命令成功后，终端会输出类似以下内容：

```
✅ Successfully created DB 'temp-mail-db'
Created your new D1 database.

{
  "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",   ← 复制这个 ID
  "name": "temp-mail-db"
}
```

**复制并保存这个 `uuid`（database_id）**，下一步需要填入配置文件。

#### 2.3 修改 Worker 配置文件

用文本编辑器打开 `worker/wrangler.toml`，修改以下字段：

```toml
name = "temp-mail-worker"
main = "src/index.ts"
compatibility_date = "2024-12-01"
workers_dev = true
account_id = "你的 Cloudflare 账号 ID"   # ← 在 Cloudflare Dashboard 右上角找到

[[d1_databases]]
binding = "DB"
database_name = "temp-mail-db"
database_id = "上一步复制的 database_id"  # ← 粘贴到这里

[vars]
# 允许跨域的前端地址（先填占位符，部署完 Vercel 后回来改）
ALLOWED_ORIGINS = "http://localhost:3000"
# 管理员密码（自己设一个强密码）。管理员凭此密码登录 /admin 管理用户和域名分配
ADMIN_PASSWORD = "你的管理员密码"

# ── 以下为域名接入申请的可选项 ──
# IMPORT_REQUEST_SECRET = "用于加密注册商 API 凭据的高强度随机密钥，建议用 wrangler secret 注入"
# RESEND_API_KEY        = "Resend 邮件 API Key，用于申请通知；不配置则只保存申请"
# IMPORT_NOTIFY_TO      = "接收通知的邮箱"
# IMPORT_NOTIFY_FROM    = "Resend 已验证的发件地址"

# ── 以下为 Hermes 机器对机器集成的可选项，不用自动化对接可全部省略 ──
# HERMES_SHARED_SECRET = "调用方与 Worker 之间的共享密钥"
# HERMES_USERNAME      = "自动化流程归属的用户名（默认 hermes）"
# HERMES_LINK_MATCH    = "激活链接前缀白名单，逗号分隔，按前缀匹配"
```

> **安全建议**：`ADMIN_PASSWORD`、`IMPORT_REQUEST_SECRET`、`RESEND_API_KEY`、`HERMES_SHARED_SECRET` 等敏感值更推荐用 `npx wrangler secret put <NAME>` 存为 Secret，而不是明文写进 `wrangler.toml` 提交到仓库。启用域名接入申请时，`IMPORT_REQUEST_SECRET` 是必需项；邮件通知相关变量是可选项。

> **如何找到 Cloudflare 账号 ID**：登录 [Cloudflare Dashboard](https://dash.cloudflare.com)，点击右上角头像 → "My Profile"，或在任意域名页面右侧栏找到 "Account ID"。

#### 2.4 初始化数据库表结构

```bash
npm run db:init
```

这会在 D1 中创建全部数据表：`emails`、`passwords`、`config`、`users`、`domain_owner`、`sessions`。

> **升级已有部署**：`schema.sql` 用的是 `CREATE TABLE IF NOT EXISTS`，对老库重复执行是安全的；新增列 / 索引等变更放在 `worker/migrations/` 下，按文件名日期顺序逐个执行，例如：
>
> ```bash
> npx wrangler d1 execute temp-mail-db --remote --file=./migrations/2026-05-29_multiuser.sql
> ```
>
> 多用户相关的 `users` / `domain_owner` / `sessions` 表及 `owner_id` 列即来自该迁移。

> 域名接入申请功能需要执行 `worker/migrations/2026-05-31_import_requests.sql`，并设置 `IMPORT_REQUEST_SECRET`。如需邮件提醒，再配置 `RESEND_API_KEY`、`IMPORT_NOTIFY_TO`、`IMPORT_NOTIFY_FROM`。
>
> Spaceship 的 API Key 和 Secret 可在 `https://www.spaceship.com/zh/application/api-manager/` 获取。若一次申请包含多个目标用户名、密码和域名分配要求，请填写管理员面板里的“多账号接入明细”；该字段会加密保存，不会写入通知邮件。

#### 2.5 部署 Worker

```bash
npm run deploy
```

部署成功后，终端输出类似：

```
✨ Worker deployed to: https://temp-mail-worker.你的账号.workers.dev
```

**保存这个 URL**，后面前端配置会用到。

---

### 第三步：配置域名收信

让 Cloudflare 接管你域名的邮件，并将来信转交给 Worker 处理。

#### 3.1 将域名添加到 Cloudflare

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 点击 "Add a site"，输入你的域名（如 `yourdomain.top`）
3. 选择 **Free** 套餐
4. Cloudflare 会给你两个 Nameserver 地址（如 `ara.ns.cloudflare.com`），记下来
5. 去你购买域名的平台（Namecheap 等），将域名的 NS 记录改为 Cloudflare 提供的地址
6. 等待 DNS 生效（通常 5–30 分钟，最长 48 小时）

#### 3.2 开启 Email Routing

1. 在 Cloudflare Dashboard 中点击你的域名
2. 左侧菜单选择 **Email** → **Email Routing**
3. 点击 "Get started"，按提示操作（Cloudflare 会自动添加必要的 MX 和 TXT 记录）
4. 开启状态变为 "Enabled" 即可

#### 3.3 添加 Catch-all 规则

在 Email Routing 页面的 **Routing rules** 部分：

1. 找到 "Catch-all address" 一行
2. 点击编辑，设置：
   - **Action**：`Send to a Worker`
   - **Worker**：选择 `temp-mail-worker`
3. 保存

这样，所有发往 `任意用户名@yourdomain.top` 的邮件都会触发你的 Worker。

---

### 第四步：部署前端到 Vercel

#### 4.1 推送代码到 GitHub

在项目根目录（`temp-mail/`）创建一个 GitHub 仓库并推送：

```bash
git remote add origin https://github.com/你的用户名/temp-mail.git
git push -u origin main
```

#### 4.2 在 Vercel 导入项目

1. 登录 [Vercel](https://vercel.com)，点击 "New Project"
2. 选择你的 GitHub 仓库
3. Framework 会自动识别为 **Next.js**，无需修改
4. 展开 **Environment Variables**，添加：

| 变量名 | 值 |
|--------|-----|
| `NEXT_PUBLIC_WORKER_URL` | `https://temp-mail-worker.你的账号.workers.dev` |

5. 点击 "Deploy"，等待部署完成（约 1–2 分钟）
6. 部署成功后记下 Vercel 给的域名，如 `temp-mail-xxx.vercel.app`

---

### 第五步：连通前后端

现在前端已部署，需要将 Vercel 地址填回 Worker 的 CORS 配置。

#### 5.1 更新 Worker 的 ALLOWED_ORIGINS

打开 `worker/wrangler.toml`，更新 `ALLOWED_ORIGINS`：

```toml
[vars]
ALLOWED_ORIGINS = "https://temp-mail-xxx.vercel.app,http://localhost:3000"
# 如果 Vercel 给了多个预览地址，全部加进来，用英文逗号分隔
```

#### 5.2 重新部署 Worker

```bash
cd worker
npm run deploy
```

---

### 第六步：管理员面板初始配置

访问你的 Vercel 站点，在 URL 后加 `/admin`（如 `https://temp-mail-xxx.vercel.app/admin`）。

1. 输入你在 `wrangler.toml` 中设置的 `ADMIN_PASSWORD`，登录
2. 在 **域名列表** 中添加你的收信域名（如 `yourdomain.top`）
3. 根据需要配置：
   - **站点名称**：显示在页面顶部的名称
   - **自动清理周期**：邮件保留多少小时后自动删除（默认 24）
   - **站点访问密码**：为整个网站设置密码（留空则无密码）
   - **转发规则**：指定某个子域名收到的邮件转发到你的真实邮箱
   - **标签规则（Tag Rules）**：定义标签名和对应的转发目标

配置完成后点击 **保存配置**。

回到首页，即可正常使用临时邮箱。

#### 多用户与域名分配（可选）

如果要把不同域名分给不同用户独立使用，在管理员面板的 **用户管理** 中：

1. **创建用户**：填用户名 + 初始密码（用户名会统一按小写、去空格归一化保存）
2. **分配域名**：把某个已配置的域名独占分配给该用户——一个域名同一时间只能属于一个用户；分配时该域名下已有的邮箱和邮件会自动归属到新用户
3. 默认配额为每个域名每小时 2 个、每日 5 个、累计 50 个成功激活邮箱；计数以邮箱首次收到激活链接为准，普通邮件和只生成未激活地址不计数
4. 用户用自己的用户名 / 密码在首页登录后，只能看到自己名下域名收到的邮件，并可为每个域名设置每日 / 每小时 / 累计配额、启用或停用域名
5. 管理员还可修改用户配额、重置用户密码、删除用户（删除会释放其域名并把其数据置为无归属）

---

## （可选）Landing Worker

`landing-worker/` 目录包含一个 Worker，访问你的收信域名时会显示一个简单的落地页（而不是 Cloudflare 的默认报错页面）。

#### 部署步骤

```bash
cd landing-worker
npm install

# 编辑 wrangler.toml：
# 1. 将 account_id 改为你的 Cloudflare 账号 ID
# 2. 将 routes 中的域名改为你自己的收信域名

npx wrangler deploy --config landing-worker/wrangler.toml
```

---

## （可选）Warmup Worker

`warmup-worker/` 目录包含一个每天定时运行的 Worker，向指定邮箱发一封邮件，目的是让整个系统保持活跃，避免冷启动延迟。

#### 部署步骤

```bash
cd warmup-worker
npm install

# 编辑 wrangler.toml：
# 1. 将 account_id 改为你的 Cloudflare 账号 ID
# 2. 将 TARGET_EMAIL 改为你自己的常用邮箱

npx wrangler deploy
```

---

## 本地开发

在本地调试时，需要同时启动前端和 Worker：

```bash
# 终端 1：启动前端
npm install
npm run dev
# 前端运行在 http://localhost:3000

# 终端 2：启动 Worker（使用本地 D1 数据库）
cd worker
npm run dev
# Worker 运行在 http://localhost:8787
```

本地开发时，编辑项目根目录的 `.env.local`：

```env
NEXT_PUBLIC_WORKER_URL=http://localhost:8787
```

本地 Worker 使用本地 D1（不影响线上数据库），首次运行本地 Worker 前需初始化本地数据库：

```bash
cd worker
npm run db:init-local
```

---

## 项目结构

```
temp-mail/
├── src/
│   └── app/
│       ├── page.tsx          # 主页：临时邮箱收信
│       ├── accounts/         # 账号管理页（密码管理器）
│       ├── admin/            # 管理员面板
│       └── globals.css
├── worker/
│   ├── src/index.ts          # 核心 Worker：收信 + API（含登录 / 多用户 / Hermes 端点）
│   ├── schema.sql            # D1 建表语句（emails/passwords/config/users/domain_owner/sessions）
│   ├── migrations/           # 增量迁移脚本（按日期顺序执行）
│   ├── wrangler.toml         # Worker 配置（需修改）
│   └── package.json
├── landing-worker/           # 可选：收信域名落地页
├── warmup-worker/            # 可选：定时热身 Worker
├── .env.local                # 前端环境变量（本地）
├── wrangler.jsonc            # 前端 Cloudflare Pages 配置（备用）
└── package.json
```

---

## 常见问题

**Q：发了邮件但网页上没有收到？**

先确认以下几点：
1. Cloudflare Email Routing 是否已开启（状态为 Enabled）
2. Catch-all 规则是否已设置为 Send to Worker
3. 管理员面板中域名列表是否已添加该域名
4. Worker 是否部署成功（访问 `https://temp-mail-worker.你的账号.workers.dev/api/config` 应返回 JSON）

**Q：网页报错 "invalid domain"？**

管理员面板 `/admin` 中，确保已将你的域名加入域名列表并保存。

**Q：网页报错 CORS 或网络请求失败？**

确认 `worker/wrangler.toml` 中的 `ALLOWED_ORIGINS` 包含你的 Vercel 域名，且重新部署了 Worker（`npm run deploy`）。

**Q：Cloudflare 的免费套餐有什么限制？**

- Workers 免费版：每天 100,000 次请求，通常足够个人使用
- D1 免费版：5 GB 存储，500 万行读取/天
- Email Routing：免费，无限制

**Q：能不能用多个域名同时接收邮件？**

可以。每个域名在 Cloudflare 都需要单独开启 Email Routing 并设置 Catch-all 规则指向同一个 Worker。然后在管理员面板的域名列表中添加所有域名即可。

**Q：如何设置某个子域名的邮件转发到 Gmail？**

在管理员面板 → **转发规则** 中添加：
- 子域名：`fwd.yourdomain.top`（仅填子域名完整地址）
- 转发目标：`yourname@gmail.com`

同时需要在 Cloudflare Email Routing 的 **Destination addresses** 中验证你的 Gmail 地址，并为该子域名也配置 Email Routing Catch-all 规则。
