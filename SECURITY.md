# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Dragon Browser's Rust launcher, Windows installer, or native Gecko integration modules, please report it privately via **GitHub Security Advisories** (*Security → Advisories → Report a vulnerability*) rather than opening a public issue.

For vulnerabilities inside the upstream Gecko rendering engine, Dragon Browser ships unmodified binary libraries from official Mozilla Firefox ESR / Release builds and tracks upstream security advisories via `engine/scripts/upgrade-engine.py`.

## Verifying Official Releases

Official Windows releases are built exclusively on GitHub-hosted `windows-latest` runners from tagged commits via `.github/workflows/release-signed.yml`.

1. **Checksum verification**:
   ```powershell
   Get-FileHash .\DragonBrowser-Setup-*.exe -Algorithm SHA256
   Get-Content .\SHA256SUMS.txt
   ```
2. **Authenticode signature verification** (Windows Smart App Control compliance):
   ```powershell
   Get-AuthenticodeSignature .\DragonBrowser-Setup-*.exe
   .\scripts\verify-signatures.ps1 -Strict
   ```
   - Dragon Browser's own executables (`DragonBrowser-Setup-*.exe`, `dragon-browser.exe`, `uninstall.exe`) are signed by **SignPath Foundation**.
   - Gecko engine binaries inside `runtime/` (`dragon.exe` and `.dll` files) retain their original **Mozilla Corporation** Authenticode signatures.
