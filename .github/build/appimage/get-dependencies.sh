#!/bin/sh

set -eu

echo "Installing package dependencies..."
echo "---------------------------------------------------------------"
pacman -S --noconfirm --needed libnss_nis nss-mdns nss pipewire
