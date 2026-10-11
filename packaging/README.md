# Упаковка

| Папка | Что это | Проверено |
|---|---|---|
| (корень) `flake.nix`, `packaging/nix/package.nix` | Nix | не проверено: Nix на этой машине нет; CI собирает пакет (`nix` job) |
| `packaging/arch/PKGBUILD`, `.SRCINFO` | Arch / AUR: сборка из исходников по тегу | собрано `makepkg`, тесты проходят, `namcap` без ошибок |
| `src-tauri/tauri.conf.json` → `bundle` | `deb`, `rpm`, `AppImage`, Windows `nsis`/`msi` через `cargo tauri build` | `deb`, `rpm`, `AppImage` собраны локально |
| `packaging/openschool.desktop` | ярлык для сборок без Tauri-бандлера (Arch, Nix) | |

Релиз делает `.github/workflows/release.yml` по тегу `v*`: он сверяет версии (Cargo.toml, tauri.conf.json, PKGBUILD, package.nix) с тегом,
собирает все пакеты и кладёт их в **черновик** релиза.

Заметки из сборки:
- AppImage: нужны `NO_STRIP=true` и `APPIMAGE_EXTRACT_AND_RUN=1` (иначе `linuxdeploy` падает на `strip` и без FUSE).
- Arch: из `CFLAGS` убираются только `-O…` и `-flto` (aws-lc собирает один файл с `-O0`); защитные флаги остаются.
- Arch: пустой `_commit` в `PKGBUILD` запрещает сборку. Копия внутри репозитория (и CI) собирается с `OPENSCHOOL_UNPINNED=1`; в копию для AUR нужно вписать хеш коммита тега.
- Nix: хеш исходников в `package.nix` (`lib.fakeHash`) нужен только при сборке без flake; flake берёт собственный checkout (`?submodules=1`).
