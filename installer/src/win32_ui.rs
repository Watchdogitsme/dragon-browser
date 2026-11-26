#![cfg(windows)]

use crate::archive::SfxArchive;
use crate::install::{
    is_existing_install, perform_install, perform_uninstall, InstallOptions,
};
use crate::win32_integration::{
    check_not_running, create_shortcut, default_install_dir, desktop_shortcut_path,
    launch_browser, register_uninstall_entry, remove_shortcuts, schedule_self_delete,
    start_menu_shortcut_path, to_wide, unregister_uninstall_entry, from_wide_nul,
};
use std::path::{Path, PathBuf};
use std::ptr;

const WS_OVERLAPPED: u32 = 0x0000_0000;
const WS_CAPTION: u32 = 0x00C0_0000;
const WS_SYSMENU: u32 = 0x0008_0000;
const WS_MINIMIZEBOX: u32 = 0x0002_0000;
const WS_VISIBLE: u32 = 0x1000_0000;
const WS_CHILD: u32 = 0x4000_0000;
const WS_TABSTOP: u32 = 0x0001_0000;
const WS_BORDER: u32 = 0x0080_0000;
const ES_AUTOHSCROLL: u32 = 0x0080;
const BS_AUTOCHECKBOX: u32 = 0x0003;
const BS_DEFPUSHBUTTON: u32 = 0x0001;
const BS_PUSHBUTTON: u32 = 0x0000;

const WM_CREATE: u32 = 0x0001;
const WM_DESTROY: u32 = 0x0002;
const WM_COMMAND: u32 = 0x0111;
const WM_SETFONT: u32 = 0x0030;
const WM_APP: u32 = 0x8000;
const WM_PROGRESS: u32 = WM_APP + 1;
const WM_INSTALL_DONE: u32 = WM_APP + 2;

const BM_GETCHECK: u32 = 0x00F0;
const BM_SETCHECK: u32 = 0x00F1;
const BST_CHECKED: usize = 1;
const PBM_SETRANGE32: u32 = 0x0406;
const PBM_SETPOS: u32 = 0x0402;

const ICC_PROGRESS_CLASS: u32 = 0x0000_0020;
const DEFAULT_GUI_FONT: i32 = 17;
const COLOR_WINDOW: usize = 5;
const SM_CXSCREEN: i32 = 0;
const SM_CYSCREEN: i32 = 1;
const SW_SHOW: i32 = 5;
const BN_CLICKED: u16 = 0;

const MB_OK: u32 = 0x0000_0000;
const MB_YESNO: u32 = 0x0000_0004;
const MB_YESNOCANCEL: u32 = 0x0000_0003;
const MB_ICONINFORMATION: u32 = 0x0000_0040;
const MB_ICONWARNING: u32 = 0x0000_0030;
const MB_ICONERROR: u32 = 0x0000_0010;
const IDYES: i32 = 6;
const IDCANCEL: i32 = 2;

const ID_PATH_EDIT: isize = 101;
const ID_BROWSE_BTN: isize = 102;
const ID_CHK_DESKTOP: isize = 103;
const ID_CHK_STARTMENU: isize = 104;
const ID_CHK_LAUNCH: isize = 105;
const ID_CHK_PORTABLE: isize = 106;
const ID_PROGRESS: isize = 107;
const ID_STATUS_LBL: isize = 108;
const ID_ACTION_BTN: isize = 109;
const ID_CANCEL_BTN: isize = 110;
const ID_TITLE_LBL: isize = 111;

#[repr(C)]
struct InitCommonControlsExStruct {
    dw_size: u32,
    dw_icc: u32,
}

#[repr(C)]
struct WndClassExW {
    cb_size: u32,
    style: u32,
    lpfn_wnd_proc: unsafe extern "system" fn(isize, u32, usize, isize) -> isize,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    h_instance: isize,
    h_icon: isize,
    h_cursor: isize,
    hbr_background: isize,
    lpsz_menu_name: *const u16,
    lpsz_class_name: *const u16,
    h_icon_sm: isize,
}

#[repr(C)]
#[derive(Default)]
struct Msg {
    hwnd: isize,
    message: u32,
    w_param: usize,
    l_param: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
}

