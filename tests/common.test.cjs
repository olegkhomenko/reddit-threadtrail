const { test } = require("node:test");
const assert = require("node:assert/strict");
const D = require("../common.js");
global.RedditDump = D;
const E = require("../extractor.js");
const snapshot = () => ({ schema_version: 1, visit: { id: "visit-12345", started_at: "2026-11-13T10:30:00.000Z" }, captured_at: "2026-11-13T10:31:00Z", page: { kind: "thread", url: "https://www.reddit.com/r/business/comments/abc123/a_title/", title: "A title" }, thread: { id: "abc123", title: "A title", subreddit: "business", body: "Post text" }, posts: [], comments: [{ id: "t1_c1", parent_id: "t3_abc123", author: "person", body: "Comment", body_loaded: true, links: [] }] });
test("supports Reddit threads, feeds and search while stripping tracking data", () => {
  assert.deepEqual(D.pageInfo("https://old.reddit.com/r/business/comments/abc123/title/?utm_source=app&sort=new#hello"), { kind: "thread", threadId: "abc123", url: "https://www.reddit.com/r/business/comments/abc123/title/?sort=new" });
  for (const path of ["/", "/r/business/", "/r/business/top/?t=week", "/new/", "/r/popular"]) assert.ok(D.pageInfo(`https://www.reddit.com${path}`));
  assert.equal(D.pageInfo("https://www.reddit.com/search/?q=business").kind, "search");
});
test("excludes other websites, private and unsupported Reddit pages", () => {
  for (const address of ["https://reddit.com.evil.org/comments/abc/", "https://evil.reddit.com/comments/abc/", "http://www.reddit.com/comments/abc/", "https://www.reddit.com:444/comments/abc/", "https://www.reddit.com/message/inbox", "https://www.reddit.com/chat", "https://www.reddit.com/user/person", "https://www.reddit.com/settings", "not a url"]) assert.equal(D.pageInfo(address), null, address);
});
test("folder validation confines downloads to a safe relative path", () => {
  assert.equal(D.validateFolder("Research/Reddit"), "Research/Reddit");
  assert.equal(D.validateFolder("Research\\Reddit"), "Research/Reddit");
  for (const path of ["../other", "/Users/me", "a/../b", "a//b", "a/", "C:\\Secret", "Research/.", "a\0b", "CON", "a/NUL.txt", "a. "]) assert.throws(() => D.validateFolder(path), undefined, path);
});
test("a visit has a stable safe filename and a different visit has a different filename", () => {
  const s = snapshot(); const name = D.fileBase(s, "Reddit ThreadTrail");
  s.captured_at = "2026-11-13T11:00:00Z";
  assert.equal(D.fileBase(s, "Reddit ThreadTrail"), name);
  assert.match(name, /^Reddit ThreadTrail\/2026-11-13\/business\//);
  s.visit.id = "visit-67890";
  assert.notEqual(D.fileBase(s, "Reddit ThreadTrail"), name);
});
test("fingerprints ignore capture time but detect content changes", () => {
  const s = snapshot(); const hash = D.fingerprint(s);
  s.captured_at = new Date().toISOString();
  assert.equal(D.fingerprint(s), hash);
  s.comments[0].body = "Updated text";
  assert.notEqual(D.fingerprint(s), hash);
});
test("cumulative comments survive collapse and retain parent structure", () => {
  const before = snapshot(); const current = snapshot();
  current.comments = [{ id: "t1_c1", body: "", body_loaded: false, links: [] }, { id: "t1_c2", parent_id: "t1_c1", body: "Reply", body_loaded: true }];
  const merged = E.merge(before, current);
  assert.equal(merged.comments[0].body, "Comment");
  assert.equal(merged.comments[1].parent_id, "t1_c1");
  current.comments = [];
  assert.equal(E.merge(merged, current).comments.length, 2);
});
test("parses displayed scores without inventing hidden values", () => {
  assert.equal(E.score("1.2k"), 1200);
  assert.equal(E.score("-12 points"), -12);
  assert.equal(E.score("1,234"), 1234);
  assert.equal(E.score("Vote"), null);
  assert.equal(E.score("[score hidden]"), null);
  assert.equal(E.iso("1731504000"), "2024-11-13T13:20:00.000Z");
  assert.equal(E.iso("not a date"), null);
});
test("Markdown includes source, thread body, comments and coverage limitation", () => {
  const result = D.markdown(snapshot());
  for (const value of ["# A title", "Post text", "Comment", "Parent: t3_abc123", "Partial archive", "visit-12345"]) assert.ok(result.includes(value));
});
