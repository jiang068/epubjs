import { applyPreferences, loadPreferences, type ReaderPreferences } from "./core/preferences";
import { navigate, readerPath, startRouter, type AppRoute } from "./core/router";
import { recordFromUrl } from "./core/source";
import { getBook, hasBookContent, saveBook } from "./core/storage";
import { pageShell, toast } from "./ui/common";
import { renderImport } from "./views/import";
import { renderLibrary } from "./views/library";
import { ReaderView } from "./views/reader";
import { renderSettings } from "./views/settings";

export class NekoApp {
  private preferences: ReaderPreferences = loadPreferences();
  private reader?: ReaderView;
  private renderToken = 0;

  constructor(private root: HTMLElement) {}

  start(): void {
    applyPreferences(this.preferences);
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      // Always check the worker script itself for updates; otherwise an old
      // broken worker can keep serving cached shell assets during local QA.
      void navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => undefined);
    }
    const legacy = new URLSearchParams(location.search);
    if (!location.hash && legacy.get("url")) {
      const query = new URLSearchParams({ url: legacy.get("url")! });
      if (legacy.get("name")) query.set("name", legacy.get("name")!);
      navigate("/open", query, true);
    }
    startRouter((route) => void this.render(route));
  }

  private async render(route: AppRoute): Promise<void> {
    const token = ++this.renderToken;
    if (route.name !== "reader") this.destroyReader();
    if (route.name === "library") { await renderLibrary(this.root); return; }
    if (route.name === "import") { renderImport(this.root); return; }
    if (route.name === "settings") {
      renderSettings(this.root, this.preferences, () => applyPreferences(this.preferences));
      return;
    }
    if (route.name === "open") {
      this.root.innerHTML = '<div class="route-loading"><div class="loading-orbit"></div><p>正在准备远程文件…</p></div>';
      const url = route.query.get("url");
      if (!url) { navigate("/import", undefined, true); return; }
      try {
        const record = recordFromUrl(url, route.query.get("name") || undefined);
        await saveBook(record);
        if (token === this.renderToken) navigate(readerPath(record.id), undefined, true);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), true);
        navigate("/import", undefined, true);
      }
      return;
    }
    if (route.name === "reader") {
      this.destroyReader();
      this.root.innerHTML = '<div class="route-loading"><div class="loading-orbit"></div><p>正在从书架取书…</p></div>';
      const book = await getBook(route.bookId);
      if (token !== this.renderToken) return;
      if (!book) {
        this.root.innerHTML = pageShell("library", '<section class="not-found"><span>?</span><h1>找不到这本书</h1><p>本地文件可能来自另一台设备或已被浏览器清理。</p><a class="button primary" href="#/import">重新导入</a></section>');
        return;
      }
      if (!hasBookContent(book)) {
        this.root.innerHTML = pageShell("library", `<section class="not-found"><span>↻</span><h1>需要重新选择本地文件</h1><p>为避免浏览器存储不断膨胀，阅读器不会保存书籍本体。请返回书架，为《${book.name.replace(/[&<>"']/g, (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" })[value] || value)}》重新选择文件，进度会继续保留。</p><a class="button primary" href="#/library">返回书架</a></section>`);
        return;
      }
      this.reader = new ReaderView(this.root, book, this.preferences, route.locator);
      await this.reader.mount();
      return;
    }
    this.root.innerHTML = pageShell("library", '<section class="not-found"><span>404</span><h1>这里没有内容</h1><p>地址可能已经失效。</p><a class="button primary" href="#/library">返回书架</a></section>');
  }

  private destroyReader(): void {
    this.reader?.destroy();
    this.reader = undefined;
  }
}
