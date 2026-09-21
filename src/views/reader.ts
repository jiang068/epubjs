import { replaceReaderLocation, navigate } from "../core/router";
import { sourceFromRecord } from "../core/source";
import { saveBook, updateProgress } from "../core/storage";
import { THEME_OPTIONS, savePreferences, type ReaderPreferences } from "../core/preferences";
import type { BookFormat, BookMetadata, BookRecord, ImageFit, Locator, ReaderEngine, ReaderFlow, ReaderHost, ReaderSpread, ReaderTheme } from "../types";
import { FORMAT_LABELS } from "../types";
import { toast } from "../ui/common";

async function makeEngine(format: BookFormat): Promise<ReaderEngine> {
  if (format === "epub") return new (await import("../engines/epub")).EpubEngine();
  if (format === "pdf") return new (await import("../engines/pdf")).PdfEngine();
  if (format === "comic") return new (await import("../engines/comic")).ComicEngine();
  return new (await import("../engines/text")).TextEngine();
}

function locatorLabel(locator: Locator, metadata?: BookMetadata, flow?: ReaderFlow): string {
  if (locator.kind === "epub" && flow === "scrolled") {
    // Continuous EPUB locations are section-based, so displayed.page/total
    // can legitimately look like "2 / 1" when crossing a spine item.
    return "连续阅读";
  }
  if (locator.kind === "pdf" && flow === "scrolled" && locator.page && locator.total) {
    return `连续阅读 · 第 ${locator.page} / ${locator.total} 页`;
  }
  if (locator.page) {
    const total = locator.total || metadata?.total;
    return total ? `第 ${locator.page} / ${total} 页` : `第 ${locator.page} 页`;
  }
  if (typeof locator.percent === "number") return `已读 ${Math.round(locator.percent * 100)}%`;
  return "阅读中";
}

