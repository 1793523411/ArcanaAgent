import type { ArtifactMeta } from "../types";

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
  artifact?: ArtifactMeta;
}

export function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileIcon(mime: string): string {
  if (mime.startsWith("image/")) return "🖼";
  if (mime === "application/pdf") return "📄";
  if (mime.startsWith("text/markdown")) return "📝";
  if (mime.startsWith("text/") || mime === "application/json") return "📃";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.startsWith("video/")) return "🎬";
  return "📎";
}

export function isPreviewable(mime: string): boolean {
  return (
    mime.startsWith("image/") ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/pdf"
  );
}

export function languageFromPath(path: string): string {
  const name = baseName(path).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (["sh", "bash", "zsh"].includes(ext)) return "bash";
  if (["js", "mjs", "cjs"].includes(ext)) return "javascript";
  if (["ts", "tsx"].includes(ext)) return "typescript";
  if (["jsx"].includes(ext)) return "jsx";
  if (["json"].includes(ext)) return "json";
  if (["py"].includes(ext)) return "python";
  if (["go"].includes(ext)) return "go";
  if (["java"].includes(ext)) return "java";
  if (["rb"].includes(ext)) return "ruby";
  if (["rs"].includes(ext)) return "rust";
  if (["yml", "yaml"].includes(ext)) return "yaml";
  if (["xml"].includes(ext)) return "xml";
  if (["html", "htm"].includes(ext)) return "html";
  if (["css"].includes(ext)) return "css";
  if (["sql"].includes(ext)) return "sql";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["toml"].includes(ext)) return "toml";
  if (["ini", "conf"].includes(ext)) return "ini";
  return "";
}

export function isCodeLikeText(mime: string, path: string): boolean {
  const lang = languageFromPath(path);
  if (lang && lang !== "markdown") return true;
  return mime === "application/json";
}

/** Map file extension to Monaco editor language id */
export function monacoLanguageFromPath(path: string): string {
  const name = baseName(path).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    json: "json",
    html: "html", htm: "html",
    css: "css", scss: "scss", less: "less",
    py: "python",
    go: "go",
    java: "java",
    rb: "ruby",
    rs: "rust",
    yml: "yaml", yaml: "yaml",
    xml: "xml",
    sql: "sql",
    md: "markdown", markdown: "markdown",
    sh: "shell", bash: "shell", zsh: "shell",
    c: "c", h: "c",
    cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
    cs: "csharp",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    r: "r",
    lua: "lua",
    toml: "ini",
    ini: "ini", conf: "ini",
    dockerfile: "dockerfile",
    graphql: "graphql", gql: "graphql",
  };
  // Check special filenames
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return map[ext] || "plaintext";
}

export function buildFileTree(artifacts: ArtifactMeta[]): TreeNode {
  const root: TreeNode = {
    name: "root",
    path: "",
    type: "folder",
    children: [],
  };

  for (const artifact of artifacts) {
    const parts = artifact.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join("/");

      if (!current.children) current.children = [];

      let node = current.children.find((n) => n.name === part);

      if (!node) {
        node = {
          name: part,
          path: currentPath,
          type: isFile ? "file" : "folder",
          ...(isFile ? { artifact } : { children: [] }),
        };
        current.children.push(node);
      }

      current = node;
    }
  }

  const sortChildren = (node: TreeNode) => {
    if (node.children) {
      node.children.sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortChildren);
    }
  };
  sortChildren(root);

  return root;
}
