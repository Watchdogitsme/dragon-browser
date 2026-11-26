# SignPath Foundation Setup Guide (Free Windows Code Signing)

Dragon Browser uses **SignPath Foundation** free open-source code signing together with official **Mozilla-signed** Gecko runtime binaries so **Windows 11 Smart App Control (SAC)** allows installing and running Dragon Browser with SAC enabled.

---

## Step 1: Push Your Repository Publicly to GitHub

SignPath Foundation requires a public GitHub repository with an OSI-approved license (`LICENSE` is already set to `MPL-2.0`) and a Code Signing Policy in `README.md` (already added).

```bash
git init
git add .
git commit -m "Initial Dragon Browser release with SignPath CI"
git branch -M main
git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/dragon-browser.git
git push -u origin main
```

---

## Step 2: Apply to SignPath Foundation

1. Submit your public repository at **https://signpath.org/projects/submit**.
2. Once approved, log in to **https://app.signpath.io/** and install the **SignPath GitHub App** on your GitHub repository.

---

## Step 3: Configure Your SignPath Project

Inside your SignPath organization, create a project (default slug `dragon-browser`) with:

1. **Two Artifact Configurations** (matching `.github/workflows/release-signed.yml`):
   - `core-binaries`: ZIP archive containing `dragon-browser.exe` and `uninstall.exe`
   - `windows-installer`: ZIP archive containing `DragonBrowser-Setup-*-win64.exe`
2. **Signing Policy**:
   - Slug: `release-signing`
   - Trusted Build System: GitHub Actions workflow `.github/workflows/release-signed.yml`
   - Approvers: your SignPath account(s)

---

## Step 4: Add GitHub Actions Secrets & Variables

In your GitHub repository under **Settings → Secrets and variables → Actions**:

- **Secret**:
  - `SIGNPATH_API_TOKEN` — API token from your SignPath user/CI account
- **Variables**:
  - `SIGNPATH_ORGANIZATION_ID` — your SignPath Organization GUID
  - `SIGNPATH_PROJECT_SLUG` — `dragon-browser` *(optional if using default)*
  - `SIGNPATH_SIGNING_POLICY_SLUG` — `release-signing` *(optional if using default)*

> **Note:** If `SIGNPATH_API_TOKEN` is not set yet, `.github/workflows/release-signed.yml` still runs end-to-end as an unsigned dry-run so you can verify CI builds and packaging before SignPath approval.

---

## Step 5: Cut a Signed Release

```bash
git tag v1.0.0
git push origin v1.0.0
```

Or open **GitHub → Actions → Release (Signed) → Run workflow**.

When finished:
- `DragonBrowser-Setup-<version>-win64.exe` is signed by **SignPath Foundation**.
- `dragon-browser.exe` and `uninstall.exe` inside the installer are signed by **SignPath Foundation**.
- Every `.exe` and `.dll` in `runtime/` retains its **Mozilla Corporation** signature.
- You can verify locally on Windows with:
  ```powershell
  .\scripts\verify-signatures.ps1 -Strict
  ```
