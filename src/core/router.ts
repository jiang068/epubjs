import type { Locator } from "../types";

export type AppRoute =
  | { name: "library" }
  | { name: "import" }
  | { name: "settings" }
  | { name: "open"; query: URLSearchParams }
  | { name: "reader"; bookId: string; locator?: Locator }
  | { name: "not-found" };

function routeUrl(path: string, query?: URLSearchParams): string {
  const suffix = query?.toString();
  return `#${path}${suffix ? `?${suffix}` : ""}`;
}

export function parseRoute(): AppRoute {
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const [rawPath = "/library", rawQuery = ""] = raw.split("?", 2);
  const path = rawPath || "/library";
  const query = new URLSearchParams(rawQuery);
  if (path === "/" || path === "/library") return { name: "library" };
  if (path === "/import") return { name: "import" };
  if (path === "/settings") return { name: "settings" };
  if (path === "/open") return { name: "open", query };
  if (path.startsWith("/read/")) {
    const encodedId = path.slice("/read/".length);
    if (!encodedId) return { name: "not-found" };
    const kind = query.get("kind");
    const page = Number(query.get("page"));
    const percent = Number(query.get("progress"));
    const locator: Locator | undefined = kind ? {
      kind: kind as Locator["kind"],
      page: Number.isFinite(page) && page > 0 ? page : undefined,
      cfi: query.get("cfi") || undefined,
      href: query.get("href") || undefined,
      percent: Number.isFinite(percent) ? percent : undefined
    } : undefined;
    return { name: "reader", bookId: decodeURIComponent(encodedId), locator };
  }
  return { name: "not-found" };
}

export function navigate(path: string, query?: URLSearchParams, replace = false): void {
  const next = routeUrl(path, query);
  if (replace) {
    history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else if (location.hash === next) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = next;
  }
}

export function readerPath(bookId: string): string {
  return `/read/${encodeURIComponent(bookId)}`;
}

export function replaceReaderLocation(bookId: string, locator: Locator): void {
  const query = new URLSearchParams({ kind: locator.kind });
  if (locator.page) query.set("page", String(locator.page));
  if (locator.cfi) query.set("cfi", locator.cfi);
  if (locator.href) query.set("href", locator.href);
  if (typeof locator.percent === "number") query.set("progress", locator.percent.toFixed(4));
  const next = routeUrl(readerPath(bookId), query);
  history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
}

export function startRouter(render: (route: AppRoute) => void): () => void {
  const onChange = () => render(parseRoute());
  window.addEventListener("hashchange", onChange);
  if (!location.hash) navigate("/library", undefined, true);
  else onChange();
  return () => window.removeEventListener("hashchange", onChange);
}
