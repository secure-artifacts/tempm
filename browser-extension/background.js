const WORKER = "https://temp-mail-worker.YOUR_SUBDOMAIN.workers.dev";
const POLL_INTERVAL_MS = 30 * 1000;   // setInterval: every 30s
const POLL_TIMEOUT_MS  = 2 * 60 * 1000; // monitoring window: 2 min
const DEBOUNCE_MS      = 10 * 1000;   // ignore duplicate calls within 10s

let lastPollAt = 0;
let intervalId = null;

// Start 30s interval — called on every service worker wake
function startInterval() {
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(poll, POLL_INTERVAL_MS);
}

// Alarm: 1 min fallback — wakes suspended service worker + restarts interval
chrome.alarms.create("poll-fallback", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === "poll-fallback") {
    startInterval(); // restart setInterval after wake-up
    poll();
  }
});

// Start immediately on service worker init
startInterval();
poll();

async function poll() {
  const now = Date.now();
  if (now - lastPollAt < DEBOUNCE_MS) return; // deduplicate
  lastPollAt = now;

  const { profile_id, poll_until } = await chrome.storage.local.get(["profile_id", "poll_until"]);
  if (!poll_until || now > poll_until) return; // not active
  if (!profile_id) return;

  let data;
  try {
    const res = await fetch(`${WORKER}/api/activation-link?profile_id=${encodeURIComponent(profile_id)}`);
    if (!res.ok) return;
    data = await res.json();
  } catch { return; }

  const links = data.links || [];
  if (links.length > 0) {
    for (const link of links) {
      chrome.tabs.create({ url: link.url });
      fetch(`${WORKER}/api/activation-link/${link.id}/consume`, { method: "POST" }).catch(() => {});
    }
    chrome.storage.local.remove("poll_until"); // stop monitoring
  }
}
