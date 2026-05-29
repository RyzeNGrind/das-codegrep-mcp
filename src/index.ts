#!/usr/bin/env node
/**
 * das-codegrep-mcp — Local-first MCP Server v0.4.1
 * ─────────────────────────────────────────────────
 * Transport  : stdio (NixOS-WSL safe)
 * Local      : Zoekt trigram (100% offline)
 * Remote     : GitHub REST code search (PAT via agenix, FLOSS API)
 * Guard      : pre-ingress bad-pattern scanner
 *
 * Tools:
 *   search_code, index_directory, guard_code, guard_file,
 *   search_file, read_file, list_index, purge_index, zoekt_status
 *   search_github_code, refresh_github_starred,
 *   search_github_starred_code, search_everywhere
 *
 * v0.4.1  fix(security): safeResolve path-traversal guard + ReDoS guard
 *         agenix integration: DAS_GH_TOKEN read from /run/agenix/github-pat
 * v0.4.0  github.ts v0.4.0: FIX-1..5 + OPT-1..5
 *         renderRateLimitBlock: local time column added
 * v0.3.0  search_everywhere: partial results + rate-limit banner
 *         all GitHub tools include rate-limit block when gate engaged
 *         partial search cache: re-run resumes from last flush
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import axios   from "axios";
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";

import {
  ghCodeSearch,
  searchStarredCode,
  starredCacheRefresh,
  loadStarredCache,
  peekStarredCache,
  formatGhHits,
  rateLimitStatus,
} from "./github.js";
import type {
  GhCodeHit,
  GhSearchScope,
  StarredSearchResult,
  RateLimitInfo,
} from "./github.js";

const VERSION    = "0.4.1";
const ZOEKT_PORT = parseInt(process.env.ZOEKT_PORT   ?? "6070");
const INDEX_DIR  = process.env.DAS_INDEX_DIR ?? `${process.env.HOME}/.local/share/das-codegrep-mcp/index`;
const WORKSPACE  = process.env.DAS_WORKSPACE ?? process.env.HOME ?? "/tmp";
const ZOEKT_BASE = `http://127.0.0.1:${ZOEKT_PORT}`;

// ─────────────────────────────────────────────────────────────────────────────
// Security: path-traversal guard
// Semgrep: path-join-resolve-traversal — all user-supplied paths go through
// safeResolve before any fs operation.
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical allowed roots. Resolved once at startup. */
const ALLOWED_ROOTS: readonly string[] = Object.freeze([
  path.resolve(WORKSPACE),
  path.resolve(INDEX_DIR),
]);

/**
 * Resolve a user-supplied path and assert it stays within an allowed root.
 * Throws an Error if the resolved path escapes all allowed roots.
 * Extra roots can be appended per call-site if needed.
 */
function safeResolve(userPath: string, ...extraRoots: string[]): string {
  const abs = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(WORKSPACE, userPath);
  const roots = [...ALLOWED_ROOTS, ...extraRoots.map(r => path.resolve(r))];
  const ok = roots.some(
    r => abs === r || abs.startsWith(r + path.sep),
  );
  if (!ok) {
    throw new Error(
      `Path traversal denied: "${abs}" is outside allowed workspace roots.\n` +
      `Allowed: ${roots.join(", ")}`
    );
  }
  return abs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Security: ReDoS guard
// Semgrep: detect-non-literal-regexp — validate user pattern before new RegExp()
// ─────────────────────────────────────────────────────────────────────────────

/** Catastrophic-backtracking patterns: nested quantifiers, e.g. (a+)+, .*.* */
const REDOS_HEURISTIC = /([+*?]\s*[)\]][+*?]|\(.*?[+*].*?\)[+*?]|\.\*\.\*)/;

/**
 * Compile a user-supplied regex pattern safely.
 * Rejects: empty, >200 chars, patterns matching ReDoS heuristic.
 */
function safeRegExp(pattern: string): RegExp {
  if (!pattern || pattern.length > 200)
    throw new Error(`Pattern rejected: must be 1–200 chars (got ${pattern.length}).`);
  if (REDOS_HEURISTIC.test(pattern))
    throw new Error(`Pattern rejected by ReDoS guard: nested quantifiers detected.`);
  return new RegExp(pattern);
}

