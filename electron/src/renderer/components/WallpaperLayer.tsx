import { useEffect, useState } from "react";

export function WallpaperLayer({ children }: { children: React.ReactNode }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    const wallpaper = window.electronAPI?.wallpaper;
    if (!wallpaper) return;

    const enableWallpaper = () => {
      document.documentElement.dataset.wallpaper = "on";
    };
    const disableWallpaper = () => {
      delete document.documentElement.dataset.wallpaper;
    };

    const offUpdate = wallpaper.onUpdate((dataUrl) => {
      setImageUrl(dataUrl);
      enableWallpaper();
    });

    const offDisabled = wallpaper.onDisabled(() => {
      setImageUrl(null);
      disableWallpaper();
    });

    void wallpaper.getConfig().then((config) => {
      if (!config.url.trim()) {
        disableWallpaper();
      }
    });

    return () => {
      offUpdate();
      offDisabled();
      disableWallpaper();
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
      {children}
    </div>
  );
}
