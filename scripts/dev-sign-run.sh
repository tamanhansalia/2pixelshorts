#!/bin/sh
# Dev-only cargo runner for macOS. Cargo runs every built binary through this
# script (see src-tauri/.cargo/config.toml), so `npm run tauri dev` launches a
# binary signed with a stable local identity.
#
# Why: the macOS Keychain ties "Always Allow" to the app's code signature. An
# ad-hoc signature changes on every build, so the password prompt returned each
# time. A certificate-based signature keeps the same identity across rebuilds.
#
# Create the identity once (self-signed, free, local-only):
#   Keychain Access > Certificate Assistant > Create a Certificate...
#   Name: 2pixelshorts Dev Signing · Identity Type: Self Signed Root
#   Certificate Type: Code Signing
# Override the name with TWOPIXEL_DEV_SIGN_IDENTITY if you use another one.
set -eu

BIN="$1"
shift
IDENTITY="${TWOPIXEL_DEV_SIGN_IDENTITY:-2pixelshorts Dev Signing}"

if security find-certificate -c "$IDENTITY" >/dev/null 2>&1; then
  codesign --force --sign "$IDENTITY" --identifier com.twopixelspace.shorts "$BIN" >/dev/null
else
  echo "dev-sign: no '$IDENTITY' certificate found; running unsigned (Keychain prompts may repeat)." >&2
fi

exec "$BIN" "$@"
