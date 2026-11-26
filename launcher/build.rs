use std::path::Path;

fn main() {
    if let Err(err) = win_icon_res::emit_ico_coff_for_build_rs(Path::new("assets/dragon.ico")) {
        panic!("Failed to embed Dragon Browser Windows icon: {err}");
    }
}