#[repr(C)]
struct BrowseInfoW {
    hwnd_owner: isize,
    pidl_root: *const core::ffi::c_void,
    psz_display_name: *mut u16,
    lpsz_title: *const u16,
    ul_flags: u32,
    lpfn: *const core::ffi::c_void,
    l_param: isize,
    i_image: i32,
}

const BIF_RETURNONLYFSDIRS: u32 = 0x0001;
const BIF_NEWDIALOGSTYLE: u32 = 0x0040;

#[link(name = "comctl32")]
extern "system" {
    fn InitCommonControlsEx(picce: *const InitCommonControlsExStruct) -> i32;
}

#[link(name = "gdi32")]
extern "system" {
    fn GetStockObject(i: i32) -> isize;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(lp_module_name: *const u16) -> isize;
}

#[link(name = "shell32")]
extern "system" {
    fn SHBrowseForFolderW(lpbi: *mut BrowseInfoW) -> *mut core::ffi::c_void;
    fn SHGetPathFromIDListW(pidl: *const core::ffi::c_void, psz_path: *mut u16) -> i32;
}

#[link(name = "ole32")]
extern "system" {
    fn CoTaskMemFree(pv: *mut core::ffi::c_void);
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, utype: u32) -> i32;
    fn RegisterClassExW(lpwcx: *const WndClassExW) -> u16;
    fn CreateWindowExW(
        dw_ex_style: u32,
        lp_class_name: *const u16,
        lp_window_name: *const u16,
        dw_style: u32,
        x: i32,
        y: i32,
        n_width: i32,
        n_height: i32,
        hwnd_parent: isize,
        h_menu: isize,
        h_instance: isize,
        lp_param: *mut core::ffi::c_void,
    ) -> isize;
    fn DefWindowProcW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn PostQuitMessage(exit_code: i32);
    fn GetMessageW(lp_msg: *mut Msg, hwnd: isize, min: u32, max: u32) -> i32;
    fn TranslateMessage(lp_msg: *const Msg) -> i32;
    fn DispatchMessageW(lp_msg: *const Msg) -> isize;
    fn SendMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
    fn SetWindowTextW(hwnd: isize, text: *const u16) -> i32;
    fn GetWindowTextW(hwnd: isize, buf: *mut u16, max_count: i32) -> i32;
    fn EnableWindow(hwnd: isize, enable: i32) -> i32;
    fn ShowWindow(hwnd: isize, n_cmd_show: i32) -> i32;
    fn DestroyWindow(hwnd: isize) -> i32;
    fn GetDlgItem(hdlg: isize, id: i32) -> isize;
    fn GetSystemMetrics(n_index: i32) -> i32;
    fn LoadCursorW(h_instance: isize, lp_cursor_name: *const u16) -> isize;
}

pub fn msg_box(title: &str, text: &str, flags: u32) -> i32 {
    let t = to_wide(title);
    let m = to_wide(text);
    unsafe { MessageBoxW(0, m.as_ptr(), t.as_ptr(), flags) }
}

struct UiState {
    exe_path: PathBuf,
    default_dir: PathBuf,
    engine_summary: String,
    installing: bool,
    finished: bool,
    launch_after_finish: bool,
    final_install_dir: Option<PathBuf>,
}

static mut UI_STATE: Option<UiState> = None;

fn set_ctrl_text(hwnd: isize, id: isize, text: &str) {
    let ctrl = unsafe { GetDlgItem(hwnd, id as i32) };
    if ctrl != 0 {
        let w = to_wide(text);
        unsafe {
            SetWindowTextW(ctrl, w.as_ptr());
        }
    }
}

fn get_ctrl_text(hwnd: isize, id: isize) -> String {
    let ctrl = unsafe { GetDlgItem(hwnd, id as i32) };
    if ctrl == 0 {
        return String::new();
    }
    let mut buf = [0u16; 1024];
    unsafe {
        GetWindowTextW(ctrl, buf.as_mut_ptr(), buf.len() as i32);
    }
    from_wide_nul(&buf)
}

fn is_checked(hwnd: isize, id: isize) -> bool {
    let ctrl = unsafe { GetDlgItem(hwnd, id as i32) };
    if ctrl == 0 {
        return false;
    }
    unsafe { SendMessageW(ctrl, BM_GETCHECK, 0, 0) == BST_CHECKED as isize }
}

