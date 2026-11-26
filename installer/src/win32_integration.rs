#![cfg(windows)]

use crate::manifest::InstallManifest;
use std::ffi::OsStr;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;

const CSIDL_PROGRAMS: i32 = 0x0002;
const CSIDL_DESKTOPDIRECTORY: i32 = 0x0010;
const CSIDL_LOCAL_APPDATA: i32 = 0x001C;
const MAX_PATH: usize = 260;

const COINIT_APARTMENTTHREADED: u32 = 0x2;
const CLSCTX_INPROC_SERVER: u32 = 0x1;

const GENERIC_WRITE: u32 = 0x4000_0000;
const OPEN_EXISTING: u32 = 3;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
const INVALID_HANDLE_VALUE: isize = -1;

const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as isize;
const KEY_WRITE: u32 = 0x20006;
const REG_SZ: u32 = 1;
const REG_DWORD: u32 = 4;

const UNINSTALL_REG_SUBKEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\DragonBrowser";

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

const CLSID_SHELL_LINK: Guid = Guid {
    data1: 0x0002_1401,
    data2: 0x0000,
    data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

const IID_ISHELL_LINK_W: Guid = Guid {
    data1: 0x0002_14F9,
    data2: 0x0000,
    data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

const IID_IPERSIST_FILE: Guid = Guid {
    data1: 0x0000_010B,
    data2: 0x0000,
    data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

#[repr(C)]
struct ComObject {
    vtbl: *const *const core::ffi::c_void,
}

#[repr(C)]
#[derive(Default)]
struct StartupInfoW {
    cb: u32,
    lp_reserved: *mut u16,
    lp_desktop: *mut u16,
    lp_title: *mut u16,
    dw_x: u32,
    dw_y: u32,
    dw_x_size: u32,
    dw_y_size: u32,
    dw_x_count_chars: u32,
    dw_y_count_chars: u32,
    dw_fill_attribute: u32,
    dw_flags: u32,
    w_show_window: u16,
    cb_reserved2: u16,
    lp_reserved2: *mut u8,
    h_std_input: isize,
    h_std_output: isize,
    h_std_error: isize,
}

#[repr(C)]
#[derive(Default)]
struct ProcessInformation {
    h_process: isize,
    h_thread: isize,
    dw_process_id: u32,
    dw_thread_id: u32,
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[link(name = "shell32")]
extern "system" {
    fn SHGetFolderPathW(
        hwnd: *mut core::ffi::c_void,
        csidl: i32,
        h_token: *mut core::ffi::c_void,
        dw_flags: u32,
        psz_path: *mut u16,
    ) -> i32;
}

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(pv_reserved: *mut core::ffi::c_void, dw_co_init: u32) -> i32;
    fn CoUninitialize();
    fn CoCreateInstance(
        rclsid: *const Guid,
        p_unk_outer: *mut core::ffi::c_void,
        dw_cls_context: u32,
        riid: *const Guid,
        ppv: *mut *mut core::ffi::c_void,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        lp_file_name: *const u16,
        dw_desired_access: u32,
        dw_share_mode: u32,
        lp_security_attributes: *mut core::ffi::c_void,
        dw_creation_disposition: u32,
        dw_flags_and_attributes: u32,
        h_template_file: isize,
    ) -> isize;
    fn CloseHandle(h_object: isize) -> i32;
    fn CreateProcessW(
        lp_application_name: *const u16,
        lp_command_line: *mut u16,
        lp_process_attributes: *mut core::ffi::c_void,
        lp_thread_attributes: *mut core::ffi::c_void,
        b_inherit_handles: i32,
        dw_creation_flags: u32,
        lp_environment: *mut core::ffi::c_void,
        lp_current_directory: *const u16,
        lp_startup_info: *const StartupInfoW,
        lp_process_information: *mut ProcessInformation,
    ) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn RegCreateKeyExW(
        h_key: isize,
        lp_sub_key: *const u16,
        reserved: u32,
        lp_class: *const u16,
        dw_options: u32,
        sam_desired: u32,
        lp_security_attributes: *mut core::ffi::c_void,
        phk_result: *mut isize,
        lpdw_disposition: *mut u32,
    ) -> i32;
    fn RegSetValueExW(
        h_key: isize,
        lp_value_name: *const u16,
        reserved: u32,
        dw_type: u32,
        lp_data: *const u8,
        cb_data: u32,
    ) -> i32;
    fn RegCloseKey(h_key: isize) -> i32;
    fn RegDeleteTreeW(h_key: isize, lp_sub_key: *const u16) -> i32;
}

pub fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

pub fn from_wide_nul(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

fn special_folder(csidl: i32) -> Option<PathBuf> {
    let mut buf = [0u16; MAX_PATH + 1];
    let hr = unsafe { SHGetFolderPathW(ptr::null_mut(), csidl, ptr::null_mut(), 0, buf.as_mut_ptr()) };
    if hr >= 0 {
        let s = from_wide_nul(&buf);
        if !s.is_empty() {
            return Some(PathBuf::from(s));
        }
    }
    None
}

pub fn default_install_dir() -> PathBuf {
    if let Some(local) = special_folder(CSIDL_LOCAL_APPDATA) {
        return local.join("Dragon Browser");
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local).join("Dragon Browser");
    }
    PathBuf::from(r"C:\Dragon Browser")
}

pub fn desktop_shortcut_path() -> Option<PathBuf> {
    special_folder(CSIDL_DESKTOPDIRECTORY).map(|p| p.join("Dragon Browser.lnk"))
}

pub fn start_menu_shortcut_path() -> Option<PathBuf> {
    special_folder(CSIDL_PROGRAMS).map(|p| p.join("Dragon Browser.lnk"))
}

/// Probe existing browser executables for exclusive write lock so upgrades fail fast
/// with a clear prompt if Dragon Browser is currently running.
pub fn check_not_running(install_dir: &Path) -> Result<(), String> {
    for rel in ["runtime\\dragon.exe", "runtime\\firefox.exe", "dragon-browser.exe"] {
        let path = install_dir.join(rel);
        if !path.is_file() {
            continue;
        }
        let wide = to_wide(&path.to_string_lossy());
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_WRITE,
                0,
                ptr::null_mut(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                0,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "Dragon Browser appears to be running ({} is currently in use).\nPlease close all Dragon Browser windows and try again.",
                path.display()
            ));
        }
        unsafe {
            CloseHandle(handle);
        }
    }
    Ok(())
}

pub fn create_shortcut(
    lnk_path: &Path,
    target_exe: &Path,
    working_dir: &Path,
    icon_path: &Path,
    description: &str,
) -> Result<(), String> {
    if let Some(parent) = lnk_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create shortcut folder failed: {e}"))?;
    }

    unsafe {
        let hr_init = CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED);
        let should_uninit = hr_init >= 0;

        let res = (|| -> Result<(), String> {
            let mut psl_raw: *mut core::ffi::c_void = ptr::null_mut();
            let hr = CoCreateInstance(
                &CLSID_SHELL_LINK,
                ptr::null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_ISHELL_LINK_W,
                &mut psl_raw,
            );
            if hr < 0 || psl_raw.is_null() {
                return Err(format!("CoCreateInstance(IShellLinkW) failed: {hr:#x}"));
            }

            let psl = psl_raw as *mut ComObject;
            let vtbl = (*psl).vtbl;

            type QueryInterfaceFn = unsafe extern "system" fn(
                *mut core::ffi::c_void,
                *const Guid,
                *mut *mut core::ffi::c_void,
            ) -> i32;
            type ReleaseFn = unsafe extern "system" fn(*mut core::ffi::c_void) -> u32;
            type SetStrFn =
                unsafe extern "system" fn(*mut core::ffi::c_void, *const u16) -> i32;
            type SetIconFn =
                unsafe extern "system" fn(*mut core::ffi::c_void, *const u16, i32) -> i32;
            type SaveFn =
                unsafe extern "system" fn(*mut core::ffi::c_void, *const u16, i32) -> i32;

            let query_interface: QueryInterfaceFn = core::mem::transmute(*vtbl.add(0));
            let release_link: ReleaseFn = core::mem::transmute(*vtbl.add(2));
            let set_description: SetStrFn = core::mem::transmute(*vtbl.add(7));
            let set_working_dir: SetStrFn = core::mem::transmute(*vtbl.add(9));
            let set_icon_location: SetIconFn = core::mem::transmute(*vtbl.add(17));
            let set_path: SetStrFn = core::mem::transmute(*vtbl.add(20));

            let target_w = to_wide(&target_exe.to_string_lossy());
            let work_w = to_wide(&working_dir.to_string_lossy());
            let icon_w = to_wide(&icon_path.to_string_lossy());
            let desc_w = to_wide(description);

            let _ = set_path(psl_raw, target_w.as_ptr());
            let _ = set_working_dir(psl_raw, work_w.as_ptr());
            let _ = set_icon_location(psl_raw, icon_w.as_ptr(), 0);
            let _ = set_description(psl_raw, desc_w.as_ptr());

            let mut ppf_raw: *mut core::ffi::c_void = ptr::null_mut();
            let hr_qi = query_interface(psl_raw, &IID_IPERSIST_FILE, &mut ppf_raw);
            if hr_qi < 0 || ppf_raw.is_null() {
                release_link(psl_raw);
                return Err(format!("QueryInterface(IPersistFile) failed: {hr_qi:#x}"));
            }

            let ppf = ppf_raw as *mut ComObject;
            let pf_vtbl = (*ppf).vtbl;
            let release_pf: ReleaseFn = core::mem::transmute(*pf_vtbl.add(2));
            let save_pf: SaveFn = core::mem::transmute(*pf_vtbl.add(6));

            let lnk_w = to_wide(&lnk_path.to_string_lossy());
            let hr_save = save_pf(ppf_raw, lnk_w.as_ptr(), 1);
            release_pf(ppf_raw);
            release_link(psl_raw);

            if hr_save < 0 {
                return Err(format!("IPersistFile::Save failed: {hr_save:#x}"));
            }
            Ok(())
        })();

        if should_uninit {
            CoUninitialize();
        }
        res
    }
}

