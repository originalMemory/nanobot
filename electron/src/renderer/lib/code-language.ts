const FILE_NAME_LANGUAGES: Record<string, string> = {
  "cmakelists.txt": "cmake",
  dockerfile: "docker",
  gemfile: "ruby",
  makefile: "makefile",
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css",
  go: "go", h: "c", hpp: "cpp", html: "markup", java: "java",
  js: "javascript", json: "json", jsonl: "json", jsx: "jsx",
  md: "markdown", mjs: "javascript", php: "php", py: "python",
  rb: "ruby", rs: "rust", scss: "scss", sh: "bash", sql: "sql",
  svg: "markup", toml: "toml", ts: "typescript", tsx: "tsx",
  vue: "vue", xml: "markup", yaml: "yaml", yml: "yaml", zsh: "bash",
};

export function codeLanguageFromPath(path?: string | null): string {
  if (!path?.trim()) return "text";
  const normalized = path.replace(/\\/g, "/").split(/[?#]/, 1)[0]!;
  const name = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (!name) return "text";
  if (name.startsWith("dockerfile.")) return "docker";
  if (FILE_NAME_LANGUAGES[name]) return FILE_NAME_LANGUAGES[name]!;
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return EXTENSION_LANGUAGES[extension] ?? (extension || "text");
}
