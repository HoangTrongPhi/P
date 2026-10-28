# Releasing Poseidon (Windows installer + Check for updates)

## How it fits together

```
your PC                                   GitHub (HoangTrongPhi/P, public)
───────────────────────────────           ─────────────────────────────────────────────
scripts/release.ps1                       Releases → v1.0.1 (latest, not pre-release)
  npm run tauri build  (signed)   ──────►   Poseidon_1.0.1_x64-setup.exe
  release/1.0.1/                            Poseidon_1.0.1_x64-setup.exe.sig
    Poseidon_…-setup.exe                    latest.json
    Poseidon_…-setup.exe.sig
    latest.json                           Installed app (Check for updates)
                                            GET releases/latest/download/latest.json
                                            newer version? → download setup.exe,
                                            verify signature with the public key,
                                            run it silently, restart
```

- **Update endpoint** (`plugins.updater.endpoints` in `src-tauri/tauri.conf.json`):
  `https://github.com/HoangTrongPhi/P/releases/latest/download/latest.json`.
  GitHub's `latest` skips drafts and releases marked *pre-release*, so publish updates as normal releases.
- **Signing**: the private key is `%USERPROFILE%\.tauri\poseidon.key` (no password); the public key is
  in `tauri.conf.json`. The app refuses an installer whose `.sig` does not match. **Back the private
  key up** (password manager / USB): without it no installed copy can ever be updated again, and a
  new key means users have to reinstall by hand. Never commit it (`*.key` is git-ignored).
- **Where the app installs**: per-user, no admin prompt — `%LOCALAPPDATA%\Poseidon\` by default
  (the user can pick another folder in the installer). Start menu + desktop shortcuts, uninstaller in
  *Settings → Apps*. App data (the Asset Matcher mesh cache) lives in
  `%LOCALAPPDATA%\com.phineas.poseidon\` and survives updates.
- **When the app checks**: once, 4 s after a release build starts (silent unless there is an update),
  and on demand from the version pill in the header, *About & contact → Check for updates*, or
  `Ctrl+K` → "Check for updates…". Dev builds (`tauri dev`) never check on their own.

## Cutting a release

1. Note what changed in `docs/CHANGELOG.md`.
2. From the repository root in PowerShell:

   ```powershell
   ./scripts/release.ps1 -Version 1.0.1 -Notes "Faster matcher on Google Drive; Unity HDRP mask maps"
   ```

   This sets the version in `package.json`, `Cargo.toml` and `tauri.conf.json`, builds the signed
   NSIS installer and writes `release/1.0.1/` with the installer, its `.sig`, `latest.json` and
   `SHA256SUMS.txt` (the Abyss launcher checks downloads against it; see Abyss `docs/RELEASE_STANDARD.md`).
   If PowerShell refuses to run scripts, allow local scripts once for your user:
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
3. Commit and push the version bump, then publish:
   - **By hand**: <https://github.com/HoangTrongPhi/P/releases/new> → tag `v1.0.1` → attach the four
     files → leave *Set as a pre-release* unticked → *Publish release*.
   - **With GitHub CLI** (`winget install GitHub.cli`, then `gh auth login`): add `-Publish` to the command above.
4. Check: open an older installed copy → header pill turns into "Update v1.0.1".

Versions must increase (semver): `1.0.0` < `1.0.1` < `1.1.0`; `1.1.0-beta.1` sorts before `1.1.0`. The NSIS installer is the only
bundle target; MSI is not built: WiX rejects pre-release versions like `-beta.1` and needs admin rights.

## Building without publishing

```powershell
npm run tauri build      # unsigned updater artifacts fail; set the key first:
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$HOME\.tauri\poseidon.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri build
```

Output: `src-tauri/target/release/bundle/nsis/Poseidon_<version>_x64-setup.exe`
(and the bare app at `src-tauri/target/release/poseidon.exe`).
