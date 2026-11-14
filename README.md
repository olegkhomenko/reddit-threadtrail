# Reddit ThreadTrail

**Browse Reddit. Keep the trail.**

A small Manifest V3 extension for Chromium browsers. It passively saves Reddit pages you view as structured **JSON**, with optional **Markdown** copies. No crawling, Reddit API calls, automatic scrolling or comment expansion. No build step, dependencies or server.

## Install

Download and extract the ZIP from the [latest release](https://github.com/olegkhomenko/reddit-threadtrail/releases/latest), or clone this repository:

```sh
git clone https://github.com/olegkhomenko/reddit-threadtrail.git
```

1. Open your browser's extensions manager: `chrome://extensions` in Chrome or Chromium, `brave://extensions` in Brave, or `edge://extensions` in Edge.
2. Enable **Developer mode**, choose **Load unpacked**, and select the `reddit-threadtrail` folder (the folder containing `manifest.json`). If using the ZIP, extract it first.
3. Pin **Reddit ThreadTrail** from the extensions menu. Reload any Reddit tabs that were already open before installation.
4. In your browser's **Downloads** settings, turn off **Ask where to save each file before downloading** if it is enabled. This allows unattended local saves.
5. Open a Reddit thread. After its content loads, look for your first file in **Downloads / Reddit ThreadTrail**. The extension popup shows whether the download completed.

The extension is ready to load; it is not installed into your everyday browser automatically. Browser or organization download policies can still block a save. Failures are shown in recent captures.

Existing users: reload the extension and open Reddit tabs after updating. Your configured output folder is preserved; new installations default to `Reddit ThreadTrail`.

## Use

- Browse Reddit normally. Supported thread, feed and search pages are captured after loading, while the tab is visible.
- Expand comments or scroll yourself. Loaded comments are added to the same visit's file; previously observed comments are retained even if later collapsed or removed from the DOM.
- Normal updates occur at most once every 20 seconds while reading. Reaching the bottom of a thread triggers an earlier check after 750 ms. For the next 15 seconds, newly loaded comments trigger additional checks even if the extra content pushes the bottom away. These checks update the same visit's file and skip unchanged content. Slower arrivals are still handled by the normal observer. Tab hiding or page exit requests a best-effort final save; closing a tab immediately can prevent it. Use **Capture now** before closing if you need the latest state saved.
- Revisiting a page, including navigating away and back within Reddit's single-page interface, creates a new visit file. Switching between browser tabs on the same page continues the same visit.
- Use **Pause / Resume** to stop or restart capture across Reddit tabs. Pages opened only in the background are not captured until viewed.
- **Settings** controls the relative output folder, Markdown copies, and whether feeds/search are included. Folder and format changes apply to new visits so existing files keep a stable destination.
- **Export visit index** writes metadata and paths for the most recent 200 visits. All older dump files remain on disk. The file timestamps and folders use UTC; popup dates use your browser's locale and time zone.
- Use the arrow next to a saved capture to reveal the file in your file manager.

Default layout:

```text
Downloads/
  Reddit ThreadTrail/
    2026-11-13/
      business/
        2026-11-13T12-00-00-000Z_abc123_<visit-id>.json
        2026-11-13T12-00-00-000Z_abc123_<visit-id>.md  # optional
      reddit/
        ..._listing_<visit-id>.json
    visit-index-<timestamp>.json
```

Chromium's downloads API takes paths relative to the browser's configured Downloads directory. You can use a subfolder such as `Research/Reddit`; you cannot enter an arbitrary absolute path in the extension. To put the archive on another drive, change your browser's Downloads location. See [Chrome's downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads).

## JSON format (schema version 1)

Each file is an independent visit snapshot. The `source` value remains `reddit-dump` for compatibility with earlier archives and analysis scripts; the extension is now named Reddit ThreadTrail:

```json
{
  "schema_version": 1,
  "source": "reddit-dump",
  "captured_at": "2026-11-13T12:00:01.000Z",
  "visit": {
    "id": "unique-visit-id",
    "started_at": "2026-11-13T12:00:00.000Z"
  },
  "page": {
    "kind": "thread",
    "url": "https://www.reddit.com/r/business/comments/abc123/title/",
    "title": "A business question"
  },
  "thread": {
    "id": "abc123",
    "fullname": "t3_abc123",
    "title": "A business question",
    "url": "https://www.reddit.com/r/business/comments/abc123/title/",
    "subreddit": "business",
    "author": "founder",
    "score": 42,
    "score_is_approximate": false,
    "created_at": null,
    "comment_count_reported": 12,
    "body": "What customers are asking for…",
    "links": [],
    "link": null,
    "media": []
  },
  "posts": [],
  "comments": [{
    "id": "t1_reply1",
    "parent_id": "t3_abc123",
    "depth": 0,
    "author": "customer",
    "body": "I would pay for…",
    "body_loaded": true,
    "links": [],
    "score": null,
    "score_is_approximate": false,
    "created_at": null,
    "url": "https://www.reddit.com/comments/abc123/_/reply1/"
  }],
  "coverage": {
    "mode": "loaded_dom_only",
    "complete_thread": false,
    "comments_cumulative_within_visit": true,
    "media_files_downloaded": false,
    "note": "Only browser-loaded content. Counts may be approximate; missing fields are null. No background requests or automatic expansion."
  }
}
```