fn set_checked(hwnd: isize, id: isize, checked: bool) {
    let ctrl = unsafe { GetDlgItem(hwnd, id as i32) };
    if ctrl != 0 {
        unsafe {
            SendMessageW(ctrl, BM_SETCHECK, if checked { BST_CHECKED } else { 0 }, 0);
        }
    }
}

fn set_enabled(hwnd: isize, id: isize, enabled: bool) {
    let ctrl = unsafe { GetDlgItem(hwnd, id as i32) };
    if ctrl != 0 {
        unsafe {
            EnableWindow(ctrl, if enabled { 1 } else { 0 });
        }
    }
}

fn browse_for_folder(owner: isize) -> Option<PathBuf> {
    let title_w = to_wide("Select Dragon Browser installation folder:");
    let mut display = [0u16; 260];
    let mut bi = BrowseInfoW {
        hwnd_owner: owner,
        pidl_root: ptr::null(),
        psz_display_name: display.as_mut_ptr(),
        lpsz_title: title_w.as_ptr(),
        ul_flags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
        lpfn: ptr::null(),
        l_param: 0,
        i_image: 0,
    };
    let pidl = unsafe { SHBrowseForFolderW(&mut bi) };
    if pidl.is_null() {
        return None;
    }
    let mut path_buf = [0u16; 520];
    let ok = unsafe { SHGetPathFromIDListW(pidl, path_buf.as_mut_ptr()) };
    unsafe {
        CoTaskMemFree(pidl);
    }
    if ok != 0 {
        let s = from_wide_nul(&path_buf);
        if !s.is_empty() {
            return Some(PathBuf::from(s));
        }
    }
    None
}

fn update_action_label(hwnd: isize) {
    let path_str = get_ctrl_text(hwnd, ID_PATH_EDIT);
    let dir = Path::new(path_str.trim());
    let portable = is_checked(hwnd, ID_CHK_PORTABLE);
    set_enabled(hwnd, ID_CHK_DESKTOP, !portable);
    set_enabled(hwnd, ID_CHK_STARTMENU, !portable);
    if is_existing_install(dir) {
        set_ctrl_text(hwnd, ID_ACTION_BTN, "Upgrade");
        set_ctrl_text(
            hwnd,
            ID_STATUS_LBL,
            "Existing installation detected — profile & bookmarks will be preserved.",
        );
    } else {
        set_ctrl_text(hwnd, ID_ACTION_BTN, "Install");
        set_ctrl_text(hwnd, ID_STATUS_LBL, "Ready to install Dragon Browser.");
    }
}

fn start_install_worker(hwnd: isize) {
    let dir_str = get_ctrl_text(hwnd, ID_PATH_EDIT);
    let install_dir = PathBuf::from(dir_str.trim());
    if install_dir.as_os_str().is_empty() {
        msg_box("Dragon Browser Setup", "Please enter a valid installation folder.", MB_OK | MB_ICONWARNING);
        return;
    }

    if let Err(err) = check_not_running(&install_dir) {
        msg_box("Dragon Browser Running", &err, MB_OK | MB_ICONWARNING);
        return;
    }

    let portable = is_checked(hwnd, ID_CHK_PORTABLE);
    let opts = InstallOptions {
        install_dir: install_dir.clone(),
        portable,
        create_desktop_shortcut: !portable && is_checked(hwnd, ID_CHK_DESKTOP),
        create_start_menu_shortcut: !portable && is_checked(hwnd, ID_CHK_STARTMENU),
        launch_after: is_checked(hwnd, ID_CHK_LAUNCH),
        silent: false,
    };

    let exe_path = unsafe {
        let Some(state) = UI_STATE.as_mut() else {
            return;
        };
        state.installing = true;
        state.launch_after_finish = opts.launch_after;
        state.exe_path.clone()
    };

    for id in [
        ID_PATH_EDIT,
        ID_BROWSE_BTN,
        ID_CHK_DESKTOP,
        ID_CHK_STARTMENU,
        ID_CHK_LAUNCH,
        ID_CHK_PORTABLE,
        ID_ACTION_BTN,
        ID_CANCEL_BTN,
    ] {
        set_enabled(hwnd, id, false);
    }

    std::thread::spawn(move || {
        let res = perform_install(&exe_path, &opts, |pct, msg| {
            let boxed = Box::new(msg.to_string());
            let ptr = Box::into_raw(boxed) as isize;
            unsafe {
                PostMessageW(hwnd, WM_PROGRESS, pct as usize, ptr);
            }
        });

        let final_res: Result<PathBuf, String> = match res {
            Ok(info) => {
                if !opts.portable {
                    let target_exe = info.install_dir.join("dragon-browser.exe");
                    let icon = info.install_dir.join("dragon.ico");
                    if opts.create_desktop_shortcut {
                        if let Some(lnk) = desktop_shortcut_path() {
                            let _ = create_shortcut(
                                &lnk,
                                &target_exe,
                                &info.install_dir,
                                &icon,
                                "Dragon Browser",
                            );
                        }
                    }
                    if opts.create_start_menu_shortcut {
                        if let Some(lnk) = start_menu_shortcut_path() {
                            let _ = create_shortcut(
                                &lnk,
                                &target_exe,
                                &info.install_dir,
                                &icon,
                                "Dragon Browser",
                            );
                        }
                    }
                    let _ = register_uninstall_entry(&info.install_dir, &info.manifest);
                }
                Ok(info.install_dir)
            }
            Err(e) => Err(e),
        };

        let boxed = Box::new(final_res);
        let ptr = Box::into_raw(boxed) as isize;
        unsafe {
            PostMessageW(hwnd, WM_INSTALL_DONE, 0, ptr);
        }
    });
}

