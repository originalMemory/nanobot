import { useEffect, useState, type ReactNode } from "react";

import { getHostApi } from "@/lib/runtime";

export function WallpaperLayer({ children }: { children: ReactNode }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    const wallpaper = getHostApi()?.wallpaper;
    if (!wallpaper) return;

    const enable = () => {
      document.documentElement.dataset.wallpaper = "on";
    };
    const disable = () => {
      delete document.documentElement.dataset.wallpaper;
    };
    const offUpdate = wallpaper.onUpdate((dataUrl) => {
      setImageUrl(dataUrl);
      enable();
    });
    const offDisabled = wallpaper.onDisabled(() => {
      setImageUrl(null);
      disable();
    });
    void wallpaper.getConfig().then((config) => {
      if (!config.url.trim()) disable();
    });

    return () => {
      offUpdate();
      offDisabled();
      disable();
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {imageUrl ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: `url("${imageUrl}")` }}
        />
      ) : null}
      <div className="wallpaper-root relative z-10 h-full w-full">{children}</div>
    </div>
  );
}
