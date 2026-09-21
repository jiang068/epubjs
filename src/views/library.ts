import { deleteBook, hasBookContent, listBooks, releaseBookContent, saveBook } from "../core/storage";
import { detectFormat, isImageFile, sortNaturally } from "../core/source";
import { readerPath, navigate } from "../core/router";
import type { BookRecord, StoredImage } from "../types";
import { FORMAT_LABELS } from "../types";
import { formatSize, pageShell, toast } from "../ui/common";

function makeBookCard(book: BookRecord, refresh: () => void): HTMLElement {
  const connected = hasBookContent(book);
  const card = document.createElement("article");
  card.className = "book-card";
  card.tabIndex = 0;
  const cover = document.createElement("div");
  cover.className = `book-cover cover-${book.format}`;
  cover.textContent = book.format === "comic" ? "漫" : book.format === "epub" ? "文" : book.format === "pdf" ? "PDF" : "字";
  const content = document.createElement("div");
  content.className = "book-card-content";
  const name = document.createElement("h3");
  name.textContent = book.name;
  const progress = Math.round((book.progress || 0) * 100);
  const meta = document.createElement("p");
  const availability = book.offlineStored ? "已保留本体" : connected ? "本次会话" : "需重新选择文件";
  meta.textContent = `${FORMAT_LABELS[book.format]} · ${formatSize(book.size)} · ${progress}% · ${availability}`;
  const bar = document.createElement("div");
  bar.className = "mini-progress";
  const fill = document.createElement("span");
  fill.style.width = `${progress}%`;
  bar.append(fill);
  content.append(name, meta, bar);
  const open = document.createElement("button");
  open.className = "card-open button secondary";
  open.textContent = connected ? (progress ? "继续阅读" : "开始阅读") : "重新选择";
  const openBook = () => {
    if (hasBookContent(book)) {
      navigate(readerPath(book.id));
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    if (book.localSource === "folder") {
      input.multiple = true;
      input.accept = "image/*";
      if (typeof (input as unknown as Record<string, unknown>).webkitdirectory === "boolean") {
        input.setAttribute("webkitdirectory", "");
        input.setAttribute("directory", "");
      } else {
        toast("当前浏览器不支持直接选择文件夹，请多选漫画图片");
      }
    } else {
      input.accept = book.format === "epub" ? ".epub" : book.format === "pdf" ? ".pdf" : book.format === "txt" ? ".txt,.text" : ".cbz,.zip,image/*";
    }
    input.addEventListener("change", async () => {
      try {
        const files = [...(input.files || [])];
        if (!files.length) return;
        if (book.localSource === "folder") {
          const images = sortNaturally(files.filter(isImageFile));
          if (!images.length) throw new Error("所选文件夹中没有支持的图片");
          book.images = images.map((file): StoredImage => ({ name: file.webkitRelativePath || file.name, blob: file }));
          book.blob = undefined;
          book.size = images.reduce((sum, file) => sum + file.size, 0);
        } else {
          const file = files[0];
          if (detectFormat(file.name, file.type) !== book.format) throw new Error(`请选择与《${book.name}》相同格式的文件`);
          book.blob = file;
          book.images = undefined;
          book.size = file.size;
        }
        await saveBook(book);
        navigate(readerPath(book.id));
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), true);
      } finally {
        input.remove();
      }
    }, { once: true });
    document.body.append(input);
    input.click();
  };
  open.addEventListener("click", openBook);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.append(open);
  if (book.offlineStored) {
    const release = document.createElement("button");
    release.className = "card-cache-action";
    release.textContent = "释放本体";
    release.title = "只释放文件本体，保留书架记录与进度";
    release.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!window.confirm(`释放《${book.name}》的文件本体？书架记录和阅读进度会保留。`)) return;
      await releaseBookContent(book.id);
      toast("已释放文件本体，阅读记录仍然保留");
      refresh();
    });
    actions.append(release);
  }
  const remove = document.createElement("button");
  remove.className = "card-remove";
  remove.textContent = "×";
  remove.title = "从书架移除";
  remove.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!window.confirm(`从本机书架移除《${book.name}》？`)) return;
    await deleteBook(book.id);
    toast("已从书架移除");
    refresh();
  });
  card.addEventListener("dblclick", (event) => { if (!(event.target instanceof Element) || !event.target.closest("button")) openBook(); });
  card.addEventListener("keydown", (event) => { if (event.key === "Enter") openBook(); });
  card.append(cover, content, actions, remove);
  return card;
}

export async function renderLibrary(root: HTMLElement): Promise<void> {
  root.innerHTML = pageShell("library", `
    <section class="hero compact-hero">
      <div class="hero-copy"><p class="eyebrow">你的私人二次元书库</p><h1>继续上次的<br><span>故事。</span></h1><p class="hero-subtitle">可按设置保留最近书籍的文件本体，刷新后也能继续阅读；超出数量时只释放本体，不删除书架记录与进度。</p><div class="hero-actions"><a class="button primary" href="#/import">＋ 导入新作品</a><a class="button secondary" href="#/settings">阅读设置</a></div></div>
      <div class="hero-art"><div class="orbit orbit-a"></div><div class="orbit orbit-b"></div><div class="mascot">ฅ^•ﻌ•^ฅ</div><span class="spark spark-a">✦</span><span class="spark spark-b">✧</span></div>
    </section>
    <section class="library"><div class="section-heading"><div><p class="eyebrow">MY SHELF</p><h2>最近阅读</h2></div><span id="book-count" class="muted">载入中…</span></div><div class="book-grid" id="book-grid"><div class="empty-state">正在整理你的书架…</div></div></section>`);
  const books = await listBooks();
  const grid = root.querySelector<HTMLDivElement>("#book-grid");
  const count = root.querySelector<HTMLElement>("#book-count");
  if (!grid || !count) return;
  count.textContent = `${books.length} 本收藏`;
  grid.replaceChildren();
  if (!books.length) {
    grid.innerHTML = '<div class="empty-state"><span>✧</span><h3>书架还是空的</h3><p>去“导入”页面添加 EPUB、漫画、PDF 或 TXT。</p><a class="button primary" href="#/import">打开导入页</a></div>';
    return;
  }
  books.forEach((book) => grid.append(makeBookCard(book, () => void renderLibrary(root))));
}
