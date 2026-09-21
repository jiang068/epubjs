import { BlobReader, BlobWriter, ZipReader } from "@zip.js/zip.js";
import { isImageFile, materializeBlob, sortNaturally } from "../core/source";
import type { BookMetadata, BookSource, ImageFit, Locator, ReaderDirection, ReaderEngine, ReaderFlow, ReaderHost, ReaderSpread, ReaderTheme, StoredImage } from "../types";

interface ComicEntry { getData?: (writer: BlobWriter) => Promise<Blob> }
interface ComicPage { name: string; blob?: Blob; entry?: ComicEntry }

function isImageName(name: string): boolean {
  return /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(name);
}

export class ComicEngine implements ReaderEngine {
  readonly format = "comic" as const;
  private pages: ComicPage[] = [];
  private index = 0;
  private host?: ReaderHost;
  private objectUrls = new Map<number, string>();
  private loadingImages = new Map<number, Promise<string>>();
  private zip?: { close(): Promise<void> };
  private imageObserver?: IntersectionObserver;
  private renderToken = 0;
  private fit: "contain" | "width" = "contain";
  private zoom = 90;
  private flow: ReaderFlow = "paginated";
  private spread: ReaderSpread = "single";
  private direction: ReaderDirection = "forward";
  private directionInitialized = false;
  private scrollHandler = () => this.updateScrolledLocation();

  async open(source: BookSource, host: ReaderHost): Promise<BookMetadata> {
    this.host = host;
    this.revokeObjectUrls();
    await this.zip?.close().catch(() => undefined);
    this.zip = undefined;
    this.pages = [];
    if (source.kind === "stored" && source.record.images?.length) {
      this.pages = sortNaturally(source.record.images).map((image: StoredImage) => ({ name: image.name, blob: image.blob }));
    } else {
      const blob = await materializeBlob(source);
      const name = source.kind === "file" ? source.file.name : source.kind === "stored" ? source.record.name : source.name || source.url;
      if (isImageName(name) || isImageFile(new File([], name))) {
        this.pages = [{ name, blob }];
      } else {
        const zip = new ZipReader(new BlobReader(blob));
        const entries = await zip.getEntries();
        for (const entry of entries) {
          if (!entry.directory && isImageName(entry.filename)) {
            this.pages.push({ name: entry.filename, entry });
          }
        }
        this.zip = zip;
        this.pages = sortNaturally(this.pages);
      }
    }
    if (!this.pages.length) throw new Error("没有找到可阅读的图片。漫画 URL 建议使用 CBZ/ZIP 文件。");
    this.index = 0;
    this.directionInitialized = false;
    const metadata = { title: source.kind === "url" ? source.name || "远程漫画" : source.kind === "stored" ? source.record.name : source.file.name, format: this.format, total: this.pages.length };
    host.onMetadata(metadata);
    await this.render();
    return metadata;
  }

  private async getObjectUrl(index: number): Promise<string> {
    const existing = this.objectUrls.get(index);
    if (existing) return existing;
    const pending = this.loadingImages.get(index);
    if (pending) return pending;
    const page = this.pages[index];
    if (!page) throw new Error("图片页不存在");
    const task = (async () => {
      const blob = page.blob || await page.entry?.getData?.(new BlobWriter());
      if (!blob) throw new Error(`无法读取图片：${page.name}`);
      page.blob = blob;
      const url = URL.createObjectURL(blob);
      this.objectUrls.set(index, url);
      return url;
    })();
    this.loadingImages.set(index, task);
    try { return await task; } finally { this.loadingImages.delete(index); }
  }

  private revokeObjectUrls(): void {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls.clear();
    this.loadingImages.clear();
  }

  private clearSurface(): HTMLElement | undefined {
    const surface = this.host?.surface;
    if (!surface) return undefined;
    surface.removeEventListener("scroll", this.scrollHandler);
    this.imageObserver?.disconnect();
    this.imageObserver = undefined;
    surface.classList.remove("comic-flow-scrolled");
    surface.style.overflow = "hidden";
    surface.replaceChildren();
    return surface;
  }

