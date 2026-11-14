// End-to-end tests in an isolated Chromium profile. All Reddit responses are synthetic.
// No npm dependencies. Requires Node 22+ and Brave or Chromium with --load-extension support.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "tests/artifacts");
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), "reddit-dump-test-"));
const downloads = path.join(profile, "downloads");
await mkdir(downloads);
await mkdir(path.join(profile, "Default"));
await writeFile(path.join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
const binary = process.env.CHROMIUM_BINARY || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const browser = spawn(binary, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--disable-extensions-except=${root}`, `--load-extension=${root}`, "--host-resolver-rules=MAP * ~NOTFOUND", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket; let diagnostic = ""; let debugState = async () => {};
async function waitFor(check, label, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await check(); if (result) return result; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Browser did not start. ${diagnostic.slice(-1200)}`)), 15_000);
    browser.stderr.on("data", chunk => { diagnostic += chunk; const match = diagnostic.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    browser.once("error", reject);
    browser.once("exit", code => { clearTimeout(timer); reject(new Error(`Browser exited ${code}. ${diagnostic.slice(-1500)}`)); });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map(); const events = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const task = pending.get(message.id); if (!task) return; pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result); }
    else for (const handler of events.get(message.method) || []) handler(message.params, message.sessionId);
  };
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async function attach(targetId) { return (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId; }
  async function evaluate(session, expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  // Use real browser preferences: CDP's "allow" download override discards the
  // filenames supplied by chrome.downloads and collapses all JSON into download.json.
  const worker = await waitFor(async () => (await send("Target.getTargets")).targetInfos.find(t => t.type === "service_worker" && t.url.endsWith("/background.js")), "extension service worker");
  const extensionId = new URL(worker.url).host;
  const workerSession = await attach(worker.targetId);
  await evaluate(workerSession, "globalThis.__testSenders=[]; chrome.runtime.onMessage.addListener((m,s)=>{__testSenders.push({type:m.type,url:s.url,tabUrl:s.tab?.url,page:m.snapshot?.page?.url})})");
  debugState = async () => {
    console.error(JSON.stringify(await evaluate(workerSession, "Promise.all([chrome.storage.local.get(null),chrome.tabs.query({}),Promise.resolve(__testSenders),chrome.downloads.search({limit:20}).then(items=>items.map(({id,filename,state,error})=>({id,filename,state,error})))]).then(([storage,tabs,senders,downloads])=>({storage,tabs,senders,downloads}))"), null, 2));
    console.error("Files on disk:", await readdir(downloads, { recursive: true }));
  };
  const page = await send("Target.createTarget", { url: "about:blank" });
  const session = await attach(page.targetId);
  await send("Page.enable", {}, session);
  const modern = await readFile(path.join(root, "tests/fixtures/modern.html"), "utf8");
  const old = await readFile(path.join(root, "tests/fixtures/old.html"), "utf8");
  const intercepted = [];
  events.set("Fetch.requestPaused", [async (params, eventSession) => {
    if (eventSession !== session) return;
    intercepted.push(params.request.url);
    const body = params.request.url.includes("old123") ? old : modern;
    try {
      if (params.resourceType === "Document") await send("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: Buffer.from(body).toString("base64") }, session);
      else await send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, session);
    } catch { /* Target may have closed. */ }
  }]);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, session);
  async function history() { return evaluate(workerSession, "chrome.storage.local.get('history').then(x => x.history || [])"); }
  async function jsonFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    return (await Promise.all(entries.map(e => e.isDirectory() ? jsonFiles(path.join(dir, e.name)) : e.name.endsWith(".json") ? [path.join(dir, e.name)] : []))).flat();
  }
  const firstUrl = "https://www.reddit.com/r/business/comments/abc123/validate/";
  await send("Page.navigate", { url: firstUrl }, session);
  await waitFor(async () => (await history())[0]?.status === "complete", "first automatic export");
  let files = await jsonFiles(downloads); assert.equal(files.length, 1);
  let capture = JSON.parse(await readFile(files[0], "utf8"));
  assert.equal(capture.thread.title, "How do you validate a business idea?");
  assert.equal(capture.thread.link, null);
  assert.equal(capture.thread.author, "founder");
  assert.equal(capture.thread.links[0], "https://example.com/research");
  assert.equal(capture.comments.length, 3);
  assert.equal(capture.comments[0].body, "Start with customer interviews.");
  assert.equal(capture.comments[1].parent_id, "t1_comment1");
  assert.equal(capture.comments[2].body_loaded, false);
  assert.equal(capture.coverage.complete_thread, false);
  console.log("PASS: automatic export from a rendered modern Reddit thread, with structured nested comments");

  const redditTab = await evaluate(workerSession, "chrome.tabs.query({}).then(tabs => tabs.find(t => t.url?.includes('/abc123/'))?.id)");
  // The worker has Reddit content-script site access but no general browser history permission.
  const tabId = redditTab || await evaluate(workerSession, "chrome.tabs.query({}).then(tabs => tabs.filter(t => !t.url?.startsWith('chrome-extension:')).at(-1).id)");
  await evaluate(session, `document.querySelector('[thingid="t1_unloaded"]').innerHTML = '<div slot="comment">An expanded comment.</div>'; document.querySelector('[thingid="t1_comment1"] > [slot="comment"]').remove();`);
  const manual = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId}, {type:'CAPTURE_NOW'})`);
  assert.equal(manual.ok, true);
  await waitFor(async () => (await history())[0]?.status === "complete", "updated export");
  files = await jsonFiles(downloads); assert.equal(files.length, 1, "updates overwrite the visit rather than adding files");
  capture = JSON.parse(await readFile(files[0], "utf8"));
  assert.equal(capture.comments[2].body, "An expanded comment.");
  assert.equal(capture.comments[0].body, "Start with customer interviews.");
  console.log("PASS: expanding and collapsing comments updates the same file without losing observed content");

  // A real scroll reaches the bottom before Reddit's delayed comment batch arrives.
  // The batch pushes the bottom below the viewport, so a second scroll is not available.
  const beforeBottom = (await history())[0];
  const bottomStarted = Date.now();
  await evaluate(session, `const spacer=document.createElement('div'); spacer.style.height='2400px'; document.body.append(spacer); window.scrollTo(0, document.scrollingElement.scrollHeight);`);
  await waitFor(() => evaluate(session, "document.scrollingElement.scrollTop > 1000"), "scroll to the bottom");
  await pause(1100);
  assert.equal((await history())[0].revisions, beforeBottom.revisions, "scrolling without new content does not re-download");
  await evaluate(session, `const late=document.createElement('shreddit-comment'); late.setAttribute('thingid','t1_late1'); late.setAttribute('parentid','t3_abc123'); late.setAttribute('author','late_buyer'); late.style.cssText='display:block;min-height:900px'; late.innerHTML='<div slot="comment">A comment loaded after reaching the bottom.</div>'; document.body.append(late);`);
  assert.ok(await evaluate(session, "document.scrollingElement.scrollHeight-document.scrollingElement.scrollTop-document.scrollingElement.clientHeight > 120"), "new comments move the bottom away");
  await waitFor(async () => { const entry=(await history())[0]; return entry.comments === 4 && entry.status === "complete"; }, "automatic bottom-triggered re-save", 8000);
  assert.ok(Date.now()-bottomStarted < 15_000, "bottom-triggered updates bypass the normal 20-second interval");
  capture = JSON.parse(await readFile(files[0], "utf8"));
  assert.equal(capture.visit.id, beforeBottom.id);
  assert.equal(capture.comments.at(-1).body, "A comment loaded after reaching the bottom.");
  await evaluate(session, `const later=document.createElement('shreddit-comment'); later.setAttribute('thingid','t1_late2'); later.setAttribute('parentid','t1_late1'); later.innerHTML='<div slot="comment">A second delayed batch.</div>'; document.body.append(later);`);
  await waitFor(async () => { const entry=(await history())[0]; return entry.comments === 5 && entry.status === "complete"; }, "second delayed comment batch", 8000);
  assert.equal((await jsonFiles(downloads)).length, 1, "bottom-triggered updates keep the same visit file");
  capture = JSON.parse(await readFile(files[0], "utf8"));
  assert.equal(capture.comments.length, 5);
  console.log("PASS: scrolling to the bottom re-saves delayed comment batches into the same file, without duplicate unchanged exports");

  // Stay in the same document and navigate as Reddit's SPA does.
  await evaluate(session, `history.pushState({}, '', '/r/business/'); document.title='Business feed';`);
  await waitFor(async () => (await history()).some(x => x.kind === "listing" && x.status === "complete"), "SPA feed navigation");
  await waitFor(async () => (await jsonFiles(downloads)).length === 2, "feed file on disk");
  await evaluate(session, `history.pushState({}, '', ${JSON.stringify(new URL(firstUrl).pathname)});`);
  await waitFor(async () => (await history()).filter(x => x.kind === "thread" && x.status === "complete").length === 2, "return visit");
  await waitFor(async () => (await jsonFiles(downloads)).length === 3, "return-visit file on disk");
  console.log("PASS: SPA navigation captures feeds and creates separate files for return visits");

  await send("Page.navigate", { url: "https://old.reddit.com/r/smallbusiness/comments/old123/shop/" }, session);
  await waitFor(async () => (await history()).some(x => x.url.includes("old123") && x.status === "complete"), "Old Reddit export");
  files = await jsonFiles(downloads);
  const oldFile = files.find(f => f.includes("old123"));
  const oldCapture = JSON.parse(await readFile(oldFile, "utf8"));
  assert.equal(oldCapture.thread.body, "Build what people need.");
  assert.equal(oldCapture.comments[0].body, "Repeat customers matter.");
  assert.equal(oldCapture.comments[0].score, 1200);
  assert.equal(oldCapture.comments[1].parent_id, "t1_oldcomment");
  console.log("PASS: Old Reddit extraction and approximate scores");

  const uiTarget = await send("Target.createTarget", { url: `chrome-extension://${extensionId}/options.html` });
  const uiSession = await attach(uiTarget.targetId);
  await waitFor(() => evaluate(uiSession, "document.getElementById('destination')?.value === 'Reddit ThreadTrail'"), "options UI");
  await send("Emulation.setDeviceMetricsOverride", { width: 980, height: 1160, deviceScaleFactor: 1, mobile: false }, uiSession);
  await evaluate(uiSession, "document.getElementById('destination').value='Research/Reddit'; document.getElementById('markdown').checked=true; document.getElementById('settingsForm').requestSubmit(document.querySelector('[type=submit]'))");
  await waitFor(() => evaluate(workerSession, "chrome.storage.local.get('settings').then(x => x.settings.folder === 'Research/Reddit' && x.settings.markdown)"), "saving options");
  const optionsScreenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, uiSession);
  await writeFile(path.join(artifacts, "options.png"), Buffer.from(optionsScreenshot.data, "base64"));
  const popupTarget = await send("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
  const popupSession = await attach(popupTarget.targetId);
  await waitFor(() => evaluate(popupSession, "document.querySelectorAll('#history li').length === 4"), "popup history");
  await send("Emulation.setDeviceMetricsOverride", { width: 410, height: 850, deviceScaleFactor: 2, mobile: false }, popupSession);
  const popupScreenshot = await send("Page.captureScreenshot", { format: "png" }, popupSession);
  await writeFile(path.join(artifacts, "popup.png"), Buffer.from(popupScreenshot.data, "base64"));
  // Pause through the actual UI and verify the persisted state.
  await evaluate(popupSession, "document.getElementById('toggle').click()");
  await waitFor(() => evaluate(workerSession, "chrome.storage.local.get('settings').then(x => !x.settings.enabled)"), "pause toggle");
  const before = (await history()).length;
  await send("Page.navigate", { url: firstUrl }, session);
  await send("Page.bringToFront", {}, session);
  await pause(2500);
  assert.equal((await history()).length, before, "paused browsing creates no export");
  console.log("PASS: options save, popup history and pause behavior through real extension APIs");

  await evaluate(popupSession, "document.getElementById('toggle').click()");
  await waitFor(async () => (await history()).length === before + 1 && (await history())[0].status === "complete", "resume capture");
  const latest = (await history())[0];
  assert.equal(latest.formats.length, 2);
  assert.ok(latest.base.startsWith("Research/Reddit/"));
  for (const item of latest.downloads) assert.ok((await readFile(path.join(downloads, item.filename))).length > 0);
  const resumedCount = (await history()).length;
  await send("Page.navigate", { url: "https://www.reddit.com/message/inbox/" }, session);
  await pause(2500);
  assert.equal((await history()).length, resumedCount);
  console.log("PASS: resume, Markdown export, custom destination and private-page exclusion");
  assert.equal(intercepted.filter(u => !u.includes("reddit.com")).length, 0);
  await writeFile(path.join(artifacts, "example-thread.json"), JSON.stringify(capture, null, 2));
  console.log(`All browser tests passed. Screenshots: ${artifacts}`);
} catch (error) {
  console.error(error);
  await debugState().catch(() => {});
  process.exitCode = 1;
} finally {
  if (socket) socket.close();
  browser.kill("SIGTERM");
  await Promise.race([new Promise(resolve => browser.once("exit", resolve)), pause(2500)]);
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
