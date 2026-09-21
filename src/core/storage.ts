import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { BookRecord, Locator, StoredImage } from "../types";

interface CachedBookContent {
  id: string;
  blob?: Blob;
  images?: StoredImage[];
  size: number;
  cachedAt: number;
}

interface NekoSchema extends DBSchema {
  books: {
    key: string;
    value: BookRecord;
    indexes: { "by-updated": number; "by-cached": number };
  };
  contents: {
    key: string;
    value: CachedBookContent;
    indexes: { "by-cached": number };
  };
}

let database: Promise<IDBPDatabase<NekoSchema>> | undefined;
const sessionContent = new Map<string, Pick<BookRecord, "blob" | "images">>();
const CACHE_LIMIT_KEY = "neko-book-cache-limit";
const DEFAULT_CACHE_LIMIT = 3;
const CACHE_LIMITS = new Set([-1, 0, 1, 3, 5, 10]);

export interface BookCacheSummary {
  count: number;
  bytes: number;
  usage?: number;
  quota?: number;
}

export function getBookCacheLimit(): number {
  const stored = localStorage.getItem(CACHE_LIMIT_KEY);
  if (stored === null) return DEFAULT_CACHE_LIMIT;
  const value = Number(stored);
  return CACHE_LIMITS.has(value) ? value : DEFAULT_CACHE_LIMIT;
}

function rememberSessionContent(book: BookRecord): void {
  if (book.blob || book.images?.length) sessionContent.set(book.id, { blob: book.blob, images: book.images });
}

function metadataOnly(book: BookRecord): BookRecord {
  const { blob: _blob, images: _images, ...metadata } = book;
  if (!metadata.url && !metadata.localSource) metadata.localSource = book.images?.length ? "folder" : "file";
  return metadata;
}

function withSessionContent(book: BookRecord): BookRecord {
  const content = sessionContent.get(book.id);
  return content ? { ...book, ...content } : book;
}

function cachedContent(book: BookRecord, cachedAt = Date.now()): CachedBookContent | undefined {
  if (!book.blob && !book.images?.length) return undefined;
  return { id: book.id, blob: book.blob, images: book.images, size: book.size, cachedAt };
}

async function migrateLegacyBookBodies(opened: IDBPDatabase<NekoSchema>): Promise<void> {
  const transaction = opened.transaction(["books", "contents"], "readwrite");
  const books = transaction.objectStore("books");
  const contents = transaction.objectStore("contents");
  const limit = getBookCacheLimit();
  let retained = 0;
  let cursor = await books.index("by-updated").openCursor(null, "prev");
  while (cursor) {
    const record = cursor.value;
    const content = cachedContent(record, record.updatedAt);
    if (content) {
      const shouldRetain = limit < 0 || retained < limit;
      if (shouldRetain) {
        await contents.put(content);
        retained += 1;
      }
      await cursor.update(metadataOnly({
        ...record,
        offlineStored: shouldRetain,
        cachedAt: shouldRetain ? content.cachedAt : undefined
      }));
    }
    cursor = await cursor.continue();
  }
  await transaction.done;
}

function db(): Promise<IDBPDatabase<NekoSchema>> {
  database ??= openDB<NekoSchema>("neko-reader", 3, {
    upgrade(upgradeDb, _oldVersion, _newVersion, upgradeTransaction) {
      // Older builds created one of the stores without all of its indexes.
      // Always repair the complete schema during an upgrade instead of
      // relying only on the version number; otherwise importing a folder can
      // fail with NotFoundError when a missing index is accessed.
      const books = upgradeDb.objectStoreNames.contains("books")
        ? upgradeTransaction.objectStore("books")
        : upgradeDb.createObjectStore("books", { keyPath: "id" });
      if (!books.indexNames.contains("by-updated")) books.createIndex("by-updated", "updatedAt");
      if (!books.indexNames.contains("by-cached")) books.createIndex("by-cached", "cachedAt");

      const contents = upgradeDb.objectStoreNames.contains("contents")
        ? upgradeTransaction.objectStore("contents")
        : upgradeDb.createObjectStore("contents", { keyPath: "id" });
      if (!contents.indexNames.contains("by-cached")) contents.createIndex("by-cached", "cachedAt");
    }
  }).then(async (opened) => {
    await migrateLegacyBookBodies(opened);
    return opened;
  });
  return database;
}

async function pruneBookCache(opened: IDBPDatabase<NekoSchema>, limit: number): Promise<void> {
  if (limit < 0) return;
  const transaction = opened.transaction(["books", "contents"], "readwrite");
  const books = transaction.objectStore("books");
  const contents = transaction.objectStore("contents");
  let remaining = await contents.count();
  let cursor = await books.index("by-cached").openCursor();
  while (cursor && remaining > limit) {
    const id = cursor.value.id;
    if (cursor.value.offlineStored) {
      await contents.delete(id);
      await cursor.update({ ...cursor.value, offlineStored: false, cachedAt: undefined });
      sessionContent.delete(id);
      remaining -= 1;
    }
    cursor = await cursor.continue();
  }
  await transaction.done;
}

