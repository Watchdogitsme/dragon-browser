use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const IMAGE_FILE_MACHINE_AMD64: u16 = 0x8664;
const IMAGE_SCN_CNT_INITIALIZED_DATA: u32 = 0x0000_0040;
const IMAGE_SCN_MEM_READ: u32 = 0x4000_0000;
const IMAGE_REL_AMD64_ADDR32NB: u16 = 0x0003;
const IMAGE_SYM_CLASS_STATIC: u8 = 3;

const RT_ICON: u32 = 3;
const RT_GROUP_ICON: u32 = 14;
const LANG_EN_US: u32 = 0x0409;
const SUBDIR_FLAG: u32 = 0x8000_0000;

#[derive(Debug, Clone)]
struct IconFrame<'a> {
    width: u8,
    height: u8,
    color_count: u8,
    reserved: u8,
    planes: u16,
    bit_count: u16,
    bytes: &'a [u8],
}

fn read_u16_le(buf: &[u8], off: usize) -> Result<u16, String> {
    let slice = buf
        .get(off..off + 2)
        .ok_or_else(|| format!("Unexpected EOF reading u16 at offset {off}"))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32_le(buf: &[u8], off: usize) -> Result<u32, String> {
    let slice = buf
        .get(off..off + 4)
        .ok_or_else(|| format!("Unexpected EOF reading u32 at offset {off}"))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn parse_ico(ico_bytes: &[u8]) -> Result<Vec<IconFrame<'_>>, String> {
    if ico_bytes.len() < 6 {
        return Err("ICO data is too small".to_string());
    }
    let reserved = read_u16_le(ico_bytes, 0)?;
    let ico_type = read_u16_le(ico_bytes, 2)?;
    let count = read_u16_le(ico_bytes, 4)? as usize;
    if reserved != 0 || ico_type != 1 || count == 0 {
        return Err(format!(
            "Invalid ICO header: reserved={reserved}, type={ico_type}, count={count}"
        ));
    }
    let dir_end = 6 + count * 16;
    if ico_bytes.len() < dir_end {
        return Err("ICO directory truncated".to_string());
    }

    let mut frames = Vec::with_capacity(count);
    for i in 0..count {
        let base = 6 + i * 16;
        let width = ico_bytes[base];
        let height = ico_bytes[base + 1];
        let color_count = ico_bytes[base + 2];
        let entry_reserved = ico_bytes[base + 3];
        let planes = read_u16_le(ico_bytes, base + 4)?;
        let bit_count = read_u16_le(ico_bytes, base + 6)?;
        let bytes_in_res = read_u32_le(ico_bytes, base + 8)? as usize;
        let image_offset = read_u32_le(ico_bytes, base + 12)? as usize;

        let end = image_offset
            .checked_add(bytes_in_res)
            .ok_or_else(|| "ICO frame offset overflow".to_string())?;
        let slice = ico_bytes
            .get(image_offset..end)
            .ok_or_else(|| format!("ICO frame {i} out of bounds"))?;
        frames.push(IconFrame {
            width,
            height,
            color_count,
            reserved: entry_reserved,
            planes,
            bit_count,
            bytes: slice,
        });
    }
    Ok(frames)
}

fn push_dir_header(out: &mut Vec<u8>, id_count: u16) {
    out.extend_from_slice(&0u32.to_le_bytes()); // Characteristics
    out.extend_from_slice(&0u32.to_le_bytes()); // TimeDateStamp
    out.extend_from_slice(&0u16.to_le_bytes()); // MajorVersion
    out.extend_from_slice(&0u16.to_le_bytes()); // MinorVersion
    out.extend_from_slice(&0u16.to_le_bytes()); // NumberOfNamedEntries
    out.extend_from_slice(&id_count.to_le_bytes()); // NumberOfIdEntries
}

fn push_dir_entry(out: &mut Vec<u8>, id: u32, offset: u32) {
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(&offset.to_le_bytes());
}

fn pad4(out: &mut Vec<u8>) {
    while out.len() % 4 != 0 {
        out.push(0);
    }
}

/// Build an x86_64 Windows COFF object (`.o`) containing `.rsrc` with `RT_ICON` and
/// `RT_GROUP_ICON` resources parsed from `ico_bytes`.
pub fn build_ico_coff_x86_64(ico_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let frames = parse_ico(ico_bytes)?;
    let n = frames.len();

    // Precompute GRPICONDIR payload (6 + 14 * N)
    let mut group_blob = Vec::with_capacity(6 + n * 14);
    group_blob.extend_from_slice(&0u16.to_le_bytes());
    group_blob.extend_from_slice(&1u16.to_le_bytes());
    group_blob.extend_from_slice(&(n as u16).to_le_bytes());
    for (idx, f) in frames.iter().enumerate() {
        let icon_id = (idx + 1) as u16;
        group_blob.push(f.width);
        group_blob.push(f.height);
        group_blob.push(f.color_count);
        group_blob.push(f.reserved);
        group_blob.extend_from_slice(&f.planes.to_le_bytes());
        group_blob.extend_from_slice(&f.bit_count.to_le_bytes());
        group_blob.extend_from_slice(&(f.bytes.len() as u32).to_le_bytes());
        group_blob.extend_from_slice(&icon_id.to_le_bytes());
    }

    // Layout `.rsrc` directory tables:
    // 1. Root directory (2 entries: RT_ICON=3, RT_GROUP_ICON=14): 16 + 2*8 = 32 bytes
    let root_off = 0u32;
    let rt_icon_dir_off = 32u32; // 16 + n*8 bytes
    let rt_group_dir_off = rt_icon_dir_off + 16 + (n as u32) * 8; // 16 + 1*8 = 24 bytes
    let lang_dirs_off = rt_group_dir_off + 24; // (n + 1) lang dirs, each 16 + 8 = 24 bytes
    let data_entries_off = lang_dirs_off + ((n + 1) as u32) * 24; // (n + 1) entries, each 16 bytes
    let payload_start_off = data_entries_off + ((n + 1) as u32) * 16;

    let mut rsrc = Vec::with_capacity(payload_start_off as usize + ico_bytes.len() + 256);

    // Root dir
    push_dir_header(&mut rsrc, 2);
    push_dir_entry(&mut rsrc, RT_ICON, SUBDIR_FLAG | rt_icon_dir_off);
    push_dir_entry(&mut rsrc, RT_GROUP_ICON, SUBDIR_FLAG | rt_group_dir_off);

    // RT_ICON name/ID dir (IDs 1..=N)
    push_dir_header(&mut rsrc, n as u16);
    for idx in 0..n {
        let lang_off = lang_dirs_off + (idx as u32) * 24;
        push_dir_entry(&mut rsrc, (idx + 1) as u32, SUBDIR_FLAG | lang_off);
    }

    // RT_GROUP_ICON name/ID dir (ID 1)
    push_dir_header(&mut rsrc, 1);
    let group_lang_off = lang_dirs_off + (n as u32) * 24;
    push_dir_entry(&mut rsrc, 1, SUBDIR_FLAG | group_lang_off);

    // Language dirs (N icon leaves + 1 group leaf)
    for idx in 0..=n {
        let data_entry_off = data_entries_off + (idx as u32) * 16;
        push_dir_header(&mut rsrc, 1);
        push_dir_entry(&mut rsrc, LANG_EN_US, data_entry_off);
    }

    debug_assert_eq!(rsrc.len(), data_entries_off as usize);

    // Reserve space for IMAGE_RESOURCE_DATA_ENTRY records; fill after placing payloads
    rsrc.resize(payload_start_off as usize, 0);

    let mut relocs: Vec<(u32, u32)> = Vec::with_capacity(n + 1);
    for (idx, frame) in frames.iter().enumerate() {
        pad4(&mut rsrc);
        let blob_off = rsrc.len() as u32;
        rsrc.extend_from_slice(frame.bytes);

        let entry_off = data_entries_off as usize + idx * 16;
        rsrc[entry_off..entry_off + 4].copy_from_slice(&blob_off.to_le_bytes());
        rsrc[entry_off + 4..entry_off + 8].copy_from_slice(&(frame.bytes.len() as u32).to_le_bytes());
        relocs.push((entry_off as u32, 0));
    }

    pad4(&mut rsrc);
    let group_blob_off = rsrc.len() as u32;
    rsrc.extend_from_slice(&group_blob);
    let group_entry_off = data_entries_off as usize + n * 16;
    rsrc[group_entry_off..group_entry_off + 4].copy_from_slice(&group_blob_off.to_le_bytes());
    rsrc[group_entry_off + 4..group_entry_off + 8]
        .copy_from_slice(&(group_blob.len() as u32).to_le_bytes());
    relocs.push((group_entry_off as u32, 0));

    pad4(&mut rsrc);
    let _ = root_off;

    let rsrc_size = rsrc.len() as u32;
    let raw_data_ptr = 20u32 + 40u32;
    let relocs_ptr = raw_data_ptr + rsrc_size;
    let symtab_ptr = relocs_ptr + (relocs.len() as u32) * 10;

    let mut coff = Vec::with_capacity(symtab_ptr as usize + 18 + 4);

    // IMAGE_FILE_HEADER (20 bytes)
    coff.extend_from_slice(&IMAGE_FILE_MACHINE_AMD64.to_le_bytes());
    coff.extend_from_slice(&1u16.to_le_bytes()); // NumberOfSections
    coff.extend_from_slice(&0u32.to_le_bytes()); // TimeDateStamp
    coff.extend_from_slice(&symtab_ptr.to_le_bytes());
    coff.extend_from_slice(&1u32.to_le_bytes()); // NumberOfSymbols
    coff.extend_from_slice(&0u16.to_le_bytes()); // SizeOfOptionalHeader
    coff.extend_from_slice(&0u16.to_le_bytes()); // Characteristics

    // IMAGE_SECTION_HEADER ".rsrc" (40 bytes)
    coff.extend_from_slice(b".rsrc\0\0\0");
    coff.extend_from_slice(&0u32.to_le_bytes()); // VirtualSize
    coff.extend_from_slice(&0u32.to_le_bytes()); // VirtualAddress
    coff.extend_from_slice(&rsrc_size.to_le_bytes());
    coff.extend_from_slice(&raw_data_ptr.to_le_bytes());
    coff.extend_from_slice(&relocs_ptr.to_le_bytes());
    coff.extend_from_slice(&0u32.to_le_bytes()); // PointerToLinenumbers
    coff.extend_from_slice(&(relocs.len() as u16).to_le_bytes());
    coff.extend_from_slice(&0u16.to_le_bytes()); // NumberOfLinenumbers
    coff.extend_from_slice(&(IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ).to_le_bytes());

    // Section raw data
    coff.extend_from_slice(&rsrc);

    // Relocations (10 bytes each)
    for (va, sym_idx) in relocs {
        coff.extend_from_slice(&va.to_le_bytes());
        coff.extend_from_slice(&sym_idx.to_le_bytes());
        coff.extend_from_slice(&IMAGE_REL_AMD64_ADDR32NB.to_le_bytes());
    }

    // Symbol table entry for `.rsrc` (18 bytes)
    coff.extend_from_slice(b".rsrc\0\0\0");
    coff.extend_from_slice(&0u32.to_le_bytes()); // Value
    coff.extend_from_slice(&1i16.to_le_bytes()); // SectionNumber (1-based)
    coff.extend_from_slice(&0u16.to_le_bytes()); // Type
    coff.push(IMAGE_SYM_CLASS_STATIC);
    coff.push(0); // NumberOfAuxSymbols

    // Empty COFF string table (4-byte size)
    coff.extend_from_slice(&4u32.to_le_bytes());

    Ok(coff)
}

/// Helper intended for `build.rs`: embeds `ico_path` (relative to `CARGO_MANIFEST_DIR` or absolute)
/// into Windows x86_64 binaries by emitting a `.rsrc` COFF object in `OUT_DIR`.
pub fn emit_ico_coff_for_build_rs(ico_path: &Path) -> Result<Option<PathBuf>, String> {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").ok_or_else(|| "CARGO_MANIFEST_DIR not set".to_string())?,
    );
    let resolved_ico = if ico_path.is_absolute() {
        ico_path.to_path_buf()
    } else {
        manifest_dir.join(ico_path)
    };
    println!("cargo:rerun-if-changed={}", resolved_ico.display());

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if target_os != "windows" || target_arch != "x86_64" {
        return Ok(None);
    }

    let ico_bytes = fs::read(&resolved_ico)
        .map_err(|e| format!("Failed to read ICO {}: {e}", resolved_ico.display()))?;
    let coff_bytes = build_ico_coff_x86_64(&ico_bytes)?;

    let out_dir = PathBuf::from(
        env::var_os("OUT_DIR").ok_or_else(|| "OUT_DIR not set".to_string())?,
    );
    let obj_path = out_dir.join("dragon_icon.obj");
    fs::write(&obj_path, coff_bytes)
        .map_err(|e| format!("Failed to write {}: {e}", obj_path.display()))?;

    println!("cargo:rustc-link-arg={}", obj_path.display());
    Ok(Some(obj_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_valid_coff_rsrc_from_repo_dragon_ico() {
        let ico_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("assets")
            .join("dragon.ico");
        let ico_bytes = fs::read(&ico_path).expect("read assets/dragon.ico");
        let frames = parse_ico(&ico_bytes).expect("parse dragon.ico");
        assert!(!frames.is_empty());

        let coff = build_ico_coff_x86_64(&ico_bytes).expect("build COFF .rsrc");
        assert_eq!(read_u16_le(&coff, 0).unwrap(), IMAGE_FILE_MACHINE_AMD64);
        assert_eq!(read_u16_le(&coff, 2).unwrap(), 1);
        assert_eq!(&coff[20..28], b".rsrc\0\0\0");

        let rsrc_size = read_u32_le(&coff, 36).unwrap() as usize;
        let raw_ptr = read_u32_le(&coff, 40).unwrap() as usize;
        let reloc_ptr = read_u32_le(&coff, 44).unwrap() as usize;
        let reloc_count = read_u16_le(&coff, 52).unwrap() as usize;

        assert_eq!(raw_ptr, 60);
        assert_eq!(reloc_count, frames.len() + 1);
        assert_eq!(reloc_ptr, raw_ptr + rsrc_size);

        let rsrc = &coff[raw_ptr..raw_ptr + rsrc_size];
        // Root dir has 2 ID entries: RT_ICON(3) and RT_GROUP_ICON(14)
        assert_eq!(read_u16_le(rsrc, 14).unwrap(), 2);
        assert_eq!(read_u32_le(rsrc, 16).unwrap(), RT_ICON);
        assert_eq!(read_u32_le(rsrc, 24).unwrap(), RT_GROUP_ICON);

        // Verify each relocation points inside `.rsrc` and uses ADDR32NB
        for i in 0..reloc_count {
            let r_off = reloc_ptr + i * 10;
            let va = read_u32_le(&coff, r_off).unwrap() as usize;
            let sym = read_u32_le(&coff, r_off + 4).unwrap();
            let rtype = read_u16_le(&coff, r_off + 8).unwrap();
            assert!(va + 4 <= rsrc_size);
            assert_eq!(sym, 0);
            assert_eq!(rtype, IMAGE_REL_AMD64_ADDR32NB);
        }
    }

    #[test]
    fn rejects_invalid_ico_bytes() {
        assert!(build_ico_coff_x86_64(b"not-an-ico").is_err());
        assert!(build_ico_coff_x86_64(&[0, 0, 2, 0, 1, 0]).is_err());
    }
}
