// Render deterministic HTML animation frames in Chromium, then encode a looping GIF.
// Requires Node 22+, Chromium and ffmpeg. Uses a disposable profile and no network.
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "threadtrail-animation-"));
const frames = path.join(temporary, "frames");
await mkdir(frames);
const artifacts = path.join(root, "tests/artifacts");
await mkdir(artifacts, { recursive: true });
const binary = process.env.CHROMIUM_BINARY || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"
].find(existsSync);
if (!binary) throw new Error("Set CHROMIUM_BINARY to a Chromium executable.");
const browser = spawn(binary, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--host-resolver-rules=MAP * ~NOTFOUND", "--remote-debugging-port=0",
  `--user-data-dir=${path.join(temporary, "profile")}`, "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Chromium startup timed out")), 15000);
    browser.stderr.on("data", data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    browser.once("error", error => { clearTimeout(timer); reject(error); });
    browser.once("exit", code => { clearTimeout(timer); reject(new Error(`Chromium exited ${code}: ${output.slice(-1000)}`)); });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map();
  let nextId = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
  };
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: `${new URL("../docs/how-it-works.html", import.meta.url).href}?capture` }, sessionId);
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  let loaded = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("typeof window.renderDiagram === 'function'")) { loaded = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!loaded) throw new Error("Diagram did not initialize.");
  await evaluate("document.fonts.ready.then(() => true)");
  const fps = 15;
  const count = Math.round(await evaluate("window.diagramDuration") / 1000 * fps);
  const samples = new Map([[0, "diagram-step-1.png"], [45, "diagram-step-3.png"], [112, "diagram-step-5.png"]]);
  for (let frame = 0; frame < count; frame++) {
    await evaluate(`window.renderDiagram(${frame * 1000 / fps}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    const file = path.join(frames, `${String(frame).padStart(4, "0")}.png`);
    await writeFile(file, Buffer.from(result.data, "base64"));
    if (samples.has(frame)) await copyFile(file, path.join(artifacts, samples.get(frame)));
    if (frame % 30 === 0) console.log(`Rendered ${frame}/${count} frames`);
  }
  const output = path.join(root, "docs/how-it-works.gif");
  await new Promise((resolve, reject) => {
    const encoder = spawn("ffmpeg", [
      "-y", "-v", "error", "-framerate", String(fps), "-i", path.join(frames, "%04d.png"),
      "-filter_complex", "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
      "-loop", "0", "-gifflags", "+transdiff", output
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    encoder.stderr.on("data", data => { errorText += data; });
    encoder.once("error", reject);
    encoder.once("exit", code => code === 0 ? resolve() : reject(new Error(errorText)));
  });
  console.log(output);
} finally {
  if (socket) socket.close();
  browser.kill("SIGTERM");
  await Promise.race([
    browser.exitCode !== null || browser.signalCode !== null ? Promise.resolve() : new Promise(resolve => browser.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 2500))
  ]);
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
