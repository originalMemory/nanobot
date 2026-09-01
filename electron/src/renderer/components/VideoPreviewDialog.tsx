import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

interface VideoPreviewDialogProps {
  open: boolean;
  url: string;
  name?: string;
  onOpenChange: (open: boolean) => void;
}

export function VideoPreviewDialog({ open, url, name, onOpenChange }: VideoPreviewDialogProps) {
  const { t } = useTranslation();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/80 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none",
          )}
        />
        <DialogPrimitive.Content
          aria-label={name ?? t("videoPreview.title")}
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "max-h-[92vh] max-w-[94vw] focus:outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            "motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <DialogPrimitive.Title className="sr-only">
            {name ?? t("videoPreview.title")}
          </DialogPrimitive.Title>
          <video
            src={url}
            controls
            muted
            preload="metadata"
            className="max-h-[92vh] max-w-[94vw] rounded-[6px] bg-black object-contain shadow-2xl"
          />
          <DialogPrimitive.Close
            aria-label={t("videoPreview.close")}
            className={cn(
              "absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-full",
              "bg-black/55 text-white/90 hover:bg-black/70 hover:text-white",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
            )}
          >
            <X className="h-4 w-4" aria-hidden />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
