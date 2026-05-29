import { useTranslation } from "react-i18next";
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ScreenshotPreviewModalProps {
  /** data: URL of the captured screenshot; null = modal is hidden */
  dataUrl: string | null;
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
}

/**
 * 截图预览弹窗（8.2）。
 * 基于 Radix Dialog，自带 focus trap + Escape 关闭 + 无障碍支持。
 */
export function ScreenshotPreviewModal({
  dataUrl,
  onConfirm,
  onCancel,
}: ScreenshotPreviewModalProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={!!dataUrl} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        showCloseButton
        className="max-w-3xl gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-muted-foreground" aria-hidden />
            <DialogTitle className="text-sm font-semibold">
              {t("screenshot.previewTitle")}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {t("screenshot.previewHint")}
          </DialogDescription>
        </DialogHeader>

        {/* Preview */}
        <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-3">
          {dataUrl && (
            <img
              src={dataUrl}
              alt={t("screenshot.previewTitle")}
              className="mx-auto block max-h-[65vh] w-auto rounded-lg object-contain shadow-sm"
              draggable={false}
            />
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="flex-row items-center justify-between gap-3 border-t border-border px-4 py-3 sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {t("screenshot.previewHint")}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("screenshot.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => dataUrl && onConfirm(dataUrl)}
              className="gap-1.5"
              autoFocus
            >
              <Camera className="h-3.5 w-3.5" aria-hidden />
              {t("screenshot.confirm")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