export async function listBooks(): Promise<BookRecord[]> {
  const books = await (await db()).getAllFromIndex("books", "by-updated");
  return books.sort((a, b) => b.updatedAt - a.updatedAt).map(withSessionContent);
}

export async function getBook(id: string): Promise<BookRecord | undefined> {
  const opened = await db();
  const book = await opened.get("books", id);
  if (!book) return undefined;
  const sessionBook = withSessionContent(book);
  if (sessionBook.blob || sessionBook.images?.length || !book.offlineStored) return sessionBook;
  const content = await opened.get("contents", id);
  if (!content) {
    await opened.put("books", { ...book, offlineStored: false, cachedAt: undefined });
    return { ...book, offlineStored: false, cachedAt: undefined };
  }
  const now = Date.now();
  const transaction = opened.transaction(["books", "contents"], "readwrite");
  await transaction.objectStore("books").put({ ...book, cachedAt: now });
  await transaction.done;
  return { ...book, blob: content.blob, images: content.images, cachedAt: now };
}

export async function saveBook(book: BookRecord): Promise<void> {
  rememberSessionContent(book);
  const opened = await db();
  const now = Date.now();
  const content = cachedContent(book, now);
  let metadata = metadataOnly({ ...book, updatedAt: now });
  const shouldStore = Boolean(content && !book.url && !book.offlineStored && getBookCacheLimit() !== 0);
  if (!shouldStore) {
    await opened.put("books", metadata);
    return;
  }
  try {
    const transaction = opened.transaction(["books", "contents"], "readwrite");
    metadata = { ...metadata, offlineStored: true, cachedAt: now };
    await transaction.objectStore("contents").put(content!);
    await transaction.objectStore("books").put(metadata);
    await transaction.done;
    await pruneBookCache(opened, getBookCacheLimit());
  } catch (error) {
    metadata = { ...metadata, offlineStored: false, cachedAt: undefined };
    await opened.put("books", metadata);
    console.warn("无法把书籍本体保存到浏览器，已改为本次会话使用。", error);
  }
}

export function hasBookContent(book: BookRecord): boolean {
  return Boolean(book.url || book.offlineStored || book.blob || book.images?.length);
}

export async function setBookCacheLimit(limit: number): Promise<void> {
  if (!CACHE_LIMITS.has(limit)) throw new Error("不支持的保留数量");
  localStorage.setItem(CACHE_LIMIT_KEY, String(limit));
  await pruneBookCache(await db(), limit);
}

export async function getBookCacheSummary(): Promise<BookCacheSummary> {
  const opened = await db();
  const transaction = opened.transaction("contents");
  let cursor = await transaction.store.openCursor();
  let count = 0;
  let bytes = 0;
  while (cursor) {
    count += 1;
    bytes += cursor.value.size;
    cursor = await cursor.continue();
  }
  await transaction.done;
  try {
    const estimate = await navigator.storage?.estimate?.();
    return { count, bytes, usage: estimate?.usage, quota: estimate?.quota };
  } catch {
    return { count, bytes };
  }
}

export async function releaseBookContent(id: string): Promise<void> {
  sessionContent.delete(id);
  const opened = await db();
  const transaction = opened.transaction(["books", "contents"], "readwrite");
  await transaction.objectStore("contents").delete(id);
  const book = await transaction.objectStore("books").get(id);
  if (book) await transaction.objectStore("books").put({ ...book, offlineStored: false, cachedAt: undefined });
  await transaction.done;
}

export async function clearBookCache(): Promise<void> {
  sessionContent.clear();
  const opened = await db();
  const transaction = opened.transaction(["books", "contents"], "readwrite");
  await transaction.objectStore("contents").clear();
  let cursor = await transaction.objectStore("books").openCursor();
  while (cursor) {
    if (cursor.value.offlineStored) await cursor.update({ ...cursor.value, offlineStored: false, cachedAt: undefined });
    cursor = await cursor.continue();
  }
  await transaction.done;
}

export async function updateProgress(id: string, locator: Locator, progress: number): Promise<void> {
  const opened = await db();
  const book = await opened.get("books", id);
  if (!book) return;
  await opened.put("books", { ...book, locator, progress, updatedAt: Date.now() });
}

export async function deleteBook(id: string): Promise<void> {
  sessionContent.delete(id);
  const transaction = (await db()).transaction(["books", "contents"], "readwrite");
  await transaction.objectStore("contents").delete(id);
  await transaction.objectStore("books").delete(id);
  await transaction.done;
}