  private createImage(index: number): HTMLImageElement {
    const image = document.createElement("img");
    image.className = `comic-page comic-fit-${this.fit}`;
    image.alt = this.pages[index]?.name || `第 ${index + 1} 页`;
    image.dataset.pageIndex = String(index);
    image.addEventListener("click", (event) => {
      event.stopPropagation();
      if (image.currentSrc || image.src) this.host?.onImage?.({ src: image.currentSrc || image.src, name: this.pages[index]?.name });
    });
    return image;
  }

  private async loadImage(index: number, image: HTMLImageElement, token: number): Promise<void> {
    try {
      const url = await this.getObjectUrl(index);
      if (token !== this.renderToken || !image.isConnected) return;
      image.src = url;
      image.addEventListener("load", () => this.updateScrolledLocation(), { once: true });
    } catch (error) {
      if (token === this.renderToken) this.host?.onError(error);
    }
  }

  private emitLocation(): void {
    if (!this.host || !this.pages.length) return;
    const logicalIndex = this.logicalIndexForSource(this.index);
    const progress = logicalIndex / Math.max(1, this.pages.length - 1);
    const step = this.spread === "double" && this.flow === "paginated" ? 2 : 1;
    this.host.onLocation({ kind: this.format, page: logicalIndex + 1, total: this.pages.length, percent: progress, atStart: logicalIndex === 0, atEnd: logicalIndex >= this.pages.length - step }, progress);
  }

  private sourceIndexForLogical(logicalIndex: number): number {
    const index = Math.max(0, Math.min(this.pages.length - 1, Math.round(logicalIndex)));
    return this.direction === "reverse" ? this.pages.length - index - 1 : index;
  }

  private logicalIndexForSource(sourceIndex: number): number {
    const index = Math.max(0, Math.min(this.pages.length - 1, Math.round(sourceIndex)));
    return this.direction === "reverse" ? this.pages.length - index - 1 : index;
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    const surface = this.clearSurface();
    if (!surface || !this.pages.length) return;
    if (this.flow === "scrolled") this.renderScrolled(surface);
    else await this.renderPaginated(surface, token);
    this.emitLocation();
  }

  private async renderPaginated(surface: HTMLElement, token: number): Promise<void> {
    const spread = document.createElement("div");
    spread.className = `comic-spread comic-spread-${this.spread}`;
    spread.style.setProperty("--comic-zoom", String(this.zoom / 100));
    spread.classList.toggle("comic-direction-reverse", this.direction === "reverse");
    // Attach the spread before loading. loadImage intentionally ignores
    // detached/stale nodes; appending only after awaiting meant every
    // paginated image failed the `isConnected` guard and never received src.
    surface.append(spread);
    const count = this.spread === "double" ? 2 : 1;
    const logicalIndex = this.logicalIndexForSource(this.index);
    for (let offset = 0; offset < count && logicalIndex + offset < this.pages.length; offset += 1) {
      if (token !== this.renderToken) return;
      const pageIndex = this.sourceIndexForLogical(logicalIndex + offset);
      const image = this.createImage(pageIndex);
      spread.append(image);
      await this.loadImage(pageIndex, image, token);
    }
  }

