import ePub from "epubjs";
import { materializeBlob } from "../core/source";
import type { BookMetadata, BookSource, ImageFit, Locator, ReaderEngine, ReaderFlow, ReaderHost, ReaderSpread, ReaderTheme } from "../types";

const PALETTES: Record<Exclude<ReaderTheme, "original">, { background: string; color: string; link: string }> = {
  paper: { background: "#fffaf3", color: "#302534", link: "#b73d72" },
  sepia: { background: "#fef3d6", color: "#5d4037", link: "#9a5635" },
  eye: { background: "#e8f5e8", color: "#2d4a2b", link: "#397a45" },
  sakura: { background: "#fff1f6", color: "#4d2942", link: "#c13d79" },
  night: { background: "#211b2c", color: "#f3eaff", link: "#ff8fbd" },
  oled: { background: "#000", color: "#f5f5f5", link: "#ff83b7" }
};

export class EpubEngine implements ReaderEngine {
  readonly format = "epub" as const;
  private book: any;
  private rendition: any;
  private host?: ReaderHost;
  private fontSize = 100;
  private theme: ReaderTheme = "sakura";
  private spread: ReaderSpread = "single";
  private flow: ReaderFlow = "paginated";
  private lineHeight = 1.85;
  private imageFit: ImageFit = "contain";
  private zoom = 90;
  private locationsReady = false;
  private lastRawLocation?: any;
  private destroyed = false;
  private resizeHandler = () => this.applySpread();
  private scrolledSurface?: HTMLElement;
  private scrolledBoundaryTimer?: number;
  private scrolledCheckTimer?: number;
  private scrolledBoundaryHandler = (): void => {
    if (this.flow !== "scrolled" || !this.rendition?.manager) return;
    const container = this.rendition.manager.container as HTMLElement | undefined;
    if (!container) return;
    const nearBoundary = container.scrollTop <= 8 || container.scrollTop + container.clientHeight >= container.scrollHeight - 8;
    if (!nearBoundary) return;
    window.clearTimeout(this.scrolledBoundaryTimer);
    this.scrolledBoundaryTimer = window.setTimeout(() => {
      if (this.destroyed || this.flow !== "scrolled") return;
      // EPUB.js normally queues this from its own scroll listener. Some
      // browsers (and accessibility scrolling) change scrollTop without
      // delivering that event to the manager, leaving the reader stuck at a
      // chapter boundary. Ask the continuous manager to fill the adjacent
      // spine section explicitly when a boundary is reached.
      const manager = this.rendition?.manager;
      try {
        void Promise.resolve(manager?.check?.()).catch(() => undefined);
      } catch {
        // A view can be destroyed between the boundary event and this task.
      }
    }, 0);
  };

  async open(source: BookSource, host: ReaderHost): Promise<BookMetadata> {
    this.destroyed = false;
    this.host = host;
    const blob = await materializeBlob(source);
    this.book = ePub(await blob.arrayBuffer());
    await this.book.ready;
    // EPUB.js deliberately sandboxes its srcdoc frames without script
    // execution. Strip script elements before the XHTML is copied into those
    // frames so harmless-but-unsupported EPUB scripts do not spam the console
    // with one "Blocked script execution" error per spine item.
    this.book.spine?.hooks?.serialize?.register?.(this.sanitizeSectionOutput);
    const metadataRaw = await Promise.resolve(this.book.loaded?.metadata || this.book.packaging?.metadata || {});
    const title = metadataRaw?.title || (source.kind === "stored" ? source.record.name : source.kind === "file" ? source.file.name : source.name || "EPUB 小说");
    const chapters = await this.readToc();
    const metadata: BookMetadata = { title, author: metadataRaw?.creator, format: this.format, chapters };
    host.onMetadata(metadata);
    // EPUB.js appends its container instead of replacing the mount node.
    // Remove the shell's loading placeholder before creating the rendition.
    host.surface.replaceChildren();
    this.createRendition();
    window.addEventListener("resize", this.resizeHandler);
    await this.rendition.display();
    this.stabilizeScrolledManager();
    this.setFontSize(this.fontSize);
    this.applyAllDocuments();
    void this.generateLocations();
    return metadata;
  }

