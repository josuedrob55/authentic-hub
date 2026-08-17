const STORAGE_KEY = "authenticHubSessionCount";
const countEl = document.getElementById("count");
const resetBtn = document.getElementById("reset");

function render() {
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    countEl.textContent = res[STORAGE_KEY] || 0;
  });
}

resetBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RESET_COUNT" }, () => render());
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) render();
});

render();