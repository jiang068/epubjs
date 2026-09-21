export function toast(message: string, danger = false): void {
  let stack = document.querySelector<HTMLElement>("#toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.className = "toast-stack";
    stack.setAttribute("aria-live", "polite");
    document.body.append(stack);
  }
  const node = document.createElement("div");
  node.className = `toast ${danger ? "toast-danger" : ""}`;
  node.setAttribute("role", "status");
  node.textContent = message;
  stack.append(node);
  window.setTimeout(() => {
    node.remove();
    if (!stack?.childElementCount) stack?.remove();
  }, 3600);
}

export function pageShell(active: "library" | "import" | "settings", content: string): string {
  return `<div class="app-shell">
    <header class="topbar">
      <a class="brand" href="#/library" aria-label="Neko Reader 书架"><span class="brand-mark">✦</span><span>NEKO <em>READER</em></span></a>
      <nav class="main-nav" aria-label="主导航">
        <a class="${active === "library" ? "active" : ""}" href="#/library">书架</a>
        <a class="${active === "import" ? "active" : ""}" href="#/import">导入</a>
        <a class="${active === "settings" ? "active" : ""}" href="#/settings">设置</a>
      </nav>
    </header>
    <main class="page-main">${content}</main>
    <footer class="home-footer">Neko Reader · 本地优先 · 文件不会上传</footer>
  </div>`;
}

export function formatSize(size: number): string {
  if (!size) return "远程文件";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