For feeds and search, `thread` is `null`, `comments` is empty, and `posts` contains the loaded post summaries. The post fields have the same shape as `thread`. Comments are flat records; use `parent_id` to reconstruct the reply tree. `t3_` identifies posts and `t1_` identifies comments. Original page sort/search parameters are retained; common tracking parameters and URL fragments are removed.

The archive is cumulative within each visit, not a record of every intermediate edit. A newly observed text edit replaces the earlier text in that visit's file. Keep separate visits when comparing a thread over time. The visit index is bounded and is not a permanent event log; visit timestamps are also embedded in every archived file.

## Analyze your archive

Python's standard library is enough. This example prints visit counts by day and subreddit; it skips visit-index files automatically:

```python
import json
from pathlib import Path
from collections import Counter

archive = Path.home() / "Downloads" / "Reddit ThreadTrail"
visits = {}
for file in archive.rglob("*.json"):
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        continue
    if data.get("source") == "reddit-dump":
        visits[data["visit"]["id"]] = data

print("Visits by day:", Counter(v["visit"]["started_at"][:10] for v in visits.values()))
print("Thread visits by subreddit:", Counter(
    v["thread"]["subreddit"] for v in visits.values() if v.get("thread")
))
print("Loaded comments:", sum(len(v["comments"]) for v in visits.values()))
```

For customer research, combine `thread.body` and each loaded `comments[].body`. Keep the source URL and visit ID alongside extracted insights. Distinguish repeated visits from unique threads with `thread.id`, and deduplicate comments across visits with `comments[].id`. This is your browsing sample, not a representative sample of Reddit.

## Coverage and privacy

- Supports current `shreddit-*` elements and Old Reddit markup, plus selected legacy redesign selectors. Reddit may change its DOM; missing fields are represented as `null` (or empty text when a body isn't loaded). Unsupported layouts may not capture at all. Reload and try **Capture now** if a page appears missing.
- Captures supported pages on `reddit.com`, `www`, `old`, `new`, `sh` and `m` Reddit hosts over HTTPS. Short links must redirect to a supported page first. Profiles, inbox, chat, settings and moderation pages are excluded.
- Reads loaded DOM content, including offscreen loaded comments. It does not retrieve unloaded, hidden behind a login wall, deleted-before-you-viewed, or removed content. Collapsed placeholders are marked `body_loaded: false` unless their body was observed earlier in the same visit.
- Scores may be rounded by the site and may be hidden. Media URLs can be recorded where available; images and videos are not downloaded, transcribed or OCRed. Markdown focuses on readable text; JSON is the full structured output.
- Only visits after installation are captured; it does not import your previous browser history. It does not measure reading duration or infer what you actually read.
- No analytics, external libraries, telemetry, credentials, cookies, general browser-history access or outbound archive uploads. Captures can include content from private communities you are authorized to view. Local folders may still be synced by your OS or backup software.
- Permissions: `storage` for settings and recent metadata; `downloads` to create and monitor local files; `alarms` to reconcile interrupted saves. Content scripts have access only to the listed Reddit hosts. See [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).
- A single capture is capped at about 2 million JSON characters. Larger visits report an error rather than silently truncating data. Open a smaller comment branch to capture separately.
- Per-visit updates intentionally overwrite that visit's generated files. Moving or deleting a file during an active visit may cause the original path to be recreated on the next capture. Moving or deleting the Downloads entry can prevent the popup's reveal action from working.

## Development and verification

No bundler or install step is required. Load the source folder directly. Runtime code contains no remote requests or remotely hosted code.

```sh
npm test
npm run test:browser
npm run package
```

`npm test` uses Node's built-in runner. Browser tests require Node 22+ and a Chromium executable that supports loading unpacked extensions by command line. They default to Brave on macOS; set `CHROMIUM_BINARY` for another installation. They use a disposable browser profile, synthetic modern/Old Reddit responses, an isolated downloads folder, and blocked DNS. They do not access your existing browser profile or fetch real Reddit content. Browser tests cover real extension downloads, overwriting, comment expansion/collapse, SPA navigation, return visits, settings, popup history, pause/resume, Markdown and private-page exclusion. Screenshots are written to `tests/artifacts/` for visual review.

The real browser verification uses synthetic DOM fixtures, not a logged-in live Reddit session. Compatibility with every live Reddit experiment/layout is not guaranteed. After installing, verify the first dump against a thread you visit.

`npm run package` writes `../reddit-threadtrail.zip`, containing only the installable extension and this README. The ZIP must be extracted before **Load unpacked**.
