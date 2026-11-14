"""Build extension PNG sizes from icons/source.png with sips or ImageMagick."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent / "icons"
source = root / "source.png"
if not source.is_file():
    raise SystemExit(f"Missing icon source: {source}")

sips = shutil.which("sips")
magick = shutil.which("magick")
if not sips and not magick:
    raise SystemExit("Icon generation requires macOS sips or ImageMagick (magick).")

def run(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)

with tempfile.TemporaryDirectory(prefix="threadtrail-icons-") as directory:
    cropped = Path(directory) / "icon.png"
    # Remove the source's wide empty margin, retaining the centered artwork and alpha.
    # The original remains unchanged for future exports.
    if sips:
        run([sips, "--cropToHeightWidth", "640", "640", str(source), "--out", str(cropped)])
    else:
        run([magick, str(source), "-gravity", "center", "-crop", "640x640+0+0", "+repage", str(cropped)])
    for size in [16, 32, 48, 128]:
        target = root / f"icon{size}.png"
        if sips:
            run([sips, "--resampleHeightWidth", str(size), str(size), str(cropped), "--out", str(target)])
        else:
            run([magick, str(cropped), "-resize", f"{size}x{size}", str(target)])
        print(target)
