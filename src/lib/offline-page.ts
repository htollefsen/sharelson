import { fetch } from "expo/fetch";
import { Directory, File, Paths } from "expo-file-system";

/**
 * Builds a self-contained offline copy of a web page: the HTML with stylesheets, images and
 * fonts inlined as data URIs, scripts removed, and remaining links made absolute so they still
 * work when the page is opened later from Drive.
 *
 * This is a plain HTML fetch, not a rendered browser snapshot, so pages that draw all their
 * content with JavaScript will save with little more than their shell.
 */

const LIMITS = {
  pageBytes: 15 * 1024 * 1024, // refuse pages whose HTML alone is bigger than this
  fileBytes: 100 * 1024 * 1024, // refuse linked files (PDFs etc.) bigger than this
  assetBytes: 4 * 1024 * 1024, // skip a single asset bigger than this
  totalAssetBytes: 40 * 1024 * 1024, // stop inlining once this much has been embedded
  maxAssets: 300,
  concurrency: 4,
  fetchTimeoutMs: 20_000,
  retries: 2, // extra attempts on 429/503 or network errors, with backoff
  maxRetryDelayMs: 4_000, // cap on Retry-After / backoff waits
  assetBudgetMs: 60_000, // stop fetching assets after this long; the rest stay as web links
};

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36 Sharelsen/1.0";

export type OfflinePage = {
  kind: "page";
  title: string;
  fileName: string;
  html: string;
  sourceUrl: string;
  finalUrl: string;
  inlinedAssets: number;
  skippedAssets: number;
};

/** A link that points straight at a file (PDF, image, video), downloaded to the app cache. */
export type LinkedFile = {
  kind: "file";
  uri: string;
  fileName: string;
  mimeType: string;
  size: number;
  finalUrl: string;
};

export type SavedLink = OfflinePage | LinkedFile;

export class PageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageError";
  }
}

// ---------------------------------------------------------------------------------------------
// Fetch helpers

async function fetchWithTimeout(url: string, referer?: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.fetchTimeoutMs);
  try {
    return (await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9,nb;q=0.8",
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: "follow",
      signal: controller.signal,
    })) as unknown as Response;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Hosts that answered 429 get their remaining requests serialised with a small gap, which
 * is what most rate limiters want, instead of hammering them in parallel.
 */
const throttledHosts = new Map<string, Promise<void>>();
const THROTTLE_GAP_MS = 250;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function throttleIfNeeded(url: string): Promise<void> {
  const host = hostOf(url);
  const queue = throttledHosts.get(host);
  if (!queue) return;
  const mine = queue.then(() => sleep(THROTTLE_GAP_MS));
  throttledHosts.set(host, mine.catch(() => undefined));
  await mine;
}

function markThrottled(url: string): void {
  const host = hostOf(url);
  if (!throttledHosts.has(host)) throttledHosts.set(host, Promise.resolve());
}

/**
 * Fetch with retries for rate limiting (429), temporary errors (5xx) and network failures.
 * Gives up once `deadline` (epoch ms) has passed so a throttling CDN can't stall the save.
 */
