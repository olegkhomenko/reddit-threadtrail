"use strict";
const $ = id => document.getElementById(id);
const isOptions = document.body.classList.contains("options");
let currentSettings = RedditDump.settings();
let activeTab = null;
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "The extension could not complete that action.");
  return result;
}
function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").hidden = false;
  $("notice").classList.toggle("error", error);
}
async function act(button, task) {
  button.disabled = true;
  try { await task(); } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
}
function renderHistory(history) {
  $("count").textContent = `${history.length} visits`;
  $("history").replaceChildren();
  $("empty").hidden = history.length > 0;
  for (const item of history.slice(0, 5)) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = `entry-dot ${item.status}`;
    dot.title = item.status;
    const body = document.createElement("div");
    body.className = "entry-body";
    const link = document.createElement("a");
    link.textContent = item.title || item.url;
    // Stored links originate in the content script; still restrict navigation to Reddit.
    link.href = RedditDump.pageInfo(item.url)?.url || "https://www.reddit.com/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const meta = document.createElement("p");
    const date = new Date(item.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    meta.textContent = `${date} · ${item.kind === "thread" ? `${item.comments} comments` : `${item.posts} posts`} · ${item.status === "complete" ? "Saved" : item.status === "failed" ? "Failed" : "Saving…"}`;
    body.append(link, meta);
    if (item.error) {
      const error = document.createElement("p"); error.className = "error"; error.textContent = item.error; body.append(error);
    }
    const reveal = document.createElement("button");
    reveal.className = "reveal"; reveal.textContent = "↗"; reveal.title = "Show file in folder"; reveal.setAttribute("aria-label", `Show saved file: ${item.title}`);
    reveal.disabled = item.status !== "complete";
    reveal.addEventListener("click", () => act(reveal, () => request({ type: "SHOW_FILE", id: item.id })));
    li.append(dot, body, reveal); $("history").append(li);
  }
}
function render(settings, history) {
  currentSettings = settings;
  if (isOptions) return;
  $("status").textContent = settings.enabled ? "Recording" : "Paused";
  $("status").classList.toggle("paused", !settings.enabled);
  $("toggle").textContent = settings.enabled ? "Pause" : "Resume";
  $("capture").disabled = !settings.enabled;
  $("folder").textContent = `Downloads / ${settings.folder}`;
  renderHistory(history);
}
async function load() {
  const result = await request({ type: "STATE" });
  render(result.settings, result.history);
  if (isOptions) {
    $("destination").value = result.settings.folder;
    for (const key of ["enabled", "markdown", "captureListings"]) $(key).checked = result.settings[key];
    return;
  }
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const page = await chrome.tabs.sendMessage(activeTab.id, { type: "PAGE_STATUS" });
    $("pageStatus").textContent = page.lastError || (page.supported ? "Ready here. Loaded content is captured automatically." : "Open a Reddit thread, feed or search page to capture.");
  } catch {
    $("pageStatus").textContent = "Open a Reddit page, or reload a tab opened before installation.";
  }
}
$("export").addEventListener("click", () => act($("export"), async () => {
  await request({ type: "EXPORT_INDEX" });
  notice("Visit index sent to Downloads. It includes the most recent 200 visits; your page files remain in the archive.");
}));
if (isOptions) {
  $("settingsForm").addEventListener("submit", event => {
    event.preventDefault();
    void act(event.submitter, async () => {
      const patch = { folder: RedditDump.validateFolder($("destination").value) };
      for (const key of ["enabled", "markdown", "captureListings"]) patch[key] = $(key).checked;
      await request({ type: "SETTINGS", patch });
      notice("Settings saved. Folder and format changes apply to new visits.");
    });
  });
} else {
  $("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("toggle").addEventListener("click", () => act($("toggle"), async () => {
    await request({ type: "SETTINGS", patch: { enabled: !currentSettings.enabled } });
    await load();
  }));
  $("capture").addEventListener("click", () => act($("capture"), async () => {
    if (!activeTab) throw new Error("Open a Reddit page first.");
    let response;
    try { response = await chrome.tabs.sendMessage(activeTab.id, { type: "CAPTURE_NOW" }); }
    catch { throw new Error("Open a Reddit page, or reload it if it was open before installation."); }
    if (!response?.ok) throw new Error(response?.error || "Capture failed.");
    if (response.skipped) notice("A capture is already in progress. Check recent captures in a moment.");
    else notice("Capture sent to Downloads. Its status appears in recent captures.");
    await load();
  }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.history || changes.settings)) request({ type: "STATE" }).then(result => render(result.settings, result.history)).catch(error => notice(error.message, true));
  });
}
load().catch(error => notice(error.message, true));
