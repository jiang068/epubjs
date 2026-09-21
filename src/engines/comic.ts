import { BlobReader, BlobWriter, ZipReader } from "@zip.js/zip.js";
import { isImageFile, materializeBlob, sortNaturally } from "../core/source";
import type { BookMetadata, BookSource, ImageFit, Locator, ReaderEngine, ReaderFlow, ReaderHost, ReaderSpread, ReaderTheme, StoredImage } from "../types";

interface ComicPage { name: string; blob: Blob }

function isImageName(name: string): boolean {
  return /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(name);
}

export class ComicEngine implements ReaderEngine {
  readonly format = "comic" as const;
  private pages: ComicPage[] = [];
  private index = 0;
  private host?: ReaderHost;
  private objectUrls: string[] = [];
  private fit: "contain" | "width" = "contain";
  private zoom = 90;
  private flow: ReaderFlow = "paginated";
  private spread: ReaderSpread = "single";
  private scrollHandler = () => this.updateScrolledLocation();

  async open(source: BookSource, host: ReaderHost): Promise<BookMetadata> {
    this.host = host;
    this.revokeObjectUrls();
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
          if (!entry.directory && isImageName(entry.filename) && entry.getData) {
            this.pages.push({ name: entry.filename, blob: await entry.getData(new BlobWriter()) });
          }
        }
        await zip.close();
        this.pages = sortNaturally(this.pages);
      }
    }
    if (!this.pages.length) throw new Error("没有找到可阅读的图片。漫画 URL 建议使用 CBZ/ZIP 文件。");
    this.index = 0;
    const metadata = { title: source.kind === "url" ? source.name || "远程漫画" : source.kind === "stored" ? source.record.name : source.file.name, format: this.format, total: this.pages.length };
    host.onMetadata(metadata);
    this.render();
    return metadata;
  }

  private ensureObjectUrls(): void {
    if (this.objectUrls.length === this.pages.length) return;
    this.revokeObjectUrls();
    this.objectUrls = this.pages.map((page) => URL.createObjectURL(page.blob));
  }

  private revokeObjectUrls(): void {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls = [];
  }

  private clearSurface(): HTMLElement | undefined {
    const surface = this.host?.surface;
    if (!surface) return undefined;
    surface.removeEventListener("scroll", this.scrollHandler);
    surface.classList.remove("comic-flow-scrolled");
    surface.style.overflow = "hidden";
    surface.replaceChildren();
    return surface;
  }

  private createImage(index: number): HTMLImageElement {
    const image = document.createElement("img");
    image.className = `comic-page comic-fit-${this.fit}`;
    image.alt = this.pages[index]?.name || `第 ${index + 1} 页`;
    image.src = this.objectUrls[index];
    image.dataset.pageIndex = String(index);
    image.addEventListener("click", (event) => {
      event.stopPropagation();
      this.host?.onImage?.({ src: image.src, name: this.pages[index]?.name });
    });
    return image;
  }

  private emitLocation(): void {
    if (!this.host || !this.pages.length) return;
    const progress = this.index / Math.max(1, this.pages.length - 1);
    const step = this.spread === "double" && this.flow === "paginated" ? 2 : 1;
    this.host.onLocation({ kind: this.format, page: this.index + 1, total: this.pages.length, percent: progress, atStart: this.index === 0, atEnd: this.index >= this.pages.length - step }, progress);
  }

  private render(): void {
    const surface = this.clearSurface();
    if (!surface || !this.pages.length) return;
    this.ensureObjectUrls();
    if (this.flow === "scrolled") this.renderScrolled(surface);
    else this.renderPaginated(surface);
    this.emitLocation();
  }

  private renderPaginated(surface: HTMLElement): void {
    const spread = document.createElement("div");
    spread.className = `comic-spread comic-spread-${this.spread}`;
    spread.style.setProperty("--comic-zoom", String(this.zoom / 100));
    const count = this.spread === "double" ? 2 : 1;
    for (let offset = 0; offset < count && this.index + offset < this.pages.length; offset += 1) spread.append(this.createImage(this.index + offset));
    surface.append(spread);
  }

  private renderScrolled(surface: HTMLElement): void {
    surface.classList.add("comic-flow-scrolled");
    surface.style.overflowY = "auto";
    surface.style.overflowX = "hidden";
    const list = document.createElement("div");
    list.className = "comic-scroll-list";
    list.style.setProperty("--comic-scroll-width", `${this.zoom}%`);
    this.pages.forEach((_page, pageIndex) => list.append(this.createImage(pageIndex)));
    surface.append(list);
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
    const target = Math.min(this.pages.length - 1, this.index + step);
    if (target === this.index) return;
    this.index = target;
    if (this.flow === "scrolled") this.scrollToIndex(this.index);
    else this.render();
    if (this.flow === "scrolled") this.emitLocation();
  }

  async prev(): Promise<void> {
    const step = this.spread === "double" && this.flow === "paginated" ? 2 : 1;
    const target = Math.max(0, this.index - step);
    if (target === this.index) return;
    this.index = target;
    if (this.flow === "scrolled") this.scrollToIndex(this.index);
    else this.render();
    if (this.flow === "scrolled") this.emitLocation();
  }

  async goTo(locator: Locator): Promise<void> {
    this.index = Math.max(0, Math.min(this.pages.length - 1, (locator.page || 1) - 1));
    if (this.flow === "scrolled") this.scrollToIndex(this.index, "auto");
    else this.render();
    if (this.flow === "scrolled") this.emitLocation();
  }

  setFontSize(_percent: number): void { /* Image readers use fit controls instead of font size. */ }
  setTheme(_theme: ReaderTheme): void { /* App shell theme is applied outside the image. */ }

  setFlow(flow: ReaderFlow): void {
    if (flow === this.flow) return;
    this.flow = flow;
    this.render();
  }

  setSpread(spread: ReaderSpread): void {
    if (spread === this.spread) return;
    this.spread = spread;
    if (this.flow === "paginated") this.render();
    else this.emitLocation();
  }

  setImageFit(fit: ImageFit): void {
    this.fit = fit === "width" ? "width" : "contain";
    this.render();
  }

  setZoom(percent: number): void {
    this.zoom = Math.max(30, Math.min(100, Math.round(percent / 5) * 5));
    if (this.host) this.render();
  }

  toggleFit(): void {
    this.fit = this.fit === "contain" ? "width" : "contain";
    this.render();
  }

  destroy(): void {
    if (this.host) this.host.surface.removeEventListener("scroll", this.scrollHandler);
    this.revokeObjectUrls();
    this.host?.surface.replaceChildren();
    this.host = undefined;
    this.pages = [];
  }
}
