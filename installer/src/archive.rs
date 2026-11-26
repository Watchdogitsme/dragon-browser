use crate::manifest::{InstallManifest, MANIFEST_FILENAME};
use crc32fast::Hasher;
use flate2::read::DeflateDecoder;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

pub const TRAILER_MAGIC: &[u8; 8] = b"DRGNINST";
pub const TRAILER_VERSION: u32 = 1;
pub const TRAILER_SIZE: usize = 32;

const ZIP_EOCD_SIG: [u8; 4] = [0x50, 0x4B, 0x05, 0x06];
const ZIP_CD_SIG: [u8; 4] = [0x50, 0x4B, 0x01, 0x02];
const ZIP_LFH_SIG: [u8; 4] = [0x50, 0x4B, 0x03, 0x04];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SfxTrailer {
    pub format_version: u32,
    pub payload_offset: u64,
    pub payload_size: u64,
    pub payload_crc32: u32,
}

impl SfxTrailer {
    pub fn to_bytes(&self) -> [u8; TRAILER_SIZE] {
        let mut out = [0u8; TRAILER_SIZE];
        out[0..8].copy_from_slice(TRAILER_MAGIC);
        out[8..12].copy_from_slice(&self.format_version.to_le_bytes());
        out[12..20].copy_from_slice(&self.payload_offset.to_le_bytes());
        out[20..28].copy_from_slice(&self.payload_size.to_le_bytes());
        out[28..32].copy_from_slice(&self.payload_crc32.to_le_bytes());
        out
    }

    pub fn from_bytes(buf: &[u8; TRAILER_SIZE]) -> Result<Self, String> {
        if &buf[0..8] != TRAILER_MAGIC {
            return Err("Missing DRGNINST installer trailer (not a packaged Setup .exe)".to_string());
        }
        let format_version = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
        if format_version != TRAILER_VERSION {
            return Err(format!("Unsupported installer format version: {format_version}"));
        }
        let payload_offset = u64::from_le_bytes([
            buf[12], buf[13], buf[14], buf[15], buf[16], buf[17], buf[18], buf[19],
        ]);
        let payload_size = u64::from_le_bytes([
            buf[20], buf[21], buf[22], buf[23], buf[24], buf[25], buf[26], buf[27],
        ]);
        let payload_crc32 = u32::from_le_bytes([buf[28], buf[29], buf[30], buf[31]]);
        Ok(Self {
            format_version,
            payload_offset,
            payload_size,
            payload_crc32,
        })
    }
}

#[derive(Debug, Clone)]
pub struct ZipEntryMeta {
    pub name: String,
    pub method: u16,
    pub crc32: u32,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_header_offset: u64,
    pub is_dir: bool,
}

pub struct SfxArchive {
    file: File,
    pub trailer: SfxTrailer,
    pub entries: Vec<ZipEntryMeta>,
}

fn read_u16(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}

fn read_u32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

/// Sanitize a ZIP entry path and reject any path-traversal or absolute-path escape attempts.
pub fn sanitize_rel_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.contains('\0') {
        return Err(format!("Invalid empty or NUL path in archive: {raw:?}"));
    }
    let normalized = raw.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(format!("Invalid root-only path in archive: {raw:?}"));
    }
    if trimmed.starts_with('/') {
        return Err(format!("Absolute path rejected in archive: {raw:?}"));
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(format!("Drive-qualified path rejected in archive: {raw:?}"));
    }

    let mut clean = PathBuf::new();
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(format!("Path traversal ('..') rejected in archive: {raw:?}"));
        }
        clean.push(seg);
    }
    if clean.as_os_str().is_empty()
        || clean
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(format!("Unsafe path rejected in archive: {raw:?}"));
    }
    Ok(clean)
}

