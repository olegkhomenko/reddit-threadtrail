(function (root) {
  "use strict";
  const COMMENT = "shreddit-comment, .thing.comment, [data-testid='comment']";
  const POST = "shreddit-post, .thing.link, [data-testid='post-container']";
  const text = node => (node?.innerText ?? node?.textContent ?? "").replace(/\u200b/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const attr = (node, ...names) => names.map(n => node?.getAttribute(n)).find(v => v !== null && v !== undefined && v !== "") || null;
  const first = (node, selectors) => selectors.map(s => node.querySelector(s)).find(Boolean) || null;
  function url(value, base) {
    if (typeof value !== "string" || !value.trim()) return null;
    try { const u = new URL(value, base); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
  }
  function score(value) {
    if (!value) return null;
    const match = String(value).replace(/,/g, "").match(/^\s*(-?\d+(?:\.\d+)?)\s*([km])?(?:\s+(?:points?|votes?))?\s*$/i);
    return match ? Math.round(Number(match[1]) * ({ k: 1000, m: 1000000 }[match[2]?.toLowerCase()] || 1)) : null;
  }
  function iso(value) {
    if (!value) return null;
    const time = /^\d+(\.\d+)?$/.test(value) ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : value;
    const d = new Date(time);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  function fullname(value, type) {
    if (!value) return null;
    const raw = String(value).replace(/^(?:t[13]_|comment[-_]|post[-_])/, "");
    return /^[a-z0-9]+$/i.test(raw) ? `${type}_${raw.toLowerCase()}` : null;
  }
  function owned(node, selectors, boundary) {
    for (const selector of selectors) {
      for (const candidate of node.querySelectorAll(selector)) if (candidate.closest(boundary) === node) return candidate;
    }
    return null;
  }
  function links(body, base) {
    if (!body) return [];
    return [...new Set([...body.querySelectorAll("a[href]")].map(a => url(a.getAttribute("href"), base)).filter(Boolean))];
  }
  function post(node, base, fallbackId = null) {
    const id = fullname(attr(node, "data-fullname", "id"), "t3") || fullname(fallbackId, "t3");
    const titleNode = first(node, ["[slot='title']", "a.title", "h1", "h3", "[data-adclicklocation='title']"]);
    const permalink = attr(node, "permalink") || first(node, ["a[data-click-id='comments']", "a.comments", "a[href*='/comments/']"])?.getAttribute("href");
    const body = owned(node, ["[slot='text-body']", "[id$='-post-rtjson-content']", ".expando .usertext-body .md", "[data-click-id='text']"], POST);
    const author = first(node, ["a.author", "[data-testid='post_author_link']", "a[href^='/user/']", "a[href*='reddit.com/user/']"]);
    const subreddit = first(node, ["a.subreddit", "[data-click-id='subreddit']", "a[href^='/r/']"]);
    const time = first(node, ["time"]);
    const counter = first(node, [".score.unvoted", ".score", "[data-testid='post-score']"]);
    const commentCount = attr(node, "comment-count", "data-num-comments");
    const media = [...node.querySelectorAll("[slot='post-media-container'] img, [slot='post-media-container'] video, .expando img, .expando video")].filter(n => !n.closest(COMMENT)).map(n => url(attr(n, "src", "poster"), base)).filter(Boolean);
    return {
      id: id?.slice(3) || null, fullname: id,
      title: attr(node, "post-title", "data-title") || text(titleNode),
      url: url(permalink, base),
      subreddit: (attr(node, "subreddit-prefixed-name", "subreddit-name", "data-subreddit") || text(subreddit) || "").replace(/^r\//, "") || null,
      author: attr(node, "author", "data-author") || text(author)?.replace(/^u\//, "") || null,
      score: score(attr(node, "score", "data-score") || text(counter)),
      score_is_approximate: !attr(node, "score", "data-score") && /[km]/i.test(text(counter)),
      created_at: iso(attr(node, "created-timestamp", "data-timestamp") || attr(time, "datetime")),
      comment_count_reported: commentCount && /^\d+$/.test(commentCount) ? Number(commentCount) : null,
      body: text(body), links: links(body, base),
      link: url(attr(node, "content-href", "data-url") || first(node, ["a.title"])?.getAttribute("href"), base),
      media: [...new Set(media)]
    };
  }
  function comment(node, base, threadId) {
    const id = fullname(attr(node, "thingid", "data-fullname", "id"), "t1");
    if (!id) return null;
    const body = owned(node, ["[slot='comment']", ".usertext-body .md", "[data-testid='comment-body']", "[id$='-comment-rtjson-content']"], COMMENT);
    const authorNode = owned(node, ["a.author", "[data-testid='comment_author_link']", "a[href^='/user/']"], COMMENT);
    const parent = node.parentElement?.closest(COMMENT);
    const explicitParent = attr(node, "parentid", "parent-id", "data-parent-fullname");
    const time = owned(node, ["time"], COMMENT);
    const count = owned(node, [".score.unvoted", ".score", "[data-testid='comment-score']"], COMMENT);
    const depth = attr(node, "depth", "data-depth");
    let inferredDepth = 0;
    for (let p = parent; p; p = p.parentElement?.closest(COMMENT)) inferredDepth++;
    return {
      id, parent_id: explicitParent || (parent && fullname(attr(parent, "thingid", "data-fullname", "id"), "t1")) || `t3_${threadId}`,
      depth: depth !== null && /^\d+$/.test(depth) ? Number(depth) : inferredDepth,
      author: attr(node, "author", "data-author") || text(authorNode)?.replace(/^u\//, "") || null,
      body: text(body), body_loaded: Boolean(body), links: links(body, base),
      score: score(attr(node, "score", "data-score") || text(count)),
      score_is_approximate: !attr(node, "score", "data-score") && /[km]/i.test(text(count)),
      created_at: iso(attr(node, "created", "created-timestamp") || attr(time, "datetime")),
      url: url(attr(node, "permalink"), base) || `https://www.reddit.com/comments/${threadId}/_/${id.slice(3)}/`
    };
  }
  function extract(doc, rawUrl) {
    const info = root.RedditDump.pageInfo(rawUrl);
    if (!info) return null;
    // Prefer newer elements if a site contains more than one rendering of a post.
    const nodes = [...doc.querySelectorAll(POST)].filter(n => !n.parentElement?.closest(POST));
    const posts = nodes.map(n => post(n, info.url)).filter(p => p.title);
    let thread = null;
    const comments = [];
    if (info.kind === "thread") {
      const node = nodes.find(n => fullname(attr(n, "data-fullname", "id"), "t3") === `t3_${info.threadId}`);
      thread = node ? post(node, info.url, info.threadId) : null;
      // Some older redesigns identify their root post only by its permalink.
      if (!thread) thread = posts.find(p => root.RedditDump.pageInfo(p.url)?.threadId === info.threadId) || null;
      if (!thread) return null; // Never label an unrelated feed post as the visited thread.
      thread.id = info.threadId;
      thread.fullname = `t3_${info.threadId}`;
      thread.url ||= `https://www.reddit.com/comments/${info.threadId}/`;
      const seen = new Set();
      for (const n of doc.querySelectorAll(COMMENT)) {
        const ownerPost = attr(n, "postid", "post-id", "data-post-id");
        if (ownerPost && fullname(ownerPost, "t3") !== `t3_${info.threadId}`) continue;
        const c = comment(n, info.url, info.threadId);
        if (c && !seen.has(c.id)) { seen.add(c.id); comments.push(c); }
      }
    }
    if (!thread && !posts.length) return null; // Skip login walls, loading placeholders and errors.
    return {
      page: { kind: info.kind, url: info.url, title: thread?.title || doc.title },
      thread, posts: thread ? [] : [...new Map(posts.map(p => [p.fullname || p.url || p.title, p])).values()], comments
    };
  }
  function merge(previous, current) {
    if (!previous) return current;
    const mergeItems = (before, after, key) => {
      const map = new Map(before.map(item => [key(item), item]));
      for (const item of after) {
        const prior = map.get(key(item));
        // A collapsed comment can lose its text; preserve what was previously loaded.
        map.set(key(item), prior && !item.body_loaded && prior.body_loaded ? { ...item, body: prior.body, body_loaded: true, links: prior.links } : item);
      }
      return [...map.values()];
    };
    return { ...current, comments: mergeItems(previous.comments, current.comments, x => x.id), posts: mergeItems(previous.posts, current.posts, x => x.fullname || x.url || x.title) };
  }
  root.RedditDumpExtractor = { extract, merge, score, iso };
  if (typeof module !== "undefined") module.exports = root.RedditDumpExtractor;
})(globalThis);