  private createRendition(): void {
    if (!this.book || !this.host) return;
    const surface = this.host.surface;
    this.rendition = this.book.renderTo(surface, {
      width: "100%",
      height: "100%",
      flow: this.flow === "scrolled" ? "scrolled" : "paginated",
      manager: this.flow === "scrolled" ? "continuous" : "default",
      spread: this.effectiveSpread(),
      minSpreadWidth: 0,
      allowScriptedContent: false
    });
    this.setSurfaceFlowClass();
    this.bindScrolledBoundary();
    // EPUB.js invokes the content hook before the view is painted. Apply the
    // reader overrides here as well as from `rendered`, otherwise images can
    // briefly use the EPUB's original layout and then jump/resize a frame later.
    this.rendition.hooks?.content?.register?.((contents: any) => this.enhanceDocument(this.documentFromView(contents)));
    this.rendition.on("rendered", (_section: unknown, view: any) => this.enhanceDocument(this.documentFromView(view)));
    this.rendition.on("relocated", (location: any) => this.emitLocation(location));
  }

  private emitLocation(location: any): void {
    this.lastRawLocation = location;
    const cfi = location?.start?.cfi;
    const percent = this.locationsReady && cfi ? this.book.locations.percentageFromCfi(cfi) : undefined;
    const isScrolled = this.flow === "scrolled";
    this.host?.onLocation({
        kind: this.format,
        // EPUB.js reports section-local page numbers for continuous flow.
        // They are not a meaningful global page counter and can appear to
        // jump when the continuous manager adds/removes spine views. Persist
        // only the CFI/href in this mode.
        page: isScrolled ? undefined : location?.start?.displayed?.page,
        total: isScrolled ? undefined : location?.start?.displayed?.total,
        cfi,
        href: location?.start?.href,
        percent,
        atStart: Boolean(location?.atStart),
        atEnd: Boolean(location?.atEnd)
      }, percent);
  }

  private async generateLocations(): Promise<void> {
    try {
      this.book.locations.pause = 10;
      await this.book.locations.generate(1200);
      if (this.destroyed || !this.book || !this.rendition) return;
      this.locationsReady = this.book.locations.length() > 0;
      const current = this.rendition?.currentLocation?.() || this.lastRawLocation;
      if (current) this.emitLocation(current);
    } catch {
      this.locationsReady = false;
    }
  }

  private cfiForDisplayedPage(page: number, total?: number): string | undefined {
    if (!this.locationsReady || !this.book?.locations?._locations?.length) return undefined;
    const href = this.lastRawLocation?.start?.href;
    const section = href ? this.book.spine.get(href) : undefined;
    const spineIndex = section?.index;
    const locations = this.book.locations._locations as string[];
    const sectionLocations = typeof spineIndex === "number"
      ? locations.filter((cfi) => {
        const match = cfi.match(/\/6\/(\d+)!/);
        return match ? (Number(match[1]) - 2) / 2 === spineIndex : false;
      })
      : [];
    const candidates = sectionLocations.length ? sectionLocations : locations;
    const ratio = (Math.max(1, page) - 1) / Math.max(1, (total || candidates.length) - 1);
    return candidates[Math.min(candidates.length - 1, Math.max(0, Math.round(ratio * (candidates.length - 1))))];
  }

  private async readToc(): Promise<Array<{ label: string; href: string }>> {
    try {
      const navigation = await Promise.resolve(this.book.loaded?.navigation || this.book.navigation);
      return (navigation?.toc || []).map((item: any) => ({ label: item.label || "未命名章节", href: item.href }));
    } catch { return []; }
  }

  async next(): Promise<void> {
    if (this.flow === "scrolled" && this.scrollSurface(1)) return;
    await this.rendition?.next();
  }
  async prev(): Promise<void> {
    if (this.flow === "scrolled" && this.scrollSurface(-1)) return;
    await this.rendition?.prev();
  }