  private renderScrolled(surface: HTMLElement): void {
    surface.classList.add("comic-flow-scrolled");
    surface.style.overflowY = "auto";
    surface.style.overflowX = "hidden";
    const list = document.createElement("div");
    list.className = "comic-scroll-list";
    list.style.setProperty("--comic-scroll-width", `${this.zoom}%`);
    const token = this.renderToken;
    for (let logicalIndex = 0; logicalIndex < this.pages.length; logicalIndex += 1) {
      const pageIndex = this.sourceIndexForLogical(logicalIndex);
      const image = this.createImage(pageIndex);
      // Keep unloaded ZIP entries from collapsing to zero height. A modest
      // placeholder lets IntersectionObserver load only the nearby pages
      // instead of considering every image to be visible at the top.
      image.style.minHeight = "240px";
      list.append(image);
    }
    surface.append(list);
    this.imageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const image = entry.target as HTMLImageElement;
        const pageIndex = Number(image.dataset.pageIndex);
        void this.loadImage(pageIndex, image, token);
        this.imageObserver?.unobserve(image);
      }
    }, { root: surface, rootMargin: "1200px 0px" });
    list.querySelectorAll<HTMLImageElement>("img[data-page-index]").forEach((image) => this.imageObserver?.observe(image));
    surface.addEventListener("scroll", this.scrollHandler, { passive: true });
    window.requestAnimationFrame(() => this.scrollToIndex(this.index, "auto"));
  }

  private scrollToIndex(index: number, behavior: ScrollBehavior = "smooth"): void {
    const surface = this.host?.surface;
    const image = surface?.querySelector<HTMLImageElement>(`img[data-page-index="${index}"]`);
    if (!surface || !image) return;
    surface.scrollTo({ top: Math.max(0, image.offsetTop - 14), behavior });
  }

  private updateScrolledLocation(): void {
    const surface = this.host?.surface;
    if (!surface || this.flow !== "scrolled") return;
    const target = surface.scrollTop + 24;
    let current = this.index;
    const images = [...surface.querySelectorAll<HTMLImageElement>("img[data-page-index]")];
    for (const image of images) {
      if (image.offsetTop + image.offsetHeight > target) {
        current = Number(image.dataset.pageIndex || 0);
        break;
      }
    }
    if (current !== this.index) {
      this.index = Math.max(0, Math.min(this.pages.length - 1, current));
      this.emitLocation();
    }
  }

  async next(): Promise<void> {
    const step = this.spread === "double" && this.flow === "paginated" ? 2 : 1;
    const logicalIndex = this.logicalIndexForSource(this.index);
    const targetLogical = Math.min(this.pages.length - 1, logicalIndex + step);
    if (targetLogical === logicalIndex) return;
    this.index = this.sourceIndexForLogical(targetLogical);
    if (this.flow === "scrolled") this.scrollToIndex(this.index);
    else await this.render();
    if (this.flow === "scrolled") this.emitLocation();
  }

  async prev(): Promise<void> {
    const step = this.spread === "double" && this.flow === "paginated" ? 2 : 1;
    const logicalIndex = this.logicalIndexForSource(this.index);
    const targetLogical = Math.max(0, logicalIndex - step);
    if (targetLogical === logicalIndex) return;
    this.index = this.sourceIndexForLogical(targetLogical);
    if (this.flow === "scrolled") this.scrollToIndex(this.index);
    else await this.render();
    if (this.flow === "scrolled") this.emitLocation();
  }

  async goTo(locator: Locator): Promise<void> {
    this.index = this.sourceIndexForLogical((locator.page || 1) - 1);
    if (this.flow === "scrolled") this.scrollToIndex(this.index, "auto");
    else await this.render();
    if (this.flow === "scrolled") this.emitLocation();
  }

  setFontSize(_percent: number): void { /* Image readers use fit controls instead of font size. */ }
  setTheme(_theme: ReaderTheme): void { /* App shell theme is applied outside the image. */ }

  setFlow(flow: ReaderFlow): void {
    if (flow === this.flow) return;
    this.flow = flow;
    void this.render();
  }

  setDirection(direction: ReaderDirection): void {
    if (direction !== "forward" && direction !== "reverse") return;
    if (direction === this.direction && this.directionInitialized) return;
    const firstApply = !this.directionInitialized;
    this.direction = direction;
    this.directionInitialized = true;
    if (firstApply && direction === "reverse" && this.pages.length) this.index = this.pages.length - 1;
    if (firstApply && direction === "forward") return;
    if (this.host) void this.render();
  }

  setSpread(spread: ReaderSpread): void {
    if (spread === this.spread) return;
    this.spread = spread;
    if (this.flow === "paginated") void this.render();
    else this.emitLocation();
  }

  setImageFit(fit: ImageFit): void {
    const nextFit = fit === "width" ? "width" : "contain";
    if (nextFit === this.fit) return;
    this.fit = nextFit;
    void this.render();
  }

  setZoom(percent: number): void {
    const nextZoom = Math.max(30, Math.min(100, Math.round(percent / 5) * 5));
    if (nextZoom === this.zoom) return;
    this.zoom = nextZoom;
    if (this.host) void this.render();
  }

  toggleFit(): void {
    this.fit = this.fit === "contain" ? "width" : "contain";
    void this.render();
  }

  destroy(): void {
    if (this.host) this.host.surface.removeEventListener("scroll", this.scrollHandler);
    this.imageObserver?.disconnect();
    void this.zip?.close().catch(() => undefined);
    this.zip = undefined;
    this.revokeObjectUrls();
    this.host?.surface.replaceChildren();
    this.host = undefined;
    this.pages = [];
  }
}
