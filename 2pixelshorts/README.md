<p align="center">
  <img src="public/brand/logo-256.png" width="96" height="96" alt="2pixelshorts logo" />
</p>

# 2pixelshorts

Local CLI video studio & social publisher for vertical shorts — Tauri + React + TypeScript.

Desktop API keys are stored in the OS credential store (macOS Keychain,
Windows Credential Manager, or Linux Secret Service). Legacy plaintext keys
are removed only after secure migration succeeds. Browser preview keys remain
in memory for that session. The Settings Test buttons make read-only service
authentication requests; a saved or long key is not automatically verified.

See [the testing and security review](docs/e2e-security-review.md) for verified
workflows, remaining limits, and repeatable checks. An isolated macOS QA app can
be built with `npm run tauri -- build --debug --bundles app --config src-tauri/tauri.qa.conf.json`
(macOS 14+). It uses a separate WebView store and credential namespace.

The app uses the supplied ribbon logo across its interface, browser icons, and
native app icons. The original artwork lives in `public/brand/logo-source.png`.
Run `npm run brand:generate` after replacing that square source image to regenerate
the 16–1024 px web assets and all Tauri platform icons. Only the outer square
corners are masked; the artwork and colors are preserved. Native launcher icons
take effect when the desktop app is rebuilt and relaunched.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
