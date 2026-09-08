import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronRight, FileText, Folder, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { FilePreview } from "@/components/workspace/FilePreview";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  fetchDiaryList,
  fetchDiaryRead,
  fetchWorkspaceList,
  fetchWorkspaceRead,
} from "@/lib/api";
import {
  joinWorkspacePath,
  previewModeForPath,
  todayDiaryPath,
  workspaceAncestorDirs,
  workspaceImageDataUrl,
  type WorkspaceListEntry,
} from "@/lib/workspaceViewer";
import { cn } from "@/lib/utils";

interface WorkspaceViewProps {
  token: string;
  gatewayUrl: string;
  rootPath: string | null;
  source?: "workspace" | "diary";
  timezone?: string | null;
  onBack: () => void;
}

interface TreeNodeState {
  entries: WorkspaceListEntry[];
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

function emptyNodeState(): TreeNodeState {
  return {
    entries: [],
    expanded: false,
    loaded: false,
    loading: false,
    error: null,
  };
}

export function WorkspaceView({
  token,
  gatewayUrl,
  rootPath,
  source = "workspace",
  timezone = null,
  onBack,
}: WorkspaceViewProps) {
  const { t } = useTranslation();
  const [rootState, setRootState] = useState<TreeNodeState>(emptyNodeState);
  const [childStates, setChildStates] = useState<Record<string, TreeNodeState>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null);
  const [previewFrontmatter, setPreviewFrontmatter] = useState<Record<string, unknown> | null>(null);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const previewAbortRef = useRef<AbortController | null>(null);
  const restoredRef = useRef(false);
  const storageKey = `${source}_viewer_state`;
  const listDirectory = source === "diary" ? fetchDiaryList : fetchWorkspaceList;
  const readFile = source === "diary" ? fetchDiaryRead : fetchWorkspaceRead;

  const loadDirectory = useCallback(async (relPath: string) => {
    const isRoot = relPath === "";
    const setState = isRoot
      ? setRootState
      : (updater: (prev: TreeNodeState) => TreeNodeState) => {
          setChildStates((prev) => ({
            ...prev,
            [relPath]: updater(prev[relPath] ?? emptyNodeState()),
          }));
        };

    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const payload = await listDirectory(token, gatewayUrl, relPath);
      setState((prev) => ({
        ...prev,
        entries: payload.entries,
        loaded: true,
        loading: false,
        expanded: true,
        error: null,
      }));
    } catch (err) {
      const message = err instanceof ApiError
        ? t("workspace.errors.http", { status: err.status })
        : t("workspace.errors.loadDir");
      setState((prev) => ({
        ...prev,
        loading: false,
        error: message,
      }));
    }
  }, [gatewayUrl, listDirectory, t, token]);

  useEffect(() => {
    void loadDirectory("");
  }, [loadDirectory]);

  /* 保存选中文件路径到 localStorage */
  useEffect(() => {
    if (restoring || !selectedPath) return;
    localStorage.setItem(
      storageKey,
      JSON.stringify({ selectedPath }),
    );
  }, [selectedPath, restoring, storageKey]);

  /* 根目录加载完成后恢复上次位置 */
  useEffect(() => {
    if (!rootState.loaded || restoredRef.current) return;
    restoredRef.current = true;
    const saved = localStorage.getItem(storageKey);
    if (!saved) return;
    let parsed: { selectedPath?: string };
    try { parsed = JSON.parse(saved); } catch { return; }
    if (!parsed.selectedPath) return;

    setRestoring(true);
    const restoreTarget = parsed.selectedPath;
    const targetDir = restoreTarget.substring(0, restoreTarget.lastIndexOf("/"));
    const dirPath = targetDir || "";
    const fileName = restoreTarget.split("/").pop() ?? "";

    (async () => {
      try {
        const payload = await listDirectory(token, gatewayUrl, dirPath);
        const exists = payload.entries.some(
          (e) => e.name === fileName && e.kind === "file",
        );
        if (exists) {
          for (const path of workspaceAncestorDirs(restoreTarget)) {
            await loadDirectory(path);
          }
          openFile(restoreTarget);
        } else {
          localStorage.removeItem(storageKey);
        }
      } catch {
        localStorage.removeItem(storageKey);
      } finally {
        setRestoring(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootState.loaded]);

  useEffect(() => () => {
    previewAbortRef.current?.abort();
  }, []);

  const openFile = useCallback(async (relPath: string, notFoundMessage?: string) => {
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const { signal } = controller;

    setSelectedPath(relPath);
    if (previewModeForPath(relPath) === "unsupported") {
      setPreviewContent(null);
      setPreviewImageSrc(null);
      setPreviewFrontmatter(null);
      setPreviewTruncated(false);
      setPreviewError(t("workspace.preview.unsupported"));
      setPreviewLoading(false);
      return false;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewContent(null);
    setPreviewImageSrc(null);
    setPreviewFrontmatter(null);
    try {
      const payload = await readFile(token, relPath, gatewayUrl, signal);
      if (signal.aborted) return false;
      if (payload.kind === "image") {
        setPreviewImageSrc(workspaceImageDataUrl(payload));
        setPreviewContent(null);
        setPreviewFrontmatter(null);
        setPreviewTruncated(Boolean(payload.truncated));
      } else {
        setPreviewContent(payload.content);
        setPreviewImageSrc(null);
        setPreviewFrontmatter(payload.frontmatter ?? null);
        setPreviewTruncated(Boolean(payload.truncated));
      }
      return true;
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return false;
      }
      const message = err instanceof ApiError
        ? (err.status === 404 && notFoundMessage
            ? notFoundMessage
            : err.status === 415 || err.status === 413
            ? t(err.status === 413 ? "workspace.preview.tooLarge" : "workspace.preview.unsupported")
            : t("workspace.errors.http", { status: err.status }))
        : t("workspace.errors.loadFile");
      setPreviewError(message);
      setPreviewContent(null);
      setPreviewImageSrc(null);
      setPreviewFrontmatter(null);
      setPreviewTruncated(false);
      return false;
    } finally {
      if (!signal.aborted) {
        setPreviewLoading(false);
      }
    }
  }, [gatewayUrl, readFile, t, token]);

  const revealFile = useCallback(async (relPath: string, notFoundMessage?: string) => {
    if (!await openFile(relPath, notFoundMessage)) return;
    for (const path of workspaceAncestorDirs(relPath)) {
      await loadDirectory(path);
    }
  }, [loadDirectory, openFile]);

  const refresh = useCallback(async () => {
    await loadDirectory("");
    if (selectedPath) await revealFile(selectedPath);
  }, [loadDirectory, revealFile, selectedPath]);

  const openToday = useCallback(() => {
    const path = todayDiaryPath(timezone);
    void revealFile(path, t("diary.todayMissing", { path }));
  }, [revealFile, t, timezone]);

  const toggleDirectory = useCallback((relPath: string) => {
    const current = childStates[relPath] ?? emptyNodeState();
    if (!current.loaded && !current.loading) {
      void loadDirectory(relPath);
      return;
    }
    setChildStates((prev) => ({
      ...prev,
      [relPath]: {
        ...(prev[relPath] ?? emptyNodeState()),
        expanded: !(prev[relPath]?.expanded ?? false),
      },
    }));
  }, [childStates, loadDirectory]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t("workspace.back")}
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">
            {t(source === "diary" ? "diary.title" : "workspace.title")}
          </h1>
          {rootPath ? (
            <p className="truncate font-mono text-xs text-muted-foreground">{rootPath}</p>
          ) : null}
        </div>
        {source === "diary" ? (
          <Button variant="ghost" size="sm" onClick={openToday}>
            <CalendarDays className="mr-1.5 h-4 w-4" />
            {t("diary.openToday")}
          </Button>
        ) : null}
        <Button variant="ghost" size="icon" onClick={() => void refresh()} title={t("workspace.refresh")}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)]">
        <aside className="scroll-surface min-h-0 overflow-auto border-r border-border/60 bg-sidebar/40 p-2">
          {rootState.error ? (
            <p className="px-2 py-1 text-xs text-destructive">{rootState.error}</p>
          ) : null}
          <DirectoryTree
            relPath=""
            depth={0}
            nodeState={rootState}
            childStates={childStates}
            selectedPath={selectedPath}
            onToggleDirectory={toggleDirectory}
            onOpenFile={openFile}
          />
        </aside>

        <section className="min-h-0 overflow-hidden bg-background">
          <FilePreview
            path={selectedPath}
            content={previewContent}
            imageSrc={previewImageSrc}
            truncated={previewTruncated}
            error={previewError}
            loading={previewLoading}
            frontmatter={previewFrontmatter}
            source={source}
            token={token}
            gatewayUrl={gatewayUrl}
          />
        </section>
      </div>
    </div>
  );
}

