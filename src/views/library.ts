import { deleteBook, listBooks } from "../core/storage";
import { readerPath, navigate } from "../core/router";
import type { BookRecord } from "../types";
import { FORMAT_LABELS } from "../types";
import { formatSize, pageShell, toast } from "../ui/common";

function makeBookCard(book: BookRecord, refresh: () => void): HTMLElement {
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
  meta.textContent = `${FORMAT_LABELS[book.format]} · ${formatSize(book.size)} · ${progress}%`;
  const bar = document.createElement("div");
  bar.className = "mini-progress";
  const fill = document.createElement("span");
  fill.style.width = `${progress}%`;
  bar.append(fill);
  content.append(name, meta, bar);
  const open = document.createElement("button");
  open.className = "card-open button secondary";
  open.textContent = progress ? "继续阅读" : "开始阅读";
  open.addEventListener("click", () => navigate(readerPath(book.id)));
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
  card.addEventListener("dblclick", () => navigate(readerPath(book.id)));
  card.addEventListener("keydown", (event) => { if (event.key === "Enter") navigate(readerPath(book.id)); });
  card.append(cover, content, open, remove);
  return card;
}

export async function renderLibrary(root: HTMLElement): Promise<void> {
  root.innerHTML = pageShell("library", `
    <section class="hero compact-hero">
      <div class="hero-copy"><p class="eyebrow">你的私人二次元书库</p><h1>继续上次的<br><span>故事。</span></h1><p class="hero-subtitle">EPUB、漫画、PDF、TXT 都保存在浏览器本地。每次翻页都会保存进度并同步到地址栏。</p><div class="hero-actions"><a class="button primary" href="#/import">＋ 导入新作品</a><a class="button secondary" href="#/settings">阅读设置</a></div></div>
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