async function fetchAsset(url: string, referer: string | undefined, deadline: number): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= LIMITS.retries; attempt++) {
    if (Date.now() > deadline) break;
    let delay = Math.min(LIMITS.maxRetryDelayMs, 800 * 2 ** attempt);
    try {
      await throttleIfNeeded(url);
      const res = await fetchWithTimeout(url, referer);
      if (res.ok || (res.status !== 429 && res.status < 500)) return res;
      if (res.status === 429) markThrottled(url);
      lastError = new Error(`HTTP ${res.status}`);
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) delay = Math.min(LIMITS.maxRetryDelayMs, retryAfter * 1000);
    } catch (e) {
      lastError = e;
    }
    if (attempt < LIMITS.retries && Date.now() + delay < deadline) await sleep(delay);
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out fetching ${url}`);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + "=";
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// URL helpers

function resolveUrl(base: string, ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed || /^(data|blob|javascript|mailto|tel|about):/i.test(trimmed) || trimmed.startsWith("#")) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function getAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, "i");
  if (re.test(tag)) return tag.replace(re, `$1"${escapeAttr(value)}"`);
  return tag.replace(/\/?>$/, (end) => ` ${name}="${escapeAttr(value)}"${end}`);
}

function removeAttr(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, "gi"), "");
}

// ---------------------------------------------------------------------------------------------
// Asset inlining

class AssetInliner {
  private cache = new Map<string, Promise<string | null>>();
  private embeddedBytes = 0;
  inlined = 0;
  skipped = 0;

  constructor(
    private referer: string,
    private deadline: number,
    private onProgress?: (done: number, total: number) => void,
  ) {}

  /** Returns a data: URI for the asset, or null if it can't or shouldn't be inlined. */
  dataUri(url: string, cssContext = false): Promise<string | null> {
    let pending = this.cache.get(url);
    if (!pending) {
      pending = this.load(url, cssContext);
      this.cache.set(url, pending);
    }
    return pending;
  }

  private async load(url: string, cssContext: boolean): Promise<string | null> {
    if (this.cache.size > LIMITS.maxAssets || this.embeddedBytes > LIMITS.totalAssetBytes || Date.now() > this.deadline) {
      this.skipped++;
      return null;
    }
    try {
      const res = await fetchAsset(url, this.referer, this.deadline);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
      if (type.startsWith("text/css")) {
        // Nested stylesheet (an @import): inline its own url() references too.
        const css = await this.inlineCssUrls(await res.text(), url);
        this.inlined++;
        return `data:text/css;base64,${toBase64(new TextEncoder().encode(css))}`;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > LIMITS.assetBytes) throw new Error("asset too large");
      this.embeddedBytes += bytes.byteLength;
      this.inlined++;
      return `data:${type};base64,${toBase64(bytes)}`;
    } catch {
      this.skipped++;
      return null;
    } finally {
      if (!cssContext) this.onProgress?.(this.inlined + this.skipped, this.cache.size);
    }
  }

  /** Rewrites url(...) and @import references inside CSS to data URIs. */
  async inlineCssUrls(css: string, baseUrl: string): Promise<string> {
    const refs = new Map<string, string>(); // raw match → resolved url
    const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi;
    for (const m of css.matchAll(urlRe)) {
      const resolved = resolveUrl(baseUrl, m[1] ?? m[2] ?? m[3] ?? "");
      if (resolved) refs.set(m[0], resolved);
    }
    const importRe = /@import\s+(?:"([^"]*)"|'([^']*)')\s*([^;]*);/gi;
    for (const m of css.matchAll(importRe)) {
      const resolved = resolveUrl(baseUrl, m[1] ?? m[2] ?? "");
      if (resolved) refs.set(m[0], resolved);
    }
    const replacements = new Map<string, string>();
    await this.mapLimit([...refs.entries()], async ([raw, resolved]) => {
      const data = await this.dataUri(resolved, true);
      if (!data) return;
      replacements.set(raw, raw.startsWith("@import") ? `@import url("${data}")${raw.match(/\)\s*([^;]*);$/)?.[1] ? " " + raw.match(/\)\s*([^;]*);$/)![1] : ""};` : `url("${data}")`);
    });
    if (replacements.size === 0) return css;
    return css.replace(/@import\s+(?:"[^"]*"|'[^']*')\s*[^;]*;|url\(\s*(?:"[^"]*"|'[^']*'|[^)"']*)\s*\)/gi, (m) => replacements.get(m) ?? m);
  }

  async mapLimit<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(LIMITS.concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    });
    await Promise.all(workers);
  }
}

// ---------------------------------------------------------------------------------------------
// Page assembly

function safeFileName(title: string, url: string): string {
  const base = (title || new URL(url).hostname + new URL(url).pathname)
    .replace(/[\\/:*?"<>| -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "page"}.html`;
}

export type PageProgress = { stage: "page" | "assets" | "file"; done?: number; total?: number };

/** Content types that are uploaded as the file itself rather than saved as an offline page. */
const DIRECT_FILE_TYPES = /^(application\/pdf|image\/|video\/)/;

const EXTENSION_FOR: Record<string, string> = { "application/pdf": ".pdf" };

