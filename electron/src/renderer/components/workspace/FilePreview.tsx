import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { CodeBlock } from "@/components/CodeBlock";
import {
  formatStructuredJsonContent,
  previewModeForPath,
} from "@/lib/workspaceViewer";
import { WorkspaceMarkdown } from "@/components/workspace/WorkspaceMarkdown";

interface FilePreviewProps {
  path: string | null;
  content: string | null;
  imageSrc?: string | null;
  truncated?: boolean;
  error?: string | null;
  loading?: boolean;
}

export function FilePreview({
  path,
  content,
  imageSrc = null,
  truncated = false,
  error = null,
  loading = false,
}: FilePreviewProps) {
  const { t } = useTranslation();

  const preview = useMemo(() => {
    if (!path) return null;
    const mode = previewModeForPath(path);
    if (mode === "image" && imageSrc) {
      return (
        <div className="flex h-full items-center justify-center">
          <img
            src={imageSrc}
            alt={path}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        </div>
      );
    }
    if (content == null) return null;
    if (mode === "markdown") {
      return <WorkspaceMarkdown>{content}</WorkspaceMarkdown>;
    }
    if (mode === "unsupported") {
      return (
        <p className="text-sm text-muted-foreground">
          {t("workspace.preview.unsupported")}
        </p>
      );
    }
    const { content: displayContent, language } = formatStructuredJsonContent(path, content);
    return (
      <CodeBlock
        language={language}
        code={displayContent}
        wrapLongLines
      />
    );
  }, [content, imageSrc, path, t]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("workspace.preview.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
        {t("workspace.preview.empty")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
        <span className="font-mono text-foreground/80">{path}</span>
        {truncated ? (
          <span className="ml-2 text-amber-600 dark:text-amber-400">
            {t("workspace.preview.truncated")}
          </span>
        ) : null}
      </div>
      <div className="scroll-surface min-h-0 flex-1 overflow-auto p-4 [&_pre]:max-w-full">{preview}</div>
    </div>
  );
}