fn create_child(
    hwnd: isize,
    hinst: isize,
    font: isize,
    class: &str,
    text: &str,
    style: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    id: isize,
) -> isize {
    let cls_w = to_wide(class);
    let txt_w = to_wide(text);
    let ctrl = unsafe {
        CreateWindowExW(
            0,
            cls_w.as_ptr(),
            txt_w.as_ptr(),
            WS_CHILD | WS_VISIBLE | style,
            x,
            y,
            w,
            h,
            hwnd,
            id,
            hinst,
            ptr::null_mut(),
        )
    };
    if ctrl != 0 && font != 0 {
        unsafe {
            SendMessageW(ctrl, WM_SETFONT, font as usize, 1);
        }
    }
    ctrl
}

unsafe extern "system" fn wnd_proc(
    hwnd: isize,
    msg: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    match msg {
        WM_CREATE => {
            let hinst = GetModuleHandleW(ptr::null());
            let font = GetStockObject(DEFAULT_GUI_FONT);
            let (summary, default_dir_str) = match UI_STATE.as_ref() {
                Some(s) => (
                    s.engine_summary.clone(),
                    s.default_dir.to_string_lossy().to_string(),
                ),
                None => ("Dragon Browser".to_string(), String::new()),
            };

            create_child(hwnd, hinst, font, "STATIC", &summary, 0, 20, 16, 460, 22, ID_TITLE_LBL);
            create_child(hwnd, hinst, font, "STATIC", "Installation folder:", 0, 20, 48, 460, 18, 0);
            create_child(
                hwnd,
                hinst,
                font,
                "EDIT",
                &default_dir_str,
                WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL,
                20,
                70,
                368,
                24,
                ID_PATH_EDIT,
            );
            create_child(
                hwnd,
                hinst,
                font,
                "BUTTON",
                "Browse...",
                WS_TABSTOP | BS_PUSHBUTTON,
                396,
                69,
                84,
                26,
                ID_BROWSE_BTN,
            );

            create_child(
                hwnd,
                hinst,
                font,
                "BUTTON",
                "Create Desktop shortcut",
                WS_TABSTOP | BS_AUTOCHECKBOX,
                20,
                108,
                220,
                20,
                ID_CHK_DESKTOP,
            );
            create_child(
                hwnd,
                hinst,
                font,
                "BUTTON",
                "Create Start Menu shortcut",
                WS_TABSTOP | BS_AUTOCHECKBOX,
                250,
                108,
                230,
                20,
                ID_CHK_STARTMENU,
            );
            create_child(
                hwnd,
                hinst,
                font,
                "BUTTON",
                "Launch Dragon Browser after installation",
                WS_TABSTOP | BS_AUTOCHECKBOX,
                20,
                134,
                280,
                20,
                ID_CHK_LAUNCH,
            );
            create_child(
                hwnd,
                hinst,
                font,
                "BUTTON",
                "Portable extract only (no shortcuts/registry)",
                WS_TABSTOP | BS_AUTOCHECKBOX,
                20,
                160,
                340,
                20,
                ID_CHK_PORTABLE,
            );

            let prog = create_child(
                hwnd,
                hinst,
                0,
                "msctls_progress32",
                "",
                0,
                20,
                194,
                460,
                18,
                ID_PROGRESS,
            );
            if prog != 0 {
                SendMessageW(prog, PBM_SETRANGE32, 0, 100);
            }
            create_child(hwnd, hinst, font, "STATIC", "", 0, 20, 220, 460, 20, ID_STATUS_LBL);

            create_child(
                hwnd,
                hinst,
                font,
                "BUTTON",
                "Install",
                WS_TABSTOP | BS_DEFPUSHBUTTON,
                284,
                252,
                92,
                28,
                ID_ACTION_BTN,
            );
            create_child(
                hwnd,
                hinst,
                font,
                "BUTTON",
                "Cancel",
                WS_TABSTOP | BS_PUSHBUTTON,
                388,
                252,
                92,
                28,
                ID_CANCEL_BTN,
            );

            set_checked(hwnd, ID_CHK_DESKTOP, true);
            set_checked(hwnd, ID_CHK_STARTMENU, true);
            set_checked(hwnd, ID_CHK_LAUNCH, true);
            update_action_label(hwnd);
            0
        }
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as isize;
            let code = ((wparam >> 16) & 0xFFFF) as u16;
            if code == BN_CLICKED {
                match id {
                    ID_BROWSE_BTN => {
                        if let Some(chosen) = browse_for_folder(hwnd) {
                            let final_dir = if chosen
                                .file_name()
                                .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("Dragon Browser"))
                            {
                                chosen
                            } else {
                                chosen.join("Dragon Browser")
                            };
                            set_ctrl_text(hwnd, ID_PATH_EDIT, &final_dir.to_string_lossy());
                            update_action_label(hwnd);
                        }
                    }
                    ID_CHK_PORTABLE => {
                        update_action_label(hwnd);
                    }
                    ID_ACTION_BTN => {
                        let finished = UI_STATE.as_ref().is_some_and(|s| s.finished);
                        if finished {
                            if let Some(s) = UI_STATE.as_ref() {
                                if s.launch_after_finish {
                                    if let Some(ref dir) = s.final_install_dir {
                                        let _ = launch_browser(dir);
                                    }
                                }
                            }
                            DestroyWindow(hwnd);
                        } else {
                            start_install_worker(hwnd);
                        }
                    }
                    ID_CANCEL_BTN => {
                        let installing = UI_STATE.as_ref().is_some_and(|s| s.installing);
                        if !installing {
                            DestroyWindow(hwnd);
                        }
                    }
                    _ => {}
                }
            }
            0
        }
        WM_PROGRESS => {
            let prog = GetDlgItem(hwnd, ID_PROGRESS as i32);
            if prog != 0 {
                SendMessageW(prog, PBM_SETPOS, wparam, 0);
            }
            if lparam != 0 {
                let msg = Box::from_raw(lparam as *mut String);
                set_ctrl_text(hwnd, ID_STATUS_LBL, &msg);
            }
            0
        }
        WM_INSTALL_DONE => {
            if lparam != 0 {
                let res = Box::from_raw(lparam as *mut Result<PathBuf, String>);
                if let Some(state) = UI_STATE.as_mut() {
                    state.installing = false;
                    match *res {
                        Ok(dir) => {
                            state.finished = true;
                            state.final_install_dir = Some(dir);
                            let prog = GetDlgItem(hwnd, ID_PROGRESS as i32);
                            if prog != 0 {
                                SendMessageW(prog, PBM_SETPOS, 100, 0);
                            }
                            set_ctrl_text(hwnd, ID_STATUS_LBL, "Dragon Browser is ready!");
                            set_ctrl_text(hwnd, ID_ACTION_BTN, "Finish");
                            set_enabled(hwnd, ID_ACTION_BTN, true);
                        }
                        Err(err) => {
                            set_ctrl_text(hwnd, ID_STATUS_LBL, "Installation failed.");
                            set_enabled(hwnd, ID_ACTION_BTN, true);
                            set_enabled(hwnd, ID_CANCEL_BTN, true);
                            set_enabled(hwnd, ID_PATH_EDIT, true);
                            set_enabled(hwnd, ID_BROWSE_BTN, true);
                            msg_box("Dragon Browser Setup Failed", &err, MB_OK | MB_ICONERROR);
                        }
                    }
                }
            }
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

pub fn run_install_gui(exe_path: &Path, initial_dir: Option<PathBuf>) -> i32 {
    let summary = match SfxArchive::open(exe_path).and_then(|mut a| a.read_manifest()) {
        Ok(m) => m.summary_line(),
        Err(err) => {
            msg_box(
                "Dragon Browser Setup Error",
                &format!("Cannot open installer payload:\n{err}"),
                MB_OK | MB_ICONERROR,
            );
            return 1;
        }
    };

    unsafe {
        let icc = InitCommonControlsExStruct {
            dw_size: core::mem::size_of::<InitCommonControlsExStruct>() as u32,
            dw_icc: ICC_PROGRESS_CLASS,
        };
        InitCommonControlsEx(&icc);

        UI_STATE = Some(UiState {
            exe_path: exe_path.to_path_buf(),
            default_dir: initial_dir.unwrap_or_else(default_install_dir),
            engine_summary: summary,
            installing: false,
            finished: false,
            launch_after_finish: true,
            final_install_dir: None,
        });

        let hinst = GetModuleHandleW(ptr::null());
        let cls_name = to_wide("DragonBrowserSetupWnd");
        let title = to_wide("Dragon Browser Setup");
        let wc = WndClassExW {
            cb_size: core::mem::size_of::<WndClassExW>() as u32,
            style: 0,
            lpfn_wnd_proc: wnd_proc,
            cb_cls_extra: 0,
            cb_wnd_extra: 0,
            h_instance: hinst,
            h_icon: 0,
            h_cursor: LoadCursorW(0, 32512 as *const u16),
            hbr_background: (COLOR_WINDOW + 1) as isize,
            lpsz_menu_name: ptr::null(),
            lpsz_class_name: cls_name.as_ptr(),
            h_icon_sm: 0,
        };
        RegisterClassExW(&wc);

        let w = 516;
        let h = 330;
        let x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
        let y = (GetSystemMetrics(SM_CYSCREEN) - h) / 2;
        let hwnd = CreateWindowExW(
            0,
            cls_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
            x.max(0),
            y.max(0),
            w,
            h,
            0,
            0,
            hinst,
            ptr::null_mut(),
        );
        if hwnd == 0 {
            return 1;
        }
        ShowWindow(hwnd, SW_SHOW);

        let mut msg = Msg::default();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        0
    }
}

pub fn run_uninstall_gui(exe_path: &Path, install_dir: &Path) -> i32 {
    let confirm = msg_box(
        "Uninstall Dragon Browser",
        &format!(
            "Uninstall Dragon Browser from:\n{}\n\nContinue?",
            install_dir.display()
        ),
        MB_YESNO | MB_ICONINFORMATION,
    );
    if confirm != IDYES {
        return 0;
    }

    if let Err(err) = check_not_running(install_dir) {
        msg_box("Dragon Browser Running", &err, MB_OK | MB_ICONWARNING);
        return 1;
    }

    let profile_choice = if install_dir.join("profile").is_dir() {
        let ans = msg_box(
            "User Profile Data",
            "Do you also want to delete your Dragon Browser profile (bookmarks, passwords, cookies, history)?\n\nChoose 'No' to keep your profile data.",
            MB_YESNOCANCEL | MB_ICONWARNING,
        );
        if ans == IDCANCEL {
            return 0;
        }
        ans == IDYES
    } else {
        false
    };

    remove_shortcuts();
    unregister_uninstall_entry();
    if let Err(err) = perform_uninstall(install_dir, profile_choice) {
        msg_box("Uninstall Failed", &err, MB_OK | MB_ICONERROR);
        return 1;
    }
    schedule_self_delete(exe_path);
    msg_box(
        "Uninstall Complete",
        "Dragon Browser has been uninstalled.",
        MB_OK | MB_ICONINFORMATION,
    );
    0
}