/** File name from Content-Disposition, else the last URL path segment, else the type's default. */
function linkedFileName(res: Response, url: string, mimeType: string): string {
  const disposition = res.headers.get("content-disposition") || "";
  const star = disposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/);
  const plain = disposition.match(/filename\s*=\s*(?:"([^"]*)"|([^;]+))/);
  let name = "";
  if (star) {
    try {
      name = decodeURIComponent(star[1].trim());
    } catch {
      name = star[1].trim();
    }
  } else if (plain) {
    name = (plain[1] ?? plain[2]).trim();
  }
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
    } catch {
      name = "";
    }
  }
  name = name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  const ext = EXTENSION_FOR[mimeType] ?? "";
  if (!name) name = `file${ext}`;
  else if (ext && !name.toLowerCase().endsWith(ext)) name += ext;
  return name;
}

/** Downloads the response body to the app cache and describes it for upload. */
async function saveLinkedFile(res: Response, finalUrl: string, mimeType: string): Promise<LinkedFile> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > LIMITS.fileBytes) throw new PageError("The file is too large to save");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > LIMITS.fileBytes) throw new PageError("The file is too large to save");
  const fileName = linkedFileName(res, finalUrl, mimeType);
  const dir = new Directory(Paths.cache, "sharelsen-files");
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, `${Date.now()}-${fileName}`);
  file.write(bytes);
  return { kind: "file", uri: file.uri, fileName, mimeType, size: bytes.byteLength, finalUrl };
}

/**
 * Fetches a shared link. Links to a PDF, image or video are downloaded as that file; anything
 * else must be an HTML page, which is turned into a self-contained offline copy.
 */
