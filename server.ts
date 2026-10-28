// H.F. Hauff site server (Bun). Serves the static build and an optional contact endpoint.
// No secrets live in this repo: RESEND_API_KEY, CONTACT_TO and CONTACT_FROM come from the environment.
import { existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT || 3000);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
  ".pdf": "application/pdf", ".woff2": "font/woff2",
};

// ---------- contact form ----------
export function formEnabled(env = process.env): boolean {
  return Boolean(env.RESEND_API_KEY && env.CONTACT_TO && env.CONTACT_FROM);
}

// Flip the form markup: the HTML ships with the fallback visible and the fields hidden,
// so a static host or a missing key can never show a form that drops submissions.
function applyFormState(html: string): string {
  if (!formEnabled()) return html;
  return html
    .replaceAll('data-form="live" hidden', 'data-form="live"')
    .replaceAll('data-form="fallback"', 'data-form="fallback" hidden');
}

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const hits = new Map<string, number[]>();
function rateLimited(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > RATE_WINDOW_MS) hits.delete(k);
  return recent.length > RATE_MAX;
}

function clientIp(req: Request, server: any): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || server?.requestIP?.(req)?.address || "unknown";
}

const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,24}$/;
function clean(v: FormDataEntryValue | null, max: number, multiline = false): string {
  let s = typeof v === "string" ? v : "";
  s = multiline ? s.replace(/\r\n?/g, "\n") : s.replace(/[\r\n\t]+/g, " ");
  return s.trim().slice(0, max + 1);
}

type Check = { ok: true; data: Record<string, string> } | { ok: false; reason: string };
export function validate(fd: FormData): Check {
  if (clean(fd.get("website"), 500)) return { ok: false, reason: "honeypot" };
  const d = {
    name: clean(fd.get("name"), 100), company: clean(fd.get("company"), 120), email: clean(fd.get("email"), 254),
    phone: clean(fd.get("phone"), 40), comment: clean(fd.get("comment"), 5000, true),
    type: clean(fd.get("type"), 20), source: clean(fd.get("source"), 20),
  };
  if (!d.name || d.name.length > 100) return { ok: false, reason: "name" };
  if (!EMAIL_RE.test(d.email) || d.email.length > 254) return { ok: false, reason: "email" };
  if (d.company.length > 120 || d.phone.length > 40 || d.comment.length > 5000) return { ok: false, reason: "length" };
  if (d.phone && !/^[0-9+().\-\s x]*$/i.test(d.phone)) return { ok: false, reason: "phone" };
  if (!["Quote", "Demo", "Contact"].includes(d.type)) d.type = "Contact";
  if (!["home", "contact"].includes(d.source)) d.source = "unknown";
  return { ok: true, data: d };
}

async function sendViaResend(d: Record<string, string>): Promise<boolean> {
  const to = String(process.env.CONTACT_TO).split(",").map((s) => s.trim()).filter(Boolean);
  const text = [
    `Request type: ${d.type}`, `Name: ${d.name}`, `Company: ${d.company || "-"}`, `Email: ${d.email}`,
    `Phone: ${d.phone || "-"}`, `Form: ${d.source}`, "", d.comment || "(no comment)",
  ].join("\n");
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.CONTACT_FROM, to, reply_to: d.email, subject: `Website ${d.type.toLowerCase()} request from ${d.name}`, text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.error(`contact: resend responded ${r.status}`);
    return r.ok;
  } catch (e) {
    console.error("contact: resend request failed", (e as Error).name);
    return false;
  }
}

// Any failure shows the contact page with the phone/email fallback (never a silent drop).
async function fallbackPage(status: number): Promise<Response> {
  const html = await Bun.file(join(ROOT, "contact.html")).text();
  return new Response(html, { status, headers: { "Content-Type": TYPES[".html"], "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}

async function handleContact(req: Request, server: any): Promise<Response> {
  if (!formEnabled()) return fallbackPage(503);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 20000) return fallbackPage(413);
  let fd: FormData;
  try { fd = await req.formData(); } catch { return fallbackPage(400); }
  const v = validate(fd);
  if (!v.ok && v.reason === "honeypot") { console.warn("contact: honeypot rejected"); return fallbackPage(400); }
  if (rateLimited(clientIp(req, server))) return fallbackPage(429);
  if (!v.ok) return fallbackPage(400);
  const sent = await sendViaResend(v.data);
  if (!sent) return fallbackPage(502);
  return new Response(null, { status: 303, headers: { Location: "/thank-you/", "Cache-Control": "no-store" } });
}

// ---------- indexing (see README-DEPLOY.md) ----------
export function indexingAllowed(req: Request): boolean {
  return false;
}

// ---------- static files ----------
function resolvePath(pathname: string): string | null {
  let p: string;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  if (p.includes("\0") || p.split("/").some((seg) => seg === ".." || seg.startsWith("."))) return null;
  if (p.endsWith("/")) p += "index.html";
  let f = join(ROOT, p);
  if (!f.startsWith(ROOT + "/")) return null;
  if (!extname(f) && existsSync(f + ".html")) f += ".html";
  if (!TYPES[extname(f).toLowerCase()]) return null; // allowlist: never serves server.ts, package.json, etc.
  if (!existsSync(f) || !statSync(f).isFile()) return null;
  return f;
}

async function serveStatic(req: Request, url: URL): Promise<Response> {
  const allowIndex = indexingAllowed(req);
  const headers: Record<string, string> = {};
  if (!allowIndex) headers["X-Robots-Tag"] = "noindex, nofollow";
  if (url.pathname === "/thank-you") return new Response(null, { status: 301, headers: { Location: "/thank-you/" } });
  if (url.pathname === "/robots.txt" && allowIndex) {
    return new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": TYPES[".txt"] } });
  }
  const f = resolvePath(url.pathname);
  if (!f) return new Response("Not found", { status: 404, headers: { ...headers, "X-Robots-Tag": "noindex, nofollow", "Content-Type": TYPES[".txt"] } });
  const ext = extname(f).toLowerCase();
  if (ext === ".html") {
    let html = applyFormState(await Bun.file(f).text());
    if (allowIndex) html = html.replace('<meta name="robots" content="noindex,nofollow">', "");
    const isThanks = f === join(ROOT, "thank-you", "index.html");
    if (isThanks) headers["X-Robots-Tag"] = "noindex"; // always noindex
    return new Response(html, { headers: { ...headers, "Content-Type": TYPES[".html"], "Cache-Control": isThanks ? "no-store" : "public, max-age=600" } });
  }
  return new Response(Bun.file(f), { headers: { ...headers, "Content-Type": TYPES[ext], "Cache-Control": "public, max-age=86400" } });
}

if (import.meta.main) {
  const server = Bun.serve({
    port: PORT,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/api/contact") {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST", "X-Robots-Tag": "noindex, nofollow" } });
        return handleContact(req, srv);
      }
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      return serveStatic(req, url);
    },
  });
  console.log(`hfhauff site on :${server.port} form=${formEnabled() ? "on" : "fallback"}`);
}
