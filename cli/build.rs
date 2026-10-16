// The CLI reports the app's version: the one in src-tauri/Cargo.toml (the only place it is written).
fn main() {
    let manifest = "../src-tauri/Cargo.toml";
    println!("cargo:rerun-if-changed={manifest}");
    let text = std::fs::read_to_string(manifest).expect("src-tauri/Cargo.toml");
    let version = text
        .split("\n[")
        .find(|section| section.starts_with("[package]") || section.starts_with("package]"))
        .and_then(|package| package.lines().find_map(|l| l.strip_prefix("version = \"")?.strip_suffix('"').map(str::to_owned)))
        .expect("version in the [package] section of src-tauri/Cargo.toml");
    println!("cargo:rustc-env=OPENSCHOOL_VERSION={version}");
}
