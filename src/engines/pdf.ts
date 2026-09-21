import * as pdfjsLib from "pdfjs-dist";
import { materializeBlob } from "../core/source";
import type { BookMetadata, BookSource, Locator, ReaderEngine, ReaderFlow, ReaderHost, ReaderTheme } from "../types";

type PdfDocument = {
  numPages: number;
  getPage(page: number): Promise<PdfPage>;
  getMetadata?(): Promise<{ info?: { Title?: string } }>;
  destroy?(): Promise<void> | void;
};
type PdfPage = {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown; transform?: [number, number, number, number, number, number] }): { promise: Promise<void>; cancel?: () => void };
  cleanup?: () => void;
};

const pdfApi = pdfjsLib as unknown as {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(options: { data: Uint8Array }): { promise: Promise<PdfDocument> };
};
pdfApi.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export class PdfEngine implements ReaderEngine {
  readonly format = "pdf" as const;
  private doc?: PdfDocument;
  private page = 1;
  private flow: ReaderFlow = "paginated";
  private host?: ReaderHost;
  private zoom = 1;
  private fitWidth = true;
  private renderId = 0;
  private renderTask?: { cancel?: () => void };
  private resizeTimer?: number;
  private scrollRaf?: number;
  private reportedPage = 0;
  private suppressScrollUntil = 0;
  private scrollAnchor?: { page: number; offset: number };
  private scrolledList?: HTMLElement;
  private scrolledRenderQueue: Promise<void> = Promise.resolve();

  private resizeHandler = () => {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => { void this.render(); }, 80);
  };

  private scrollHandler = () => {
    if (this.flow !== "scrolled" || !this.host) return;
    if (performance.now() < this.suppressScrollUntil) return;
    if (this.scrollRaf) return;
    this.scrollRaf = window.requestAnimationFrame(() => {
      this.scrollRaf = undefined;
      this.updateScrollLocation();
      void this.renderVisibleScrolled(this.renderId);
    });
  };

  async open(source: BookSource, host: ReaderHost): Promise<BookMetadata> {
    this.host = host;
    host.surface.classList.add("pdf-surface");
    host.surface.addEventListener("scroll", this.scrollHandler, { passive: true });
    try {
      const blob = await materializeBlob(source);
      this.doc = await pdfApi.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
      this.page = 1;
      window.addEventListener("resize", this.resizeHandler, { passive: true });
      let title = source.kind === "url" ? source.name || "远程 PDF" : source.kind === "stored" ? source.record.name : source.file.name;
      try { title = (await this.doc.getMetadata?.())?.info?.Title || title; } catch { /* Metadata is optional. */ }
      const metadata = { title, format: this.format, total: this.doc.numPages } satisfies BookMetadata;
      host.onMetadata(metadata);
      this.applyFlowClass();
      await this.render();
      return metadata;
    } catch (error) {
      host.onError(error);
      throw error;
    }
  }

  private applyFlowClass(): void {
    const surface = this.host?.surface;
    if (!surface) return;
    surface.classList.toggle("pdf-scrolled", this.flow === "scrolled");
  }

  private calculateScale(page: PdfPage): { viewport: { width: number; height: number }; outputScale: number } {
    const surface = this.host!.surface;
    const base = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(220, surface.clientWidth - 32);
    const scale = this.fitWidth ? Math.max(0.25, (availableWidth / base.width) * this.zoom) : Math.max(0.25, this.zoom);
    const viewport = page.getViewport({ scale });
    let outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const pixels = viewport.width * viewport.height * outputScale * outputScale;
    if (pixels > 10_000_000) outputScale *= Math.sqrt(10_000_000 / pixels);
    return { viewport, outputScale };
  }

  private async renderPage(pageNumber: number, renderId: number): Promise<HTMLCanvasElement | undefined> {
    const doc = this.doc;
    if (!doc || !this.host) return undefined;
    const page = await doc.getPage(pageNumber);
    if (renderId !== this.renderId || this.doc !== doc || !this.host) { page.cleanup?.(); return undefined; }
    const { viewport, outputScale } = this.calculateScale(page);
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-page";
    canvas.dataset.page = String(pageNumber);
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${Math.round(viewport.width)}px`;
    canvas.style.height = `${Math.round(viewport.height)}px`;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) { page.cleanup?.(); throw new Error("无法创建 PDF 画布"); }
    const task = page.render({ canvasContext: context, viewport, transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined });
    this.renderTask = task;
    try {
      await task.promise;
      if (renderId !== this.renderId || this.doc !== doc || !this.host) return undefined;
      return canvas;
    } finally {
      page.cleanup?.();
      if (this.renderTask === task) this.renderTask = undefined;
    }
  }

  private async render(): Promise<void> {
    const host = this.host;
    const doc = this.doc;
    if (!host || !doc) return;
    const renderId = ++this.renderId;
    this.renderTask?.cancel?.();
    this.renderTask = undefined;
    try {
      if (this.flow === "scrolled") {
        await this.renderScrolled(host, doc, renderId);
      } else {
        const pageNumber = Math.max(1, Math.min(doc.numPages, this.page));
        const canvas = await this.renderPage(pageNumber, renderId);
        if (!canvas || renderId !== this.renderId || this.doc !== doc || !this.host) return;
        host.surface.replaceChildren(canvas);
        this.reportLocation(pageNumber);
      }
    } catch (error) {
      if (renderId !== this.renderId || (error as { name?: string })?.name === "RenderingCancelledException") return;
      this.renderTask = undefined;
      host.onError(error);
    }
  }

  private async renderScrolled(host: ReaderHost, doc: PdfDocument, renderId: number): Promise<void> {
    const list = document.createElement("div");
    list.className = "pdf-scroll-list";
    // Keep only lightweight placeholders in the DOM. Rendering every page of
    // a long PDF up front makes scrolling janky and can exhaust the canvas
    // memory budget. Visible pages (plus a small buffer) are painted below.
    let estimatedHeight = 900;
    try {
      const first = await doc.getPage(1);
      estimatedHeight = Math.max(240, Math.round(this.calculateScale(first).viewport.height));
      first.cleanup?.();
    } catch { /* The first real render will surface a useful error. */ }
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const item = document.createElement("section");
      item.className = "pdf-scroll-page";
      item.dataset.page = String(pageNumber);
      item.style.minHeight = `${estimatedHeight}px`;
      item.setAttribute("aria-label", `第 ${pageNumber} 页`);
      list.append(item);
    }
    if (renderId !== this.renderId || this.doc !== doc || !this.host) return;
    // The user may keep reading while the detached pages render. Sample the
    // live position now, at commit time, instead of restoring the stale
    // position captured when the zoom gesture began.
    this.updateScrollLocation();
    this.captureScrollAnchor();
    const anchor = this.scrollAnchor;
    const targetPage = Math.max(1, Math.min(doc.numPages, anchor?.page || this.page));
    // Swap and restore synchronously in the same task, before the browser can
    // paint the detached list at scrollTop 0.
    host.surface.replaceChildren(list);
    this.scrolledList = list;
    this.reportedPage = 0;
    const target = list.querySelector<HTMLElement>(`.pdf-scroll-page[data-page="${targetPage}"]`);
    if (target) {
      this.suppressScrollUntil = performance.now() + 48;
      const offset = anchor?.page === targetPage ? anchor.offset : -12;
      host.surface.scrollTop = Math.max(0, target.offsetTop + offset);
    }
    this.scrollAnchor = undefined;
    this.page = targetPage;
    this.reportLocation(targetPage);
    await this.renderVisibleScrolled(renderId);
  }

  private async renderVisibleScrolled(renderId: number): Promise<void> {
    const surface = this.host?.surface;
    const list = this.scrolledList;
    const doc = this.doc;
    if (!surface || !list || !doc || this.flow !== "scrolled") return;
    const surfaceRect = surface.getBoundingClientRect();
    const items = [...list.querySelectorAll<HTMLElement>(".pdf-scroll-page")];
    const visible = items.filter((item) => {
      const rect = item.getBoundingClientRect();
      return rect.bottom >= surfaceRect.top - surface.clientHeight * 1.5
        && rect.top <= surfaceRect.bottom + surface.clientHeight * 1.5;
    });
    this.scrolledRenderQueue = this.scrolledRenderQueue.then(async () => {
      for (const item of visible) {
        if (renderId !== this.renderId || this.doc !== doc || this.flow !== "scrolled") return;
        if (item.dataset.rendered === "true") continue;
        const pageNumber = Number(item.dataset.page);
        if (!Number.isFinite(pageNumber)) continue;
        const canvas = await this.renderPage(pageNumber, renderId);
        if (!canvas || renderId !== this.renderId || this.doc !== doc) return;
        item.replaceChildren(canvas);
        item.dataset.rendered = "true";
        item.style.minHeight = "";
      }
    }).catch((error) => {
      if ((error as { name?: string })?.name !== "RenderingCancelledException") this.host?.onError(error);
    });
    await this.scrolledRenderQueue;
  }

  private updateScrollLocation(): void {
    const surface = this.host?.surface;
    const pages = surface?.querySelectorAll<HTMLElement>(".pdf-scroll-page");
    if (!surface || !pages?.length || !this.doc) return;
    const surfaceRect = surface.getBoundingClientRect();
    let closest = 1;
    let largestVisibleArea = -1;
    pages.forEach((item) => {
      const rect = item.getBoundingClientRect();
      const visibleHeight = Math.max(0, Math.min(rect.bottom, surfaceRect.bottom) - Math.max(rect.top, surfaceRect.top));
      const visibleArea = visibleHeight * Math.max(0, Math.min(rect.right, surfaceRect.right) - Math.max(rect.left, surfaceRect.left));
      if (visibleArea > largestVisibleArea) {
        largestVisibleArea = visibleArea;
        closest = Number(item.dataset.page) || closest;
      }
    });
    this.page = closest;
    this.reportLocation(closest);
  }

  private reportLocation(pageNumber: number): void {
    if (!this.host || !this.doc || this.reportedPage === pageNumber) return;
    this.reportedPage = pageNumber;
    const progress = (pageNumber - 1) / Math.max(1, this.doc.numPages - 1);
    this.host.onLocation({ kind: this.format, page: pageNumber, total: this.doc.numPages, percent: progress, atStart: pageNumber === 1, atEnd: pageNumber === this.doc.numPages }, progress);
  }

  private captureScrollAnchor(): void {
    const surface = this.host?.surface;
    if (!surface || this.flow !== "scrolled") return;
    const item = surface.querySelector<HTMLElement>(`.pdf-scroll-page[data-page="${this.page}"]`);
    if (item) this.scrollAnchor = { page: this.page, offset: surface.scrollTop - item.offsetTop };
  }

  private previewScrolledZoom(nextZoom: number): void {
    const surface = this.host?.surface;
    const anchor = this.scrollAnchor;
    if (!surface || !anchor || this.zoom <= 0 || nextZoom === this.zoom) return;
    const ratio = nextZoom / this.zoom;
    surface.querySelectorAll<HTMLCanvasElement>(".pdf-scroll-page .pdf-page").forEach((canvas) => {
      const width = Number.parseFloat(canvas.style.width) || canvas.getBoundingClientRect().width;
      const height = Number.parseFloat(canvas.style.height) || canvas.getBoundingClientRect().height;
      canvas.style.width = `${Math.max(1, width * ratio)}px`;
      canvas.style.height = `${Math.max(1, height * ratio)}px`;
    });
    const target = surface.querySelector<HTMLElement>(`.pdf-scroll-page[data-page="${anchor.page}"]`);
    if (target) {
      anchor.offset *= ratio;
      this.suppressScrollUntil = performance.now() + 48;
      surface.scrollTop = Math.max(0, target.offsetTop + anchor.offset);
    }
  }

  async next(): Promise<void> {
    if (!this.doc) return;
    if (this.flow === "scrolled") { this.scrollByPage(1); return; }
    if (this.page < this.doc.numPages) { this.page += 1; await this.render(); }
  }

  async prev(): Promise<void> {
    if (!this.doc) return;
    if (this.flow === "scrolled") { this.scrollByPage(-1); return; }
    if (this.page > 1) { this.page -= 1; await this.render(); }
  }

  private scrollByPage(delta: number): void {
    const target = this.host?.surface.querySelector<HTMLElement>(`.pdf-scroll-page[data-page="${Math.max(1, this.page + delta)}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async goTo(locator: Locator): Promise<void> {
    if (!this.doc) return;
    const requested = Number(locator.page || 1);
    this.page = Number.isFinite(requested) ? Math.max(1, Math.min(this.doc.numPages, Math.round(requested))) : 1;
    if (this.flow === "scrolled") {
      const target = this.host?.surface.querySelector<HTMLElement>(`.pdf-scroll-page[data-page="${this.page}"]`);
      if (target) {
        this.suppressScrollUntil = performance.now() + 80;
        target.scrollIntoView({ block: "start" });
        this.reportedPage = 0;
        this.reportLocation(this.page);
      }
      return;
    }
    await this.render();
  }

  setFlow(flow: ReaderFlow): void {
    if (flow !== "paginated" && flow !== "scrolled") return;
    if (this.flow === "scrolled") this.updateScrollLocation();
    if (flow !== this.flow) this.scrollAnchor = undefined;
    this.flow = flow;
    this.reportedPage = 0;
    this.applyFlowClass();
    if (this.host && this.doc) void this.render();
  }

  setFontSize(_percent: number): void { /* PDFs have fixed layout; use zoom instead. */ }
  setZoom(percent: number): void {
    const nextZoom = Math.max(0.3, Math.min(2, percent / 100));
    if (nextZoom === this.zoom) return;
    if (this.flow === "scrolled") {
      this.updateScrollLocation();
      this.captureScrollAnchor();
      this.previewScrolledZoom(nextZoom);
    }
    this.zoom = nextZoom;
    void this.render();
  }
  setTheme(_theme: ReaderTheme): void { /* PDF pixels are not color-filtered. */ }
  toggleFit(): void {
    if (this.flow === "scrolled") { this.updateScrollLocation(); this.captureScrollAnchor(); }
    this.fitWidth = !this.fitWidth;
    void this.render();
  }

  destroy(): void {
    this.renderId += 1;
    this.renderTask?.cancel?.();
    this.renderTask = undefined;
    window.clearTimeout(this.resizeTimer);
    if (this.scrollRaf) window.cancelAnimationFrame(this.scrollRaf);
    window.removeEventListener("resize", this.resizeHandler);
    this.host?.surface.removeEventListener("scroll", this.scrollHandler);
    this.host?.surface.classList.remove("pdf-surface", "pdf-scrolled");
    this.host?.surface.replaceChildren();
    this.scrolledList = undefined;
    this.scrolledRenderQueue = Promise.resolve();
    this.host = undefined;
    void this.doc?.destroy?.();
    this.doc = undefined;
  }
}
