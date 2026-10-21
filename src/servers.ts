export const aliases: Record<string, string> = {
  go: "gopls",
  gopls: "gopls",
  rust: "rust-analyzer",
  "rust-analyzer": "rust-analyzer",
  c: "clangd",
  cpp: "clangd",
  clangd: "clangd",
  ts: "typescript",
  typescript: "typescript",
  javascript: "typescript",
  js: "typescript",
  python: "pyright",
  pyright: "pyright",
  html: "html",
  css: "css",
  scss: "css",
  less: "css",
};

/** 将自然语言别名规范到固定服务器集合，不接受任意包名。 */
export function target(value: string): string {
  const name = aliases[value.toLowerCase()];
  if (!name) throw new Error("InvalidInput：不支持的服务器。");
  return name;
}
