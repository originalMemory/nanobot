import { useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { FileReferenceChip } from "@/components/FileReferenceChip";
import { codeLanguageFromPath } from "@/lib/code-language";
import {
  hasRenderableFileDiff,
  parseRenderableFileDiff,
} from "@/lib/file-diff";
import type { UIFileDiff, UIFileEdit } from "@/lib/types";
import { cn } from "@/lib/utils";

import { ActivityStep } from "./ActivityStep";
import { DiffSyntaxHighlight } from "./DiffSyntaxHighlight";
import { DiffPair } from "./DiffPair";

export interface FileEditSummary {
  key: string;
  path: string;
  absolute_path?: string;
  added: number;
  deleted: number;
  approximate: boolean;
  binary: boolean;
  status: UIFileEdit["status"];
  operation?: UIFileEdit["operation"];
  pending: boolean;
  error?: string;
  diff?: UIFileDiff;
}

export function FileEditGroup({
  edits,
  onOpenFilePreview,
}: {
  edits: FileEditSummary[];
  onOpenFilePreview?: (path: string) => void;
}) {
  if (edits.length === 0) return null;
  return (
    <>
      {edits.map((edit) => (
        <FileEditRow
          key={edit.key}
          edit={edit}
          onOpenFilePreview={onOpenFilePreview}
        />
      ))}
    </>
  );
}

function FileEditRow({
  edit,
  onOpenFilePreview,
}: {
  edit: FileEditSummary;
  onOpenFilePreview?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const editing = edit.status === "editing";
  const failed = edit.status === "error";
  const canExpand = !editing && !failed && hasRenderableFileDiff(edit.diff);
  const hunks = useMemo(
    () => expanded && edit.diff ? parseRenderableFileDiff(edit.diff) : [],
    [edit.diff, expanded],
  );
  const action = fileEditAction(edit, editing, failed);
  const hasCountedDiff = !failed && !edit.binary && hasVisibleDiffStats(edit);
  const statusIcon = failed ? (
    <AlertCircle className="h-3 w-3" aria-hidden />
  ) : editing ? (
    <CircleDashed className="h-3 w-3 animate-spin" aria-hidden />
  ) : (
    <CheckCircle2 className="h-3 w-3" aria-hidden />
  );

  return (
    <div className="min-w-0">
      <ActivityStep
        marker={(
          <span
            className={cn(
              "grid h-3.5 w-3.5 place-items-center rounded-full border bg-background transition-colors",
              failed && "border-destructive/30 text-destructive/78",
              editing && "border-muted-foreground/24 text-muted-foreground/65",
              !failed && !editing && "border-emerald-500/28 text-emerald-500/78",
            )}
          >
            {statusIcon}
          </span>
        )}
        active={editing}
        tone={failed ? "error" : editing ? "active" : "success"}
        className="text-xs"
        ariaLabel={edit.path ? `${action} ${edit.path}` : action}
        label={edit.pending && !edit.path
          ? t("message.fileEditPreparing", { defaultValue: "Preparing file edit…" })
          : (
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
              <span className="shrink-0">{action}</span>
              <FileReferenceChip
                path={edit.path}
                previewPath={edit.absolute_path || edit.path}
                onOpen={onOpenFilePreview}
                display="path"
                active={editing}
                className="min-w-0"
                textClassName="truncate text-[12px]"
                testId="activity-file-reference"
              />
              {edit.approximate && hasCountedDiff ? (
                <span
                  aria-label={t("message.fileEditEstimated", { defaultValue: "estimated" })}
                  title={t("message.fileEditEstimated", { defaultValue: "estimated" })}
                  className="text-[11px] text-muted-foreground/65"
                >
                  ≈
                </span>
              ) : null}
              {hasCountedDiff ? <DiffPair added={edit.added} deleted={edit.deleted} /> : null}
              {canExpand ? (
                <button
                  type="button"
                  aria-label={t("message.fileDiffToggle", {
                    defaultValue: `${expanded ? "Hide" : "Show"} diff for ${edit.path}`,
                  })}
                  aria-expanded={expanded}
                  onClick={() => setExpanded((value) => !value)}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded transition-colors hover:bg-muted/55"
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      expanded && "rotate-90",
                    )}
                  />
                </button>
              ) : null}
            </span>
          )}
      />
      {expanded && hunks.length ? (
        <div className="ml-[1.625rem] mt-1 max-h-80 overflow-auto rounded-md border border-border/55 bg-background/55">
          {edit.diff?.truncated ? (
            <div className="border-b border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-200">
              {t("message.fileDiffTruncated")}
            </div>
          ) : null}
          {hunks.map((hunk, index) => (
            <div key={`${hunk.header}:${index}`}>
              <div className="border-y border-border/35 bg-muted/35 px-3 py-1 font-mono text-[10px] text-muted-foreground">
                {hunk.header}
              </div>
              <DiffSyntaxHighlight
                language={codeLanguageFromPath(edit.path)}
                lines={hunk.lines}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function hasVisibleDiffStats(edit: Pick<FileEditSummary, "added" | "deleted">): boolean {
  return edit.added > 0 || edit.deleted > 0;
}

function fileEditAction(edit: FileEditSummary, editing: boolean, failed: boolean): string {
  const deleting = edit.operation === "delete";
  if (failed) return deleting ? "Could not delete" : "Could not edit";
  if (editing) return deleting ? "Deleting" : "Editing";
  return deleting ? "Deleted" : "Edited";
}
