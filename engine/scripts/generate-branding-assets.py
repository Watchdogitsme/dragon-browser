#!/usr/bin/env python3
"""
Dragon Browser - Pure-Python Branding Asset Generator (PNG & Windows ICO)
Generates multi-resolution RGBA PNG emblems and spec-compliant Windows .ico bundles
using only Python standard library modules (struct, zlib, math, pathlib).
"""

import math
import struct
import zlib
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

Color = Tuple[int, int, int, int]
Point = Tuple[float, float]

# Design space is 0..128 (matching assets/dragon.svg geometry)
HEX_OUTER: List[Point] = [
    (64.0, 6.0),
    (114.0, 35.0),
    (114.0, 93.0),
    (64.0, 122.0),
    (14.0, 93.0),
    (14.0, 35.0),
]

HEX_INNER: List[Point] = [
    (64.0, 10.0),
    (110.5, 37.0),
    (110.5, 91.0),
    (64.0, 118.0),
    (17.5, 91.0),
    (17.5, 37.0),
]

DRAGON_CREST: List[Point] = [
    (32.0, 88.0),
    (42.0, 40.0),
    (68.0, 24.0),
    (94.0, 34.0),
    (76.0, 44.0),
    (98.0, 54.0),
    (76.0, 62.0),
    (92.0, 78.0),
    (62.0, 102.0),
    (48.0, 92.0),
    (66.0, 76.0),
    (50.0, 74.0),
]

DRAGON_HIGHLIGHT: List[Point] = [
    (42.0, 40.0),
    (68.0, 24.0),
    (94.0, 34.0),
    (66.0, 46.0),
    (50.0, 52.0),
]

DRAGON_SHADOW_CUT: List[Point] = [
    (50.0, 74.0),
    (66.0, 76.0),
    (58.0, 86.0),
    (44.0, 82.0),
]

DRAGON_EYE: List[Point] = [
    (63.0, 49.0),
    (75.0, 45.0),
    (71.0, 54.0),
]


def _lerp_color(c1: Color, c2: Color, t: float) -> Color:
    if t <= 0.0:
        return c1
    if t >= 1.0:
        return c2
    inv = 1.0 - t
    return (
        int(c1[0] * inv + c2[0] * t + 0.5),
        int(c1[1] * inv + c2[1] * t + 0.5),
        int(c1[2] * inv + c2[2] * t + 0.5),
        int(c1[3] * inv + c2[3] * t + 0.5),
    )


def _polygon_spans(poly: Sequence[Point], y: float) -> List[Tuple[float, float]]:
    """Return sorted (x_start, x_end) intersection spans of polygon at scanline y."""
    xs: List[float] = []
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 <= y < y2) or (y2 <= y < y1):
            t = (y - y1) / (y2 - y1)
            xs.append(x1 + t * (x2 - x1))
    xs.sort()
    spans: List[Tuple[float, float]] = []
    for i in range(0, len(xs) - 1, 2):
        spans.append((xs[i], xs[i + 1]))
    return spans


