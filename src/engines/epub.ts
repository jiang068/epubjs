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
  private fixedLayout = false;
  private fixedPageCount = 0;
  private locationsReady = false;
  private lastRawLocation?: any;
  private destroyed = false;
  private flowTransitionVersion = 0;
  private navigationVersion = 0;
  private resizeHandler = () => {
    this.applySpread();
    window.requestAnimationFrame(() => this.alignAllFixedLayoutPages());
  };
  private scrolledSurface?: HTMLElement;
  private scrolledLocationTimer?: number;
  private scrolledBoundaryTimer?: number;
  private lastFixedScrolledHref?: string;
  private scrolledBoundaryHandler = (): void => {
    if (this.flow !== "scrolled" || !this.rendition?.manager) return;
    const container = this.rendition.manager.container as HTMLElement | undefined;
    if (!container) return;
    if (!this.fixedLayout) return;
    window.clearTimeout(this.scrolledLocationTimer);
    this.scrolledLocationTimer = window.setTimeout(() => this.emitFixedScrolledLocation(), 90);
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 500) {
      this.scheduleFixedLayoutCheck();
    }
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
    const packageMetadata = this.book.packaging?.metadata || this.book.package?.metadata || metadataRaw;
    this.fixedLayout = packageMetadata?.layout === "pre-paginated" || this.book.displayOptions?.fixedLayout === "true";
    const spineItems = this.book.spine?.items || [];
    this.fixedPageCount = spineItems.filter((item: any) => item.linear !== "no").length || spineItems.length;
    const title = metadataRaw?.title || (source.kind === "stored" ? source.record.name : source.kind === "file" ? source.file.name : source.name || "EPUB 小说");
    const chapters = await this.readToc();
    const metadata: BookMetadata = { title, author: metadataRaw?.creator, format: this.format, total: this.fixedLayout ? this.fixedPageCount : undefined, chapters };
    host.onMetadata(metadata);
    // EPUB.js appends its container instead of replacing the mount node.
    // Remove the shell's loading placeholder before creating the rendition.
    host.surface.replaceChildren();
    this.createRendition();
    const rendition = this.rendition;
    window.addEventListener("resize", this.resizeHandler);
    await this.prepareRenditionFlow(rendition);
    await rendition.display();
    if (this.rendition !== rendition || this.destroyed) return metadata;
    this.configureFixedLayoutAxis();
    this.setFontSize(this.fontSize);
    this.applyAllDocuments();
    if (this.fixedLayout && this.flow === "scrolled") this.emitFixedScrolledLocation();
    if (this.fixedLayout && this.flow === "scrolled") this.scheduleFixedLayoutCheck();
    // A fixed-layout EPUB is already paginated by its spine: generating
    // character locations for every image page only delays the progress UI.
    if (!this.fixedLayout) void this.generateLocations();
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
    const rendition = this.rendition;
    const isCurrentRendition = () => !this.destroyed && this.rendition === rendition;
    this.setSurfaceFlowClass();
    this.configureFixedLayoutAxis();
    this.bindScrolledBoundary();
    // EPUB.js invokes the content hook before the view is painted. Apply the
    // reader overrides here as well as from `rendered`, otherwise images can
    // briefly use the EPUB's original layout and then jump/resize a frame later.
    rendition.hooks?.content?.register?.((contents: any) => {
      if (isCurrentRendition()) this.enhanceDocument(this.documentFromView(contents));
    });
    rendition.on("rendered", (_section: unknown, view: any) => {
      if (!isCurrentRendition()) return;
      const doc = this.documentFromView(view);
      this.enhanceDocument(doc);
      this.alignFixedLayoutPage(doc);
    });
    rendition.on("relocated", (location: any) => {
      if (!isCurrentRendition()) return;
      if (!this.fixedLayout || this.flow !== "scrolled" || !this.emitFixedScrolledLocation()) this.emitLocation(location);
    });
  }

  private emitLocation(location: any): void {
    this.lastRawLocation = location;
    const cfi = location?.start?.cfi;
    const isScrolled = this.flow === "scrolled";
    const href = location?.start?.href;
    const fixedSection = this.fixedLayout && href ? this.book.spine?.get?.(href) : undefined;
    const linearSections = this.fixedLayout
      ? (this.book.spine?.items || []).filter((item: any) => item.linear !== "no")
      : [];
    const fixedPage = fixedSection
      ? linearSections.findIndex((item: any) => item.href === fixedSection.href) + 1
      : undefined;
    const percent = this.fixedLayout && fixedPage && this.fixedPageCount > 1
      ? (fixedPage - 1) / (this.fixedPageCount - 1)
      : this.locationsReady && cfi ? this.book.locations.percentageFromCfi(cfi) : undefined;
    this.host?.onLocation({
        kind: this.format,
        // EPUB.js reports section-local page numbers for continuous flow.
        // They are not a meaningful global page counter and can appear to
        // jump when the continuous manager adds/removes spine views. Persist
        // only the CFI/href in this mode.
        page: isScrolled ? undefined : fixedPage || location?.start?.displayed?.page,
        total: isScrolled ? undefined : this.fixedLayout ? this.fixedPageCount : location?.start?.displayed?.total,
        cfi,
        href,
        percent,
        atStart: Boolean(location?.atStart),
        atEnd: Boolean(location?.atEnd)
      }, percent);
  }

  private async generateLocations(): Promise<void> {
    const rendition = this.rendition;
    try {
      this.book.locations.pause = 10;
      await this.book.locations.generate(1200);
      if (this.destroyed || !this.book || this.rendition !== rendition) return;
      this.locationsReady = this.book.locations.length() > 0;
      const current = rendition?.currentLocation?.();
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
      let navigation: any;
      try {
        navigation = await Promise.resolve(this.book.loaded?.navigation);
      } catch {
        navigation = undefined;
      }
      const toc = navigation?.toc || this.book.navigation?.toc || [];
      const chapters: Array<{ label: string; href: string }> = [];
      const append = (items: any[], depth = 0): void => {
        for (const item of items || []) {
          if (typeof item?.href === "string" && item.href.trim()) {
            const label = String(item.label || "未命名章节").trim();
            chapters.push({ label: `${"　".repeat(depth)}${label}`, href: item.href });
          }
          append(item?.subitems || item?.children || [], depth + 1);
        }
      };
      append(toc);
      return chapters;
    } catch { return []; }
  }

  async next(): Promise<void> {
    this.navigationVersion += 1;
    if (this.flow === "scrolled" && this.scrollSurface(1)) return;
    await this.rendition?.next();
  }
  async prev(): Promise<void> {
    this.navigationVersion += 1;
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
    this.navigationVersion += 1;
    const rendition = this.rendition;
    let target: string | undefined;
    if (locator.cfi || locator.href) {
      target = locator.cfi || locator.href;
    } else if (locator.page) {
      if (this.fixedLayout) {
        const sections = (this.book?.spine?.items || []).filter((item: any) => item.linear !== "no");
        target = sections[locator.page - 1]?.href;
      } else {
        target = this.cfiForDisplayedPage(locator.page, locator.total);
      }
    }
    if (!target || !rendition) return;
    const navigation = this.navigationVersion;
    await rendition.display(target);
    if (this.rendition !== rendition || this.destroyed || this.navigationVersion !== navigation) return;
    if (this.fixedLayout && this.flow === "scrolled") this.emitFixedScrolledLocation();
    if (this.fixedLayout && this.flow === "scrolled") this.scheduleFixedLayoutCheck();
    else {
      const current = rendition.currentLocation?.();
      if (current) this.emitLocation(current);
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
    const transition = ++this.flowTransitionVersion;
    this.flow = flow;
    this.setSurfaceFlowClass();
    if (!this.rendition || !this.host || !this.book) return;
    const oldRendition = this.rendition;
    const currentStart = oldRendition.currentLocation?.()?.start;
    const cfi = currentStart?.cfi || this.lastRawLocation?.start?.cfi;
    const href = currentStart?.href || this.lastRawLocation?.start?.href;
    const navigation = this.navigationVersion;
    this.lastFixedScrolledHref = undefined;
    // EPUB.js leaves the continuous manager's asynchronous trim queue alive
    // after destroy(). Cancel it before its old views are removed; otherwise
    // a queued trim can try removing a node from the replacement rendition.
    const oldManager = oldRendition.manager;
    if (oldManager) {
      window.clearTimeout(oldManager.trimTimeout);
      oldManager.q?.stop?.();
      oldManager.trim = () => Promise.resolve();
    }
    oldRendition.destroy?.();
    this.host.surface.replaceChildren();
    this.createRendition();
    const rendition = this.rendition;
    const target = this.fixedLayout ? (href || cfi) : cfi;
    const stillCurrent = () => !this.destroyed && this.rendition === rendition && this.flowTransitionVersion === transition && this.navigationVersion === navigation;
    void this.prepareRenditionFlow(rendition).then(() => {
      if (!stillCurrent()) return;
      return rendition.display(target);
    }).then(() => {
      if (!stillCurrent()) return;
      this.configureFixedLayoutAxis();
      if (this.fixedLayout && this.flow === "scrolled" && href) {
        const manager = this.rendition?.manager;
        const section = this.book?.spine?.get?.(href);
        const view = section ? manager?.views?.find?.(section) : undefined;
        const position = view?.position?.();
        if (manager?.container && position && Number.isFinite(position.top)) {
          manager.container.scrollTop = Math.max(0, position.top);
          manager.scrollTop = manager.container.scrollTop;
          manager.scrollLeft = manager.container.scrollLeft;
        }
      }
      this.setFontSize(this.fontSize);
      this.applyAllDocuments();
      if (this.fixedLayout && this.flow === "scrolled") this.emitFixedScrolledLocation();
      if (this.fixedLayout && this.flow === "scrolled") this.scheduleFixedLayoutCheck();
      else {
        const current = this.rendition?.currentLocation?.();
        if (current) this.emitLocation(current);
      }
    }).catch((error: unknown) => {
      if (stillCurrent()) this.host?.onError(error);
    });
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
    surface.classList.toggle("reader-epub-fixed-layout", this.fixedLayout);
    surface.style.setProperty("--reader-scroll-width", `${this.zoom}%`);
  }

  private bindScrolledBoundary(): void {
    this.scrolledSurface?.removeEventListener("scroll", this.scrolledBoundaryHandler, true);
    this.scrolledSurface = undefined;
    window.clearTimeout(this.scrolledLocationTimer);
    window.clearTimeout(this.scrolledBoundaryTimer);
    if (this.flow !== "scrolled" || !this.host?.surface) return;
    this.scrolledSurface = this.host.surface;
    this.scrolledSurface.addEventListener("scroll", this.scrolledBoundaryHandler, { capture: true, passive: true });
  }

  private scheduleFixedLayoutCheck(): void {
    if (!this.fixedLayout || this.flow !== "scrolled") return;
    window.clearTimeout(this.scrolledBoundaryTimer);
    this.scrolledBoundaryTimer = window.setTimeout(() => {
      if (this.destroyed || this.flow !== "scrolled") return;
      const manager = this.rendition?.manager;
      if (!manager?.container) return;
      // ContinuousViewManager fills neighboring spine pages when explicitly
      // checked. A restored position can already be at the end of its
      // currently mounted pages and therefore produce no native scroll event.
      void Promise.resolve(manager.check?.()).catch((error: unknown) => this.host?.onError(error));
    }, 25);
  }

  private configureFixedLayoutAxis(): void {
    const manager = this.rendition?.manager;
    if (!manager) return;
    if (this.flow === "scrolled" && !manager.__nekoCoordinateSyncWrapped) {
      const scrollTo = manager.scrollTo?.bind(manager);
      const check = manager.check?.bind(manager);
      manager.__nekoCoordinateSyncWrapped = true;
      if (scrollTo) {
        manager.scrollTo = (left: number, top: number, silent?: boolean) => {
          const result = scrollTo(left, top, silent);
          // EPUB.js clear()/display() updates the actual scroll element but
          // leaves ContinuousViewManager's cached coordinates untouched.
          // The following fill() then thinks it is still at the previous
          // chapter and prepends pages there instead of staying at the target.
          if (!manager.settings?.fullsize && manager.container) {
            manager.scrollTop = manager.container.scrollTop;
            manager.scrollLeft = manager.container.scrollLeft;
          }
          return result;
        };
      }
      if (check) {
        manager.check = (...args: unknown[]) => {
          if (!manager.settings?.fullsize && manager.container) {
            manager.scrollTop = manager.container.scrollTop;
            manager.scrollLeft = manager.container.scrollLeft;
          }
          return check(...args);
        };
      }
    }
    if (this.flow === "scrolled" && !this.fixedLayout && !manager.__nekoRetainViewGeometry) {
      // ContinuousViewManager unloads an offscreen iframe and recreates it
      // when reading back. For a long text chapter its resize compensation
      // can move the viewport by thousands of pixels. Keep loaded text views
      // mounted throughout this rendition so upward reading remains stable.
      // Fixed-layout image pages retain EPUB.js' normal view recycling.
      manager.__nekoRetainViewGeometry = true;
      manager.update = () => {
        for (const view of manager.views?.all?.() || []) {
          if (view.displayed) view.show?.();
        }
        return Promise.resolve();
      };
      manager.trim = () => Promise.resolve();
    }
    if (this.flow === "scrolled" && this.fixedLayout && !manager.__nekoRetainFixedGeometry) {
      // Keep lightweight page wrappers in place. EPUB.js' trim removes an
      // entire page and compensates scrollTop. Keep the page geometry stable
      // during reverse scrolling while its normal update() still unloads
      // distant image iframes to bound decoded artwork memory.
      manager.__nekoRetainFixedGeometry = true;
      manager.trim = () => Promise.resolve();
    }
    if (!this.fixedLayout) return;
    // EPUB.js derives a horizontal axis from `writing-mode: vertical-rl`.
    // That is right for vertical text, but fixed-layout pages are scanned
    // artwork: spreads need a horizontal paginated axis, while continuous
    // reading must remain vertical so later spine pages are appended below.
    if (!manager.__nekoFixedLayoutAxisWrapped) {
      const updateAxis = manager.updateAxis?.bind(manager);
      if (!updateAxis) return;
      manager.__nekoFixedLayoutAxisWrapped = true;
      manager.updateAxis = (_axis: string, forceUpdate?: boolean) => updateAxis(
        this.flow === "scrolled" ? "vertical" : "horizontal",
        forceUpdate
      );
    }
    manager.updateAxis(this.flow === "scrolled" ? "vertical" : "horizontal", true);
    if (this.flow === "scrolled") {
      // RTL is a page-turning direction, not a vertical scroll direction.
      // With RTL here EPUB.js reverses its scrollTop calculation and thinks
      // the reader is at the start when actually at the bottom, so it never
      // appends the next image page.
      manager.direction?.("ltr");
    }
  }

  private emitFixedScrolledLocation(): boolean {
    const manager = this.rendition?.manager;
    const container = manager?.container as HTMLElement | undefined;
    const views = manager?.views?.all?.() || [];
    if (!container || !views.length || !this.host) return false;
    const containerTop = container.getBoundingClientRect().top;
    const marker = container.scrollTop + container.clientHeight / 2;
    const positioned = views.map((view: any) => {
      const rect = view.element?.getBoundingClientRect?.();
      const top = rect ? container.scrollTop + rect.top - containerTop : Number(view.element?.offsetTop || 0);
      const height = Number(rect?.height || view.height?.() || view.element?.offsetHeight || container.clientHeight);
      return { view, top, bottom: top + height };
    });
    const active = positioned.find((item: any) => item.top <= marker && item.bottom > marker)?.view;
    if (!active?.section?.href) return false;
    const href = active.section.href;
    if (href === this.lastFixedScrolledHref) return true;
    this.lastFixedScrolledHref = href;
    const linearSections = (this.book?.spine?.items || []).filter((item: any) => item.linear !== "no");
    const pageIndex = linearSections.findIndex((item: any) => item.href === href);
    const percent = pageIndex >= 0 && linearSections.length > 1 ? pageIndex / (linearSections.length - 1) : 0;
    this.lastRawLocation = { start: { href, cfi: active.section.cfiBase } };
    this.host.onLocation({
      kind: this.format,
      href,
      percent,
      atStart: pageIndex === 0,
      atEnd: pageIndex === linearSections.length - 1
    }, percent);
    return true;
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
      .replace(/<script\b[^>]*\/\s*>/gi, "")
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/\s+(?:href|src|xlink:href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi, "");
  };

  private applyAllDocuments(): void {
    const contents = this.rendition?.getContents?.() || [];
    for (const content of contents) {
      const doc = content?.document || content?.content?.ownerDocument;
      this.enhanceDocument(doc);
      this.alignFixedLayoutPage(doc);
    }
  }

  private alignAllFixedLayoutPages(): void {
    if (!this.fixedLayout) return;
    const contents = this.rendition?.getContents?.() || [];
    for (const content of contents) this.alignFixedLayoutPage(content?.document || content?.content?.ownerDocument);
  }

  private alignFixedLayoutPage(doc?: Document): void {
    if (!this.fixedLayout || !doc?.body) return;
    const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null;
    if (!frame?.isConnected) return;
    const body = doc.body;
    // EPUB.js scales a pre-paginated page to fit the frame's height, but
    // anchors it to the left when the viewport is wider than the artwork.
    // Center the already-scaled page without altering its intrinsic size.
    body.style.position = "relative";
    body.style.left = "0px";
    body.style.top = "0px";
    const frameRect = frame.getBoundingClientRect();
    const pageRect = body.getBoundingClientRect();
    body.style.left = `${Math.max(0, (frameRect.width - pageRect.width) / 2)}px`;
    body.style.top = `${Math.max(0, (frameRect.height - pageRect.height) / 2)}px`;
  }

  private markIllustrations(doc: Document): void {
    // Fixed-layout pages are already scaled by EPUB.js from the OPF viewport.
    // Rewriting SVG/img dimensions here applies a second transform and makes
    // full-page artwork appear tiny or jump after the first paint.
    if (this.fixedLayout) return;
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

  private async prepareRenditionFlow(rendition = this.rendition): Promise<void> {
    if (!rendition) return;
    // EPUB.js applies the package flow and writing-mode while starting. For
    // scanned Japanese fixed-layout books, the XHTML often declares vertical
    // writing even though pages themselves must be laid out as image pages.
    // Install the axis override after the manager exists but before its first
    // view is displayed, otherwise ContinuousViewManager can preload the book
    // along the wrong axis and create a giant blank scroll range.
    await rendition.started;
    if (this.rendition !== rendition || this.destroyed) return;
    rendition.flow(this.flow === "scrolled" ? "scrolled" : "paginated");
    this.configureFixedLayoutAxis();
  }

  private enhanceDocument(doc?: Document): void {
    if (!doc?.head || !doc.body) return;
    // EPUB XHTML is untrusted input. EPUB.js renders it in a sandbox, but
    // remove inline handlers and javascript: URLs as a second defensive line
    // before applying reader-specific behavior.
    doc.querySelectorAll("*").forEach((element) => {
      [...element.attributes].forEach((attribute) => {
        if (/^on/i.test(attribute.name) || ((attribute.name === "href" || attribute.name === "src" || attribute.name === "xlink:href") && /^\s*javascript:/i.test(attribute.value))) {
          element.removeAttribute(attribute.name);
        }
      });
    });
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
    if (this.fixedLayout) {
      // EPUB.js owns sizing and scaling for pre-paginated content. Keep the
      // source page's viewport, SVG viewBox, and intrinsic image geometry
      // intact; only paint the outer background for the selected theme.
      style.textContent = themeCss;
      return;
    }
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
  }

  private paintDocumentBackground(doc?: Document): void {
    if (!doc?.documentElement || !doc.body) return;
    const palette = this.theme === "original" ? undefined : PALETTES[this.theme];
    const background = palette?.background || "transparent";
    doc.documentElement.style.backgroundColor = background;
    doc.body.style.backgroundColor = background;
  }

  destroy(): void { this.destroyed = true; window.removeEventListener("resize", this.resizeHandler); this.bindScrolledBoundary(); this.rendition?.destroy?.(); this.book?.destroy?.(); this.host?.surface.replaceChildren(); this.rendition = undefined; this.book = undefined; this.host = undefined; }
}
