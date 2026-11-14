"""Generate the extension's small arrow icon with stdlib PNG encoding."""
from pathlib import Path
import struct
import zlib

root = Path(__file__).resolve().parent.parent / "icons"
root.mkdir(exist_ok=True)

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

def pixel(x, y):
    # Rounded green tile, with a cream arrow running down and right.
    dx, dy = max(21 - x, 0, x - 107), max(21 - y, 0, y - 107)
    if not (4 <= x <= 124 and 4 <= y <= 124 and dx * dx + dy * dy <= 17 * 17):
        return (0, 0, 0, 0)
    shaft = 34 <= x <= 86 and abs(y - x) < 5.5
    tip = (77 <= x <= 88 and 55 <= y <= 88) or (55 <= x <= 88 and 77 <= y <= 88)
    return (250, 249, 245, 255) if shaft or tip else (47, 104, 79, 255)

for size in [16, 32, 48, 128]:
    scan = bytearray()
    for y in range(size):
        scan.append(0)
        for x in range(size):
            samples = [pixel((x + (sx + .5) / 4) * 128 / size, (y + (sy + .5) / 4) * 128 / size) for sy in range(4) for sx in range(4)]
            scan.extend(round(sum(p[c] for p in samples) / 16) for c in range(4))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(scan)) + chunk(b"IEND", b"")
    (root / f"icon{size}.png").write_bytes(png)
