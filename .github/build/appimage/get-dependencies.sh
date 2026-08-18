#!/bin/sh

set -eu

echo "Installing package dependencies..."
echo "---------------------------------------------------------------"
# Sharun can only bundle Electron libraries that exist in the build container.
pacman -S --noconfirm --needed \
  at-spi2-core \
  cairo \
  gtk3 \
  libcups \
  libnss_nis \
  libxcomposite \
  libxdamage \
  libxkbcommon \
  nss \
  nss-mdns \
  pango \
  pipewire
