export type BookFormat = "epub" | "pdf" | "comic" | "txt";

export type BookSource =
  | { kind: "file"; file: File; name?: string }
  | { kind: "url"; url: string; name?: string }
  | { kind: "stored"; record: BookRecord };

export interface StoredImage {
  name: string;
  blob: Blob;
}

export interface BookRecord {
  id: string;
  name: string;
  format: BookFormat;
  size: number;
  addedAt: number;
  updatedAt: number;
  url?: string;
  localSource?: "file" | "folder";
  offlineStored?: boolean;
  cachedAt?: number;
  blob?: Blob;
  images?: StoredImage[];
  progress: number;
  locator?: Locator;
}

export interface Locator {
  kind: BookFormat;
  page?: number;
  total?: number;
  cfi?: string;
  href?: string;
  offset?: number;
  percent?: number;
  atStart?: boolean;
  atEnd?: boolean;
}

export interface BookMetadata {
  title: string;
  author?: string;
  format: BookFormat;
  total?: number;
  chapters?: Array<{ label: string; href: string }>;
}

export interface ReaderHost {
  surface: HTMLElement;
  onMetadata(metadata: BookMetadata): void;
  onLocation(locator: Locator, progress?: number): void;
  onImage?(image: { src: string; name?: string }): void;
  onInteraction?(): void;
  onError(error: unknown): void;
}

export interface ReaderEngine {
  readonly format: BookFormat;
  open(source: BookSource, host: ReaderHost): Promise<BookMetadata>;
  next(): Promise<void>;
  prev(): Promise<void>;
  goTo(locator: Locator): Promise<void>;
  setFontSize(percent: number): void;
  setTheme(theme: ReaderTheme): void;
  setSpread?(spread: ReaderSpread): void;
  setFlow?(flow: ReaderFlow): void;
  setLineHeight?(lineHeight: number): void;
  setImageFit?(fit: ImageFit): void;
  setZoom?(percent: number): void;
  toggleFit?(): void;
  destroy(): void;
}

export type ReaderTheme = "original" | "paper" | "sepia" | "eye" | "sakura" | "night" | "oled";
export type ReaderSpread = "single" | "double";
export type ReaderFlow = "paginated" | "scrolled";
export type ImageFit = "contain" | "width" | "original";

export const FORMAT_LABELS: Record<BookFormat, string> = {
  epub: "EPUB 小说",
  pdf: "PDF 文档",
  comic: "漫画 / CBZ",
  txt: "TXT 小说"
};
