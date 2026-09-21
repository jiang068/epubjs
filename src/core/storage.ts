import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { BookRecord, Locator } from "../types";

interface NekoSchema extends DBSchema {
  books: {
    key: string;
    value: BookRecord;
    indexes: { "by-updated": number };
  };
}

let database: Promise<IDBPDatabase<NekoSchema>> | undefined;

function db(): Promise<IDBPDatabase<NekoSchema>> {
  database ??= openDB<NekoSchema>("neko-reader", 1, {
    upgrade(upgradeDb) {
      const store = upgradeDb.createObjectStore("books", { keyPath: "id" });
      store.createIndex("by-updated", "updatedAt");
    }
  });
  return database;
}

export async function listBooks(): Promise<BookRecord[]> {
  const books = await (await db()).getAllFromIndex("books", "by-updated");
  return books.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getBook(id: string): Promise<BookRecord | undefined> {
  return (await db()).get("books", id);
}

export async function saveBook(book: BookRecord): Promise<void> {
  await (await db()).put("books", { ...book, updatedAt: Date.now() });
}

export async function updateProgress(id: string, locator: Locator, progress: number): Promise<void> {
  const book = await getBook(id);
  if (!book) return;
  await saveBook({ ...book, locator, progress, updatedAt: Date.now() });
}

export async function deleteBook(id: string): Promise<void> {
  await (await db()).delete("books", id);
}
