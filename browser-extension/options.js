const input = document.getElementById("pid");
const saved = document.getElementById("saved");

chrome.storage.local.get("profile_id", ({ profile_id }) => {
  if (profile_id) input.value = profile_id;
});

document.getElementById("save").addEventListener("click", () => {
  const val = input.value.trim();
  if (!val) return;
  chrome.storage.local.set({ profile_id: val }, () => {
    saved.style.display = "block";
    setTimeout(() => { saved.style.display = "none"; }, 2000);
  });
});