fn read_pe_security_dir(file: &mut File, total_len: u64) -> Option<(u64, u64)> {
    if total_len < 0x120 {
        return None;
    }
    let mut dos = [0u8; 64];
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_exact(&mut dos).ok()?;
    if &dos[0..2] != b"MZ" {
        return None;
    }
    let e_lfanew = read_u32(&dos, 0x3C) as u64;
    if e_lfanew == 0 || e_lfanew + 24 + 152 > total_len {
        return None;
    }
    let mut pe_hdr = [0u8; 24 + 152];
    file.seek(SeekFrom::Start(e_lfanew)).ok()?;
    file.read_exact(&mut pe_hdr).ok()?;
    if &pe_hdr[0..4] != b"PE\x00\x00" {
        return None;
    }
    let opt_magic = read_u16(&pe_hdr, 24);
    if opt_magic != 0x20B {
        return None;
    }
    let num_rva = read_u32(&pe_hdr, 24 + 108);
    if num_rva <= 4 {
        return None;
    }
    let cert_offset = read_u32(&pe_hdr, 24 + 144) as u64;
    let cert_size = read_u32(&pe_hdr, 24 + 148) as u64;
    if cert_offset == 0 || cert_size == 0 {
        return None;
    }
    let cert_end = cert_offset.checked_add(cert_size)?;
    if cert_end > total_len {
        return None;
    }
    Some((cert_offset, cert_size))
}

fn locate_trailer(file: &mut File, total_len: u64) -> Result<(SfxTrailer, u64), String> {
    if total_len < TRAILER_SIZE as u64 {
        return Err("Installer executable is smaller than trailer size".to_string());
    }

    if let Some((cert_offset, _cert_size)) = read_pe_security_dir(file, total_len) {
        // Authenticode appends 0..7 bytes of 8-byte alignment padding before WIN_CERTIFICATE.
        for pad in 0u64..=7 {
            if cert_offset < pad + TRAILER_SIZE as u64 {
                continue;
            }
            let trailer_pos = cert_offset - pad - TRAILER_SIZE as u64;
            file.seek(SeekFrom::Start(trailer_pos))
                .map_err(|e| format!("Seek signed trailer failed: {e}"))?;
            let mut trailer_buf = [0u8; TRAILER_SIZE];
            file.read_exact(&mut trailer_buf)
                .map_err(|e| format!("Read signed trailer failed: {e}"))?;
            if let Ok(trailer) = SfxTrailer::from_bytes(&trailer_buf) {
                if trailer.payload_offset.checked_add(trailer.payload_size) == Some(trailer_pos) {
                    return Ok((trailer, trailer_pos));
                }
            }
        }
        return Err(
            "Missing DRGNINST installer trailer before Authenticode signature".to_string(),
        );
    }

    let trailer_pos = total_len - TRAILER_SIZE as u64;
    file.seek(SeekFrom::Start(trailer_pos))
        .map_err(|e| format!("Seek trailer failed: {e}"))?;
    let mut trailer_buf = [0u8; TRAILER_SIZE];
    file.read_exact(&mut trailer_buf)
        .map_err(|e| format!("Read trailer failed: {e}"))?;
    let trailer = SfxTrailer::from_bytes(&trailer_buf)?;
    let payload_end = trailer
        .payload_offset
        .checked_add(trailer.payload_size)
        .ok_or_else(|| "Payload offset overflow".to_string())?;
    if payload_end != trailer_pos {
        return Err(format!(
            "Corrupt installer layout: expected trailer at {}, got {}",
            payload_end, trailer_pos
        ));
    }
    Ok((trailer, trailer_pos))
}