function DirectoryTree({
  relPath,
  depth,
  nodeState,
  childStates,
  selectedPath,
  onToggleDirectory,
  onOpenFile,
}: {
  relPath: string;
  depth: number;
  nodeState: TreeNodeState;
  childStates: Record<string, TreeNodeState>;
  selectedPath: string | null;
  onToggleDirectory: (relPath: string) => void;
  onOpenFile: (relPath: string) => void;
}) {
  if (!nodeState.loaded && nodeState.loading && depth === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">…</p>;
  }

  if (!nodeState.expanded && depth > 0) {
    return null;
  }

  const entries = depth === 0 && !nodeState.loaded ? [] : nodeState.entries;

  return (
    <ul className="space-y-0.5">
      {entries.map((entry) => {
        const entryPath = joinWorkspacePath(relPath, entry.name);
        const isDir = entry.kind === "dir";
        const childState = childStates[entryPath] ?? emptyNodeState();
        const expanded = isDir && childState.expanded;
        const active = selectedPath === entryPath;

        return (
          <li key={entryPath}>
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs",
                "hover:bg-sidebar-accent/80",
                active && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              onClick={() => {
                if (isDir) {
                  onToggleDirectory(entryPath);
                } else {
                  void onOpenFile(entryPath);
                }
              }}
            >
              {isDir ? (
                expanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
                )
              ) : (
                <span className="inline-block w-3.5 shrink-0" />
              )}
              {isDir ? (
                <Folder className="h-3.5 w-3.5 shrink-0 opacity-80" />
              ) : (
                <FileText className="h-3.5 w-3.5 shrink-0 opacity-80" />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
            {isDir && expanded ? (
              <DirectoryTree
                relPath={entryPath}
                depth={depth + 1}
                nodeState={childState}
                childStates={childStates}
                selectedPath={selectedPath}
                onToggleDirectory={onToggleDirectory}
                onOpenFile={onOpenFile}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