pub fn remove_shortcuts() {
    if let Some(desktop) = desktop_shortcut_path() {
        let _ = fs::remove_file(desktop);
    }
    if let Some(start_menu) = start_menu_shortcut_path() {
        let _ = fs::remove_file(start_menu);
    }
}

fn reg_set_sz(hkey: isize, name: &str, value: &str) {
    let name_w = to_wide(name);
    let val_w = to_wide(value);
    let byte_len = (val_w.len() * 2) as u32;
    unsafe {
        RegSetValueExW(
            hkey,
            name_w.as_ptr(),
            0,
            REG_SZ,
            val_w.as_ptr() as *const u8,
            byte_len,
        );
    }
}

fn reg_set_dword(hkey: isize, name: &str, value: u32) {
    let name_w = to_wide(name);
    let bytes = value.to_le_bytes();
    unsafe {
        RegSetValueExW(hkey, name_w.as_ptr(), 0, REG_DWORD, bytes.as_ptr(), 4);
    }
}

pub fn register_uninstall_entry(
    install_dir: &Path,
    manifest: &InstallManifest,
) -> Result<(), String> {
    let subkey_w = to_wide(UNINSTALL_REG_SUBKEY);
    let mut hkey: isize = 0;
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey_w.as_ptr(),
            0,
            ptr::null(),
            0,
            KEY_WRITE,
            ptr::null_mut(),
            &mut hkey,
            ptr::null_mut(),
        )
    };
    if status != 0 {
        return Err(format!("RegCreateKeyExW failed with error {status}"));
    }

    let uninstaller = install_dir.join("uninstall.exe");
    let icon = install_dir.join("dragon-browser.exe");
    let display_ver = if manifest.display_version.is_empty() {
        manifest.app_version.clone()
    } else {
        format!("{} (Gecko {})", manifest.app_version, manifest.display_version)
    };
    let estimated_kb = ((manifest.uncompressed_bytes / 1024).max(1)) as u32;

    reg_set_sz(hkey, "DisplayName", &manifest.app_name);
    reg_set_sz(hkey, "DisplayVersion", &display_ver);
    reg_set_sz(hkey, "Publisher", "Dragon Browser");
    reg_set_sz(hkey, "DisplayIcon", &format!("{},0", icon.display()));
    reg_set_sz(hkey, "InstallLocation", &install_dir.to_string_lossy());
    reg_set_sz(
        hkey,
        "UninstallString",
        &format!("\"{}\" --uninstall", uninstaller.display()),
    );
    reg_set_sz(
        hkey,
        "QuietUninstallString",
        &format!("\"{}\" --uninstall --silent", uninstaller.display()),
    );
    reg_set_dword(hkey, "EstimatedSize", estimated_kb);
    reg_set_dword(hkey, "NoModify", 1);
    reg_set_dword(hkey, "NoRepair", 1);

    unsafe {
        RegCloseKey(hkey);
    }
    Ok(())
}