impl SfxArchive {
    pub fn open(exe_path: &Path) -> Result<Self, String> {
        let mut file =
            File::open(exe_path).map_err(|e| format!("Failed to open {}: {e}", exe_path.display()))?;
        let total_len = file
            .metadata()
            .map_err(|e| format!("Failed to stat {}: {e}", exe_path.display()))?
            .len();

        let (trailer, payload_end) = locate_trailer(&mut file, total_len)?;

        // Verify full payload CRC32 before parsing ZIP structures
        file.seek(SeekFrom::Start(trailer.payload_offset))
            .map_err(|e| format!("Seek payload failed: {e}"))?;
        let mut hasher = Hasher::new();
        let mut remaining = trailer.payload_size;
        let mut buf = vec![0u8; 256 * 1024];
        while remaining > 0 {
            let to_read = (remaining as usize).min(buf.len());
            file.read_exact(&mut buf[..to_read])
                .map_err(|e| format!("Failed reading payload for CRC check: {e}"))?;
            hasher.update(&buf[..to_read]);
            remaining -= to_read as u64;
        }
        let actual_crc = hasher.finalize();
        if actual_crc != trailer.payload_crc32 {
            return Err(format!(
                "Installer payload checksum mismatch (expected {:#010x}, got {:#010x})",
                trailer.payload_crc32, actual_crc
            ));
        }

        // Locate EOCD at tail of ZIP payload
        let tail_search_len = trailer.payload_size.min(65_557) as usize;
        let tail_start = payload_end - tail_search_len as u64;
        file.seek(SeekFrom::Start(tail_start))
            .map_err(|e| format!("Seek EOCD search region failed: {e}"))?;
        let mut tail = vec![0u8; tail_search_len];
        file.read_exact(&mut tail)
            .map_err(|e| format!("Read EOCD search region failed: {e}"))?;

        let eocd_rel = tail
            .windows(4)
            .rposition(|w| w == ZIP_EOCD_SIG)
            .ok_or_else(|| "ZIP End of Central Directory not found in installer payload".to_string())?;
        if eocd_rel + 22 > tail.len() {
            return Err("Truncated ZIP EOCD record".to_string());
        }
        let total_entries = read_u16(&tail, eocd_rel + 10) as usize;
        let cd_size = read_u32(&tail, eocd_rel + 12) as usize;
        let cd_offset = read_u32(&tail, eocd_rel + 16) as u64;

        let cd_abs = trailer.payload_offset + cd_offset;
        if cd_abs + cd_size as u64 > payload_end {
            return Err("ZIP Central Directory extends past payload bounds".to_string());
        }

        file.seek(SeekFrom::Start(cd_abs))
            .map_err(|e| format!("Seek Central Directory failed: {e}"))?;
        let mut cd_bytes = vec![0u8; cd_size];
        file.read_exact(&mut cd_bytes)
            .map_err(|e| format!("Read Central Directory failed: {e}"))?;

        let mut entries = Vec::with_capacity(total_entries);
        let mut pos = 0usize;
        for _ in 0..total_entries {
            if pos + 46 > cd_bytes.len() {
                return Err("Truncated ZIP Central Directory entry".to_string());
            }
            if cd_bytes[pos..pos + 4] != ZIP_CD_SIG {
                return Err("Invalid ZIP Central Directory signature".to_string());
            }
            let method = read_u16(&cd_bytes, pos + 10);
            let crc32 = read_u32(&cd_bytes, pos + 16);
            let compressed_size = read_u32(&cd_bytes, pos + 20) as u64;
            let uncompressed_size = read_u32(&cd_bytes, pos + 24) as u64;
            let name_len = read_u16(&cd_bytes, pos + 28) as usize;
            let extra_len = read_u16(&cd_bytes, pos + 30) as usize;
            let comment_len = read_u16(&cd_bytes, pos + 32) as usize;
            let lhoff = read_u32(&cd_bytes, pos + 42) as u64;

            let name_end = pos + 46 + name_len;
            let next_pos = name_end + extra_len + comment_len;
            if next_pos > cd_bytes.len() {
                return Err("Truncated ZIP Central Directory metadata".to_string());
            }
            let name = String::from_utf8(cd_bytes[pos + 46..name_end].to_vec())
                .map_err(|_| "Non-UTF-8 entry name in ZIP payload".to_string())?;
            let is_dir = name.ends_with('/') || name.ends_with('\\');
            // Always validate entry paths up front so traversal fails immediately
            let _ = sanitize_rel_path(&name)?;

            entries.push(ZipEntryMeta {
                name,
                method,
                crc32,
                compressed_size,
                uncompressed_size,
                local_header_offset: lhoff,
                is_dir,
            });
            pos = next_pos;
        }

        Ok(Self {
            file,
            trailer,
            entries,
        })
    }

