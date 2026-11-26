#!/usr/bin/env python3
"""
Pure-Python Mozilla `optimizejars` (`omni.ja`) Reader & Compiler.

Mozilla's `omni.ja` binary layout (produced by `optimizejars.py`):
  - Bytes 0..4: `<I` readahead size (`hdr_val`).
  - Bytes 4..4+cd_size: `total_entries` Central Directory (`PK\\x01\\x02`) records
    (46-byte struct `<4sHHHHHHIIIHHHHHII` + filename + extra + comment).
    Each CD entry's `lhoff` points to its Local File Header (`PK\\x03\\x04`,
    30-byte struct `<4sHHHHHIIIHH` + filename + extra + payload bytes).
  - Bytes 4+cd_size..4+cd_size+22: EOCD (`PK\\x05\\x06`, `<4sHHHHIIH` with
    `cd_offset = 4`, `cd_size = len(cd)`).
  - Bytes 4+cd_size+22..eocd2: All Local File Header + payload blocks sequentially.
  - Bytes eocd2..EOF: Trailing 22-byte EOCD (`PK\\x05\\x06`) identical to the first
    EOCD (`cd_offset = 4`, `cd_size = len(cd)`).

Also transparently reads standard ZIP archives (`PK\\x03\\x04` at offset 0).
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
import tempfile
import zlib
from collections import OrderedDict
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Union

CD_SIGNATURE = b"PK\x01\x02"
LH_SIGNATURE = b"PK\x03\x04"
EOCD_SIGNATURE = b"PK\x05\x06"

CD_STRUCT = struct.Struct("<4sHHHHHHIIIHHHHHII")
LH_STRUCT = struct.Struct("<4sHHHHHIIIHH")
EOCD_STRUCT = struct.Struct("<4sHHHHIIH")


class Entry:
    """Represents a single archive entry inside a Mozilla omni.ja or standard ZIP."""

    __slots__ = (
        "name",
        "raw_bytes",
        "compress_method",
        "crc",
        "csize",
        "usize",
        "mtime",
        "mdate",
        "v_made",
        "v_ext",
        "flag",
        "disk",
        "iattr",
        "eattr",
        "cd_extra",
        "lh_extra",
        "comment",
        "lhoff",
    )

    def __init__(
        self,
        name: str,
        raw_bytes: bytes,
        compress_method: int = 0,
        crc: Optional[int] = None,
        csize: Optional[int] = None,
        usize: Optional[int] = None,
        mtime: int = 0,
        mdate: int = 0x21,
        v_made: int = 788,
        v_ext: int = 10,
        flag: int = 0,
        disk: int = 0,
        iattr: int = 0,
        eattr: int = 0x81A40000,
        cd_extra: bytes = b"",
        lh_extra: bytes = b"",
        comment: bytes = b"",
        lhoff: int = 0,
    ) -> None:
        self.name = name
        self.raw_bytes = raw_bytes
        self.compress_method = compress_method
        if crc is None:
            if compress_method == 0:
                crc = zlib.crc32(raw_bytes) & 0xFFFFFFFF
            else:
                decompressed = zlib.decompress(raw_bytes, -15)
                crc = zlib.crc32(decompressed) & 0xFFFFFFFF
        self.crc = crc & 0xFFFFFFFF
        self.csize = len(raw_bytes) if csize is None else csize
        if usize is None:
            if compress_method == 0:
                usize = len(raw_bytes)
            else:
                usize = len(zlib.decompress(raw_bytes, -15))
        self.usize = usize
        self.mtime = mtime
        self.mdate = mdate
        self.v_made = v_made
        self.v_ext = v_ext
        self.flag = flag
        self.disk = disk
        self.iattr = iattr
        self.eattr = eattr
        self.cd_extra = cd_extra
        self.lh_extra = lh_extra
        self.comment = comment
        self.lhoff = lhoff

    @property
    def method(self) -> int:
        return self.compress_method

    @property
    def crc32(self) -> int:
        return self.crc

    @property
    def compressed_size(self) -> int:
        return self.csize

    @property
    def uncompressed_size(self) -> int:
        return self.usize

    def read(self) -> bytes:
        """Decompress and return the entry's payload bytes."""
        if self.compress_method == 0:
            return self.raw_bytes
        if self.compress_method == 8:
            return zlib.decompress(self.raw_bytes, -15)
        raise ValueError(f"Unsupported compression method {self.compress_method} for {self.name}")


