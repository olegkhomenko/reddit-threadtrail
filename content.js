/* Passive observer: no fetch, scrolling, link following or simulated clicks. */
(() => {
  "use strict";
  const D = RedditDump;
  const E = RedditDumpExtractor;
  let settings = D.settings();
  let visit = null;
  let accumulated = null;
  let lastFingerprint = null;
  let lastSave = 0;
  let timer = null;
  let busy = false;
  let lastError = null;
  let visibleVisit = false;
  let dirty = true;
  let bottomWatchUntil = 0;
  let bottomTimer = null;
  function reset(info) {
    visit = info ? { id: crypto.randomUUID(), started_at: new Date().toISOString(), url: info.url } : null;
    accumulated = null;
    lastFingerprint = null;
    lastSave = 0;
    lastError = null;
    visibleVisit = document.visibilityState === "visible";
    dirty = true;
    bottomWatchUntil = 0;
    clearTimeout(bottomTimer);
    bottomTimer = null;
  }
  function infoNow() {
    const info = D.pageInfo(location.href);
    if (info?.url !== visit?.url) reset(info);
    return info;
  }
  async function capture(force = false, final = false, bottomUpdate = false) {
    const info = infoNow();
    if (!info) return { ok: false, error: "Open a Reddit thread, feed or search page." };
    if (!settings.enabled) return { ok: false, error: "Capture is paused. Resume it first." };
    if (info.kind !== "thread" && !settings.captureListings) return { ok: false, error: "Feed and search capture is turned off in settings." };
    if (busy) return { ok: true, skipped: "busy" };
    if (!force && !final && document.visibilityState !== "visible") return { ok: true, skipped: "hidden" };
    if (!force && !final && !bottomUpdate && Date.now() - lastSave < 20_000) return { ok: true, skipped: "throttled" };
    if (!visibleVisit && document.visibilityState !== "visible") return { ok: true, skipped: true };
    visibleVisit = true;
    const current = E.extract(document, location.href);
    if (!current) return { ok: false, error: "No loaded Reddit content found yet. Wait for the page to finish loading." };
    accumulated = E.merge(accumulated, current);
    const snapshot = {
      schema_version: 1, source: "reddit-dump", captured_at: new Date().toISOString(),
      visit: { id: visit.id, started_at: visit.started_at },
      ...accumulated,
      coverage: { mode: "loaded_dom_only", complete_thread: false, comments_cumulative_within_visit: true, media_files_downloaded: false, note: "Only browser-loaded content. Counts may be approximate; missing fields are null. No background requests or automatic expansion." }
    };
    const fingerprint = D.fingerprint(snapshot);
    if (!force && fingerprint === lastFingerprint) { dirty = false; return { ok: true, skipped: "unchanged" }; }
    busy = true;
    const activeVisit = visit.id;
    try {
      const response = await chrome.runtime.sendMessage({ type: "CAPTURE", snapshot, force });
      if (activeVisit === visit?.id) {
        if (!response?.ok) throw new Error(response?.error || "Capture failed.");
        if (!response.skipped) { lastFingerprint = fingerprint; lastSave = Date.now(); }
        lastError = null;
        // A mutation during the download will be picked up by the next scheduled pass.
      }
      return response;
    } catch (error) {
      lastError = error.message;
      return { ok: false, error: error.message };
    } finally { busy = false; }
  }
  function scheduleBottomCapture() {
    if (bottomTimer || Date.now() > bottomWatchUntil || document.visibilityState !== "visible" || !settings.enabled) return;
    bottomTimer = setTimeout(async () => {
      bottomTimer = null;
      if (infoNow()?.kind !== "thread" || Date.now() > bottomWatchUntil) return;
      // Bypass the normal interval, while still deduplicating unchanged content.
      const result = await capture(false, false, true);
      if (result?.skipped === "busy" || result?.skipped === "saving") scheduleBottomCapture();
    }, 750);
  }
  function onScroll(event) {
    if (!settings.enabled || document.visibilityState !== "visible" || infoNow()?.kind !== "thread") return;
    const scroller = event.target === document ? document.scrollingElement : event.target;
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 120) return;
    // Loaded comments can push the bottom away without another scroll event.
    bottomWatchUntil = Date.now() + 15_000;
    scheduleBottomCapture();
  }
  function schedule() {
    dirty = true;
    scheduleBottomCapture();
    if (!timer) timer = setTimeout(() => { timer = null; void capture(); }, 1200);
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "CAPTURE_NOW") { capture(true).then(respond); return true; }
    if (message.type === "PAGE_STATUS") {
      respond({ ok: true, supported: Boolean(infoNow()), comments: accumulated?.comments.length || 0, lastError, lastSave });
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      settings = D.settings(changes.settings.newValue);
      dirty = true;
      if (settings.enabled) { lastFingerprint = null; lastSave = 0; schedule(); }
    }
  });
  chrome.storage.local.get("settings").then(value => {
    settings = D.settings(value.settings);
    reset(D.pageInfo(location.href));
    new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["score", "post-title", "author", "comment-count", "src", "href"] });
    schedule();
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    // Also detects pushState navigation; no code is injected into Reddit's page world.
    setInterval(() => { infoNow(); if (dirty) void capture(); }, 2000);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { if (visibleVisit) void capture(false, true); }
    else { visibleVisit = true; schedule(); }
  });
  window.addEventListener("pagehide", () => { if (visibleVisit) void capture(false, true); });
})();
