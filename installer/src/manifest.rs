use serde::{Deserialize, Serialize};

pub const MANIFEST_FILENAME: &str = "dragon-manifest.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestFileEntry {
    pub path: String,
    pub size: u64,
    pub crc32: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallManifest {
    pub app_name: String,
    pub app_version: String,
    pub engine: String,
    pub engine_channel: String,
    pub engine_version: String,
    pub display_version: String,
    #[serde(default)]
    pub build_id: String,
    #[serde(default)]
    pub built_at_utc: String,
    pub file_count: usize,
    pub uncompressed_bytes: u64,
    #[serde(default)]
    pub files: Vec<ManifestFileEntry>,
}

impl InstallManifest {
    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, String> {
        serde_json::from_slice(bytes)
            .map_err(|err| format!("Invalid {MANIFEST_FILENAME} in installer payload: {err}"))
    }

    pub fn summary_line(&self) -> String {
        format!(
            "{} {} ({} {})",
            self.app_name, self.app_version, self.engine, self.display_version
        )
    }
}
