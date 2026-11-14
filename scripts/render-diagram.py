"""Render the local documentation diagram to PNG using an isolated Chromium profile."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
binary = os.environ.get("CHROMIUM_BINARY") or next((p for p in [
    shutil.which("chromium"),
    shutil.which("chromium-browser"),
    shutil.which("google-chrome"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] if p and Path(p).is_file()), None)
if not binary:
    raise SystemExit("Set CHROMIUM_BINARY to your Chromium executable.")

output = root / "docs/how-it-works.png"
with tempfile.TemporaryDirectory(prefix="threadtrail-diagram-") as profile:
    result = subprocess.run([
        binary, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        "--disable-component-update", "--disable-sync", "--host-resolver-rules=MAP * ~NOTFOUND",
        "--window-size=1600,900", "--force-device-scale-factor=2", "--virtual-time-budget=1200",
        f"--user-data-dir={profile}", f"--screenshot={output}",
        (root / "docs/how-it-works.html").as_uri(),
    ], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise SystemExit(result.stderr)
if not output.is_file():
    raise SystemExit("Chromium did not create the diagram image.")
print(output)
