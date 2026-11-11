# Karaoke System

**AD SOUND & SERVICE**

Karaoke subtitle studio for Windows and macOS: lyrics search, tap sync and auto-sync, per-word colors, animated backgrounds, Full HD video render, YouTube audio import and vocal removal (Demucs). Everything is built in, nothing else to install.

## Download

Get the latest version from **[Releases](../../releases/latest)**:

| System | File |
|---|---|
| Windows 10/11 | `Karaoke-System-Setup-x.y.z.exe` |
| Mac with Apple Silicon (M1–M4) | `Karaoke-System-x.y.z-mac-arm64.dmg` |
| Mac with Intel | `Karaoke-System-x.y.z-mac-x64.dmg` |

**First launch**
- Windows: if SmartScreen appears, click **More info → Run anyway**.
- macOS: open the app once; if macOS blocks it, go to **System Settings → Privacy & Security** and click **Open Anyway**.

## Updates

The app checks for new versions on start (and Help → Check for updates). Windows downloads and installs updates automatically; on macOS the app downloads the new .dmg for you.

## Releasing a new version (maintainer)

1. Bump `version` in `package.json`.
2. Commit and push to main. The new version number starts the build automatically.
3. GitHub Actions builds Windows and both Mac versions and publishes the release.
