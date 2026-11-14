"use strict";
importScripts("common.js");
const D = RedditDump;
let queue = Promise.resolve();
function serial(task) {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}
const getSettings = async () => D.settings((await chrome.storage.local.get("settings")).settings);
const getHistory = async () => (await chrome.storage.local.get("history")).history || [];
const isUI = sender => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(""));
async function badge(error = false) {
  const settings = await getSettings();
  await chrome.action.setBadgeBackgroundColor({ color: error ? "#b33a29" : "#276b53" });
  await chrome.action.setBadgeText({ text: error ? "!" : settings.enabled ? "" : "OFF" });
}
function validateSnapshot(snapshot, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) throw new Error("Capture must come from a Reddit tab.");
  // Chromium keeps sender.url at the document's original address after pushState.
  // sender.tab.url reflects the current top-level address without a tabs permission.
  const info = D.pageInfo(sender.tab.url || sender.url);
  const captured = D.pageInfo(snapshot?.page?.url);
  if (!info || !captured || info.url !== captured.url) throw new Error("The tab navigated before capture. Please try again.");
  if (snapshot.schema_version !== 1 || !/^[a-zA-Z0-9_-]{8,80}$/.test(snapshot.visit?.id || "") || !/^\d{4}-\d\d-\d\dT/.test(snapshot.visit?.started_at || "") || !Number.isFinite(Date.parse(snapshot.visit.started_at)) || !Array.isArray(snapshot.comments) || !Array.isArray(snapshot.posts)) throw new Error("Invalid capture.");
  if (info.kind === "thread" && snapshot.thread?.id !== info.threadId) throw new Error("The loaded post does not match this URL.");
  if (JSON.stringify(snapshot).length > 2_000_000) throw new Error("This capture exceeds the 2 MB safety limit. Open a smaller comment branch and capture again.");
  return info;
}
async function download(text, type, filename) {
  return chrome.downloads.download({ url: `data:${type};charset=utf-8,${encodeURIComponent(text)}`, filename, conflictAction: "overwrite", saveAs: false });
}
async function save(snapshot, sender, force) {
  const info = validateSnapshot(snapshot, sender);
  const settings = await getSettings();
  if (!settings.enabled) return { ok: true, skipped: "paused" };
  if (info.kind !== "thread" && !settings.captureListings) return { ok: true, skipped: "listings-disabled" };
  const history = await reconcile();
  let record = history.find(x => x.id === snapshot.visit.id);
  if (record?.status === "saving") return { ok: true, skipped: "saving" };
  const fingerprint = D.fingerprint(snapshot);
  if (!force && record?.fingerprint === fingerprint && record.status === "complete") return { ok: true, skipped: "unchanged" };
  // Preserve destination and formats for the lifetime of a visit, so updates replace its files.
  const base = record?.base || D.fileBase(snapshot, settings.folder);
  const formats = record?.formats || (settings.markdown ? ["json", "md"] : ["json"]);
  const now = new Date().toISOString();
  record = {
    ...record, id: snapshot.visit.id, base, formats, fingerprint,
    title: snapshot.thread?.title || snapshot.page.title, url: info.url, kind: info.kind,
    started_at: snapshot.visit.started_at, captured_at: snapshot.captured_at,
    comments: snapshot.comments.length, posts: snapshot.posts.length,
    revisions: (record?.revisions || 0) + 1, updated_at: now, status: "saving", error: null, downloads: []
  };
  const next = [record, ...history.filter(x => x.id !== record.id)].slice(0, 200);
  await chrome.storage.local.set({ history: next });
  try {
    for (const format of formats) {
      const filename = `${base}.${format}`;
      const data = format === "json" ? `${JSON.stringify(snapshot, null, 2)}\n` : D.markdown(snapshot);
      const id = await download(data, format === "json" ? "application/json" : "text/markdown", filename);
      record.downloads.push({ id, filename, state: "in_progress", error: null });
      await chrome.storage.local.set({ history: next });
    }
    // A small local download can finish before its ID has been persisted.
    await reconcile(next);
    await badge(record.status === "failed");
    return record.status === "failed" ? { ok: false, error: record.error } : { ok: true, status: record.status, filename: `${base}.json` };
  } catch (error) {
    record.status = "failed";
    record.error = error.message;
    await chrome.storage.local.set({ history: next });
    await badge(true);
    return { ok: false, error: error.message };
  }
}
async function reconcile(history = null) {
  history ||= await getHistory();
  let changed = false;
  for (const record of history.filter(x => x.status === "saving")) {
    for (const item of record.downloads) {
      if (item.state !== "in_progress") continue;
      const [found] = await chrome.downloads.search({ id: item.id });
      const state = found?.state || "interrupted";
      const error = found?.error || (!found ? "Download is no longer available." : null);
      if (item.state !== state || item.error !== error) changed = true;
      item.state = state;
      item.error = error;
    }
    if (record.downloads.some(x => x.state === "interrupted")) {
      record.status = "failed";
      record.error = record.downloads.find(x => x.error)?.error || "Download interrupted.";
      changed = true;
    } else if (record.downloads.length === record.formats.length && record.downloads.every(x => x.state === "complete")) {
      record.status = "complete";
      changed = true;
    } else if (Date.now() - Date.parse(record.updated_at) > 120_000) {
      record.status = "failed";
      record.error = "Capture was interrupted. Reopen the page or use Capture now to retry.";
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ history });
  return history;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const task = async () => {
    if (message.type === "CAPTURE") return save(message.snapshot, sender, message.force === true);
    if (!isUI(sender)) throw new Error("This action is available only in Reddit ThreadTrail.");
    if (message.type === "STATE") return { ok: true, settings: await getSettings(), history: await reconcile() };
    if (message.type === "SETTINGS") {
      const current = await getSettings();
      const patch = message.patch || {};
      if ("folder" in patch) D.validateFolder(patch.folder);
      const value = D.settings({ ...current, ...patch });
      await chrome.storage.local.set({ settings: value });
      await badge();
      return { ok: true, settings: value };
    }
    if (message.type === "EXPORT_INDEX") {
      const history = await reconcile();
      const id = await download(`${JSON.stringify({ schema_version: 1, exported_at: new Date().toISOString(), note: "Most recent 200 visits in this browser; paths are relative to Downloads.", visits: history }, null, 2)}\n`, "application/json", `${(await getSettings()).folder}/visit-index-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      return { ok: true, id };
    }
    if (message.type === "SHOW_FILE") {
      const record = (await getHistory()).find(x => x.id === message.id);
      const item = record?.downloads.find(x => x.state === "complete");
      if (!item) throw new Error("No completed download for this visit yet.");
      await chrome.downloads.show(item.id);
      return { ok: true };
    }
    throw new Error("Unknown action.");
  };
  serial(task).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state || delta.error) serial(async () => {
    const history = await reconcile();
    await badge(history.some(x => x.status === "failed"));
  });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "reconcile") serial(() => reconcile());
});
chrome.runtime.onInstalled.addListener(() => serial(async () => {
  await chrome.storage.local.set({ settings: await getSettings() });
  await chrome.alarms.create("reconcile", { periodInMinutes: 1 });
  await badge();
}));
chrome.runtime.onStartup.addListener(() => serial(async () => {
  await chrome.alarms.create("reconcile", { periodInMinutes: 1 });
  const history = await reconcile();
  await badge(history.some(x => x.status === "failed"));
}));
