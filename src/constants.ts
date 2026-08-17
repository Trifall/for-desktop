export const sinkName = "stoat-virtual-sink";
export const sourceName = "stoat-virtual-source";

export const isWayland =
  process.platform === "linux" &&
  (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