    pub fn extract_entry_bytes(&mut self, entry: &ZipEntryMeta) -> Result<Vec<u8>, String> {
        let lfh_abs = self.trailer.payload_offset + entry.local_header_offset;
        self.file
            .seek(SeekFrom::Start(lfh_abs))
            .map_err(|e| format!("Seek LFH failed for {}: {e}", entry.name))?;
        let mut lfh = [0u8; 30];
        self.file
            .read_exact(&mut lfh)
            .map_err(|e| format!("Read LFH failed for {}: {e}", entry.name))?;
        if lfh[0..4] != ZIP_LFH_SIG {
            return Err(format!("Invalid ZIP Local File Header for {}", entry.name));
        }
        let name_len = read_u16(&lfh, 26) as u64;
        let extra_len = read_u16(&lfh, 28) as u64;
        let data_start = lfh_abs + 30 + name_len + extra_len;
        let payload_end = self.trailer.payload_offset + self.trailer.payload_size;
        if data_start + entry.compressed_size > payload_end {
            return Err(format!("Entry payload out of bounds for {}", entry.name));
        }

        self.file
            .seek(SeekFrom::Start(data_start))
            .map_err(|e| format!("Seek entry data failed for {}: {e}", entry.name))?;

        let mut raw = Vec::with_capacity(entry.uncompressed_size as usize);
        let limited = (&mut self.file).take(entry.compressed_size);
        match entry.method {
            0 => {
                let mut reader = limited;
                reader
                    .read_to_end(&mut raw)
                    .map_err(|e| format!("Read stored entry {} failed: {e}", entry.name))?;
            }
            8 => {
                let mut decoder = DeflateDecoder::new(limited);
                decoder
                    .read_to_end(&mut raw)
                    .map_err(|e| format!("Deflate decompression failed for {}: {e}", entry.name))?;
            }
            other => {
                return Err(format!(
                    "Unsupported ZIP compression method {other} for {}",
                    entry.name
                ));
            }
        }

        if raw.len() as u64 != entry.uncompressed_size {
            return Err(format!(
                "Size mismatch for {}: expected {} bytes, got {}",
                entry.name,
                entry.uncompressed_size,
                raw.len()
            ));
        }

        let mut hasher = Hasher::new();
        hasher.update(&raw);
        let actual_crc = hasher.finalize();
        if actual_crc != entry.crc32 {
            return Err(format!(
                "CRC32 mismatch for {}: expected {:#010x}, got {:#010x}",
                entry.name, entry.crc32, actual_crc
            ));
        }
        Ok(raw)
    }

    pub fn read_manifest(&mut self) -> Result<InstallManifest, String> {
        let entry = self
            .entries
            .iter()
            .find(|e| !e.is_dir && e.name == MANIFEST_FILENAME)
            .cloned()
            .ok_or_else(|| format!("Installer payload missing {MANIFEST_FILENAME}"))?;
        let bytes = self.extract_entry_bytes(&entry)?;
        InstallManifest::from_json_bytes(&bytes)
    }

    pub fn extract_all_to<F>(&mut self, dest_dir: &Path, mut on_progress: F) -> Result<(), String>
    where
        F: FnMut(usize, usize, &str),
    {
        let total = self.entries.len().max(1);
        let entries_snapshot = self.entries.clone();
        for (idx, entry) in entries_snapshot.iter().enumerate() {
            let rel = sanitize_rel_path(&entry.name)?;
            let target = dest_dir.join(&rel);
            if entry.is_dir {
                fs::create_dir_all(&target)
                    .map_err(|e| format!("Failed creating dir {}: {e}", target.display()))?;
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed creating dir {}: {e}", parent.display()))?;
                }
                let data = self.extract_entry_bytes(entry)?;
                fs::write(&target, &data)
                    .map_err(|e| format!("Failed writing {}: {e}", target.display()))?;
            }
            on_progress(idx + 1, total, &entry.name);
        }
        Ok(())
    }
}

/// Write only the executable stub (`0..payload_offset`) to `dest_path` so `uninstall.exe`
/// stays lightweight (~500 KB) without carrying the browser payload.
pub fn write_stripped_stub(
    exe_path: &Path,
    payload_offset: u64,
    dest_path: &Path,
) -> Result<(), String> {
    let mut src =
        File::open(exe_path).map_err(|e| format!("Open stub source failed: {e}"))?;
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create dir failed: {e}"))?;
    }
    let mut dst =
        File::create(dest_path).map_err(|e| format!("Create {} failed: {e}", dest_path.display()))?;
    let mut remaining = payload_offset;
    let mut buf = [0u8; 65_536];
    while remaining > 0 {
        let chunk = (remaining as usize).min(buf.len());
        src.read_exact(&mut buf[..chunk])
            .map_err(|e| format!("Read stub failed: {e}"))?;
        dst.write_all(&buf[..chunk])
            .map_err(|e| format!("Write uninstaller failed: {e}"))?;
        remaining -= chunk as u64;
    }
    dst.flush().map_err(|e| format!("Flush uninstaller failed: {e}"))?;
    Ok(())
}

