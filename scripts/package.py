"""Build a dependency-free unpacked-extension ZIP; no shell commands or network."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "manifest.json").read_text())
files = ["manifest.json", "common.js", "extractor.js", "content.js", "background.js", "popup.html", "options.html", "ui.js", "ui.css", "README.md", "CHANGELOG.md"]
files += sorted(set(manifest.get("icons", {}).values()))
files += ["docs/how-it-works.html", "docs/how-it-works.gif"]
for file in files:
    if not (root / file).is_file():
        raise SystemExit(f"Missing extension file: {file}")
output = root.parent / "reddit-threadtrail.zip"
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for file in files:
        archive.write(root / file, f"reddit-threadtrail/{file}")
print(output)
