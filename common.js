/* Shared by the service worker, content script, UI and tests. */
(function (root) {
  "use strict";
  const DEFAULTS = Object.freeze({ enabled: true, folder: "Reddit ThreadTrail", markdown: false, captureListings: true });
  const HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "sh.reddit.com", "m.reddit.com"]);
  function pageInfo(raw) {
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.port) return null;
    const path = url.pathname.replace(/\/{2,}/g, "/");
    const match = path.match(/^\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i);
    let kind = match ? "thread" : null;
    if (!kind && (/^\/(?:|hot\/?|new\/?|top\/?|rising\/?|best\/?)$/.test(path) || /^\/r\/[^/]+(?:\/(?:hot\/?|new\/?|top\/?|rising\/?)?)?$/.test(path))) kind = "listing";
    if (!kind && /^\/(?:r\/[^/]+\/)?search\/?$/.test(path)) kind = "search";
    if (!kind) return null;
    const clean = new URL(path, "https://www.reddit.com");
    for (const key of ["q", "sort", "t", "restrict_sr", "context", "depth", "show"]) {
      if (url.searchParams.has(key)) clean.searchParams.set(key, url.searchParams.get(key));
    }
    return { kind, threadId: match?.[1]?.toLowerCase() || null, url: clean.href };
  }
  function validateFolder(value) {
    const folder = String(value ?? "").trim().replace(/\\/g, "/");
    if (!folder || folder.length > 160 || folder.startsWith("/") || folder.split("/").some(p => !p || p === "." || p === ".." || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
      throw new Error("Use a relative folder such as Reddit ThreadTrail or Research/Reddit. Avoid .. and special characters.");
    }
    return folder;
  }
  function settings(value = {}) {
    const result = { ...DEFAULTS };
    for (const key of ["enabled", "markdown", "captureListings"]) if (typeof value[key] === "boolean") result[key] = value[key];
    try { result.folder = validateFolder(value.folder ?? DEFAULTS.folder); } catch { /* Safe default for corrupted storage. */ }
    return result;
  }
  function slug(value) {
    return String(value || "reddit").normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "reddit";
  }
  function fileBase(snapshot, folder) {
    const date = snapshot.visit.started_at.slice(0, 10);
    const stamp = snapshot.visit.started_at.replace(/[:.]/g, "-");
    const topic = snapshot.thread?.id || snapshot.page.kind;
    return `${validateFolder(folder)}/${date}/${slug(snapshot.thread?.subreddit || "reddit")}/${stamp}_${slug(topic)}_${slug(snapshot.visit.id)}`;
  }
  function fingerprint(snapshot) {
    // Visit timestamps change independently of the actual page content.
    const copy = { page: snapshot.page, thread: snapshot.thread, posts: snapshot.posts, comments: snapshot.comments };
    const value = JSON.stringify(copy);
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return `${value.length}:${hash >>> 0}`;
  }
  function markdown(snapshot) {
    const clean = value => String(value ?? "").replace(/\r/g, "");
    const thread = snapshot.thread;
    const out = [`# ${clean(thread?.title || snapshot.page.title)}`, "", `Source: ${snapshot.page.url}`, `Visit: ${snapshot.visit.started_at}`, `Last captured: ${snapshot.captured_at}`, `Visit ID: ${snapshot.visit.id}`, "", "> Partial archive of content loaded in the browser. Comments are cumulative within this visit; unloaded comments and media files are not fetched.", ""];
    if (thread) {
      out.push(`Subreddit: ${clean(thread.subreddit || "unknown")} · Author: ${clean(thread.author || "unknown")} · Score: ${thread.score ?? "unknown"}`, "", clean(thread.body), "");
      if (thread.link) out.push(`Link: ${thread.link}`, "");
      if (thread.media?.length) out.push("Media URLs:", ...thread.media.map(x => `- ${x}`), "");
      out.push(`## Loaded comments (${snapshot.comments.length})`, "");
      for (const c of snapshot.comments) {
        out.push(`### ${clean(c.author || "unknown")} · ${c.id}`, `Parent: ${c.parent_id || "unknown"} · Depth: ${c.depth ?? "unknown"} · Score: ${c.score ?? "unknown"}`, "", clean(c.body), "");
      }
    } else {
      for (const post of snapshot.posts) out.push(`## ${clean(post.title)}`, post.url || "", `Subreddit: ${clean(post.subreddit || "unknown")} · Author: ${clean(post.author || "unknown")}`, "", clean(post.body), "");
    }
    return out.join("\n");
  }
  const api = { DEFAULTS, pageInfo, validateFolder, settings, slug, fileBase, fingerprint, markdown };
  root.RedditDump = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