export async function saveLink(sourceUrl: string, onProgress?: (p: PageProgress) => void): Promise<SavedLink> {
  onProgress?.({ stage: "page" });
  const deadline = Date.now() + LIMITS.assetBudgetMs;
  let res: Response;
  try {
    res = await fetchAsset(sourceUrl, undefined, deadline);
  } catch (e) {
    throw new PageError(`The page could not be loaded (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!res.ok) throw new PageError(`The page could not be loaded (HTTP ${res.status})`);
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const finalUrl = res.url || sourceUrl;
  if (DIRECT_FILE_TYPES.test(contentType)) {
    onProgress?.({ stage: "file" });
    return saveLinkedFile(res, finalUrl, contentType);
  }
  if (contentType && !/html|xml/.test(contentType)) {
    throw new PageError(`That link is not a web page (${contentType})`);
  }
  let html = await res.text();
  if (html.length > LIMITS.pageBytes) throw new PageError("The page is too large to save");
  return buildOfflinePage(html, sourceUrl, finalUrl, deadline, onProgress);
}

async function buildOfflinePage(
  html: string,
  sourceUrl: string,
  finalUrl: string,
  deadline: number,
  onProgress?: (p: PageProgress) => void,
): Promise<OfflinePage> {

  // Base URL for relative references: <base href> wins over the final URL.
  const baseTag = html.match(/<base\s[^>]*>/i)?.[0];
  const baseHref = baseTag ? getAttr(baseTag, "href") : null;
  const baseUrl = (baseHref && resolveUrl(finalUrl, baseHref)) || finalUrl;

  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();

  // Scripts can't run meaningfully offline and often break the saved page; drop them along with
  // inline event handlers and the <base> tag (everything is made absolute below).
  html = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<noscript\b[^>]*>|<\/noscript\s*>/gi, "")
    .replace(/<base\s[^>]*>/gi, "")
    .replace(/<link\b[^>]*rel\s*=\s*["']?(?:preload|prefetch|modulepreload|dns-prefetch|preconnect|manifest)["']?[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi, "");

  const inliner = new AssetInliner(finalUrl, deadline, (done, total) => onProgress?.({ stage: "assets", done, total }));

  // Every tag we may rewrite, matched in one pass. Transforms are collected per unique tag
  // string, applied in sequence, and substituted back in a single replace at the end, so the
  // cost stays linear in the page size even for pages with thousands of links.
  const EDITABLE =
    /<style\b[^>]*>[\s\S]*?<\/style\s*>|<(?:link|img|source|video|audio|input|embed|a|area|form)\b[^>]*>|<[a-z][^>]*\sstyle\s*=\s*"[^"]*url\([^"]*"[^>]*>/gi;
  type Transform = (tag: string) => Promise<string>;
  const edits = new Map<string, Transform[]>();
  const addEdit = (raw: string, fn: Transform) => {
    const list = edits.get(raw);
    if (list) list.push(fn);
    else edits.set(raw, [fn]);
  };

  for (const raw of new Set([...html.matchAll(EDITABLE)].map((m) => m[0]))) {
    const lower = raw.slice(0, 8).toLowerCase();

    if (lower.startsWith("<style")) {
      addEdit(raw, async (tag) => {
        const css = tag.match(/^<style\b[^>]*>([\s\S]*?)<\/style\s*>$/i)?.[1];
        return css ? tag.replace(css, await inliner.inlineCssUrls(css, baseUrl)) : tag;
      });
      continue;
    }

    // Inline style attributes with url(...) references, on any element.
    if (/\sstyle\s*=\s*"[^"]*url\(/i.test(raw)) {
      addEdit(raw, async (tag) => {
        const style = getAttr(tag, "style");
        return style ? setAttr(tag, "style", await inliner.inlineCssUrls(style, baseUrl)) : tag;
      });
    }

    if (lower.startsWith("<link")) {
      const rel = (getAttr(raw, "rel") || "").toLowerCase();
      const href = getAttr(raw, "href");
      const resolved = href ? resolveUrl(baseUrl, href) : null;
      if (!resolved) continue;
      if (rel.split(/\s+/).includes("stylesheet")) {
        addEdit(raw, async (tag) => {
          try {
            const r = await fetchAsset(resolved, finalUrl, deadline);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const css = await inliner.inlineCssUrls(await r.text(), resolved);
            inliner.inlined++;
            const media = getAttr(tag, "media");
            return `<style${media ? ` media="${escapeAttr(media)}"` : ""}>\n${css}\n</style>`;
          } catch {
            inliner.skipped++;
            return "";
          }
        });
      } else if (rel.includes("icon")) {
        addEdit(raw, async (tag) => {
          const data = await inliner.dataUri(resolved);
          return data ? setAttr(tag, "href", data) : "";
        });
      } else {
        addEdit(raw, async (tag) => setAttr(tag, "href", resolved));
      }
    } else if (/^<(?:img|source|video|audio|input|embed)\b/i.test(raw)) {
      addEdit(raw, async (tag) => {
        let out = removeAttr(removeAttr(tag, "srcset"), "loading");
        for (const attr of ["src", "poster", "data-src"]) {
          const v = getAttr(out, attr);
          const resolved = v ? resolveUrl(baseUrl, v) : null;
          if (!resolved) continue;
          const data = await inliner.dataUri(resolved);
          out = setAttr(out, attr, data ?? resolved);
          if (attr === "data-src" && data) out = setAttr(out, "src", data);
        }
        return out;
      });
    } else if (/^<(?:a|area|form)\b/i.test(raw)) {
      // Make links and form targets absolute so they still point at the live site.
      const attr = lower.startsWith("<form") ? "action" : "href";
      const v = getAttr(raw, attr);
      const resolved = v ? resolveUrl(baseUrl, v) : null;
      if (resolved && resolved !== v) addEdit(raw, async (tag) => setAttr(tag, attr, resolved));
    }
  }

  // Run the transforms (asset fetches inside use limited concurrency), then substitute once.
  const results = new Map<string, string>();
  await inliner.mapLimit([...edits], async ([raw, fns]) => {
    let out = raw;
    for (const fn of fns) out = await fn(out);
    results.set(raw, out);
  });
  html = html.replace(EDITABLE, (m) => results.get(m) ?? m);

  // Provenance note and charset, right after <head> (or at the top if there is none).
  const savedAt = new Date().toISOString();
  const note =
    `<meta charset="utf-8">` +
    `<meta name="sharelsen-source" content="${escapeAttr(finalUrl)}">` +
    `<meta name="sharelsen-saved" content="${savedAt}">` +
    `<!-- Saved offline by Sharelsen from ${escapeAttr(finalUrl)} on ${savedAt}. Scripts removed; assets inlined. -->`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + note) : note + html;
  if (!/<!doctype/i.test(html)) html = "<!DOCTYPE html>\n" + html;

  return {
    kind: "page",
    title,
    fileName: safeFileName(title, finalUrl),
    html,
    sourceUrl,
    finalUrl,
    inlinedAssets: inliner.inlined,
    skippedAssets: inliner.skipped,
  };
}

/** Writes the page to the app cache and returns the file's URI. */
export function saveOfflinePage(page: OfflinePage): string {
  const dir = new Directory(Paths.cache, "sharelsen-pages");
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, `${Date.now()}-${page.fileName}`);
  file.write(page.html);
  return file.uri;
}