export class ReaderView {
  private engine?: ReaderEngine;
  private metadata?: BookMetadata;
  private latestLocator?: Locator;
  private restoring = true;
  private destroyed = false;
  private pendingProgress?: { locator: Locator; progress: number };
  private progressTimer?: number;
  private keyHandler = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); void this.engine?.next(); }
    if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); void this.engine?.prev(); }
    if (event.key === "Escape") {
      if (this.isImagePreviewOpen()) this.closeImagePreview();
      else navigate("/library");
    }
  };

  constructor(private root: HTMLElement, private book: BookRecord, private preferences: ReaderPreferences, private routeLocator?: Locator) {}

  async mount(): Promise<void> {
    this.render();
    window.addEventListener("keydown", this.keyHandler);
    this.bindControls();
    const surface = this.root.querySelector<HTMLElement>("#reader-surface");
    if (!surface) return;
    const initialLocator = this.routeLocator || this.book.locator;
    try {
      this.engine = await makeEngine(this.book.format);
      if (this.destroyed) { this.engine.destroy(); return; }
      this.engine.setFlow?.(this.preferences.flow);
      const host: ReaderHost = {
        surface,
        onMetadata: (metadata) => { this.metadata = metadata; this.updateMetadata(metadata); },
        onLocation: (locator, progress) => this.onLocation(locator, progress),
        onImage: (image) => this.openImagePreview(image),
        onInteraction: () => this.closeDrawers(),
        onError: (error) => this.showError(error)
      };
      await this.engine.open(this.book.url ? { kind: "url", url: this.book.url, name: this.book.name } : sourceFromRecord(this.book), host);
      if (this.destroyed) return;
      this.engine.setTheme(this.preferences.theme);
      this.engine.setFontSize(this.preferences.fontSize);
      this.engine.setSpread?.(this.preferences.spread);
      this.engine.setLineHeight?.(this.preferences.lineHeight);
      this.engine.setImageFit?.(this.preferences.imageFit);
      this.engine.setZoom?.(this.preferences.scrollZoom);
      if (initialLocator) await this.engine.goTo(initialLocator);
      this.restoring = false;
      if (this.latestLocator) this.persistLocation(this.latestLocator, this.latestLocator.percent);
      if (this.book.url) await saveBook(this.book);
    } catch (error) {
      this.showError(error);
    }
  }

  private render(): void {
    this.root.innerHTML = `<div class="reader-shell format-${this.book.format}">
      <button class="reader-fab reader-back-fab" id="back-button" aria-label="返回书架" title="返回书架">←</button>
      <main class="reader-main">
        <aside class="reader-drawer chapter-panel" id="chapter-panel"><div class="drawer-header"><div><p>CONTENTS</p><h2>目录</h2></div><button class="drawer-close" data-close-drawer>×</button></div><div id="chapter-list"><p class="muted">正在载入目录…</p></div></aside>
        <aside class="reader-drawer appearance-panel" id="appearance-panel"><div class="drawer-header"><div><p>APPEARANCE</p><h2>阅读显示</h2></div><button class="drawer-close" data-close-drawer>×</button></div><div class="drawer-section flow-settings"><label>阅读方式</label><div class="segment-control"><button data-reader-flow="paginated" class="${this.preferences.flow === "paginated" ? "active" : ""}">分页翻页</button><button data-reader-flow="scrolled" class="${this.preferences.flow === "scrolled" ? "active" : ""}">上下滚动</button></div></div><div class="drawer-section spread-settings"><label>单页 / 双页</label><div class="segment-control"><button data-reader-spread="single" class="${this.preferences.spread === "single" ? "active" : ""}">单页</button><button data-reader-spread="double" class="${this.preferences.spread === "double" ? "active" : ""}">双页</button></div></div><div class="drawer-section scroll-zoom-settings"><label>${this.book.format === "comic" ? "漫画缩放" : "滚动宽度 / 缩放"} <strong id="reader-zoom-value">${this.preferences.scrollZoom}%</strong></label><div class="font-control"><button class="button secondary" id="zoom-down">−</button><button class="button secondary" id="zoom-up">＋</button></div><input id="reader-zoom" type="range" min="30" max="100" step="5" value="${this.preferences.scrollZoom}"></div><div class="drawer-section"><label>字号 <strong id="reader-font-value">${this.preferences.fontSize}%</strong></label><div class="font-control"><button class="button secondary" id="font-down">A−</button><button class="button secondary" id="font-up">A＋</button></div></div><div class="drawer-section page-fit-settings"><label>页面适应</label><button class="button secondary" id="fit-button">切换适应宽度 / 整页</button></div><div class="drawer-section"><label>正文行距 <strong id="reader-line-value">${this.preferences.lineHeight.toFixed(2)}</strong></label><input id="reader-line-height" type="range" min="1.35" max="2.4" step="0.05" value="${this.preferences.lineHeight}"></div><div class="drawer-section"><label>背景主题</label><div class="reader-themes">${THEME_OPTIONS.map((theme) => `<button class="theme-dot theme-${theme.id} ${this.preferences.theme === theme.id ? "active" : ""}" data-reader-theme="${theme.id}" title="${theme.label}"><span></span>${theme.label}</button>`).join("")}</div></div><div class="drawer-section epub-image-settings"><label>EPUB 配图</label><div class="segment-control vertical"><button data-reader-image-fit="contain" class="${this.preferences.imageFit === "contain" ? "active" : ""}">整图放大</button><button data-reader-image-fit="width" class="${this.preferences.imageFit === "width" ? "active" : ""}">适应宽度</button><button data-reader-image-fit="original" class="${this.preferences.imageFit === "original" ? "active" : ""}">原始尺寸</button></div></div></aside>
        <aside class="reader-drawer page-jump-panel" id="page-jump-panel"><div class="drawer-header"><div><p>PAGE</p><h2>跳转页码</h2></div><button class="drawer-close" data-close-drawer>×</button></div><form id="jump-form" class="jump-form"><label>${this.book.format === "epub" ? "输入当前章节页码" : "输入页码"}</label><div><input id="jump-page" type="number" min="1" inputmode="numeric" placeholder="页码"><button class="button primary" type="submit">跳转</button></div></form></aside>
        <section class="reader-stage" id="reader-stage">
          <button class="page-zone page-zone-prev" id="page-zone-prev" aria-label="上一页"><span>‹</span></button>
          <div id="reader-surface" class="reader-surface"><div class="loading-orbit"></div></div>
          <button class="page-zone page-zone-next" id="page-zone-next" aria-label="下一页"><span>›</span></button>
        </section>
      </main>
      <div class="reader-floating-controls">
        <button class="reader-page-fab" id="reader-page-button" title="页码与跳转"><strong id="reader-counter">载入中…</strong><small id="reader-percent">${this.book.format === "epub" ? "计算中" : "0%"}</small></button>
        <button class="reader-fab" id="chapter-button" aria-label="目录" title="目录">☰</button>
        <button class="reader-fab" id="appearance-button" aria-label="阅读显示" title="阅读显示">◐</button>
      </div>
      <div class="image-preview" id="image-preview" aria-hidden="true">
        <div class="image-preview-backdrop" data-preview-close></div>
        <img class="image-preview-image" id="image-preview-image" alt="图片预览">
      </div>
    </div>`;
    if (this.book.format === "epub" || this.book.format === "txt") this.root.querySelector(".page-fit-settings")?.classList.add("hidden");
    if (this.book.format !== "epub") this.root.querySelector(".epub-image-settings")?.classList.add("hidden");
    if (this.book.format !== "epub" && this.book.format !== "txt" && this.book.format !== "comic" && this.book.format !== "pdf") {
      this.root.querySelector(".spread-settings")?.classList.add("hidden");
    }
    this.updateFlowControls(this.preferences.flow);
  }

  private bindControls(): void {
    const prev = () => void this.engine?.prev();
    const next = () => void this.engine?.next();
    this.root.querySelector("#back-button")?.addEventListener("click", () => navigate("/library"));
    this.root.querySelector("#page-zone-prev")?.addEventListener("click", prev);
    this.root.querySelector("#page-zone-next")?.addEventListener("click", next);
    this.root.querySelector("#chapter-button")?.addEventListener("click", () => this.toggleDrawer("chapter-panel"));
    this.root.querySelector("#chapter-close")?.addEventListener("click", () => this.closeDrawers());
    this.root.querySelector("#appearance-button")?.addEventListener("click", () => this.toggleDrawer("appearance-panel"));
    this.root.querySelector("#reader-page-button")?.addEventListener("click", () => {
      this.toggleDrawer("page-jump-panel");
      if (this.root.querySelector("#page-jump-panel.open")) window.setTimeout(() => this.root.querySelector<HTMLInputElement>("#jump-page")?.focus(), 0);
    });
    this.root.querySelector("#fit-button")?.addEventListener("click", () => { this.engine?.toggleFit?.(); toast("已切换页面适应方式"); });
    this.root.querySelectorAll<HTMLButtonElement>("[data-reader-flow]").forEach((button) => button.addEventListener("click", () => this.setFlow(button.dataset.readerFlow as ReaderFlow)));
    this.root.querySelectorAll("[data-close-drawer]").forEach((node) => node.addEventListener("click", () => this.closeDrawers()));
    this.root.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".reader-drawer, .reader-floating-controls")) this.closeDrawers();
    });
    this.root.querySelector("#font-down")?.addEventListener("click", () => this.adjustFont(-10));
    this.root.querySelector("#font-up")?.addEventListener("click", () => this.adjustFont(10));
    this.root.querySelector("#zoom-down")?.addEventListener("click", () => this.adjustZoom(-5));
    this.root.querySelector("#zoom-up")?.addEventListener("click", () => this.adjustZoom(5));
    this.root.querySelector<HTMLInputElement>("#reader-zoom")?.addEventListener("input", (event) => this.setZoom(Number((event.target as HTMLInputElement).value)));
    this.root.querySelectorAll<HTMLButtonElement>("[data-reader-theme]").forEach((button) => button.addEventListener("click", () => this.setTheme(button.dataset.readerTheme as ReaderTheme)));
    this.root.querySelectorAll<HTMLButtonElement>("[data-reader-spread]").forEach((button) => button.addEventListener("click", () => this.setSpread(button.dataset.readerSpread as ReaderSpread)));
    this.root.querySelectorAll<HTMLButtonElement>("[data-reader-image-fit]").forEach((button) => button.addEventListener("click", () => this.setImageFit(button.dataset.readerImageFit as ImageFit)));
    this.root.querySelector<HTMLInputElement>("#reader-line-height")?.addEventListener("input", (event) => this.setLineHeight(Number((event.target as HTMLInputElement).value)));
    this.bindImagePreview();
    this.root.querySelector("#jump-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const page = Number(this.root.querySelector<HTMLInputElement>("#jump-page")?.value);
      if (Number.isFinite(page) && page > 0) {
        this.closeDrawers();
        void this.engine?.goTo({ kind: this.book.format, page });
      }
    });
    let startX = 0;
    let startY = 0;
    const stage = this.root.querySelector<HTMLElement>("#reader-stage");
    stage?.addEventListener("pointerdown", (event) => { startX = event.clientX; startY = event.clientY; });
    stage?.addEventListener("pointerup", (event) => {
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.3) void (dx < 0 ? this.engine?.next() : this.engine?.prev());
    });
  }

  private bindImagePreview(): void {
    this.root.querySelector("[data-preview-close]")?.addEventListener("click", () => this.closeImagePreview());
  }

  private isImagePreviewOpen(): boolean {
    return this.root.querySelector("#image-preview.open") !== null;
  }

  private openImagePreview(image: { src: string; name?: string }): void {
    const overlay = this.root.querySelector<HTMLElement>("#image-preview");
    const preview = this.root.querySelector<HTMLImageElement>("#image-preview-image");
    if (!overlay || !preview || !image.src) return;
    preview.src = image.src;
    preview.alt = image.name || "图片预览";
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
  }

  private closeImagePreview(): void {
    const overlay = this.root.querySelector<HTMLElement>("#image-preview");
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    const preview = this.root.querySelector<HTMLImageElement>("#image-preview-image");
    if (preview) preview.removeAttribute("src");
  }

  private toggleDrawer(id: string): void {
    const target = this.root.querySelector(`#${id}`);
    const wasOpen = target?.classList.contains("open");
    this.closeDrawers();
    if (!wasOpen) target?.classList.add("open");
  }

  private closeDrawers(): void {
    this.root.querySelectorAll(".reader-drawer.open").forEach((node) => node.classList.remove("open"));
  }

  private adjustFont(delta: number): void {
    this.preferences.fontSize = Math.max(50, Math.min(200, this.preferences.fontSize + delta));
    savePreferences(this.preferences);
    this.engine?.setFontSize(this.preferences.fontSize);
    const label = this.root.querySelector("#reader-font-value");
    if (label) label.textContent = `${this.preferences.fontSize}%`;
  }

  private adjustZoom(delta: number): void {
    this.setZoom(this.preferences.scrollZoom + delta);
  }

  private setZoom(percent: number): void {
    const maxZoom = this.book.format === "pdf" ? 200 : 100;
    this.preferences.scrollZoom = Math.max(30, Math.min(maxZoom, Math.round(percent / 5) * 5));
    savePreferences(this.preferences);
    this.engine?.setZoom?.(this.preferences.scrollZoom);
    const value = this.root.querySelector("#reader-zoom-value");
    const input = this.root.querySelector<HTMLInputElement>("#reader-zoom");
    if (value) value.textContent = `${this.preferences.scrollZoom}%`;
    if (input) input.value = String(this.preferences.scrollZoom);
  }

  private setTheme(theme: ReaderTheme): void {
    this.preferences.theme = theme;
    savePreferences(this.preferences);
    this.engine?.setTheme(theme);
    this.root.querySelectorAll<HTMLElement>("[data-reader-theme]").forEach((node) => node.classList.toggle("active", node.dataset.readerTheme === theme));
  }

  private setSpread(spread: ReaderSpread): void {
    this.preferences.spread = spread;
    savePreferences(this.preferences);
    this.engine?.setSpread?.(spread);
    this.root.querySelectorAll<HTMLElement>("[data-reader-spread]").forEach((node) => node.classList.toggle("active", node.dataset.readerSpread === spread));
  }

  private setFlow(flow: ReaderFlow): void {
    this.preferences.flow = flow;
    savePreferences(this.preferences);
    this.engine?.setFlow?.(flow);
    this.updateFlowControls(flow);
  }

  private updateFlowControls(flow: ReaderFlow): void {
    this.root.querySelectorAll<HTMLElement>("[data-reader-flow]").forEach((node) => node.classList.toggle("active", node.dataset.readerFlow === flow));
    this.root.querySelector(".spread-settings")?.classList.toggle("hidden", this.book.format === "pdf" || flow === "scrolled");
    this.root.querySelector(".scroll-zoom-settings")?.classList.toggle("hidden", this.book.format !== "comic" && this.book.format !== "pdf" && flow !== "scrolled");
    // PDF is fixed-layout and never uses the continuous-flow renderer. Do not
    // inherit the global EPUB/comic scroll preference and hide its page zones.
    this.root.querySelector(".reader-shell")?.classList.toggle("flow-scrolled", flow === "scrolled");
  }

  private setLineHeight(lineHeight: number): void {
    this.preferences.lineHeight = Math.max(1.35, Math.min(2.4, lineHeight));
    savePreferences(this.preferences);
    this.engine?.setLineHeight?.(this.preferences.lineHeight);
    const label = this.root.querySelector("#reader-line-value");
    if (label) label.textContent = this.preferences.lineHeight.toFixed(2);
  }

  private setImageFit(fit: ImageFit): void {
    this.preferences.imageFit = fit;
    savePreferences(this.preferences);
    this.engine?.setImageFit?.(fit);
    this.root.querySelectorAll<HTMLElement>("[data-reader-image-fit]").forEach((node) => node.classList.toggle("active", node.dataset.readerImageFit === fit));
  }

  private updateMetadata(metadata: BookMetadata): void {
    const title = this.root.querySelector("#reader-title");
    const format = this.root.querySelector("#reader-format");
    if (title) title.textContent = metadata.title;
    if (format) format.textContent = FORMAT_LABELS[metadata.format];
    const list = this.root.querySelector("#chapter-list");
    if (!list) return;
    list.replaceChildren();
    if (!metadata.chapters?.length) { list.innerHTML = '<p class="muted drawer-empty">当前格式没有章节目录，可使用底部按钮或页码跳转。</p>'; return; }
    metadata.chapters.forEach((chapter, index) => {
      const button = document.createElement("button");
      button.className = "chapter-item";
      button.dataset.chapterHref = chapter.href.split("#")[0];
      button.innerHTML = `<span>${String(index + 1).padStart(2, "0")}</span><b></b>`;
      const label = button.querySelector("b");
      if (label) label.textContent = chapter.label;
      button.addEventListener("click", () => { void this.engine?.goTo({ kind: "epub", href: chapter.href }); this.closeDrawers(); });
      list.append(button);
    });
  }

  private onLocation(locator: Locator, progress?: number): void {
    if (this.destroyed) return;
    const hasProgress = typeof progress === "number" && Number.isFinite(progress);
    if (hasProgress) locator.percent = progress;
    else delete locator.percent;
    this.latestLocator = locator;
    const counter = this.root.querySelector("#reader-counter");
    const percent = this.root.querySelector("#reader-percent");
    if (counter) counter.textContent = locatorLabel(locator, this.metadata, this.preferences.flow);
    if (percent) percent.textContent = hasProgress ? `${Math.round(progress * 100)}%` : "计算中";
    this.root.querySelectorAll<HTMLButtonElement>("#page-zone-prev").forEach((button) => { button.disabled = Boolean(locator.atStart); });
    this.root.querySelectorAll<HTMLButtonElement>("#page-zone-next").forEach((button) => { button.disabled = Boolean(locator.atEnd); });
    if (locator.href) {
      const currentHref = locator.href.split("#")[0];
      this.root.querySelectorAll<HTMLElement>("[data-chapter-href]").forEach((item) => item.classList.toggle("active", currentHref.endsWith(item.dataset.chapterHref || "\u0000") || (item.dataset.chapterHref || "").endsWith(currentHref)));
    }
    if (!this.restoring) this.persistLocation(locator, progress);
  }

  private persistLocation(locator: Locator, progress?: number): void {
    this.book.locator = locator;
    if (typeof progress === "number" && Number.isFinite(progress)) this.book.progress = progress;
    replaceReaderLocation(this.book.id, locator);
    this.pendingProgress = { locator: { ...locator }, progress: this.book.progress || 0 };
    window.clearTimeout(this.progressTimer);
    this.progressTimer = window.setTimeout(() => {
      this.progressTimer = undefined;
      const pending = this.pendingProgress;
      this.pendingProgress = undefined;
      if (pending) void updateProgress(this.book.id, pending.locator, pending.progress);
    }, 650);
  }

  private showError(error: unknown): void {
    if (this.destroyed) return;
    const message = error instanceof Error ? error.message : String(error);
    toast(message, true);
    const surface = this.root.querySelector<HTMLElement>("#reader-surface");
    if (!surface) return;
    surface.replaceChildren();
    const box = document.createElement("div");
    box.className = "reader-error";
    box.innerHTML = '<span>⚠</span><h2>这本书暂时打不开</h2>';
    const details = document.createElement("p");
    details.textContent = message;
    const back = document.createElement("button");
    back.className = "button primary";
    back.textContent = "返回书架";
    back.addEventListener("click", () => navigate("/library"));
    box.append(details, back);
    surface.append(box);
  }

  private escape(value: string): string {
    const span = document.createElement("span");
    span.textContent = value;
    return span.innerHTML;
  }

  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    const pending = this.pendingProgress;
    this.pendingProgress = undefined;
    if (pending) void updateProgress(this.book.id, pending.locator, pending.progress);
    this.closeImagePreview();
    window.removeEventListener("keydown", this.keyHandler);
    this.engine?.destroy();
    this.engine = undefined;
  }
}