def render_dragon_rgba(size: int, variant: str = "default") -> bytes:
    """
    Render a crisp anti-aliased RGBA image of the Dragon Browser emblem at `size x size`.
    Uses 2x2 supersampled scanline polygon rasterization in normalized 128x128 coordinates.
    """
    if variant == "private":
        border_col: Color = (76, 46, 133, 255)
        bg_top: Color = (24, 17, 43, 255)
        bg_bot: Color = (11, 9, 20, 255)
        crest_top: Color = (192, 132, 252, 255)
        crest_mid: Color = (147, 51, 234, 255)
        crest_bot: Color = (109, 40, 217, 255)
        hi_top: Color = (233, 213, 255, 255)
        hi_bot: Color = (168, 85, 247, 255)
        cut_col: Color = (15, 11, 28, 255)
        eye_col: Color = (250, 245, 255, 255)
    else:
        border_col = (45, 50, 70, 255)
        bg_top = (24, 27, 38, 255)
        bg_bot = (11, 13, 18, 255)
        crest_top = (255, 107, 53, 255)
        crest_mid = (244, 63, 94, 255)
        crest_bot = (190, 18, 60, 255)
        hi_top = (255, 176, 103, 255)
        hi_bot = (255, 77, 79, 255)
        cut_col = (14, 16, 23, 255)
        eye_col = (255, 245, 235, 255)

    # Render at 2x supersampled resolution for small/medium sizes, 1x for huge sizes if needed,
    # Actually 2x supersampling even at 384 (768 rows) takes <0.05s with span filling!
    ss = 2 if size <= 192 else 1
    w = size * ss
    h = size * ss
    scale = 128.0 / float(w)

    # Precompute row gradients in supersampled space
    layers = [
        (HEX_OUTER, "border"),
        (HEX_INNER, "bg"),
        (DRAGON_CREST, "crest"),
        (DRAGON_HIGHLIGHT, "highlight"),
        (DRAGON_SHADOW_CUT, "cut"),
        (DRAGON_EYE, "eye"),
    ]

    # Buffer of flat RGBA bytes at supersampled resolution (w * h * 4)
    buf = bytearray(w * h * 4)

    for sy in range(h):
        y_norm = (sy + 0.5) * scale
        t_bg = max(0.0, min(1.0, (y_norm - 10.0) / 108.0))
        c_bg = _lerp_color(bg_top, bg_bot, t_bg)

        t_crest = max(0.0, min(1.0, (y_norm - 24.0) / 78.0))
        if t_crest < 0.52:
            c_crest = _lerp_color(crest_top, crest_mid, t_crest / 0.52)
        else:
            c_crest = _lerp_color(crest_mid, crest_bot, (t_crest - 0.52) / 0.48)

        t_hi = max(0.0, min(1.0, (y_norm - 24.0) / 30.0))
        c_hi = _lerp_color(hi_top, hi_bot, t_hi)

        color_map = {
            "border": bytes(border_col),
            "bg": bytes(c_bg),
            "crest": bytes(c_crest),
            "highlight": bytes(c_hi),
            "cut": bytes(cut_col),
            "eye": bytes(eye_col),
        }

        row_offset = sy * w * 4
        for poly, kind in layers:
            spans = _polygon_spans(poly, y_norm)
            if not spans:
                continue
            px_bytes = color_map[kind]
            for x0_norm, x1_norm in spans:
                ix0 = max(0, min(w, int(x0_norm / scale + 0.5)))
                ix1 = max(0, min(w, int(x1_norm / scale + 0.5)))
                if ix1 > ix0:
                    count = ix1 - ix0
                    start = row_offset + ix0 * 4
                    buf[start : start + count * 4] = px_bytes * count

    if ss == 1:
        return bytes(buf)

    # Downsample 2x2 -> 1x1
    out = bytearray(size * size * 4)
    stride = w * 4
    out_idx = 0
    for y in range(size):
        r0 = (2 * y) * stride
        r1 = r0 + stride
        for x in range(size):
            c0 = r0 + (2 * x) * 4
            c1 = r1 + (2 * x) * 4
            out[out_idx] = (buf[c0] + buf[c0 + 4] + buf[c1] + buf[c1 + 4] + 2) >> 2
            out[out_idx + 1] = (buf[c0 + 1] + buf[c0 + 5] + buf[c1 + 1] + buf[c1 + 5] + 2) >> 2
            out[out_idx + 2] = (buf[c0 + 2] + buf[c0 + 6] + buf[c1 + 2] + buf[c1 + 6] + 2) >> 2
            out[out_idx + 3] = (buf[c0 + 3] + buf[c0 + 7] + buf[c1 + 3] + buf[c1 + 7] + 2) >> 2
            out_idx += 4
    return bytes(out)


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def encode_png(width: int, height: int, rgba: bytes) -> bytes:
    """Encode raw RGBA bytes into a standard PNG image."""
    assert len(rgba) == width * height * 4
    signature = b"\x89PNG\r\n\x1a\n"
    # Color type 6 = RGBA, bit depth 8
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)

    # Filter byte 0 (None) at start of each scanline
    stride = width * 4
    raw_scanlines = bytearray((stride + 1) * height)
    for y in range(height):
        dst = y * (stride + 1)
        raw_scanlines[dst] = 0
        src = y * stride
        raw_scanlines[dst + 1 : dst + 1 + stride] = rgba[src : src + stride]

    compressed = zlib.compress(bytes(raw_scanlines), level=9)
    return (
        signature
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", compressed)
        + _png_chunk(b"IEND", b"")
    )