/// Test helper: build a valid DEFLATE ZIP buffer from `(name, bytes)` pairs.
#[cfg(test)]
pub fn build_test_zip(items: &[(&str, &[u8])]) -> Vec<u8> {
    use flate2::write::DeflateEncoder;
    use flate2::Compression;

    let mut local_blob = Vec::new();
    let mut cd_blob = Vec::new();

    for &(name, data) in items {
        let mut crc_h = Hasher::new();
        crc_h.update(data);
        let crc = crc_h.finalize();

        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        enc.write_all(data).unwrap();
        let compressed = enc.finish().unwrap();

        let lhoff = local_blob.len() as u32;
        let name_bytes = name.as_bytes();

        local_blob.extend_from_slice(&ZIP_LFH_SIG);
        local_blob.extend_from_slice(&20u16.to_le_bytes());
        local_blob.extend_from_slice(&0u16.to_le_bytes());
        local_blob.extend_from_slice(&8u16.to_le_bytes());
        local_blob.extend_from_slice(&0u16.to_le_bytes());
        local_blob.extend_from_slice(&0x21u16.to_le_bytes());
        local_blob.extend_from_slice(&crc.to_le_bytes());
        local_blob.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        local_blob.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local_blob.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        local_blob.extend_from_slice(&0u16.to_le_bytes());
        local_blob.extend_from_slice(name_bytes);
        local_blob.extend_from_slice(&compressed);

        cd_blob.extend_from_slice(&ZIP_CD_SIG);
        cd_blob.extend_from_slice(&20u16.to_le_bytes());
        cd_blob.extend_from_slice(&20u16.to_le_bytes());
        cd_blob.extend_from_slice(&0u16.to_le_bytes());
        cd_blob.extend_from_slice(&8u16.to_le_bytes());
        cd_blob.extend_from_slice(&0u16.to_le_bytes());
        cd_blob.extend_from_slice(&0x21u16.to_le_bytes());
        cd_blob.extend_from_slice(&crc.to_le_bytes());
        cd_blob.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        cd_blob.extend_from_slice(&(data.len() as u32).to_le_bytes());
        cd_blob.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        cd_blob.extend_from_slice(&0u16.to_le_bytes());
        cd_blob.extend_from_slice(&0u16.to_le_bytes());
        cd_blob.extend_from_slice(&0u16.to_le_bytes());
        cd_blob.extend_from_slice(&0u16.to_le_bytes());
        cd_blob.extend_from_slice(&0u32.to_le_bytes());
        cd_blob.extend_from_slice(&lhoff.to_le_bytes());
        cd_blob.extend_from_slice(name_bytes);
    }

    let cd_offset = local_blob.len() as u32;
    let cd_size = cd_blob.len() as u32;
    let count = items.len() as u16;

    let mut out = Vec::new();
    out.extend_from_slice(&local_blob);
    out.extend_from_slice(&cd_blob);
    out.extend_from_slice(&ZIP_EOCD_SIG);
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// Test helper: build a complete SFX archive buffer (stub + ZIP + DRGNINST trailer).
#[cfg(test)]
pub fn build_test_sfx(stub: &[u8], zip_bytes: &[u8]) -> Vec<u8> {
    let mut crc_h = Hasher::new();
    crc_h.update(zip_bytes);
    let trailer = SfxTrailer {
        format_version: TRAILER_VERSION,
        payload_offset: stub.len() as u64,
        payload_size: zip_bytes.len() as u64,
        payload_crc32: crc_h.finalize(),
    };
    let mut out = Vec::with_capacity(stub.len() + zip_bytes.len() + TRAILER_SIZE);
    out.extend_from_slice(stub);
    out.extend_from_slice(zip_bytes);
    out.extend_from_slice(&trailer.to_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dragon_arch_test_{name}_{}_{nanos}", std::process::id()))
    }

    #[test]
    fn sanitize_rejects_traversal_and_absolute_paths() {
        assert_eq!(
            sanitize_rel_path("runtime/dragon.exe").unwrap(),
            PathBuf::from("runtime").join("dragon.exe")
        );
        assert!(sanitize_rel_path("../evil.txt").is_err());
        assert!(sanitize_rel_path("runtime/../../evil.txt").is_err());
        assert!(sanitize_rel_path("/etc/passwd").is_err());
        assert!(sanitize_rel_path(r"C:\Windows\System32\cmd.exe").is_err());
        assert!(sanitize_rel_path("").is_err());
    }

    #[test]
    fn sfx_round_trip_verifies_crc_and_detects_corruption() {
        let sfx_path = temp_path("sfx.exe");
        let stub = b"MZ-FAKE-STUB-BINARY-HEADER";
        let manifest = serde_json::json!({
            "app_name": "Dragon Browser",
            "app_version": "1.0.0",
            "engine": "Dragon Gecko ESR",
            "engine_channel": "esr",
            "engine_version": "153.7.0",
            "display_version": "153.7.0esr",
            "file_count": 1,
            "uncompressed_bytes": 12
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let zip_bytes = build_test_zip(&[
            (MANIFEST_FILENAME, &manifest_bytes),
            ("runtime/hello.txt", b"hello dragon"),
        ]);
        let mut sfx = build_test_sfx(stub, &zip_bytes);
        fs::write(&sfx_path, &sfx).unwrap();

        let mut arc = SfxArchive::open(&sfx_path).expect("open valid SFX");
        let parsed = arc.read_manifest().expect("read manifest");
        assert_eq!(parsed.engine_version, "153.7.0");
        let extract_dir = temp_path("extract");
        arc.extract_all_to(&extract_dir, |_, _, _| {}).expect("extract");
        assert_eq!(
            fs::read(extract_dir.join("runtime").join("hello.txt")).unwrap(),
            b"hello dragon"
        );

        // Corrupt a byte in payload and verify rejection
        sfx[stub.len() + 4] ^= 0xFF;
        fs::write(&sfx_path, &sfx).unwrap();
        assert!(SfxArchive::open(&sfx_path).is_err());

        let _ = fs::remove_file(&sfx_path);
        let _ = fs::remove_dir_all(&extract_dir);
    }

    #[test]
    fn sfx_rejects_zip_slip_entry_names() {
        let sfx_path = temp_path("zipslip.exe");
        let zip_bytes = build_test_zip(&[("../escape.txt", b"bad")]);
        let sfx = build_test_sfx(b"STUB", &zip_bytes);
        fs::write(&sfx_path, sfx).unwrap();
        let err = match SfxArchive::open(&sfx_path) {
            Ok(_) => panic!("expected zip-slip error"),
            Err(e) => e,
        };
        assert!(err.contains(".."));
        let _ = fs::remove_file(&sfx_path);
    }

    #[test]
    fn sfx_opens_authenticode_signed_pe_with_alignment_padding() {
        let manifest = serde_json::json!({
            "app_name": "Dragon Browser",
            "app_version": "1.0.0",
            "engine": "Dragon Gecko ESR",
            "engine_channel": "esr",
            "engine_version": "153.7.0",
            "display_version": "153.7.0esr",
            "file_count": 1,
            "uncompressed_bytes": 12
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let zip_bytes = build_test_zip(&[
            (MANIFEST_FILENAME, &manifest_bytes),
            ("runtime/hello.txt", b"signed-sfx"),
        ]);

        for pad_len in 0usize..=7 {
            let sfx_path = temp_path(&format!("signed_pad_{pad_len}.exe"));
            let mut stub = vec![0u8; 0x200];
            stub[0..2].copy_from_slice(b"MZ");
            stub[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
            stub[0x80..0x84].copy_from_slice(b"PE\x00\x00");
            stub[0x84..0x86].copy_from_slice(&0x8664u16.to_le_bytes());
            stub[0x98..0x9A].copy_from_slice(&0x20Bu16.to_le_bytes());
            stub[0x104..0x108].copy_from_slice(&16u32.to_le_bytes());

            let mut sfx = build_test_sfx(&stub, &zip_bytes);
            sfx.extend(std::iter::repeat_n(0u8, pad_len));
            let cert_offset = sfx.len() as u32;
            let fake_cert = vec![0x30u8; 64];
            sfx.extend_from_slice(&fake_cert);
            // Write PE32+ DataDirectory[4] (offset = 0x80 + 24 + 144 = 0x128)
            sfx[0x128..0x12C].copy_from_slice(&cert_offset.to_le_bytes());
            sfx[0x12C..0x130].copy_from_slice(&(fake_cert.len() as u32).to_le_bytes());

            fs::write(&sfx_path, &sfx).unwrap();
            let mut arc = SfxArchive::open(&sfx_path).expect("open signed SFX");
            let parsed = arc.read_manifest().expect("read signed manifest");
            assert_eq!(parsed.engine_version, "153.7.0");

            // Flip a byte inside ZIP payload and verify rejection
            sfx[stub.len() + 2] ^= 0x55;
            fs::write(&sfx_path, &sfx).unwrap();
            assert!(SfxArchive::open(&sfx_path).is_err());

            let _ = fs::remove_file(&sfx_path);
        }
    }
}
