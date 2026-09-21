import type { BookFormat, BookRecord, BookSource, StoredImage } from "../types";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"]);

export function extensionOf(name: string): string {
  const clean = name.split(/[?#]/, 1)[0];
  return clean.includes(".") ? clean.split(".").pop()!.toLowerCase() : "";
}

export function detectFormat(name: string, mime = ""): BookFormat {
  const ext = extensionOf(name);
  if (ext === "epub" || mime.includes("epub")) return "epub";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (ext === "txt" || ext === "text" || mime.startsWith("text/")) return "txt";
  if (ext === "cbz" || ext === "zip" || IMAGE_EXTENSIONS.has(ext) || mime.startsWith("image/")) return "comic";
  return "txt";
}

export function isImageFile(file: File): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(file.name)) || file.type.startsWith("image/");
}

export function sortNaturally<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export function sourceName(source: BookSource): string {
  if (source.kind === "file") return source.name || source.file.name;
  if (source.kind === "stored") return source.record.name;
  return source.name || decodeURIComponent(new URL(source.url).pathname.split("/").pop() || "远程文件");
}

export function sourceFormat(source: BookSource): BookFormat {
  if (source.kind === "stored") return source.record.format;
  if (source.kind === "file") return detectFormat(sourceName(source), source.file.type);
  return detectFormat(sourceName(source));
}

export async function materializeBlob(source: BookSource): Promise<Blob> {
  if (source.kind === "file") return source.file;
  if (source.kind === "stored") {
    if (!source.record.blob) throw new Error("本地书籍内容已被清理，请重新选择文件");
    return source.record.blob;
  }
  const response = await fetch(source.url, { mode: "cors", credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new Error(`远程文件请求失败（HTTP ${response.status}）`);
  return response.blob();
}

export async function materializeText(source: BookSource): Promise<string> {
  const blob = await materializeBlob(source);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("\uFFFD")) return utf8.replace(/^\uFEFF/, "");
  return new TextDecoder("gb18030").decode(bytes).replace(/^\uFEFF/, "");
}

export function recordFromFile(file: File, format: BookFormat): BookRecord {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    format,
    size: file.size,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    localSource: "file",
    blob: file,
    progress: 0
  };
}

export function recordFromImages(images: StoredImage[], title = "图片漫画"): BookRecord {
  const size = images.reduce((sum, image) => sum + image.blob.size, 0);
  return {
    id: crypto.randomUUID(),
    name: title,
    format: "comic",
    size,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    localSource: "folder",
    images,
    progress: 0
  };
}

export function recordFromUrl(url: string, name?: string): BookRecord {
  const original = new URL(url);
  const resolvedName = name || decodeURIComponent(original.pathname.split("/").pop() || "远程文件");
  let fingerprint = 2166136261;
  for (let index = 0; index < original.href.length; index += 1) fingerprint = Math.imul(fingerprint ^ original.href.charCodeAt(index), 16777619);
  let readableUrl = original.toString();
  if (original.protocol === "http:" && location.protocol === "https:") {
    const proxy = new URL("./api/proxy", document.baseURI);
    proxy.searchParams.set("url", original.toString());
    readableUrl = proxy.toString();
  }
  return {
    id: `remote:${(fingerprint >>> 0).toString(36)}`,
    name: resolvedName,
    format: detectFormat(resolvedName),
    size: 0,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    url: readableUrl,
    progress: 0
  };
}

export function sourceFromRecord(record: BookRecord): BookSource {
  return { kind: "stored", record };
}
