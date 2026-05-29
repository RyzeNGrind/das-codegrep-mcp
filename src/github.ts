#!/usr/bin/env node
/**
 * das-codegrep-mcp — GitHub remote search backend  v0.4.0
 * ─────────────────────────────────────────────────────────
 * Pure typed helper module — no MCP SDK imports here.
 *
 * Env vars:
 *   DAS_GH_TOKEN          GitHub PAT (classic or fine-grained, read:user + public_repo)
 *   DAS_GH_USER           GitHub login (e.g. RyzeNGrind)
 *   DAS_GH_STARRED_CACHE  Override path for starred cache JSON
 *   DAS_GH_STARRED_TTL_H  Cache TTL in hours (default 6)
 *
 * v0.4.0 patch summary:
 *   FIX-1  RateLimitGate.refill() checks resetAt before refilling
 *   FIX-2  restoreAfterSleep() called after withRetry sleeps reset window
 *   FIX-3  Partial cache always flushed on last batch (not only on modulo)
 *   FIX-4  RateLimitGate fields tokens/lastRefill/cap promoted to public
 *   FIX-5  Batch catch: in-place WAIT+RETRY (MAX_BATCH_RETRY) before skipping
 *   OPT-1  RATE_BUCKET_CAP raised 8→9 (GH limit 10/min, 1 hard reserve)
 *   OPT-2  FLUSH_EVERY_N_BATCH lowered 3→2
 *   OPT-3  rateLimitBanner prints local time alongside UTC
 *   OPT-4  Stale partials (>2h) auto-discarded on load
 *   OPT-5  ≥80% partial cache coverage → fast-path return without API calls
 */

import axios, { AxiosInstance, AxiosError } from "axios";
import * as fs   from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GhCodeHit {
  repo:         string;
  path:         string;
  url:          string;
  score:        number;
  textMatches?: GhTextMatch[];
}

export interface GhTextMatch {
  fragment: string;
  matches:  Array<{ text: string; indices: [number, number] }>;
}

export interface StarredRepo {
  full_name:        string;
  language:         string | null;
  description:      string | null;
  stargazers_count: number;
  html_url:         string;
  updated_at:       string;
}

export interface StarredCache {
  fetchedAt: string;
  repos:     StarredRepo[];
  partial?:  boolean;
}

export type GhSearchScope = "global" | "user" | "repo" | "starred";

export interface GhSearchOpts {
  language?: string;
  scope?:    GhSearchScope;
  repos?:    string[];
  limit?:    number;
}

export interface StarredSearchResult {
  hits:           GhCodeHit[];
  reposSearched:  number;
  fromCache:      boolean;
  partialError?:  string;
  rateLimitInfo?: RateLimitInfo;
}

export interface RateLimitInfo {
  resetAt:    string;
  resetHuman: string;
  remaining:  number;
  limit:      number;
}

