import { materializeText } from "../core/source";
import type { BookMetadata, BookSource, Locator, ReaderEngine, ReaderFlow, ReaderHost, ReaderSpread, ReaderTheme } from "../types";

function splitPages(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const paragraphs = normalized.split("\n");
  const pages: string[] = [];
  let current = "";
  const target = 2800;
  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n${paragraph}` : paragraph;
    if (next.length > target && current) {
      pages.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }
  if (current || !pages.length) pages.push(current);
  return pages;
}

export class TextEngine implements ReaderEngine {
  readonly format = "txt" as const;
  private pages: string[] = [];
  private index = 0;
  private host?: ReaderHost;
  private fontSize = 100;
  private spread: ReaderSpread = "single";
  private flow: ReaderFlow = "paginated";
  private lineHeight = 1.85;
  private zoom = 90;
  private scrollHandler?: () => void;

  async open(source: BookSource, host: ReaderHost): Promise<BookMetadata> {
    this.host = host;
    this.pages = splitPages(await materializeText(source));
    this.index = 0;
    const metadata = { title: source.kind === "url" ? source.name || "远程 TXT" : source.kind === "stored" ? source.record.name : source.file.name, format: this.format, total: this.pages.length };
    host.onMetadata(metadata);
    this.render();
    return metadata;
  }

  private render(): void {
    if (!this.host) return;
    this.scrollHandler = undefined;
    this.host.surface.innerHTML = "";
    const article = document.createElement("article");
    article.className = `txt-page${this.flow === "scrolled" ? " txt-flow" : ""}`;
    article.textContent = this.flow === "scrolled" ? this.pages.join("\n\n") : (this.pages[this.index] || "");
    article.style.fontSize = `${this.fontSize}%`;
    article.style.lineHeight = String(this.lineHeight);
    article.classList.toggle("txt-double", this.flow === "paginated" && this.spread === "double" && window.innerWidth > 760);
    this.host.surface.append(article);
    if (this.flow === "scrolled") {
      this.scrollHandler = () => this.reportScroll(article);
      article.addEventListener("scroll", this.scrollHandler, { passive: true });
      this.reportScroll(article);
    } else {
      const progress = this.index / Math.max(1, this.pages.length - 1);
      this.host.onLocation({ kind: this.format, page: this.index + 1, total: this.pages.length, percent: progress, atStart: this.index === 0, atEnd: this.index === this.pages.length - 1 }, progress);
    }
  }

  private reportScroll(article: HTMLElement): void {
    const max = Math.max(0, article.scrollHeight - article.clientHeight);
    const progress = max ? article.scrollTop / max : 0;
    this.index = Math.max(0, Math.min(this.pages.length - 1, Math.round(progress * Math.max(1, this.pages.length - 1))));
    this.host?.onLocation({ kind: this.format, page: this.index + 1, total: this.pages.length, percent: progress, offset: article.scrollTop, atStart: article.scrollTop <= 1, atEnd: article.scrollTop >= max - 1 }, progress);
  }

  async next(): Promise<void> {
    if (this.flow === "scrolled") {
      const article = this.host?.surface.querySelector<HTMLElement>(".txt-flow");
      if (article) { article.scrollTop = Math.min(article.scrollHeight - article.clientHeight, article.scrollTop + article.clientHeight * .9); this.reportScroll(article); }
      return;
    }
    if (this.index < this.pages.length - 1) {
      this.index += 1;
      this.render();
    }
  }

  async prev(): Promise<void> {
    if (this.flow === "scrolled") {
      const article = this.host?.surface.querySelector<HTMLElement>(".txt-flow");
      if (article) { article.scrollTop = Math.max(0, article.scrollTop - article.clientHeight * .9); this.reportScroll(article); }
      return;
    }
    if (this.index > 0) {
      this.index -= 1;
      this.render();
    }
  }

  async goTo(locator: Locator): Promise<void> {
    if (this.flow === "scrolled") {
      const article = this.host?.surface.querySelector<HTMLElement>(".txt-flow");
      if (article) { const ratio = Math.max(0, Math.min(1, ((locator.page || 1) - 1) / Math.max(1, this.pages.length - 1))); article.scrollTop = ratio * Math.max(0, article.scrollHeight - article.clientHeight); this.reportScroll(article); }
      return;
    }
    this.index = Math.max(0, Math.min(this.pages.length - 1, (locator.page || 1) - 1));
    this.render();
  }

  setFontSize(percent: number): void {
    this.fontSize = percent;
    const page = this.host?.surface.querySelector<HTMLElement>(".txt-page");
    if (page) page.style.fontSize = `${percent}%`;
  }

  setTheme(_theme: ReaderTheme): void {
    // The app shell owns the global theme; text content intentionally stays readable.
  }

  setSpread(spread: ReaderSpread): void {
    this.spread = spread;
    const page = this.host?.surface.querySelector<HTMLElement>(".txt-page");
    page?.classList.toggle("txt-double", this.flow === "paginated" && spread === "double" && window.innerWidth > 760);
  }

  setFlow(flow: ReaderFlow): void {
    this.flow = flow;
    if (this.host) this.render();
  }

  setLineHeight(lineHeight: number): void {
    this.lineHeight = lineHeight;
    const page = this.host?.surface.querySelector<HTMLElement>(".txt-page");
    if (page) page.style.lineHeight = String(lineHeight);
  }

  setZoom(percent: number): void {
    this.zoom = Math.max(30, Math.min(100, percent));
    this.host?.surface.style.setProperty("--reader-scroll-width", `${this.zoom}%`);
  }

  destroy(): void {
    const page = this.host?.surface.querySelector<HTMLElement>(".txt-flow");
    if (page && this.scrollHandler) page.removeEventListener("scroll", this.scrollHandler);
    this.host?.surface.replaceChildren();
    this.host = undefined;
    this.pages = [];
  }
}
