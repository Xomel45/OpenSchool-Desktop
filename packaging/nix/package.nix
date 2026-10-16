# The OpenSchool desktop client for Nix. Built from `src` (the flake passes its own checkout, which must include the `bridge`
# submodule: `nix build '.?submodules=1'`); without `src` the release tagged with this version is fetched from GitHub.
{ lib
, rustPlatform
, fetchFromGitHub
, pkg-config
, cmake
, wrapGAppsHook3
, webkitgtk_4_1
, gtk3
, libsoup_3
, glib
, dbus
, libayatana-appindicator
, src ? null
}:

let
  # The one place the version is written: the app's Cargo.toml (next to this file in the repository).
  version = (lib.importTOML ../../src-tauri/Cargo.toml).package.version;
  source = if src != null then src else fetchFromGitHub {
    owner = "Xomel45";
    repo = "OpenSchool-Desktop";
    rev = "v${version}";
    fetchSubmodules = true;
    # Run `nix build` once: it prints the real hash to put here.
    hash = lib.fakeHash;
  };
in

rustPlatform.buildRustPackage {
  pname = "openschool";
  inherit version;

  src = source;
  cargoLock.lockFile = source + "/src-tauri/Cargo.lock";
  cargoRoot = "src-tauri";
  buildAndTestSubdir = "src-tauri";

  nativeBuildInputs = [ pkg-config cmake wrapGAppsHook3 ];
  buildInputs = [ webkitgtk_4_1 gtk3 libsoup_3 glib dbus libayatana-appindicator ];

  # The tests are run by the project's CI; some of them want a secret service and a desktop session.
  doCheck = false;

  postInstall = ''
    install -Dm644 packaging/openschool.desktop $out/share/applications/openschool.desktop
    install -Dm644 src-tauri/icons/32x32.png $out/share/icons/hicolor/32x32/apps/openschool_desktop.png
    install -Dm644 src-tauri/icons/128x128.png $out/share/icons/hicolor/128x128/apps/openschool_desktop.png
    install -Dm644 'src-tauri/icons/128x128@2x.png' $out/share/icons/hicolor/256x256/apps/openschool_desktop.png
  '';

  # The tray icon library is loaded at run time, not linked.
  preFixup = ''
    gappsWrapperArgs+=(--prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ libayatana-appindicator ]})
  '';

  meta = {
    description = "Unofficial desktop client for «Моя школа» (Gosuslugi): schedule, marks, homework";
    homepage = "https://github.com/Xomel45/OpenSchool-Desktop";
    license = lib.licenses.mpl20;
    mainProgram = "openschool_desktop";
    platforms = lib.platforms.linux;
  };
}