interface PartialSearchCache {
  query:     string;
  language:  string | undefined;
  hits:      GhCodeHit[];
  repos:     string[];
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const DATA_DIR =
  process.env.DAS_INDEX_DIR
    ? path.dirname(process.env.DAS_INDEX_DIR)
    : path.join(process.env.HOME ?? "/tmp", ".local", "share", "das-codegrep-mcp");

const STARRED_CACHE_PATH =
  process.env.DAS_GH_STARRED_CACHE ??
  path.join(DATA_DIR, "starred.json");

const STARRED_CACHE_TTL_MS =
  parseInt(process.env.DAS_GH_STARRED_TTL_H ?? "6") * 3_600_000;

// GitHub authenticated code search: 10 req/min hard ceiling.
// 9 tokens/min (1 hard reserve) → 1 token every 6667 ms.
const RATE_BUCKET_CAP     = 9;         // OPT-1
const RATE_REFILL_MS      = 6_667;
const REPOS_PER_QUERY     = 5;
const RETRY_ATTEMPTS      = 4;
const MAX_BATCH_RETRY     = 2;         // FIX-5
const PER_PAGE_STARRED    = 100;
const PER_PAGE_CODE       = 30;
const FLUSH_EVERY_N_BATCH = 2;         // OPT-2
const PARTIAL_CACHE_MAX_AGE_MS = 2 * 3_600_000; // OPT-4: 2h

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function progress(msg: string): void {
  process.stderr.write(`[das-codegrep-mcp] ${msg}\n`);
}

function humanMs(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** OPT-3: shows UTC + local time in the banner */
function rateLimitBanner(resetAt: Date | null, waitMs: number, context: string): string {
  const now      = new Date(Date.now() + waitMs);
  const utcIso   = (resetAt ?? now).toISOString();
  const localStr = (resetAt ?? now).toLocaleTimeString("en-US", {
    hour12: false, timeZoneName: "short",
  });
  const human  = humanMs(waitMs);
  const pad    = (s: string) => s.slice(0, 48).padEnd(48);
  return [
    "",
    "╔══════════════════════════════════════════════════════════════╗",
    "║  ⏸  GITHUB RATE LIMIT — GATE PAUSING                       ║",
    `║  Context : ${pad(context)} ║`,
    `║  Reset   : ${pad(utcIso)} ║`,
    `║  Local   : ${pad(localStr)} ║`,
    `║  Wait    : ${pad(human)} ║`,
    "╚══════════════════════════════════════════════════════════════╝",
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// RateLimitGate  (FIX-1, FIX-2, FIX-4)
// ─────────────────────────────────────────────────────────────────────────────

class RateLimitGate {
  public  tokens:     number;
  public  lastRefill: number;
  public  cap:        number;
  public  resetAt:    Date | null = null;
  public  remaining:  number      = RATE_BUCKET_CAP;
  public  limit:      number      = 10;

  constructor(capArg: number, private refillMs: number) {
    this.cap        = capArg;
    this.tokens     = capArg;
    this.lastRefill = Date.now();
  }

  /** FIX-1: do not refill while inside an active 429/403 window */
  private refill(): void {
    const now = Date.now();
    if (this.resetAt) {
      if (now < this.resetAt.getTime()) return; // window still active
      // window passed — full restore
      this.tokens     = this.cap;
      this.resetAt    = null;
      this.lastRefill = now;
      return;
    }
    const added = Math.floor((now - this.lastRefill) / this.refillMs);
    if (added > 0) {
      this.tokens     = Math.min(this.cap, this.tokens + added);
      this.lastRefill = now;
    }
  }

  async acquire(context = ""): Promise<void> {
    this.refill();
    if (this.tokens > 0) { this.tokens--; return; }
    const wait = this.resetAt
      ? Math.max(0, this.resetAt.getTime() - Date.now()) + 200
      : this.refillMs - (Date.now() - this.lastRefill) + 100;
    progress(rateLimitBanner(this.resetAt, wait, context || "token-bucket empty"));
    await sleep(wait);
    this.refill();
    if (this.tokens === 0) this.tokens = 1;
    this.tokens--;
  }

  notifyRateLimit(headers: Record<string, string | undefined>): number {
    const resetSec   = headers["x-ratelimit-reset"];
    const retryAfter = headers["retry-after"];
    this.remaining   = parseInt(headers["x-ratelimit-remaining"] ?? "0");
    this.limit       = parseInt(headers["x-ratelimit-limit"]     ?? "10");
    let waitMs: number;
    if (retryAfter) {
      waitMs = parseInt(retryAfter) * 1000 + 500;
    } else if (resetSec) {
      this.resetAt = new Date(parseInt(resetSec) * 1000);
      waitMs = Math.max(1000, this.resetAt.getTime() - Date.now()) + 500;
    } else {
      this.resetAt = new Date(Date.now() + 60_000);
      waitMs = 60_500;
    }
    this.tokens = 0;
    return waitMs;
  }

  /** FIX-2: called after withRetry sleeps the full reset window */
  restoreAfterSleep(): void {
    this.tokens     = this.cap;
    this.resetAt    = null;
    this.lastRefill = Date.now();
  }

  status(): RateLimitInfo | null {
    if (!this.resetAt) return null;
    const waitMs = Math.max(0, this.resetAt.getTime() - Date.now());
    return {
      resetAt:    this.resetAt.toISOString(),
      resetHuman: humanMs(waitMs),
      remaining:  this.remaining,
      limit:      this.limit,
    };
  }
}

export const rateLimitGate = new RateLimitGate(RATE_BUCKET_CAP, RATE_REFILL_MS);

// ─────────────────────────────────────────────────────────────────────────────
// Axios factory
// ─────────────────────────────────────────────────────────────────────────────

function makeClient(): AxiosInstance {
  const token = process.env.DAS_GH_TOKEN;
  if (!token) throw new Error(
    "DAS_GH_TOKEN not set. Export a GitHub PAT with read:user + public_repo scopes."
  );
  return axios.create({
    baseURL: "https://api.github.com",
    headers: {
      Authorization:        `Bearer ${token}`,
      Accept:               "application/vnd.github.v3.text-match+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    timeout: 15_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// withRetry  (FIX-2)
// ─────────────────────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn:      () => Promise<T>,
  context: string,
  attempts = RETRY_ATTEMPTS,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const e = err as AxiosError;
      const status = e.response?.status ?? 0;
      if (status === 429 || status === 403) {
        const headers = Object.fromEntries(
          Object.entries(e.response?.headers ?? {}).map(([k, v]) => [k, String(v)])
        ) as Record<string, string | undefined>;
        const waitMs = rateLimitGate.notifyRateLimit(headers);
        progress(rateLimitBanner(rateLimitGate.resetAt, waitMs,
          `${context} | attempt ${i + 1}/${attempts}`));
        await sleep(waitMs);
        // FIX-2: restore bucket so next acquire() fires immediately
        rateLimitGate.restoreAfterSleep();
        continue;
      }
      if (status >= 500 || status === 0) {
        const backoff = 1000 * Math.pow(2, i);
        progress(`  withRetry: ${context} → ${status} — backoff ${humanMs(backoff)}`);
        await sleep(backoff);
        continue;
      }
      throw err; // 4xx non-rate-limit — unrecoverable
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Starred cache helpers
// ─────────────────────────────────────────────────────────────────────────────

export function loadStarredCache(): StarredCache | null {
  try {
    if (!fs.existsSync(STARRED_CACHE_PATH)) return null;
    const raw  = fs.readFileSync(STARRED_CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as StarredCache;
    const age  = Date.now() - new Date(data.fetchedAt).getTime();
    if (age > STARRED_CACHE_TTL_MS) return null;
    return data;
  } catch { return null; }
}

export function peekStarredCache(): { count: number; fetchedAt: string; partial: boolean } | null {
  try {
    if (!fs.existsSync(STARRED_CACHE_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(STARRED_CACHE_PATH, "utf-8")) as StarredCache;
    return { count: data.repos.length, fetchedAt: data.fetchedAt, partial: data.partial ?? false };
  } catch { return null; }
}

function writeStarredCache(data: StarredCache): void {
  fs.mkdirSync(path.dirname(STARRED_CACHE_PATH), { recursive: true });
  fs.writeFileSync(STARRED_CACHE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// starredCacheRefresh — page through /user/starred
// ─────────────────────────────────────────────────────────────────────────────

export async function starredCacheRefresh(): Promise<StarredCache> {
  const client = makeClient();
  const repos: StarredRepo[] = [];
  let page = 1;
  let done = false;

  while (!done) {
    await rateLimitGate.acquire(`refresh_starred page ${page}`);
    const resp = await withRetry(
      () => client.get("/user/starred", {
        params: { per_page: PER_PAGE_STARRED, page },
      }),
      `refresh_starred page ${page}`,
    );
    const batch: StarredRepo[] = (resp.data ?? []).map((r: any) => ({
      full_name:        r.full_name,
      language:         r.language  ?? null,
      description:      r.description ?? null,
      stargazers_count: r.stargazers_count ?? 0,
      html_url:         r.html_url,
      updated_at:       r.updated_at,
    }));
    repos.push(...batch);
    progress(`  refresh_starred: page ${page} → ${batch.length} repos (total ${repos.length})`);
    if (batch.length < PER_PAGE_STARRED) done = true;
    else page++;
  }

  const cache: StarredCache = { fetchedAt: new Date().toISOString(), repos };
  writeStarredCache(cache);
  progress(`  refresh_starred: wrote ${repos.length} repos to ${STARRED_CACHE_PATH}`);
  return cache;
}

// ─────────────────────────────────────────────────────────────────────────────
// Partial search cache helpers  (FIX-3, OPT-4)
// ─────────────────────────────────────────────────────────────────────────────

function partialCachePath(query: string, language: string | undefined): string {
  const slug = (query + (language ?? "")).replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
  return path.join(DATA_DIR, `partial_${slug}.json`);
}

function loadPartialSearchCache(
  query: string, language: string | undefined
): PartialSearchCache | null {
  try {
    const p = partialCachePath(query, language);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as PartialSearchCache;
    // OPT-4: discard stale partials
    const ageMs = Date.now() - new Date(data.updatedAt).getTime();
    if (ageMs > PARTIAL_CACHE_MAX_AGE_MS) {
      fs.unlinkSync(p);
      progress(`  partial cache discarded (age ${humanMs(ageMs)} > 2h): ${p}`);
      return null;
    }
    return data;
  } catch { return null; }
}

function writePartialSearchCache(data: PartialSearchCache): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(partialCachePath(data.query, data.language), JSON.stringify(data), "utf-8");
  } catch { /* non-fatal */ }
}

function clearPartialSearchCache(query: string, language: string | undefined): void {
  try {
    const p = partialCachePath(query, language);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// ghCodeSearch — single REST call, rate-gated
// ─────────────────────────────────────────────────────────────────────────────

export async function ghCodeSearch(
  query: string,
  opts:  GhSearchOpts = {},
): Promise<GhCodeHit[]> {
  const { language, scope = "global", repos = [], limit = PER_PAGE_CODE } = opts;
  const client = makeClient();

  let q = query;
  if (language) q += ` language:${language}`;
  if (scope === "user") {
    const user = process.env.DAS_GH_USER;
    if (user) q += ` user:${user}`;
  } else if ((scope === "repo" || scope === "starred") && repos.length) {
    q += " " + repos.map(r => `repo:${r}`).join(" ");
  }

  await rateLimitGate.acquire(`ghCodeSearch: ${q.slice(0, 60)}`);

  const resp = await withRetry(
    () => client.get("/search/code", {
      params: { q, per_page: Math.min(limit, 100) },
    }),
    `ghCodeSearch: ${q.slice(0, 60)}`,
  );

  return (resp.data.items ?? []).map((it: any): GhCodeHit => ({
    repo:         it.repository.full_name,
    path:         it.path,
    url:          it.html_url,
    score:        it.score,
    textMatches:  (it.text_matches ?? []).map((tm: any): GhTextMatch => ({
      fragment: tm.fragment ?? "",
      matches:  (tm.matches ?? []).map((m: any) => ({
        text:    m.text,
        indices: m.indices as [number, number],
      })),
    })),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// searchStarredCode  (FIX-3, FIX-5, OPT-5)
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchStarredOpts {
  language?:     string;
  limitPerRepo?: number;
  maxRepos?:     number;
}

export async function searchStarredCode(
  query: string,
  opts:  SearchStarredOpts = {},
): Promise<StarredSearchResult> {
  const { language, limitPerRepo = 3, maxRepos = 60 } = opts;
  const cache = loadStarredCache();

  if (!cache) {
    const hits = await ghCodeSearch(query, { language, scope: "user", limit: limitPerRepo * 5 });
    return { hits, reposSearched: 0, fromCache: false };
  }

  let targets: StarredRepo[] = language
    ? cache.repos.filter(r => (r.language ?? "").toLowerCase() === language.toLowerCase())
    : cache.repos;
  targets = targets.slice(0, maxRepos);

  const batches: string[][] = [];
  for (let i = 0; i < targets.length; i += REPOS_PER_QUERY) {
    batches.push(targets.slice(i, i + REPOS_PER_QUERY).map(r => r.full_name));
  }

  progress(
    `searchStarredCode: ${targets.length} repos → ${batches.length} batches ` +
    `(${REPOS_PER_QUERY}/batch, gate=${RATE_BUCKET_CAP} tok/min)`
  );

  // Resume from partial
  const prior = loadPartialSearchCache(query, language);
  const allHits: GhCodeHit[] = prior?.hits ?? [];
  const doneBefore = new Set<string>(prior?.repos ?? []);
  let reposSearched = prior?.repos.length ?? 0;

  // OPT-5: fast-path if ≥80% already cached
  if (prior && doneBefore.size >= Math.ceil(targets.length * 0.8)) {
    progress(`  fast-path: ${doneBefore.size}/${targets.length} repos cached (≥80%) — returning without API calls`);
    return {
      hits:          allHits,
      reposSearched: doneBefore.size,
      fromCache:     true,
      partialError:  doneBefore.size < targets.length
        ? `Partial cache covers ${doneBefore.size}/${targets.length} repos. Re-run to complete.`
        : undefined,
    };
  }

  const rateLimitedBatches: string[] = [];
  let rateLimitInfo: RateLimitInfo | undefined;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const freshBatch = batch.filter(r => !doneBefore.has(r));
    if (!freshBatch.length) {
      progress(`  batch ${bi + 1}/${batches.length}: already cached — skip`);
      continue;
    }
    progress(`  batch ${bi + 1}/${batches.length}: ${freshBatch.join(", ")}`);

    // FIX-5: batch-level retry
    let batchRetry  = 0;
    let batchSuccess = false;
    while (batchRetry <= MAX_BATCH_RETRY && !batchSuccess) {
      try {
        const hits = await ghCodeSearch(query, {
          language,
          scope:  "repo",
          repos:  freshBatch,
          limit:  limitPerRepo * freshBatch.length,
        });
        allHits.push(...hits);
        for (const r of freshBatch) doneBefore.add(r);
        reposSearched += freshBatch.length;
        batchSuccess = true;

        // FIX-3: always flush on last batch
        const isLast = bi + 1 === batches.length;
        if ((bi + 1) % FLUSH_EVERY_N_BATCH === 0 || isLast) {
          writePartialSearchCache({
            query, language, hits: allHits,
            repos: [...doneBefore],
            updatedAt: new Date().toISOString(),
          });
          progress(`  flushed partial (${allHits.length} hits, ${reposSearched} repos${isLast ? " — final" : ""})`);
        }
      } catch (err: unknown) {
        const e = err as AxiosError;
        const s = e.response?.status ?? 0;
        if ((s === 429 || s === 403) && batchRetry < MAX_BATCH_RETRY) {
          batchRetry++;
          const waitMs = rateLimitGate.resetAt
            ? Math.max(0, rateLimitGate.resetAt.getTime() - Date.now()) + 500
            : RATE_REFILL_MS * RATE_BUCKET_CAP;
          rateLimitInfo = rateLimitGate.status() ?? undefined;
          writePartialSearchCache({
            query, language, hits: allHits,
            repos: [...doneBefore],
            updatedAt: new Date().toISOString(),
          });
          progress(rateLimitBanner(rateLimitGate.resetAt, waitMs,
            `batch ${bi + 1}/${batches.length} retry ${batchRetry}/${MAX_BATCH_RETRY}`));
          await sleep(waitMs);
          rateLimitGate.restoreAfterSleep();
          continue;
        }
        // Permanently skip this batch
        rateLimitInfo = rateLimitGate.status() ?? undefined;
        progress(rateLimitBanner(rateLimitGate.resetAt, 0,
          `batch ${bi + 1}/${batches.length} SKIPPED after ${batchRetry} retries`));
        progress(`  batch ${bi + 1} skipped: ${(err as Error).message}`);
        rateLimitedBatches.push(freshBatch.join(", "));
        writePartialSearchCache({
          query, language, hits: allHits,
          repos: [...doneBefore],
          updatedAt: new Date().toISOString(),
        });
        break;
      }
    }
  }

  if (rateLimitedBatches.length === 0) clearPartialSearchCache(query, language);

  const partialError = rateLimitedBatches.length > 0
    ? `Rate-limited: ${rateLimitedBatches.length} batch(es) skipped — ` +
      `${reposSearched}/${targets.length} repos searched. ` +
      (rateLimitInfo
        ? `Reset at **${rateLimitInfo.resetAt}** (in ${rateLimitInfo.resetHuman}). `
        : "") +
      `Re-run to resume from partial cache (${allHits.length} hits preserved).`
    : undefined;

  return { hits: allHits, reposSearched, fromCache: true, partialError, rateLimitInfo };
}

// ─────────────────────────────────────────────────────────────────────────────
// formatGhHits
// ─────────────────────────────────────────────────────────────────────────────

export function formatGhHits(hits: GhCodeHit[], section: string): string {
  if (!hits.length) return `*No results from ${section}.*`;
  return hits.map(h => {
    const snippets = (h.textMatches ?? []).map(tm =>
      `> \`${tm.fragment.split("\n").slice(0, 3).join(" … ").trim().slice(0, 200)}\``
    ).slice(0, 2).join("\n");
    return [
      `**[${h.repo}](https://github.com/${h.repo})** — \`${h.path}\``,
      snippets || "",
      `[View on GitHub](${h.url})`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

export function rateLimitStatus(): RateLimitInfo | null {
  return rateLimitGate.status();
}