pub fn unregister_uninstall_entry() {
    let subkey_w = to_wide(UNINSTALL_REG_SUBKEY);
    unsafe {
        RegDeleteTreeW(HKEY_CURRENT_USER, subkey_w.as_ptr());
    }
}

pub fn launch_browser(install_dir: &Path) -> Result<(), String> {
    let exe = install_dir.join("dragon-browser.exe");
    if !exe.is_file() {
        return Err(format!("Missing launcher at {}", exe.display()));
    }
    std::process::Command::new(&exe)
        .current_dir(install_dir)
        .spawn()
        .map_err(|e| format!("Failed to launch Dragon Browser: {e}"))?;
    Ok(())
}

/// Schedule deletion of `uninstall.exe` and its parent folder (if empty) after exit.
pub fn schedule_self_delete(uninstall_exe: &Path) {
    let Some(parent) = uninstall_exe.parent() else {
        return;
    };
    let cmd = format!(
        "cmd.exe /c ping 127.0.0.1 -n 2 > nul & del /f /q \"{}\" & rmdir \"{}\" 2>nul",
        uninstall_exe.display(),
        parent.display()
    );
    let mut cmd_w = to_wide(&cmd);
    let mut si = StartupInfoW::default();
    si.cb = core::mem::size_of::<StartupInfoW>() as u32;
    let mut pi = ProcessInformation::default();
    unsafe {
        if CreateProcessW(
            ptr::null(),
            cmd_w.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            CREATE_NO_WINDOW,
            ptr::null_mut(),
            ptr::null(),
            &si,
            &mut pi,
        ) != 0
        {
            CloseHandle(pi.h_process);
            CloseHandle(pi.h_thread);
        }
    }
}
