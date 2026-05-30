const WORKER = "https://temp-mail-worker.YOUR_SUBDOMAIN.workers.dev";
const TOKEN = "change-me";

let toastTimer = null;

function showToast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); showToast("✓ 已复制"); } catch {}
}

async function render() {
  const main = document.getElementById("main");
  const { profile_id } = await chrome.storage.local.get("profile_id");

  if (!profile_id) {
    main.innerHTML = `<div class="no-profile">
      尚未设置 Profile ID<br>请先前往 <a href="options.html" target="_blank">设置页</a> 填写
    </div>`;
    return;
  }

  let addresses = [], links = [];
  try {
    const [ar, lr] = await Promise.all([
      fetch(`${WORKER}/api/profile-address?profile_id=${encodeURIComponent(profile_id)}`).then(r => r.json()),
      fetch(`${WORKER}/api/activation-link?profile_id=${encodeURIComponent(profile_id)}`).then(r => r.json()),
    ]);
    addresses = ar.addresses || [];
    links = lr.links || [];
  } catch {}

  let html = `<button class="btn-generate" id="btnGen">🎲 生成新邮箱地址</button>`;

  // Pending activation links
  if (links.length > 0) {
    html += `<div class="section-title">🔑 激活链接 (${links.length})</div>`;
    for (const l of links) {
      html += `<div class="item">
        <span class="item-text" title="${l.url}">${l.url}</span>
        <button class="btn-copy" data-val="${l.url}">复制</button>
      </div>`;
    }
    html += `<hr class="divider">`;
  }

  // Assigned addresses
  html += `<div class="section-title">📬 可用地址</div>`;
  if (addresses.length === 0) {
    html += `<div class="empty">暂无地址，点上方按钮生成</div>`;
  } else {
    for (const addr of addresses) {
      html += `<div class="item">
        <span class="item-text">${addr}</span>
        <button class="btn-copy" data-val="${addr}">复制</button>
      </div>`;
    }
  }

  main.innerHTML = html;

  // Generate button
  document.getElementById("btnGen").addEventListener("click", async () => {
    const btn = document.getElementById("btnGen");
    btn.disabled = true;
    btn.textContent = "⏳ 生成中...";
    try {
      const res = await fetch(`${WORKER}/api/generate-address`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify({ profile_id }),
      });
      const data = await res.json();
      if (data.address) {
        await copyText(data.address);
        // Activate monitoring for 15 minutes
        await chrome.storage.local.set({ poll_until: Date.now() + 1 * 60 * 1000 });
        showToast(`✓ 已生成并复制：${data.address}`);
        render();
      } else {
        showToast("❌ 生成失败");
        btn.disabled = false;
        btn.textContent = "🎲 生成新邮箱地址";
      }
    } catch {
      showToast("❌ 网络错误");
      btn.disabled = false;
      btn.textContent = "🎲 生成新邮箱地址";
    }
  });

  // Copy buttons
  main.querySelectorAll(".btn-copy").forEach(btn => {
    btn.addEventListener("click", () => copyText(btn.dataset.val));
  });
}

render();