  private scrollSurface(direction: 1 | -1): boolean {
    const surface = this.host?.surface;
    if (!surface) return false;
    const frames = [...surface.querySelectorAll<HTMLIFrameElement>("iframe")];
    for (const frame of frames) {
      const document = frame.contentDocument;
      const scroller = document?.scrollingElement;
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 2) continue;
      const before = scroller.scrollTop;
      const distance = Math.max(80, scroller.clientHeight * .88) * direction;
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, before + distance));
      if (scroller.scrollTop !== before) {
        // The continuous manager listens to this same scroll container and
        // reports a debounced location. Emitting a second synchronous
        // location here races that report and makes the saved CFI/page appear
        // to jump backwards or forwards during fast scrolling.
        return true;
      }
    }
    const containers = [surface, this.rendition?.manager?.container, this.rendition?.manager?.stage?.container].filter(Boolean) as HTMLElement[];
    for (const container of containers) {
      if (container.scrollHeight <= container.clientHeight + 2) continue;
      const before = container.scrollTop;
      const distance = Math.max(80, container.clientHeight * .88) * direction;
      container.scrollTop = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, before + distance));
      if (container.scrollTop === before) continue;
      return true;
    }
    return false;
  }
  async goTo(locator: Locator): Promise<void> {
    if (locator.cfi || locator.href) {
      await this.rendition?.display(locator.cfi || locator.href);
      return;
    }
    if (locator.page) {
      const cfi = this.cfiForDisplayedPage(locator.page, locator.total);
      if (cfi) await this.rendition?.display(cfi);
    }
  }
  setFontSize(percent: number): void { this.fontSize = percent; this.rendition?.themes?.fontSize(`${percent}%`); }
  setTheme(theme: ReaderTheme): void {
    this.theme = theme;
    this.applyAllDocuments();
  }

  setSpread(spread: ReaderSpread): void {
    this.spread = spread;
    if (this.flow === "scrolled") return;
    this.applySpread(true);
  }

  setFlow(flow: ReaderFlow): void {
    if (this.flow === flow && this.rendition) return;
    this.flow = flow;
    this.setSurfaceFlowClass();
    if (!this.rendition || !this.host || !this.book) return;
    const cfi = this.rendition.currentLocation?.()?.start?.cfi;
    this.rendition.destroy?.();
    this.host.surface.replaceChildren();
    this.createRendition();
    void this.rendition.display(cfi).then(() => {
      this.stabilizeScrolledManager();
      this.setFontSize(this.fontSize);
      this.applyAllDocuments();
    }).catch((error: unknown) => this.host?.onError(error));
  }

  setLineHeight(lineHeight: number): void {
    this.lineHeight = lineHeight;
    this.applyAllDocuments();
  }

  setImageFit(fit: ImageFit): void {
    this.imageFit = fit;
    this.applyAllDocuments();
  }

  setZoom(percent: number): void {
    this.zoom = Math.max(30, Math.min(100, percent));
    this.setSurfaceFlowClass();
    this.applyAllDocuments();
    if (this.flow === "scrolled") {
      window.requestAnimationFrame(() => this.applyAllDocuments());
      window.setTimeout(() => this.applyAllDocuments(), 80);
    }
  }

  private effectiveSpread(): "none" | "always" {
    return this.flow !== "scrolled" && this.spread === "double" && window.innerWidth > 760 ? "always" : "none";
  }

  private setSurfaceFlowClass(): void {
    const surface = this.host?.surface;
    if (!surface) return;
    surface.classList.toggle("reader-flow-scrolled", this.flow === "scrolled");
    surface.style.setProperty("--reader-scroll-width", `${this.zoom}%`);
  }

  private bindScrolledBoundary(): void {
    this.scrolledSurface?.removeEventListener("scroll", this.scrolledBoundaryHandler, true);
    this.scrolledSurface = undefined;
    window.clearTimeout(this.scrolledBoundaryTimer);
    if (this.flow !== "scrolled" || !this.host?.surface) return;
    this.scrolledSurface = this.host.surface;
    this.scrolledSurface.addEventListener("scroll", this.scrolledBoundaryHandler, { capture: true, passive: true });
  }

  private stabilizeScrolledManager(): void {
    if (this.flow !== "scrolled") return;
    const manager = this.rendition?.manager;
    if (!manager || manager.__nekoStableScroll) return;
    // EPUB.js normally removes distant views after a short delay. With a
    // long, reflowable chapter that removal changes scrollHeight and can make
    // the viewport jump while the reader is actively scrolling. Keep loaded
    // spine views in continuous mode; new sections are still appended by the
    // manager boundary check above. This trades some memory for a stable,
    // uninterrupted reading stream.
    manager.__nekoStableScroll = true;
    // ContinuousViewManager.update() destroys every view outside its
    // viewport before scheduling trim(). Recreating those iframe views on
    // the way back up changes scrollHeight and makes a long book jump to a
    // different chapter. Keep all loaded views mounted instead. The
    // manager still runs check(), so adjacent spine items continue to be
    // appended/prepended as the reader reaches a boundary.
    for (const method of ["append", "prepend"] as const) {
      const original = manager[method]?.bind(manager);
      if (!original || manager[`__neko${method}Wrapped`]) continue;
      manager[`__neko${method}Wrapped`] = true;
      manager[method] = (section: any) => {
        const view = original(section);
        if (view && !view.__nekoShowHooked) {
          const previous = view.onDisplayed;
          view.__nekoShowHooked = true;
          view.onDisplayed = (shown: any) => {
            try {
              previous?.(shown);
            } finally {
              (shown || view)?.show?.();
            }
          };
        }
        return view;
      };
    }
    manager.update = () => {
      const views = manager.views?.all?.() || [];
      for (const view of views) {
        if (view?.displayed) view.show?.();
      }
      return Promise.resolve();
    };
    manager.trim = () => Promise.resolve();
    this.scheduleScrolledCheck();
  }

  private scheduleScrolledCheck(): void {
    if (this.flow !== "scrolled" || !this.rendition?.manager) return;
    window.clearTimeout(this.scrolledCheckTimer);
    this.scrolledCheckTimer = window.setTimeout(() => {
      if (this.destroyed || this.flow !== "scrolled") return;
      try {
        void Promise.resolve(this.rendition?.manager?.check?.()).catch(() => undefined);
      } catch {
        // The rendition can be torn down while a late image load is settling.
      }
    }, 0);
  }

  private applySpread(restoreLocation = false): void {
    if (!this.rendition?.spread) return;
    const cfi = restoreLocation ? this.rendition.currentLocation?.()?.start?.cfi : undefined;
    this.rendition.spread(this.effectiveSpread(), 0);
    if (cfi) void this.rendition.display(cfi);
  }

  private documentFromView(view: any): Document | undefined {
    return view?.document || view?.contents?.document || view?.contents?.content?.ownerDocument;
  }

  private sanitizeSectionOutput = (output: unknown, section: any): void => {
    if (typeof output !== "string" || !section) return;
    // Earlier serialize hooks (notably EPUB.js resource substitution) write
    // the resolved blob/data URLs to section.output. The hook receives the
    // original output argument, so sanitizing that argument would undo image
    // URL substitution and break every illustration.
    const resolved = typeof section.output === "string" ? section.output : output;
    section.output = resolved
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<script\b[^>]*\/\s*>/gi, "");
  };

  private applyAllDocuments(): void {
    const contents = this.rendition?.getContents?.() || [];
    for (const content of contents) this.enhanceDocument(content?.document || content?.content?.ownerDocument);
  }

  private markIllustrations(doc: Document): void {
    const body = doc.body;
    if (!body) return;
    const media = [...body.querySelectorAll<HTMLElement>("img, svg")];
    const textLength = (body.innerText || "").replace(/\s/g, "").length;
    body.classList.toggle("neko-image-page", media.length === 1 && textLength < 180);
    media.forEach((element) => {
      if (element.tagName.toLowerCase() === "img") {
        const image = element as HTMLImageElement;
        // Some EPUBs ship a `.fit` rule with a percentage/line-height based
        // max-height. In continuous mode that value can resolve against the
        // still-growing iframe and collapse a perfectly loaded image to a
        // few pixels. Set the intrinsic height explicitly; the surrounding
        // reader container still controls the available width.
        if (this.flow === "scrolled") {
          image.style.setProperty("width", "100%", "important");
          image.style.setProperty("height", "auto", "important");
          image.style.setProperty("max-width", "100%", "important");
          image.style.setProperty("max-height", "none", "important");
        }
        const mark = () => image.classList.toggle("neko-large-illustration", image.naturalWidth >= 320 || image.naturalHeight >= 320 || media.length === 1);
        mark();
        if (!image.complete && image.dataset.nekoImageListener !== "1") {
          image.dataset.nekoImageListener = "1";
          image.addEventListener("load", () => { mark(); this.enhanceDocument(doc); }, { once: true });
        }
      } else {
        element.classList.add("neko-large-illustration");
      }
    });
  }

  private enhanceDocument(doc?: Document): void {
    if (!doc?.head || !doc.body) return;
    this.paintDocumentBackground(doc);
    if (doc.body.dataset.nekoInteractionBound !== "1") {
      doc.body.dataset.nekoInteractionBound = "1";
      const notifyInteraction = () => this.host?.onInteraction?.();
      const previewImage = (event: Event) => {
        // The target belongs to the iframe's realm, so `instanceof Element`
        // from the parent window is false for otherwise normal DOM elements.
        const eventTarget = event.target as Element | null;
        const target = eventTarget?.closest?.("img, svg") || null;
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        if (target.tagName.toLowerCase() === "img") {
          const image = target as HTMLImageElement;
          const candidate = image.alt || image.currentSrc || image.src;
          const name = candidate.split("/").pop()?.split("?")[0];
          this.host?.onImage?.({
            src: image.currentSrc || image.src,
            name: name && /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(name) ? name : "illustration.png"
          });
          return;
        }
        const embeddedImage = target.querySelector("image");
        const embeddedHref = embeddedImage?.getAttribute("href") || embeddedImage?.getAttribute("xlink:href");
        if (embeddedHref) {
          const candidate = embeddedHref.split("/").pop()?.split("?")[0];
          this.host?.onImage?.({
            src: new URL(embeddedHref, doc.baseURI).href,
            name: candidate && /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(candidate) ? candidate : "illustration.png"
          });
          return;
        }
        const svg = new XMLSerializer().serializeToString(target);
        this.host?.onImage?.({
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          name: "illustration.svg"
        });
      };
      doc.addEventListener("pointerdown", previewImage, { capture: true });
      doc.addEventListener("click", previewImage, { capture: true });
      // Pointer events cover real mouse/touch input. Keep a click listener as
      // well because some embedded-document implementations synthesize click
      // without exposing the pointerdown event to the parent document.
      doc.addEventListener("pointerdown", notifyInteraction, { passive: true });
      doc.addEventListener("click", notifyInteraction, { passive: true });
      doc.addEventListener("keydown", notifyInteraction, { passive: true });
    }
    let style = doc.querySelector<HTMLStyleElement>("#neko-reader-overrides");
    if (!style) {
      style = doc.createElement("style");
      style.id = "neko-reader-overrides";
      doc.head.append(style);
    }
    const palette = this.theme === "original" ? undefined : PALETTES[this.theme];
    const themeCss = palette ? `
      html, body { background: ${palette.background} !important; color: ${palette.color} !important; }
      body :is(p, span, li, td, th, h1, h2, h3, h4, h5, h6):not([style*="color"]) { color: ${palette.color} !important; }
      a { color: ${palette.link} !important; }
    ` : "";
    // A small preflight is installed before classifying images. It prevents
    // the browser from painting the source EPUB's unconstrained image first.
    style.textContent = `
      ${themeCss}
      img, svg { display: block; max-width: 100% !important; height: auto; object-fit: contain; }
      figure { max-width: 100% !important; margin-inline: auto !important; }
      ${this.flow === "scrolled" ? "html, body { width: 100% !important; height: auto !important; min-height: 0 !important; overflow: visible !important; } img, svg { max-height: none !important; }" : ""}
    `;
    this.markIllustrations(doc);
    const illustrationCss = this.imageFit === "width" ? `
      img.neko-large-illustration, svg.neko-large-illustration { display: block !important; width: 100% !important; height: auto !important; max-width: 100% !important; max-height: none !important; margin: 1em auto !important; object-fit: contain !important; }
    ` : this.imageFit === "original" ? `
      img.neko-large-illustration, svg.neko-large-illustration { display: block !important; width: auto !important; height: auto !important; max-width: 100% !important; max-height: 80vh !important; margin: 1em auto !important; object-fit: contain !important; }
    ` : `
      img.neko-large-illustration, svg.neko-large-illustration { display: block !important; width: min(100%, 960px) !important; height: auto !important; max-width: 100% !important; max-height: 82vh !important; margin: 1em auto !important; object-fit: contain !important; }
      body.neko-image-page { margin: 0 !important; padding: 0 !important; overflow: hidden !important; }
      body.neko-image-page img.neko-large-illustration, body.neko-image-page svg.neko-large-illustration { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; max-width: 100vw !important; max-height: 100vh !important; margin: 0 !important; object-fit: contain !important; }
    `;
    const flowCss = this.flow === "scrolled" ? `
      html, body { width: 100% !important; height: auto !important; min-height: 0 !important; overflow: visible !important; }
      body.neko-image-page { margin: 0 !important; padding: 0 !important; overflow: visible !important; }
      img, svg { max-height: none !important; }
      /* Match the image-page selector above. Without the body qualifier its
         fixed-position rule wins on specificity and collapses cover SVGs to
         the viewport height, leaving a long blank area in scroll mode. */
      body.neko-image-page img.neko-large-illustration,
      body.neko-image-page svg.neko-large-illustration { position: static !important; inset: auto !important; display: block !important; width: 100% !important; height: auto !important; max-width: 100% !important; max-height: none !important; margin: 1em auto !important; object-fit: contain !important; }
    ` : "";
    style.textContent = `
      ${themeCss}
      p, li, blockquote { line-height: ${this.lineHeight} !important; }
      img, svg { max-width: 100% !important; object-fit: contain; }
      figure { max-width: 100% !important; margin-inline: auto !important; }
      ${illustrationCss}
      ${flowCss}
    `;
    // Let EPUB.js finish attaching the view before changing its iframe
    // height. Doing it synchronously during the content hook can race its
    // own MutationObserver while the frame is still being mounted.
    window.requestAnimationFrame(() => this.syncScrolledFrameSize(doc));
  }

  private syncScrolledFrameSize(doc: Document): void {
    if (this.flow !== "scrolled") return;
    const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null;
    if (!frame || !frame.isConnected) return;
    // Continuous manager views are initially measured before late-loading
    // illustrations have intrinsic dimensions. Measure the rendered content
    // after our overrides and grow that view instead of leaving a 16px iframe
    // which clips the image to a thin strip.
    const bottoms = [
      doc.documentElement?.getBoundingClientRect().bottom || 0,
      doc.body?.getBoundingClientRect().bottom || 0,
      ...[...doc.querySelectorAll<HTMLElement>("img, svg, p, figure, div")].map((node) => node.getBoundingClientRect().bottom)
    ];
    const height = Math.max(16, Math.ceil(Math.max(...bottoms.filter(Number.isFinite), 0) + 16));
    if (Math.abs(frame.getBoundingClientRect().height - height) > 1 || frame.style.height !== `${height}px`) {
      frame.style.height = `${height}px`;
      this.scheduleScrolledCheck();
    }
  }

  private paintDocumentBackground(doc?: Document): void {
    if (!doc?.documentElement || !doc.body) return;
    const palette = this.theme === "original" ? undefined : PALETTES[this.theme];
    const background = palette?.background || "transparent";
    doc.documentElement.style.backgroundColor = background;
    doc.body.style.backgroundColor = background;
  }

  destroy(): void { this.destroyed = true; window.removeEventListener("resize", this.resizeHandler); this.bindScrolledBoundary(); window.clearTimeout(this.scrolledCheckTimer); this.rendition?.destroy?.(); this.book?.destroy?.(); this.host?.surface.replaceChildren(); this.rendition = undefined; this.book = undefined; this.host = undefined; }
}
