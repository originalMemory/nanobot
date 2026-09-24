import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, ChevronDown, ChevronRight, FileText, Folder, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AttachmentTile } from "@/components/AttachmentTile";
import { MarkdownText } from "@/components/MarkdownText";
import { LibraryDocument } from "@/components/library/LibraryDocument";
import { CodeBlock } from "@/components/CodeBlock";
import { ApiError, fetchLibrary, type LibraryPayload, type LibrarySource } from "@/lib/api";
import { useClient } from "@/providers/ClientProvider";

interface DirectoryState {
  expanded: boolean;
  loading: boolean;
  payload?: Extract<LibraryPayload, { kind: "directory" }>;
  error?: string;
}

export function LibraryView({ source, onBack }: { source: LibrarySource; onBack: () => void }) {
  const { t } = useTranslation();
  const { getToken } = useClient();
  const token = useRef(getToken); token.current = getToken;
  const [nodes, setNodes] = useState<Record<string, DirectoryState>>({});
  const [preview, setPreview] = useState<LibraryPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickDocuments, setQuickDocuments] = useState<string[] | null>(null);
  const [quickSelected, setQuickSelected] = useState(0);
  const quickInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { setQuickDocuments(null); setQuickOpen(false); }, [source]);
  useEffect(() => {
    const abort = new AbortController();
    void fetchLibrary(token.current(), source, "index", "", abort.signal).then((payload) => {
      if (!abort.signal.aborted && payload.kind === "index") setQuickDocuments(payload.documents);
    }).catch(() => {});
    return () => abort.abort();
  }, [source]);
  const directoryRequests = useRef(new Map<string, AbortController>());
  const previewAbort = useRef<AbortController | null>(null);
  const storageKey = `nanobot.library.${source}.selection`;
  const tx = (key: string) => t(`library.${key}`);
  const message = (error: unknown) => error instanceof ApiError
    ? t("library.httpError", { status: error.status }) : t("library.error");
  const errorMessage = useRef(message); errorMessage.current = message;

  const loadDirectory = useCallback(async (path: string) => {
    directoryRequests.current.get(path)?.abort();
    const abort = new AbortController(); directoryRequests.current.set(path, abort);
    setNodes((previous) => ({ ...previous, [path]: { ...previous[path], expanded: true, loading: true, error: undefined } }));
    try {
      const payload = await fetchLibrary(token.current(), source, "list", path, abort.signal);
      if (abort.signal.aborted) return;
      if (payload.kind !== "directory") throw new Error("Invalid directory response");
      setNodes((previous) => ({ ...previous, [path]: { ...previous[path], payload, loading: false } }));
    } catch (error) {
      if (!abort.signal.aborted) setNodes((previous) => ({ ...previous, [path]: { ...previous[path], loading: false, error: errorMessage.current(error) } }));
    } finally {
      if (directoryRequests.current.get(path) === abort) directoryRequests.current.delete(path);
    }
  }, [source]);

  const open = useCallback(async (path: string, today = false, reveal = false) => {
    previewAbort.current?.abort();
    const abort = new AbortController(); previewAbort.current = abort;
    setSelected(path); setPreview(null); setLoading(true); setError(null); setRaw(false);
    try {
      const payload = await fetchLibrary(token.current(), source, today ? "today" : "read", path, abort.signal);
      if (abort.signal.aborted) return;
      setPreview(payload); setSelected(payload.path);
      try { localStorage.setItem(storageKey, payload.path); } catch { /* Optional view preference. */ }
      if (today || reveal) {
        const parts = payload.path.split("/").slice(0, -1);
        for (let index = 1; index <= parts.length; index++) {
          if (abort.signal.aborted) break;
          await loadDirectory(parts.slice(0, index).join("/"));
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        setError(errorMessage.current(error));
        if (error instanceof ApiError && error.status === 404) {
          try { localStorage.removeItem(storageKey); } catch { /* Optional view preference. */ }
        }
      }
    } finally { if (!abort.signal.aborted) setLoading(false); }
  }, [source, storageKey, loadDirectory]);

  useEffect(() => {
    void loadDirectory("");
    try { const saved = localStorage.getItem(storageKey); if (saved) void open(saved, false, true); } catch { /* Optional view preference. */ }
    const requests = directoryRequests.current;
    return () => { previewAbort.current?.abort(); requests.forEach((request) => request.abort()); requests.clear(); };
  }, [loadDirectory, open, storageKey]);

  const toggle = (path: string) => {
    if (!nodes[path]?.payload && !nodes[path]?.loading) { void loadDirectory(path); return; }
    setNodes((previous) => ({ ...previous, [path]: { ...previous[path], expanded: !previous[path]?.expanded } }));
  };
  const refresh = () => {
    for (const [path, node] of Object.entries(nodes)) if (node.expanded) void loadDirectory(path);
    if (selected) void open(selected, false, true);
  };
  const openReference = (path: string) => {
    if (/^[a-z]+:/i.test(path) || path.startsWith("/")) return;
    const base = (preview?.path ?? "").split("/").slice(0, -1);
    for (const part of path.split("/")) {
      if (part === "..") base.pop(); else if (part && part !== ".") base.push(part);
    }
    void open(base.join("/"), false, true);
  };
  const quickResults = (quickDocuments ?? []).filter((path) => {
    const queries = quickQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!queries.length) return true;
    const value = path.toLocaleLowerCase();
    return queries.every((query) => {
      let cursor = 0;
      return [...query].every((char) => (cursor = value.indexOf(char, cursor)) >= 0 && cursor++ >= 0);
    });
  }).slice(0, 80);
  const openQuickSwitcher = useCallback(() => {
    setQuickOpen(true); setQuickQuery(""); setQuickSelected(0);
    if (!quickDocuments) void fetchLibrary(token.current(), source, "index", "").then((payload) => {
      if (payload.kind === "index") setQuickDocuments(payload.documents);
    }).catch(() => setQuickDocuments([]));
  }, [quickDocuments, source]);
  useEffect(() => {
    if (!quickOpen) return;
    quickInputRef.current?.focus();
  }, [quickOpen]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "o") return;
      event.preventDefault();
      openQuickSwitcher();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [openQuickSwitcher]);
  const renderTree = (path: string, depth = 0): ReactNode => {
    const node = nodes[path];
    if (node && !node.expanded) return null;
    return <>
      {!node || node.loading ? <p className="px-2 py-1 text-xs text-muted-foreground">{tx("loading")}</p> : null}
      {node?.error ? <div role="alert" className="px-2 text-xs text-destructive">{node.error}<Button size="sm" variant="ghost" onClick={() => void loadDirectory(path)}>{tx("refresh")}</Button></div> : null}
      {node?.payload?.entries.length === 0 ? <p className="px-2 text-xs text-muted-foreground">{tx("empty")}</p> : null}
      <ul className="space-y-0.5">{node?.payload?.entries.map((entry) => {
        const target = [path, entry.name].filter(Boolean).join("/");
        const isDir = entry.kind === "dir";
        const expanded = !!nodes[target]?.expanded;
        return <li key={target}>
          <button type="button" title={target} aria-expanded={isDir ? expanded : undefined} aria-current={selected === target ? "page" : undefined}
            className={`flex w-full items-center gap-1 rounded-control py-1 pr-2 text-left text-xs hover:bg-sidebar-accent/80 ${selected === target ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}`}
            style={{ paddingLeft: depth * 12 + 8 }} onClick={() => isDir ? toggle(target) : void open(target)}>
            {isDir ? expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <span className="w-3.5 shrink-0" />}
            {isDir ? <Folder className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}<span className="truncate">{entry.name}</span>
          </button>
          {isDir && expanded ? renderTree(target, depth + 1) : null}
        </li>;
      })}</ul>
      {node?.payload?.truncated ? <p role="status" className="px-2 text-xs">{tx("truncated")}</p> : null}
    </>;
  };

  return <section className="flex h-full min-h-0 flex-col text-foreground" aria-label={tx(source)}>
    {quickOpen ? <div className="fixed inset-0 z-50 bg-black/15" onMouseDown={() => setQuickOpen(false)}>
      <div className="mx-auto mt-[12vh] w-[min(38rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border/70 bg-popover shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <input ref={quickInputRef} value={quickQuery} onChange={(event) => { setQuickQuery(event.target.value); setQuickSelected(0); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuickOpen(false);
            else if (event.key === "ArrowDown") { event.preventDefault(); setQuickSelected((value) => Math.min(value + 1, Math.max(0, quickResults.length - 1))); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setQuickSelected((value) => Math.max(0, value - 1)); }
            else if (event.key === "Enter" && quickResults[quickSelected]) { void open(quickResults[quickSelected], false, true); setQuickOpen(false); }
          }} placeholder={tx("quickOpenPlaceholder")} aria-label={tx("quickOpen")} className="w-full border-0 border-b border-border/60 bg-transparent px-4 py-3 text-sm outline-none" />
        <div className="max-h-[min(28rem,60vh)] overflow-auto p-1">
          {quickResults.map((path, index) => <button key={path} type="button" onClick={() => { void open(path, false, true); setQuickOpen(false); }}
            className={`flex w-full flex-col rounded-md px-3 py-2 text-left text-sm ${index === quickSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}>
            <span className="truncate">{path.split("/").pop()}</span><span className="truncate text-xs text-muted-foreground">{path}</span>
          </button>)}
          {!quickResults.length ? <p className="px-3 py-4 text-sm text-muted-foreground">{tx("quickOpenEmpty")}</p> : null}
        </div>
      </div>
    </div> : null}
    <header className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
      <Button className="host-no-drag" variant="ghost" size="sm" onClick={onBack}>{tx("back")}</Button>
      <div className="min-w-0 flex-1"><h1 className="truncate text-sm font-semibold">{tx(source)}</h1><p className="truncate font-mono text-xs text-muted-foreground">{nodes[""]?.payload?.root ?? preview?.root}</p></div>
      {source === "notes" ? <Button className="host-no-drag" variant="ghost" size="sm" onClick={() => void open("", true)}><CalendarDays className="mr-1.5 h-4 w-4" />{tx("today")}</Button> : null}
      <Button className="host-no-drag" variant="ghost" size="icon" aria-label={tx("refresh")} onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
    </header>
    <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto border-r border-border/60 bg-sidebar/40 p-2">{renderTree("")}</aside>
      <article className="flex min-h-0 min-w-0 flex-col overflow-hidden" aria-label={tx("preview")}>
        {selected !== null ? <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground"><span className="min-w-0 flex-1 break-all font-mono">{selected}</span>
          {preview?.kind === "text" && preview.language === "markdown" ? <Button variant="ghost" size="sm" onClick={() => setRaw(!raw)}>{raw ? tx("rendered") : tx("raw")}</Button> : null}
        </div> : null}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading ? <p>{tx("loading")}</p> : error ? <p role="alert">{error}</p> : !preview ? <p className="text-muted-foreground">{tx("select")}</p> : <>
            {preview.truncated ? <p role="status" className="mb-3 text-destructive">{tx("truncated")}</p> : null}
            {preview.kind === "image" ? <AttachmentTile attachment={{ kind: "image", url: preview.url, name: preview.path }} /> : null}
            {preview.kind === "text" ? <>
              {!!preview.images_omitted && <p role="status" className="mb-3 text-muted-foreground">{t("library.imagesOmitted", { count: preview.images_omitted })}</p>}
              {preview.frontmatter && (source !== "notes" || !Object.keys(preview.properties ?? {}).length) ? <details className="mb-4"><summary>{tx("properties")}</summary><CodeBlock code={preview.frontmatter} language="yaml" /></details> : null}
              {preview.language === "markdown" && !raw ? source === "notes"
                ? <LibraryDocument path={preview.path} properties={preview.properties} localImages={preview.image_sources} onOpenFilePreview={openReference}>{preview.content}</LibraryDocument>
                : <MarkdownText document localImages={preview.image_sources ?? {}} onOpenFilePreview={openReference}>{preview.content}</MarkdownText>
                : <CodeBlock code={raw ? preview.raw_content ?? preview.content : preview.content} language={preview.language} />}
            </> : null}
          </>}
        </div>
      </article>
    </div>
  </section>;
}
