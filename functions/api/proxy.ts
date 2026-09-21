type PagesContext = {
  request: Request;
  env: Record<string, unknown>;
};

const MAX_PROXY_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 45_000;

function corsHeaders(): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Range,If-Range,If-Modified-Since,If-None-Match");
  headers.set("Access-Control-Expose-Headers", "Accept-Ranges,Content-Length,Content-Range,Content-Type,ETag,Last-Modified");
  return headers;
}

function allowedHost(hostname: string, rawAllowlist: unknown): boolean {
  const allowlist = String(rawAllowlist || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return allowlist.includes(hostname.toLowerCase());
}

function isAllowedTarget(target: URL, rawAllowlist: unknown): boolean {
  return ["http:", "https:"].includes(target.protocol) && allowedHost(target.hostname, rawAllowlist);
}

function limitedBody(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        received += result.value.byteLength;
        if (received > MAX_PROXY_BYTES) {
          await reader.cancel("Response exceeds the proxy size limit");
          controller.error(new Error("Upstream response is too large"));
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { void reader.cancel(reason); }
  });
}

export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (context.request.method !== "GET" && context.request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
  const incoming = new URL(context.request.url);
  const rawTarget = incoming.searchParams.get("url");
  if (!rawTarget) return new Response("Missing url", { status: 400, headers: corsHeaders() });
  let target: URL;
  try { target = new URL(rawTarget); } catch { return new Response("Invalid url", { status: 400, headers: corsHeaders() }); }
  if (!isAllowedTarget(target, context.env.READER_PROXY_ALLOWLIST)) {
    return new Response("Host is not allowlisted", { status: 403, headers: corsHeaders() });
  }
  const requestHeaders = new Headers();
  for (const name of ["range", "if-range", "if-modified-since", "if-none-match"]) {
    const value = context.request.headers.get(name);
    if (value) requestHeaders.set(name, value);
  }
  let upstream: Response | undefined;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      upstream = await fetch(target.toString(), { method: context.request.method, headers: requestHeaders, redirect: "manual", cache: "no-store", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
    const location = upstream.headers.get("location");
    if (!location || redirect === MAX_REDIRECTS) return new Response("Too many redirects", { status: 502, headers: corsHeaders() });
    try {
      target = new URL(location, target);
    } catch {
      return new Response("Invalid redirect target", { status: 502, headers: corsHeaders() });
    }
    if (!isAllowedTarget(target, context.env.READER_PROXY_ALLOWLIST)) return new Response("Redirect target is not allowlisted", { status: 403, headers: corsHeaders() });
  }
  if (!upstream) return new Response("Upstream request failed", { status: 502, headers: corsHeaders() });
  const declaredLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_BYTES) return new Response("Upstream response is too large", { status: 413, headers: corsHeaders() });
  const headers = corsHeaders();
  for (const name of ["accept-ranges", "content-length", "content-range", "content-type", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("CDN-Cache-Control", "no-store");
  return new Response(context.request.method === "HEAD" ? null : limitedBody(upstream.body), { status: upstream.status, headers });
}