// ─────────────────────────────────────────────────────────────────────────────
// Query normaliser
// ─────────────────────────────────────────────────────────────────────────────
const LANG_TITLES: Record<string, string> = {
  nix:"Nix", ts:"TypeScript", typescript:"TypeScript",
  js:"JavaScript", javascript:"JavaScript",
  py:"Python",  python:"Python",
  rs:"Rust",    rust:"Rust",
  sh:"Shell",   bash:"Shell",    shell:"Shell",
  go:"Go",      c:"C",           cpp:"C++",
  java:"Java",  rb:"Ruby",       ruby:"Ruby",
  md:"Markdown",markdown:"Markdown",
  json:"JSON",  yaml:"YAML",     toml:"TOML",
  html:"HTML",  css:"CSS",
};

function rewriteQuery(q: string): string {
  let out = q.replace(/\b(?:lang|language):(\S+)/gi, (_m, l) => {
    const key = l.toLowerCase();
    return `lang:${LANG_TITLES[key] ?? l}`;
  });
  out = out.replace(/\bext:(\S+)/gi, (_m, e) =>
    `f:\\.${e.replace(/^\./, "")}$`);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit info block renderer (v0.4.0: local time column)
// ─────────────────────────────────────────────────────────────────────────────
function renderRateLimitBlock(info: RateLimitInfo | null | undefined): string {
  if (!info) return "";
  const localStr = new Date(info.resetAt).toLocaleTimeString("en-US", {
    hour12: false, timeZoneName: "short",
  });
  return [
    "",
    "---",
    "### ⏸ GitHub Rate-Limit Status",
    `| Field | Value |`,
    `|-------|-------|`,
    `| 🕐 Reset at (UTC)    | \`${info.resetAt}\` |`,
    `| 🕐 Reset at (local)  | \`${localStr}\` |`,
    `| ⏳ Reset in           | **${info.resetHuman}** |`,
    `| 📊 Remaining / Limit  | ${info.remaining} / ${info.limit} |`,
    ``,
    `> ⚡ **Re-run after reset to resume from partial cache** — previous results are preserved.`,
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard patterns
// ─────────────────────────────────────────────────────────────────────────────
interface GuardPattern {
  id: string; label: string; severity: "error" | "warn"; regex: RegExp; tip: string;
}

const GUARD: GuardPattern[] = [
  { id:"hardcoded-secret",  label:"Hardcoded secret/token",
    severity:"error",
    regex:/(api[_-]?key|secret|token|password)\s*=\s*["'][^"']{8,}["']/i,
    tip:"Move secrets to env vars or sops-nix / agenix." },
  { id:"eval-exec",         label:"eval() / exec() / execSync()",
    severity:"error",
    regex:/\b(eval|exec|execSync)\s*\(/,
    tip:"Avoid dynamic code execution; use a safe parser or AST." },
  { id:"eval-dollar",       label:"eval $() shell injection",
    severity:"error",
    regex:/eval\s+\$\(/,
    tip:"Never eval shell subshell output." },
  { id:"shell-injection",   label:"Shell injection risk",
    severity:"error",
    regex:/child_process\.exec\s*\(\s*`[^`]*\$\{/,
    tip:"Use execFile() or spawnSync() with arg arrays." },
  { id:"path-traversal",    label:"Path traversal",
    severity:"error",
    regex:/\.\.\/|\.\.\\|path\.join\([^)]*req\./i,
    tip:"Validate and sanitise all user-supplied paths." },
  { id:"todo-fixme",        label:"TODO / FIXME / HACK",
    severity:"warn",
    regex:/\b(TODO|FIXME|HACK|XXX)\b/,
    tip:"Resolve before merging." },
  { id:"console-log",       label:"console.log left in code",
    severity:"warn",
    regex:/console\.log\s*\(/,
    tip:"Replace with structured logging." },
  { id:"nix-ifd",           label:"Nix IFD (import-from-derivation)",
    severity:"warn",
    regex:/import\s+\(.*(?:mkDerivation|runCommand)/,
    tip:"Avoid IFD in flakes; pre-generate or use builtins." },
];

interface GuardHit {
  pattern:  GuardPattern;
  line:     number;
  col:      number;
  snippet:  string;
}

function guardScan(code: string): GuardHit[] {
  const hits: GuardHit[] = [];
  const lines = code.split("\n");
  for (let li = 0; li < lines.length; li++) {
    for (const p of GUARD) {
      const m = p.regex.exec(lines[li]);
      if (m) hits.push({ pattern: p, line: li + 1, col: m.index + 1, snippet: lines[li].trim().slice(0, 120) });
    }
  }
  return hits;
}

function renderGuardHits(hits: GuardHit[], source: string): string {
  if (!hits.length) return `✅ **No issues found** in \`${source}\`.`;
  const errors = hits.filter(h => h.pattern.severity === "error");
  const warns  = hits.filter(h => h.pattern.severity === "warn");
  const header = `🚨 **${errors.length} error(s), ${warns.length} warning(s)** in \`${source}\`\n`;
  const rows = hits.map(h =>
    `| ${h.pattern.severity === "error" ? "🔴" : "🟡"} | L${h.line}:C${h.col} | **${h.pattern.label}** | \`${h.snippet}\` | ${h.pattern.tip} |`
  ).join("\n");
  return header +
    `\n| Sev | Loc | Pattern | Snippet | Tip |\n|-----|-----|---------|---------|-----|\n${rows}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zoekt helpers
// ─────────────────────────────────────────────────────────────────────────────
interface ZoektFile {
  FileName: string;
  Repository: string;
  Branches: string[];
  Language: string;
  LineMatches?: ZoektLineMatch[];
  ChunkMatches?: ZoektChunkMatch[];
}

interface ZoektLineMatch  { Line: string; LineNumber: number; }
interface ZoektChunkMatch { Content: string; Ranges: Array<{ Start: { Line: number } }> }

async function zoektSearch(
  query: string,
  maxResults = 20,
  contextLines = 2,
): Promise<string> {
  try {
    const resp = await axios.post(
      `${ZOEKT_BASE}/search`,
      { Q: query, Opts: { NumContextLines: contextLines, MaxDocDisplayCount: maxResults } },
      { timeout: 10_000 },
    );
    const files: ZoektFile[] = resp.data?.Result?.Files ?? [];
    if (!files.length) return "*No local results.*";
    return files.map(f => {
      const chunks = [
        ...(f.LineMatches ?? []).map(lm =>
          `  L${lm.LineNumber}: ${lm.Line.trim().slice(0, 160)}`
        ),
        ...(f.ChunkMatches ?? []).map(cm =>
          `  L${cm.Ranges[0]?.Start.Line ?? "?"}: ${cm.Content.trim().slice(0, 160)}`
        ),
      ];
      return [
        `**${f.Repository}** — \`${f.FileName}\` (${f.Language})`,
        ...chunks.slice(0, 5),
      ].join("\n");
    }).join("\n\n");
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return `⚠️ Zoekt unavailable: ${msg}\nStart zoekt-webserver: \`zoekt-webserver -index ${INDEX_DIR}\``;
  }
}

function zoektIndex(dir: string): Promise<string> {
  return new Promise(resolve => {
    // safeResolve enforces workspace/index-dir boundary (semgrep: path-traversal)
    let abs: string;
    try { abs = safeResolve(dir); } catch (e) {
      resolve(`❌ ${(e as Error).message}`); return;
    }
    if (!fs.existsSync(abs)) { resolve(`❌ Directory not found: ${abs}`); return; }
    const proc = child_process.spawn(
      "zoekt-index",
      ["-index", INDEX_DIR, abs],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "", err = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("close", code => {
      if (code === 0) resolve(`✅ Indexed \`${abs}\` → \`${INDEX_DIR}\`\n${out.trim()}`);
      else            resolve(`❌ zoekt-index failed (exit ${code})\n${err.trim()}`);
    });
    proc.on("error", e => resolve(`❌ zoekt-index not found: ${(e as Error).message}\nnix-env -iA nixpkgs.zoekt`));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool schemas
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS: Tool[] = [
  {
    name: "search_code",
    description: "Trigram code search across locally-indexed repositories using Zoekt. Fast, offline, privacy-preserving.",
    inputSchema: {
      type: "object",
      properties: {
        query:       { type: "string",  description: "Search query. Supports lang:Nix, ext:ts, repo:name, regex." },
        maxResults:  { type: "number",  description: "Max files to return (default 20)." },
        contextLines:{ type: "number",  description: "Lines of context around matches (default 2)." },
      },
      required: ["query"],
    },
  },
  {
    name: "index_directory",
    description: "Index a local directory into Zoekt for future search_code queries.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Absolute or workspace-relative path to index." },
      },
      required: ["directory"],
    },
  },
  {
    name: "guard_code",
    description: "Scan a code snippet for security issues, bad patterns, and Nix anti-patterns before it enters your workspace.",
    inputSchema: {
      type: "object",
      properties: {
        code:     { type: "string", description: "Source code to scan." },
        filename: { type: "string", description: "Optional filename hint (for context)." },
      },
      required: ["code"],
    },
  },
  {
    name: "guard_file",
    description: "Scan an existing file in the workspace for bad patterns.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative path." },
      },
      required: ["path"],
    },
  },
  {
    name: "search_file",
    description: "Grep a file for a pattern (ripgrep-style, literal or regex).",
    inputSchema: {
      type: "object",
      properties: {
        path:    { type: "string", description: "File path." },
        pattern: { type: "string", description: "Search pattern." },
        regex:   { type: "boolean",description: "Treat pattern as regex (default false)." },
      },
      required: ["path", "pattern"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the workspace (max 200 KB).",
    inputSchema: {
      type: "object",
      properties: {
        path:  { type: "string", description: "File path." },
        lines: { type: "number", description: "Max lines to return (default 300)." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_index",
    description: "List all repositories currently in the Zoekt index.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "purge_index",
    description: "Delete all shard files from the Zoekt index directory.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "Must be true to confirm destructive operation." },
      },
      required: ["confirm"],
    },
  },
  {
    name: "zoekt_status",
    description: "Show Zoekt server status, index directory, and server version.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  // ── GitHub remote tools ──────────────────────────────────────────────────
  {
    name: "search_github_code",
    description: "Search GitHub code via REST API (PAT-auth via agenix). Supports scope: global | user | repo.",
    inputSchema: {
      type: "object",
      properties: {
        query:    { type: "string",  description: "Code search query." },
        language: { type: "string",  description: "Language filter (e.g. Nix, TypeScript)." },
        scope:    { type: "string",  description: "global | user | repo (default: user)." },
        repos:    { type: "array",   items: { type: "string" }, description: "Repo list for scope=repo." },
        limit:    { type: "number",  description: "Max results (default 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "refresh_github_starred",
    description: "Refresh the local cache of your GitHub starred repositories (uses DAS_GH_TOKEN from agenix).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_github_starred_code",
    description: "Search code across your GitHub starred repos. Uses local starred cache + GH code search API. Partial results are cached; re-run to resume after rate-limit.",
    inputSchema: {
      type: "object",
      properties: {
        query:        { type: "string",  description: "Code search query." },
        language:     { type: "string",  description: "Language filter." },
        limitPerRepo: { type: "number",  description: "Max hits per repo (default 3)." },
        maxRepos:     { type: "number",  description: "Max repos to search (default 60)." },
      },
      required: ["query"],
    },
  },
  {
    name: "search_everywhere",
    description: "Fan-out code search: local Zoekt + GitHub starred (parallel). Best for 'find vllm examples everywhere'.",
    inputSchema: {
      type: "object",
      properties: {
        query:    { type: "string",  description: "Search query." },
        language: { type: "string",  description: "Language filter." },
        scope:    { type: "string",  description: "local | github | all (default: all)." },
      },
      required: ["query"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "das-codegrep-mcp", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  // ── local tools ───────────────────────────────────────────────────────────
  if (name === "search_code") {
    const q    = rewriteQuery(String(args.query ?? ""));
    const maxR = Number(args.maxResults   ?? 20);
    const ctx  = Number(args.contextLines ?? 2);
    const text = await zoektSearch(q, maxR, ctx);
    return { content: [{ type: "text", text: `## 🔍 Local: \`${q}\`\n\n${text}` }] };
  }

  if (name === "index_directory") {
    const dir = String(args.directory ?? "");
    // safeResolve called inside zoektIndex
    const text = await zoektIndex(dir);
    return { content: [{ type: "text", text }] };
  }

  if (name === "guard_code") {
    const code = String(args.code ?? "");
    const src  = String(args.filename ?? "<snippet>");
    const hits = guardScan(code);
    return { content: [{ type: "text", text: renderGuardHits(hits, src) }] };
  }

  if (name === "guard_file") {
    const p = String(args.path ?? "");
    let abs: string;
    try { abs = safeResolve(p); } catch (e) {
      return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
    }
    try {
      const code = fs.readFileSync(abs, "utf-8");
      const hits = guardScan(code);
      return { content: [{ type: "text", text: renderGuardHits(hits, abs) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Cannot read file: ${(e as Error).message}` }] };
    }
  }

  if (name === "search_file") {
    const p       = String(args.path ?? "");
    const pattern = String(args.pattern ?? "");
    const useRe   = Boolean(args.regex);
    let abs: string;
    try { abs = safeResolve(p); } catch (e) {
      return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
    }
    try {
      const content = fs.readFileSync(abs, "utf-8");
      const lines   = content.split("\n");
      // safeRegExp guards against ReDoS (semgrep: detect-non-literal-regexp)
      let re: RegExp | null = null;
      if (useRe) {
        try { re = safeRegExp(pattern); } catch (e) {
          return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
        }
      }
      const hits = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => re ? re.test(l) : l.includes(pattern))
        .slice(0, 50)
        .map(({ l, i }) => `L${i + 1}: ${l.trim().slice(0, 160)}`);
      const text = hits.length
        ? `**${hits.length} match(es)** in \`${abs}\`\n\`\`\`\n${hits.join("\n")}\n\`\`\``
        : `*No matches for \`${pattern}\` in \`${abs}\`.*`;
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
    }
  }

  if (name === "read_file") {
    const p     = String(args.path ?? "");
    const limit = Number(args.lines ?? 300);
    let abs: string;
    try { abs = safeResolve(p); } catch (e) {
      return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
    }
    try {
      const stat = fs.statSync(abs);
      if (stat.size > 200_000) return { content: [{ type: "text", text: `❌ File too large (${stat.size} bytes > 200 KB).` }] };
      const lines = fs.readFileSync(abs, "utf-8").split("\n").slice(0, limit);
      return { content: [{ type: "text", text: `\`\`\`\n${lines.join("\n")}\n\`\`\`` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
    }
  }

  if (name === "list_index") {
    try {
      const shards = fs.readdirSync(INDEX_DIR).filter(f => f.endsWith(".zoekt"));
      if (!shards.length) return { content: [{ type: "text", text: `*Index empty — run index_directory first.*` }] };
      return { content: [{ type: "text", text: `**${shards.length} shard(s)** in \`${INDEX_DIR}\`\n\`\`\`\n${shards.join("\n")}\n\`\`\`` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
    }
  }

  if (name === "purge_index") {
    if (!args.confirm) return { content: [{ type: "text", text: "⚠️ Set confirm=true to purge." }] };
    try {
      const shards = fs.readdirSync(INDEX_DIR).filter(f => f.endsWith(".zoekt"));
      for (const s of shards) fs.unlinkSync(path.join(INDEX_DIR, s));
      return { content: [{ type: "text", text: `🗑️ Purged ${shards.length} shard(s) from \`${INDEX_DIR}\`.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
    }
  }

  if (name === "zoekt_status") {
    try {
      await axios.get(`${ZOEKT_BASE}/`, { timeout: 3000 });
      const shards = fs.existsSync(INDEX_DIR)
        ? fs.readdirSync(INDEX_DIR).filter(f => f.endsWith(".zoekt")).length
        : 0;
      return { content: [{ type: "text", text: [
        `## Zoekt Status`,
        `| Field | Value |`,
        `|-------|-------|`,
        `| Status      | ✅ Running |`,
        `| Endpoint    | \`${ZOEKT_BASE}\` |`,
        `| Index dir   | \`${INDEX_DIR}\` |`,
        `| Shards      | ${shards} |`,
        `| MCP version | v${VERSION} |`,
      ].join("\n") }] };
    } catch {
      return { content: [{ type: "text", text: [
        `## Zoekt Status`,
        `| Field | Value |`,
        `|-------|-------|`,
        `| Status     | ⚠️ Not reachable |`,
        `| Endpoint   | \`${ZOEKT_BASE}\` |`,
        `| Index dir  | \`${INDEX_DIR}\` |`,
        `| MCP version| v${VERSION} |`,
        ``,
        `Run: \`zoekt-webserver -index ${INDEX_DIR} -listen :${ZOEKT_PORT} &\``,
      ].join("\n") }] };
    }
  }

  // ── GitHub tools ──────────────────────────────────────────────────────────
  if (name === "search_github_code") {
    try {
      const hits = await ghCodeSearch(
        String(args.query ?? ""),
        {
          language: args.language ? String(args.language) : undefined,
          scope:    (args.scope as GhSearchScope) ?? "user",
          repos:    Array.isArray(args.repos) ? args.repos.map(String) : [],
          limit:    Number(args.limit ?? 10),
        },
      );
      const rlInfo = rateLimitStatus();
      const text = [
        `## 🐙 GitHub: \`${args.query}\``,
        formatGhHits(hits, "GitHub"),
        renderRateLimitBlock(rlInfo),
      ].join("\n");
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ GitHub search error: ${(e as Error).message}` }] };
    }
  }

  if (name === "refresh_github_starred") {
    try {
      const cache = await starredCacheRefresh();
      const byLang: Record<string, number> = {};
      for (const r of cache.repos) {
        const l = r.language ?? "Unknown";
        byLang[l] = (byLang[l] ?? 0) + 1;
      }
      const top = Object.entries(byLang).sort((a, b) => b[1] - a[1]).slice(0, 10);
      const rows = top.map(([l, n]) => `| ${l} | ${n} |`).join("\n");
      return { content: [{ type: "text", text: [
        `## ✅ Starred Cache Refreshed`,
        `**${cache.repos.length} repos** cached at \`${cache.fetchedAt}\``,
        ``,
        `### Top Languages`,
        `| Language | Count |`,
        `|----------|-------|`,
        rows,
      ].join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ refresh_github_starred: ${(e as Error).message}` }] };
    }
  }

  if (name === "search_github_starred_code") {
    try {
      const result: StarredSearchResult = await searchStarredCode(
        String(args.query ?? ""),
        {
          language:     args.language     ? String(args.language)     : undefined,
          limitPerRepo: args.limitPerRepo ? Number(args.limitPerRepo) : undefined,
          maxRepos:     args.maxRepos     ? Number(args.maxRepos)     : undefined,
        },
      );
      const peek = peekStarredCache();
      const sections: string[] = [
        `## ⭐ Starred Search: \`${args.query}\``,
        `*${result.reposSearched} repos searched | ${result.hits.length} hits | cache: ${result.fromCache ? "hit" : "miss"}*`,
      ];
      if (peek) {
        sections.push(`*Starred cache: ${peek.count} repos as of ${peek.fetchedAt}*`);
      }
      sections.push("", formatGhHits(result.hits, "starred repos"));
      if (result.partialError) {
        sections.push(`\n> ⚠️ **Partial results:** ${result.partialError}`);
      }
      sections.push(renderRateLimitBlock(result.rateLimitInfo));
      return { content: [{ type: "text", text: sections.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ search_github_starred_code: ${(e as Error).message}` }] };
    }
  }

  if (name === "search_everywhere") {
    const query    = String(args.query ?? "");
    const language = args.language ? String(args.language) : undefined;
    const scope    = String(args.scope ?? "all");

    const tasks: [string, Promise<string>][] = [];

    if (scope === "local" || scope === "all") {
      tasks.push(["local", zoektSearch(rewriteQuery(query))]);
    }
    if (scope === "github" || scope === "all") {
      tasks.push(["github",
        searchStarredCode(query, { language, limitPerRepo: 3, maxRepos: 40 })
          .then((r: StarredSearchResult) => [
            formatGhHits(r.hits, "starred repos"),
            r.partialError ? `\n> ⚠️ ${r.partialError}` : "",
            renderRateLimitBlock(r.rateLimitInfo),
          ].join("\n"))
          .catch((e: unknown) => `⚠️ GitHub search failed: ${(e as Error).message}`),
      ]);
    }

    const settled = await Promise.allSettled(tasks.map(([, p]) => p));
    const sections: string[] = [`## 🌐 search_everywhere: \`${query}\``];
    for (let i = 0; i < tasks.length; i++) {
      const [label]  = tasks[i];
      const result   = settled[i];
      const emoji    = label === "local" ? "🔍" : "🐙";
      sections.push(`\n### ${emoji} ${label.charAt(0).toUpperCase() + label.slice(1)} Results`);
      if (result.status === "fulfilled") {
        sections.push(result.value);
      } else {
        sections.push(`⚠️ ${label} search error: ${result.reason}`);
      }
    }

    const rlInfo = rateLimitStatus();
    if (rlInfo) sections.push(renderRateLimitBlock(rlInfo));

    return { content: [{ type: "text", text: sections.join("\n") }] };
  }

  return {
    content: [{ type: "text", text: `❌ Unknown tool: ${name}` }],
    isError: true,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[das-codegrep-mcp] v${VERSION} ready  zoekt@${ZOEKT_BASE}  index:${INDEX_DIR}\n`
  );
}

main().catch(err => {
  process.stderr.write(`[das-codegrep-mcp] FATAL: ${err}\n`);
  process.exit(1);
});
