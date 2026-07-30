import { useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { FileReferenceChip } from "@/components/FileReferenceChip";
import { StreamingLabelSheen } from "@/components/MessageBubble";
import { codeLanguageFromPath } from "@/lib/code-language";
import {
  hasRenderableFileDiff,
  parseRenderableFileDiff,
} from "@/lib/file-diff";
import type { UIFileDiff, UIFileEdit } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DiffSyntaxHighlight } from "./DiffSyntaxHighlight";

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

export function FileEditGroup({ edits }: { edits: FileEditSummary[] }) {
  if (!edits.length) return null;
  return (
    <div className="space-y-1">
      {edits.map((edit) => <FileEditRow key={edit.key} edit={edit} />)}
    </div>
  );
}

function FileEditRow({ edit }: { edit: FileEditSummary }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const editing = edit.status === "editing";
  const failed = edit.status === "error";
  const canExpand = !editing && !failed && hasRenderableFileDiff(edit.diff);
  const hunks = useMemo(
    () => expanded && edit.diff ? parseRenderableFileDiff(edit.diff) : [],
    [edit.diff, expanded],
  );
  const label = failed
    ? edit.operation === "delete"
      ? t("message.fileEditDeleteFailed")
      : t("message.fileEditEditFailed")
    : edit.operation === "delete"
      ? (editing ? t("message.fileEditDeleting") : t("message.fileEditDeleted"))
      : (editing ? t("message.fileEditEditing") : t("message.fileEditEdited"));
  const error = failed
    ? cleanFileEditError(edit.error) || t("message.fileEditUnknownError")
    : "";

  return (
    <div className="min-w-0">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "activity-detail-content flex w-full min-w-0 items-center gap-2 py-0.5 text-left text-xs",
          canExpand && "cursor-pointer rounded hover:bg-muted/30",
          !canExpand && "cursor-default",
        )}
        aria-expanded={canExpand ? expanded : undefined}
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center text-muted-foreground/60">
          {failed ? <AlertCircle className="h-3.5 w-3.5 text-destructive/75" />
            : editing ? <CircleDashed className="h-3.5 w-3.5 animate-spin" />
              : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500/75" />}
        </span>
        <span className="shrink-0 text-muted-foreground/78">{label}</span>
        {edit.pending && !edit.path ? (
          <StreamingLabelSheen active className="min-w-0 truncate">
            {t("message.fileEditPreparing")}
          </StreamingLabelSheen>
        ) : (
          <FileReferenceChip
            path={edit.path}
            tooltipPath={edit.absolute_path}
            display="path"
            active={editing}
            className="min-w-0"
            textClassName="text-[12px]"
            testId="activity-file-reference"
          />
        )}
        {!failed && !edit.binary && (edit.added > 0 || edit.deleted > 0) ? (
          <span className="ml-auto inline-flex shrink-0 gap-1.5 tabular-nums">
            <span className="text-emerald-500/80">+{edit.added}</span>
            <span className="text-rose-500/80">-{edit.deleted}</span>
            {edit.approximate ? (
              <span className="text-muted-foreground/65">
                {t("message.fileEditEstimated")}
              </span>
            ) : null}
          </span>
        ) : null}
        {canExpand ? (
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
        ) : null}
      </button>
      {failed ? (
        <div className="activity-detail-content ml-7 break-words pr-2 text-[11px] text-destructive/80">
          {error}
        </div>
      ) : null}
      {expanded && hunks.length ? (
        <div className="ml-7 mt-1 max-h-80 overflow-auto rounded-md border border-border/55 bg-background/55">
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
              <DiffSyntaxHighlight language={codeLanguageFromPath(edit.path)} lines={hunk.lines} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function cleanFileEditError(error: string | undefined): string {
  if (!error) return "";
  return error.replace(/^(?:error|runtimeerror|exception):\s*/i, "").trim();
}
