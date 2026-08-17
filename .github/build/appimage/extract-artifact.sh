#!/bin/sh

set -eu

echo "Extracting Artifact..."
echo "---------------------------------------------------------------"

mkdir -p ./AppDir/bin
set -- /tmp/stoat/Stoat-Desktop-linux-x64-*.zip
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Expected exactly one Stoat Desktop Linux x64 ZIP in /tmp/stoat" >&2
  exit 1
fi

unzip "$1"
cp -a ./Stoat-linux-x64/. ./AppDir/bin/

BUILD_VERSION=${BUILD_VERSION#v}
echo "Packaging as version $BUILD_VERSION"
echo "$BUILD_VERSION" > ~/version
