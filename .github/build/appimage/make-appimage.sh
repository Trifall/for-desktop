#!/bin/sh

set -eu

ARCH=$(uname -m)
export ARCH
export OUTPATH=./dist
export ADD_HOOKS="self-updater.hook"
export UPINFO="gh-releases-zsync|${GITHUB_REPOSITORY%/*}|${GITHUB_REPOSITORY#*/}|latest|*$ARCH.AppImage.zsync"
export ICON=https://raw.githubusercontent.com/stoatchat/assets/1e7f9990c29315f3f55acb7a420dabb6b4db1d9d/desktop/icon.png
export DESKTOP=./chat.stoat.StoatDesktop.desktop
export DEPLOY_PIPEWIRE=1

if [ -n "${SHARUN_PATH:-}" ]; then
  cp "$SHARUN_PATH" ./AppDir/sharun
  chmod +x ./AppDir/sharun
fi

# Deploy dependencies
quick-sharun ./AppDir/bin/*

# Additional changes can be done in between here

# Turn AppDir into AppImage
quick-sharun --make-appimage

# Test the app for 12 seconds, if the test fails due to the app
# having issues running in the CI use --simple-test instead
quick-sharun --test ./dist/*.AppImage