def encode_ico(png_frames: Sequence[Tuple[int, bytes]]) -> bytes:
    """
    Pack (size, png_bytes) frames into a spec-compliant Windows .ico file.
    ICONDIR header:Reserved=0, Type=1 (ICO), Count=len(frames) -> b'\\x00\\x00\\x01\\x00'
    """
    count = len(png_frames)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries = bytearray()
    payloads = bytearray()

    for size, png_data in png_frames:
        w_byte = 0 if size >= 256 else size
        h_byte = 0 if size >= 256 else size
        entry = struct.pack(
            "<BBBBHHII",
            w_byte,          # bWidth (0 means 256)
            h_byte,          # bHeight (0 means 256)
            0,               # bColorCount
            0,               # bReserved
            1,               # wPlanes
            32,              # wBitCount (32-bit RGBA)
            len(png_data),   # dwBytesInRes
            offset,          # dwImageOffset
        )
        entries.extend(entry)
        payloads.extend(png_data)
        offset += len(png_data)

    return header + bytes(entries) + bytes(payloads)


def generate_all_assets(repo_root: Path) -> None:
    assets_dir = repo_root / "assets"
    branding_dir = repo_root / "engine" / "branding" / "dragon"
    content_dir = branding_dir / "content"

    assets_dir.mkdir(parents=True, exist_ok=True)
    branding_dir.mkdir(parents=True, exist_ok=True)
    content_dir.mkdir(parents=True, exist_ok=True)

    default_sizes = [16, 22, 24, 32, 48, 64, 70, 128, 150, 192, 256, 384]
    png_cache: Dict[int, bytes] = {}
    for sz in default_sizes:
        rgba = render_dragon_rgba(sz, variant="default")
        png_cache[sz] = encode_png(sz, sz, rgba)

    private_sizes = [16, 32, 48, 64, 70, 128, 150, 192, 256, 384]
    private_cache: Dict[int, bytes] = {}
    for sz in private_sizes:
        rgba = render_dragon_rgba(sz, variant="private")
        private_cache[sz] = encode_png(sz, sz, rgba)

    # Build multi-resolution ICOs (16, 32, 48, 64, 128, 256)
    ico_sizes = [16, 32, 48, 64, 128, 256]
    ico_bytes = encode_ico([(sz, png_cache[sz]) for sz in ico_sizes])
    private_ico_bytes = encode_ico([(sz, private_cache[sz]) for sz in ico_sizes])

    # Write ICO targets
    ico_targets = [
        assets_dir / "dragon.ico",
        branding_dir / "default.ico",
        branding_dir / "firefox.ico",
        branding_dir / "firefox64.ico",
        branding_dir / "document.ico",
        branding_dir / "document_pdf.ico",
        branding_dir / "newtab.ico",
        branding_dir / "newwindow.ico",
        content_dir / "document.ico",
    ]
    for path in ico_targets:
        path.write_bytes(ico_bytes)

    (branding_dir / "pbmode.ico").write_bytes(private_ico_bytes)

    # Write root branding PNGs
    for sz in [16, 22, 24, 32, 48, 64, 128, 256]:
        (branding_dir / f"default{sz}.png").write_bytes(png_cache[sz])

    (branding_dir / "VisualElements_150.png").write_bytes(png_cache[150])
    (branding_dir / "VisualElements_70.png").write_bytes(png_cache[70])
    (branding_dir / "PrivateBrowsing_150.png").write_bytes(private_cache[150])
    (branding_dir / "PrivateBrowsing_70.png").write_bytes(private_cache[70])

    # Write content branding PNGs
    for sz in [16, 32, 48, 64, 128]:
        (content_dir / f"icon{sz}.png").write_bytes(png_cache[sz])

    (content_dir / "about-logo.png").write_bytes(png_cache[192])
    (content_dir / "about-logo@2x.png").write_bytes(png_cache[384])
    (content_dir / "about-logo-private.png").write_bytes(private_cache[192])
    (content_dir / "about-logo-private@2x.png").write_bytes(private_cache[384])
    (content_dir / "about.png").write_bytes(png_cache[256])


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    generate_all_assets(repo_root)
    print(f"[generate-branding-assets] Generated PNG and ICO assets in {repo_root}")


if __name__ == "__main__":
    main()
