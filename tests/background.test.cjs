const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
function setup() {
  const state = { settings: { enabled: true, folder: "Reddit ThreadTrail", markdown: true, captureListings: true } };
  const listeners = {}; const downloads = []; const items = new Map();
  const event = name => ({ addListener: callback => { listeners[name] = callback; } });
  const chrome = {
    runtime: { id: "extension-id", getURL: p => `chrome-extension://extension-id/${p}`, onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup") },
    storage: { local: { get: async key => ({ [key]: structuredClone(state[key]) }), set: async value => Object.assign(state, structuredClone(value)) } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create: async () => {}, onAlarm: event("alarm") },
    downloads: { onChanged: event("changed"), show: async () => {}, search: async ({ id }) => items.has(id) ? [items.get(id)] : [], download: async options => {
      if (state.failDownload) throw new Error("Disk unavailable");
      const id = downloads.push(options); items.set(id, { id, state: state.interrupt ? "interrupted" : "complete", ...(state.interrupt ? { error: "FILE_ACCESS_DENIED" } : {}) }); return id;
    } }
  };
  const context = vm.createContext({ chrome, URL, Date, Set, Map, console });
  context.importScripts = filename => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", filename), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  const sender = { id: "extension-id", url: "https://www.reddit.com/r/business/comments/abc123/title/", tab: { id: 1 }, frameId: 0 };
  const ui = { id: "extension-id", url: "chrome-extension://extension-id/popup.html" };
  const snapshot = { schema_version: 1, visit: { id: "visit-12345", started_at: "2026-11-13T12:00:00.000Z" }, captured_at: "2026-11-13T12:00:01.000Z", page: { kind: "thread", url: sender.url, title: "A title" }, thread: { id: "abc123", title: "A title", subreddit: "business", body: "Body" }, comments: [], posts: [] };
  const message = (data, origin = sender) => new Promise(resolve => listeners.message(data, origin, resolve));
  return { state, downloads, items, snapshot, sender, ui, message };
}
test("exports JSON and Markdown, confirms completion, and replaces files on updates", async () => {
  const t = setup();
  assert.equal((await t.message({ type: "CAPTURE", snapshot: t.snapshot })).ok, true);
  assert.equal(t.state.history[0].status, "complete");
  assert.equal(t.downloads.length, 2);
  const firstName = t.downloads[0].filename;
  assert.equal(t.downloads[0].saveAs, false);
  assert.equal(t.downloads[0].conflictAction, "overwrite");
  const json = JSON.parse(decodeURIComponent(t.downloads[0].url.split(",").slice(1).join(",")));
  assert.equal(json.thread.body, "Body");
  t.snapshot.comments.push({ id: "t1_reply", body: "A reply" });
  await t.message({ type: "CAPTURE", snapshot: t.snapshot });
  assert.equal(t.downloads[2].filename, firstName);
  assert.equal(t.state.history.length, 1);
  assert.equal(t.state.history[0].revisions, 2);
});
test("unchanged captures do not create repeated downloads", async () => {
  const t = setup();
  await t.message({ type: "CAPTURE", snapshot: t.snapshot });
  assert.equal((await t.message({ type: "CAPTURE", snapshot: t.snapshot })).skipped, "unchanged");
  assert.equal(t.downloads.length, 2);
});
test("pause and thread-only settings stop automatic saves", async () => {
  const t = setup(); t.state.settings.enabled = false;
  assert.equal((await t.message({ type: "CAPTURE", snapshot: t.snapshot })).skipped, "paused");
  t.state.settings.enabled = true; t.state.settings.captureListings = false;
  t.sender.url = "https://www.reddit.com/r/business/"; t.snapshot.page = { kind: "listing", url: t.sender.url }; t.snapshot.thread = null;
  assert.equal((await t.message({ type: "CAPTURE", snapshot: t.snapshot })).skipped, "listings-disabled");
  assert.equal(t.downloads.length, 0);
});
test("rejects stale pages, other origins, subframes and oversized captures", async () => {
  const t = setup();
  assert.equal((await t.message({ type: "CAPTURE", snapshot: t.snapshot }, { ...t.sender, url: "https://example.org/" })).ok, false);
  assert.equal((await t.message({ type: "CAPTURE", snapshot: t.snapshot }, { ...t.sender, frameId: 1 })).ok, false);
  t.snapshot.thread.id = "other";
  assert.equal((await t.message({ type: "CAPTURE", snapshot: t.snapshot })).ok, false);
  t.snapshot.thread.id = "abc123"; t.snapshot.thread.body = "x".repeat(2_000_001);
  assert.equal((await t.message({ type: "CAPTURE", snapshot: t.snapshot })).ok, false);
  assert.equal(t.downloads.length, 0);
});
test("download failures and interruptions are shown as failed rather than saved", async () => {
  for (const failure of ["failDownload", "interrupt"]) {
    const t = setup(); t.state[failure] = true;
    const result = await t.message({ type: "CAPTURE", snapshot: t.snapshot });
    assert.equal(result.ok, false);
    assert.equal(t.state.history[0].status, "failed");
    assert.ok(t.state.history[0].error);
  }
});
test("settings and index export are restricted to extension UI", async () => {
  const t = setup();
  assert.equal((await t.message({ type: "SETTINGS", patch: { folder: "../escape" } }, t.ui)).ok, false);
  assert.equal((await t.message({ type: "SETTINGS", patch: { enabled: false } })).ok, false);
  assert.equal((await t.message({ type: "SETTINGS", patch: { folder: "Research/Reddit" } }, t.ui)).ok, true);
  assert.equal(t.state.settings.folder, "Research/Reddit");
  assert.equal((await t.message({ type: "STATE" }, { ...t.ui, tab: { id: 5 } })).ok, true);
  await t.message({ type: "EXPORT_INDEX" }, t.ui);
  assert.match(t.downloads[0].filename, /^Research\/Reddit\/visit-index-/);
});
test("new visits are retained independently; destination stays stable within a visit", async () => {
  const t = setup(); await t.message({ type: "CAPTURE", snapshot: t.snapshot });
  t.state.settings.folder = "Changed"; t.state.settings.markdown = false;
  t.snapshot.thread.body = "Changed body"; await t.message({ type: "CAPTURE", snapshot: t.snapshot });
  assert.match(t.downloads[2].filename, /^Reddit ThreadTrail\//);
  assert.equal(t.downloads.length, 4);
  t.snapshot.visit.id = "visit-67890"; await t.message({ type: "CAPTURE", snapshot: t.snapshot });
  assert.equal(t.state.history.length, 2);
  assert.match(t.downloads[4].filename, /^Changed\//);
  assert.equal(t.downloads.length, 5);
});
test("SPA captures validate against the current tab URL, not the initial document URL", async () => {
  const t = setup();
  t.sender.tab.url = "https://www.reddit.com/r/business/";
  t.snapshot.page = { kind: "listing", url: t.sender.tab.url, title: "Business" };
  t.snapshot.thread = null;
  assert.equal((await t.message({ type: "CAPTURE", snapshot: t.snapshot })).ok, true);
  assert.equal(t.state.history[0].kind, "listing");
  t.sender.tab.url = "https://www.reddit.com/message/inbox/";
  assert.equal((await t.message({ type: "CAPTURE", snapshot: t.snapshot })).ok, false);
});
