export const isElectron =
  typeof window !== "undefined" && typeof window.electronAPI !== "undefined";