class MozJar:
    """Reader and compiler for Mozilla optimizejars (`omni.ja`) and ZIP archives."""

    def __init__(
        self,
        path: Optional[Union[str, Path]] = None,
        readahead: int = 0,
    ) -> None:
        self.path: Optional[Path] = Path(path) if path is not None else None
        self.readahead: int = readahead
        self.is_optimized: bool = True
        self.comment: bytes = b""
        self.entries: "OrderedDict[str, Entry]" = OrderedDict()
        if self.path is not None and self.path.exists():
            self._parse_file(self.path)

    @classmethod
    def load(cls, path: Union[str, Path]) -> "MozJar":
        """Load an `omni.ja` or standard ZIP archive from disk."""
        p = Path(path)
        if not p.exists():
            raise FileNotFoundError(f"Archive not found: {p}")
        instance = cls()
        instance.path = p
        instance._parse_file(p)
        return instance

    def _parse_file(self, path: Path) -> None:
        data = path.read_bytes()
        self._parse_bytes(data)

    def _parse_bytes(self, data: bytes) -> None:
        if len(data) < 22:
            raise ValueError("Data is too short to be a valid MozJar or ZIP archive")

        # Locate End of Central Directory (EOCD) at tail
        eocd_pos = data.rfind(EOCD_SIGNATURE, max(0, len(data) - 65557))
        if eocd_pos == -1:
            raise ValueError("EOCD signature (PK\\x05\\x06) not found in archive")

        (
            eocd_sig,
            _disk_num,
            _cd_disk,
            _entries_on_disk,
            total_entries,
            cd_size,
            cd_offset,
            comment_len,
        ) = EOCD_STRUCT.unpack_from(data, eocd_pos)
        if eocd_sig != EOCD_SIGNATURE:
            raise ValueError("Invalid EOCD signature")

        self.comment = data[eocd_pos + 22 : eocd_pos + 22 + comment_len]

        if cd_offset == 4 and data[4:8] == CD_SIGNATURE:
            self.is_optimized = True
            self.readahead = struct.unpack_from("<I", data, 0)[0]
        elif data[:4] == LH_SIGNATURE or cd_offset != 4:
            self.is_optimized = False
            self.readahead = 0
        else:
            self.is_optimized = True
            self.readahead = struct.unpack_from("<I", data, 0)[0]

        self.entries.clear()
        pos = cd_offset
        cd_end = cd_offset + cd_size

        for _ in range(total_entries):
            if pos + 46 > len(data) or pos >= cd_end:
                raise ValueError(f"Truncated Central Directory at offset {pos}")
            (
                sig,
                v_made,
                v_ext,
                flag,
                method,
                mtime,
                mdate,
                crc,
                csize,
                usize,
                nlen,
                elen,
                clen,
                disk,
                iattr,
                eattr,
                lhoff,
            ) = CD_STRUCT.unpack_from(data, pos)
            if sig != CD_SIGNATURE:
                raise ValueError(f"Invalid CD entry signature at offset {pos}: {sig!r}")

            name_bytes = data[pos + 46 : pos + 46 + nlen]
            name = name_bytes.decode("utf-8", errors="surrogateescape")
            cd_extra = data[pos + 46 + nlen : pos + 46 + nlen + elen]
            comment = data[pos + 46 + nlen + elen : pos + 46 + nlen + elen + clen]
            pos += 46 + nlen + elen + clen

            if lhoff + 30 > len(data):
                raise ValueError(f"Invalid Local File Header offset {lhoff} for {name}")
            (
                lh_sig,
                _lh_v_ext,
                _lh_flag,
                _lh_method,
                _lh_mtime,
                _lh_mdate,
                _lh_crc,
                _lh_csize,
                _lh_usize,
                lh_nlen,
                lh_elen,
            ) = LH_STRUCT.unpack_from(data, lhoff)
            if lh_sig != LH_SIGNATURE:
                raise ValueError(f"Invalid Local File Header signature at {lhoff} for {name}: {lh_sig!r}")

            lh_extra = data[lhoff + 30 + lh_nlen : lhoff + 30 + lh_nlen + lh_elen]
            data_start = lhoff + 30 + lh_nlen + lh_elen
            data_end = data_start + csize
            if data_end > len(data):
                raise ValueError(f"Truncated entry payload for {name}")
            raw_bytes = data[data_start:data_end]

            self.entries[name] = Entry(
                name=name,
                raw_bytes=raw_bytes,
                compress_method=method,
                crc=crc,
                csize=csize,
                usize=usize,
                mtime=mtime,
                mdate=mdate,
                v_made=v_made,
                v_ext=v_ext,
                flag=flag,
                disk=disk,
                iattr=iattr,
                eattr=eattr,
                cd_extra=cd_extra,
                lh_extra=lh_extra,
                comment=comment,
                lhoff=lhoff,
            )

    def __len__(self) -> int:
        return len(self.entries)

    def __contains__(self, name: str) -> bool:
        return name in self.entries

    def namelist(self) -> List[str]:
        return list(self.entries.keys())

    def has_entry(self, name: str) -> bool:
        return name in self.entries

    def get_entry(self, name: str) -> Entry:
        if name not in self.entries:
            raise KeyError(f"Entry not found in MozJar: {name}")
        return self.entries[name]

    def read_entry(self, name: str) -> bytes:
        """Read and decompress the named entry."""
        return self.get_entry(name).read()

    def read_text(self, name: str, encoding: str = "utf-8") -> str:
        """Read and decode the named entry as text."""
        return self.read_entry(name).decode(encoding)

    def set_entry(
        self,
        name: str,
        data_bytes: Union[bytes, bytearray, memoryview, str],
        compress: bool = False,
    ) -> Entry:
        """Update or add an entry in the archive.

        By default uses `method = 0` uncompressed store mode with
        `zlib.crc32(data_bytes) & 0xffffffff`, `csize = usize = len(data_bytes)`,
        `mtime = 0`, `mdate = 0x21`.
        """
        if isinstance(data_bytes, str):
            payload = data_bytes.encode("utf-8")
        else:
            payload = bytes(data_bytes)

        crc = zlib.crc32(payload) & 0xFFFFFFFF
        usize = len(payload)

        if compress:
            comp = zlib.compressobj(9, zlib.DEFLATED, -15)
            raw_bytes = comp.compress(payload) + comp.flush()
            method = 8
            v_ext = 20
        else:
            raw_bytes = payload
            method = 0
            v_ext = 10

        csize = len(raw_bytes)
        existing = self.entries.get(name)
        v_made = existing.v_made if existing is not None else 788
        eattr = existing.eattr if existing is not None else 0x81A40000

        entry = Entry(
            name=name,
            raw_bytes=raw_bytes,
            compress_method=method,
            crc=crc,
            csize=csize,
            usize=usize,
            mtime=0,
            mdate=0x21,
            v_made=v_made,
            v_ext=v_ext,
            flag=0,
            disk=0,
            iattr=0,
            eattr=eattr,
            cd_extra=b"",
            lh_extra=b"",
            comment=b"",
            lhoff=0,
        )
        self.entries[name] = entry
        return entry

    def remove_entry(self, name: str) -> None:
        if name in self.entries:
            del self.entries[name]

    def to_bytes(self, optimize: bool = True) -> bytes:
        """Serialize the archive into a Mozilla `optimizejars` (`omni.ja`) or standard ZIP byte buffer."""
        total_entries = len(self.entries)
        encoded_items = []
        cd_size = 0

        for entry in self.entries.values():
            name_bytes = entry.name.encode("utf-8", errors="surrogateescape")
            cd_rec_len = 46 + len(name_bytes) + len(entry.cd_extra) + len(entry.comment)
            lh_rec_len = 30 + len(name_bytes) + len(entry.lh_extra) + len(entry.raw_bytes)
            cd_size += cd_rec_len
            encoded_items.append((entry, name_bytes, cd_rec_len, lh_rec_len))

        if optimize:
            # Layout:
            # [0..4]: <I readahead
            # [4..4+cd_size]: Central Directory records
            # [4+cd_size..4+cd_size+22]: First EOCD (cd_offset = 4)
            # [4+cd_size+22..eocd2]: Local File Header + payload blocks
            # [eocd2..EOF]: Trailing 22-byte EOCD (cd_offset = 4)
            cd_offset = 4
            current_lhoff = 4 + cd_size + 22 + len(self.comment)
            cd_chunks: List[bytes] = []
            lh_chunks: List[bytes] = []

            for entry, name_bytes, _cd_rec_len, lh_rec_len in encoded_items:
                entry.lhoff = current_lhoff
                cd_header = CD_STRUCT.pack(
                    CD_SIGNATURE,
                    entry.v_made,
                    entry.v_ext,
                    entry.flag,
                    entry.compress_method,
                    entry.mtime,
                    entry.mdate,
                    entry.crc,
                    entry.csize,
                    entry.usize,
                    len(name_bytes),
                    len(entry.cd_extra),
                    len(entry.comment),
                    entry.disk,
                    entry.iattr,
                    entry.eattr,
                    current_lhoff,
                )
                cd_chunks.append(cd_header)
                cd_chunks.append(name_bytes)
                if entry.cd_extra:
                    cd_chunks.append(entry.cd_extra)
                if entry.comment:
                    cd_chunks.append(entry.comment)

                lh_header = LH_STRUCT.pack(
                    LH_SIGNATURE,
                    entry.v_ext,
                    entry.flag,
                    entry.compress_method,
                    entry.mtime,
                    entry.mdate,
                    entry.crc,
                    entry.csize,
                    entry.usize,
                    len(name_bytes),
                    len(entry.lh_extra),
                )
                lh_chunks.append(lh_header)
                lh_chunks.append(name_bytes)
                if entry.lh_extra:
                    lh_chunks.append(entry.lh_extra)
                lh_chunks.append(entry.raw_bytes)

                current_lhoff += lh_rec_len

            readahead_val = self.readahead if self.readahead > 0 else (current_lhoff - (4 + cd_size + 22))
            hdr_bytes = struct.pack("<I", readahead_val & 0xFFFFFFFF)
            eocd_bytes = (
                EOCD_STRUCT.pack(
                    EOCD_SIGNATURE,
                    0,
                    0,
                    total_entries,
                    total_entries,
                    cd_size,
                    cd_offset,
                    len(self.comment),
                )
                + self.comment
            )

            return b"".join([hdr_bytes, *cd_chunks, eocd_bytes, *lh_chunks, eocd_bytes])
        else:
            # Standard ZIP layout: Local headers first, then Central Directory, then EOCD
            current_lhoff = 0
            cd_chunks = []
            lh_chunks = []

            for entry, name_bytes, _cd_rec_len, lh_rec_len in encoded_items:
                entry.lhoff = current_lhoff
                lh_header = LH_STRUCT.pack(
                    LH_SIGNATURE,
                    entry.v_ext,
                    entry.flag,
                    entry.compress_method,
                    entry.mtime,
                    entry.mdate,
                    entry.crc,
                    entry.csize,
                    entry.usize,
                    len(name_bytes),
                    len(entry.lh_extra),
                )
                lh_chunks.append(lh_header)
                lh_chunks.append(name_bytes)
                if entry.lh_extra:
                    lh_chunks.append(entry.lh_extra)
                lh_chunks.append(entry.raw_bytes)

                cd_header = CD_STRUCT.pack(
                    CD_SIGNATURE,
                    entry.v_made,
                    entry.v_ext,
                    entry.flag,
                    entry.compress_method,
                    entry.mtime,
                    entry.mdate,
                    entry.crc,
                    entry.csize,
                    entry.usize,
                    len(name_bytes),
                    len(entry.cd_extra),
                    len(entry.comment),
                    entry.disk,
                    entry.iattr,
                    entry.eattr,
                    current_lhoff,
                )
                cd_chunks.append(cd_header)
                cd_chunks.append(name_bytes)
                if entry.cd_extra:
                    cd_chunks.append(entry.cd_extra)
                if entry.comment:
                    cd_chunks.append(entry.comment)

                current_lhoff += lh_rec_len

            cd_offset = current_lhoff
            eocd_bytes = (
                EOCD_STRUCT.pack(
                    EOCD_SIGNATURE,
                    0,
                    0,
                    total_entries,
                    total_entries,
                    cd_size,
                    cd_offset,
                    len(self.comment),
                )
                + self.comment
            )
            return b"".join([*lh_chunks, *cd_chunks, eocd_bytes])

    def save(self, out_path: Optional[Union[str, Path]] = None, optimize: bool = True) -> Path:
        """Write a 100% bit-valid Mozilla `optimizejars` `omni.ja` via atomic temp file + rename."""
        target = Path(out_path) if out_path is not None else self.path
        if target is None:
            raise ValueError("No output path specified for MozJar.save()")

        target.parent.mkdir(parents=True, exist_ok=True)
        payload = self.to_bytes(optimize=optimize)

        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{target.name}.",
            suffix=".tmp",
            dir=str(target.parent),
        )
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(payload)
            os.replace(tmp_name, target)
        except Exception:
            if os.path.exists(tmp_name):
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass
            raise

        return target


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Mozilla optimizejars (omni.ja) inspection & compiler utility")
    parser.add_argument("archive", type=Path, help="Path to omni.ja archive")
    parser.add_argument("--list", action="store_true", help="List entries in archive")
    parser.add_argument("--extract-entry", type=str, help="Print contents of a single entry to stdout")
    parser.add_argument("--verify", action="store_true", help="Verify all entries and CRC32 checksums")
    args = parser.parse_args(list(argv) if argv is not None else None)

    jar = MozJar.load(args.archive)
    if args.list:
        for name in jar.namelist():
            e = jar.get_entry(name)
            print(f"{e.usize:10d}  method={e.compress_method}  crc={e.crc:08x}  {name}")
    if args.extract_entry:
        sys.stdout.buffer.write(jar.read_entry(args.extract_entry))
    if args.verify:
        for name in jar.namelist():
            e = jar.get_entry(name)
            raw = jar.read_entry(name)
            calc_crc = zlib.crc32(raw) & 0xFFFFFFFF
            if calc_crc != e.crc:
                raise RuntimeError(f"CRC mismatch for {name}: expected {e.crc:08x}, got {calc_crc:08x}")
        print(f"[OK] Verified {len(jar)} entries in {args.archive} (optimized={jar.is_optimized})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
