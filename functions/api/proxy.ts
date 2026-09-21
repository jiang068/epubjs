type PagesContext = {
  request: Request;
  env: Record<string, unknown>;
};

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

export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (context.request.method !== "GET" && context.request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
  const incoming = new URL(context.request.url);
  const rawTarget = incoming.searchParams.get("url");
  if (!rawTarget) return new Response("Missing url", { status: 400, headers: corsHeaders() });
  let target: URL;
  try { target = new URL(rawTarget); } catch { return new Response("Invalid url", { status: 400, headers: corsHeaders() }); }
  if (!["http:", "https:"].includes(target.protocol) || !allowedHost(target.hostname, context.env.READER_PROXY_ALLOWLIST)) {
    return new Response("Host is not allowlisted", { status: 403, headers: corsHeaders() });
  }
  const requestHeaders = new Headers();
  for (const name of ["range", "if-range", "if-modified-since", "if-none-match"]) {
    const value = context.request.headers.get(name);
    if (value) requestHeaders.set(name, value);
  }
  const upstream = await fetch(target.toString(), { method: context.request.method, headers: requestHeaders, redirect: "follow", cache: "no-store" });
  const headers = corsHeaders();
  for (const name of ["accept-ranges", "content-length", "content-range", "content-type", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("CDN-Cache-Control", "no-store");
  return new Response(context.request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
}
