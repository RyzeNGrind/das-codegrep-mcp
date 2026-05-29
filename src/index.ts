#!/usr/bin/env node
/**
 * das-codegrep-mcp — Local-first MCP Server
 * ─────────────────────────────────────────
 * Transport : stdio (NixOS-WSL safe)
 * Search    : Zoekt trigram (100% offline)
 * Guard     : pre-ingress bad-pattern scanner
 *
 * Tools: search_code, index_directory, guard_code, guard_file,
 *        search_file, read_file, list_index, zoekt_status
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios  from "axios";
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";

const ZOEKT_PORT = parseInt(process.env.ZOEKT_PORT  ?? "6070");
const INDEX_DIR  = process.env.DAS_INDEX_DIR ?? `${process.env.HOME}/.local/share/das-codegrep-mcp/index`;
const WORKSPACE  = process.env.DAS_WORKSPACE ?? process.env.HOME ?? "/tmp";
const ZOEKT_BASE = `http://127.0.0.1:${ZOEKT_PORT}`;

// ---------------------------------------------------------------------------
// Zoekt query rewriter
// Zoekt REST API uses `language:` not `lang:`, and language names are Title-cased.
// Also normalises common aliases so `lang:nix` → `language:Nix` etc.
// ---------------------------------------------------------------------------
const LANG_MAP: Record<string,string> = {
  nix:"Nix", ts:"TypeScript", typescript:"TypeScript", js:"JavaScript",
  javascript:"JavaScript", py:"Python", python:"Python", rs:"Rust", rust:"Rust",
  sh:"Shell", bash:"Shell", shell:"Shell", go:"Go", c:"C", cpp:"C++",
  java:"Java", rb:"Ruby", ruby:"Ruby", md:"Markdown", markdown:"Markdown",
  json:"JSON", yaml:"YAML", toml:"TOML", html:"HTML", css:"CSS",
};

function rewriteQuery(q: string): string {
  // Replace lang:xxx or language:xxx with language:NormalisedName
  return q.replace(/\b(?:lang|language):(\S+)/gi, (_m, l) => {
    const key = l.toLowerCase();
    return `language:${LANG_MAP[key] ?? l}`;
  });
}

// ---------------------------------------------------------------------------
// Guard patterns — ordered most-severe first
// ---------------------------------------------------------------------------
interface GuardPattern {
  id: string; label: string; severity: "error" | "warn"; regex: RegExp; tip: string;
}

const GUARD: GuardPattern[] = [
  // Secrets
  { id:"hardcoded-secret",  label:"Hardcoded secret/token",
    severity:"error", regex:/(api[_-]?key|secret|token|password)\s*=\s*["'][^"']{8,}["']/i,
    tip:"Use sops-nix, age, or environment variables." },
  // eval variants: eval(…), eval $(…), eval `…`
  { id:"eval-usage", label:"eval() / eval $() / eval `` call",
    severity:"error", regex:/\beval\s*(\(|\$\(|`)/,
    tip:"eval is a code-injection vector. Refactor to avoid it." },
  // curl/wget exec patterns: pipe to shell OR eval $(curl …) OR bash <(curl …)
  { id:"curl-exec", label:"Remote code execution via curl/wget",
    severity:"error",
    regex:/curl[^|#\n]*\|\s*(ba)?sh|wget[^|#\n]*\|\s*(ba)?sh|eval\s+\$\(\s*(curl|wget)|bash\s+<\(\s*(curl|wget)/,
    tip:"Verify checksums — never execute remote content directly." },
  // rm -rf with no variable guard
  { id:"rm-rf", label:"rm -rf without guard",
    severity:"error", regex:/rm\s+-rf?\s+[^$\{]/,
    tip:"Add path validation or use safer deletion patterns." },
  // Nix-specific
  { id:"nix-fetchurl-nohash", label:"fetchurl/fetchTarball without hash",
    severity:"error", regex:/fetch(url|Tarball)\s*\{[^}]*url[^}]*\}/,
    tip:"Pin with sha256 for reproducibility." },
  { id:"nix-with-pkgs", label:"with pkgs; anti-pattern",
    severity:"warn", regex:/with\s+pkgs\s*;/,
    tip:"Prefer explicit pkgs.foo over with pkgs;" },
  // JS/TS
  { id:"console-log", label:"console.log in source",
    severity:"warn", regex:/console\.log\(/,
    tip:"Use a structured logger for production code." },
  { id:"todo-fixme", label:"TODO/FIXME left in code",
    severity:"warn", regex:/\b(TODO|FIXME|HACK|XXX)\b/,
    tip:"Track in your issue tracker instead." },
  { id:"empty-catch", label:"Empty catch block",
    severity:"warn", regex:/catch\s*\([^)]*\)\s*\{\s*\}/,
    tip:"Always handle or re-throw errors." },
  { id:"any-type", label:"TypeScript any type",
    severity:"warn", regex:/:\s*any\b/,
    tip:"Use specific types or unknown + type narrowing." },
];

interface GuardFinding {
  pattern:string; label:string; severity:"error"|"warn";
  line:number; lineText:string; tip:string; filename:string;
}

function guardCode(code:string, filename="snippet"): GuardFinding[] {
  const findings:GuardFinding[] = [];
  code.split("\n").forEach((l,i) => {
    for (const p of GUARD)
      if (p.regex.test(l))
        findings.push({pattern:p.id,label:p.label,severity:p.severity,
          line:i+1,lineText:l.trim().slice(0,120),tip:p.tip,filename});
  });
  return findings;
}

function zoektIndex(dirs:string[]): Promise<{stderr:string}> {
  return new Promise((res,rej) => {
    const p = child_process.spawn("zoekt-index",["-index",INDEX_DIR,...dirs],{stdio:"pipe"});
    let stderr="";
    p.stderr.on("data",(d:Buffer)=>stderr+=d.toString());
    p.on("close",c=>c===0?res({stderr}):rej(new Error(`zoekt-index exited ${c}: ${stderr}`)));
  });
}

interface ZoektResult {
  repo:string; fileName:string; language:string; score:number;
  lines:{lineNumber:number;line:string;before:string[];after:string[]}[];
}

async function zoektSearch(query:string, max=15): Promise<ZoektResult[]> {
  const rewritten = rewriteQuery(query);
  try {
    const r = await axios.get(`${ZOEKT_BASE}/search`,
      {params:{q:rewritten,num:max,format:"json"},timeout:5000});
    return (r.data?.Result?.Files??[]).map((f:any)=>({
      repo:f.Repository??"",fileName:f.FileName??"",language:f.Language??"",score:f.Score??0,
      lines:(f.LineMatches??[]).map((l:any)=>({
        lineNumber:l.LineNumber,
        line:Buffer.from(l.Line,"base64").toString("utf8"),
        before:(l.Before??[]).map((b:any)=>Buffer.from(b,"base64").toString("utf8")),
        after:(l.After??[]).map((a:any)=>Buffer.from(a,"base64").toString("utf8")),
      })),
    }));
  } catch(e:any) {
    if(e?.code==="ECONNREFUSED") throw new Error(`Zoekt not running on ${ZOEKT_PORT}. Run: ./bin/dev-up`);
    throw e;
  }
}

const TOOLS: Tool[] = [
  {name:"search_code",
   description:"Trigram search across indexed local codebases via Zoekt. Supports lang:nix, f:*.nix, regex, boolean ops.",
   inputSchema:{type:"object",properties:{query:{type:"string"},maxResults:{type:"number",default:15}},required:["query"]}},
  {name:"index_directory",
   description:"Index local directories with Zoekt. Run once per new repo/workspace.",
   inputSchema:{type:"object",properties:{directories:{type:"array",items:{type:"string"}}},required:["directories"]}},
  {name:"guard_code",
   description:"Scan a snippet for bad patterns (secrets, eval, rm -rf, curl-exec, Nix anti-patterns) BEFORE writing to workspace.",
   inputSchema:{type:"object",properties:{code:{type:"string"},filename:{type:"string"}},required:["code"]}},
  {name:"guard_file",
   description:"Scan an existing local file for bad patterns (read-only).",
   inputSchema:{type:"object",properties:{filePath:{type:"string"}},required:["filePath"]}},
  {name:"search_file",
   description:"Search for files by name/glob in workspace.",
   inputSchema:{type:"object",properties:{pattern:{type:"string"},searchDir:{type:"string"},maxDepth:{type:"number",default:10}},required:["pattern"]}},
  {name:"read_file",
   description:"Read a local file, optionally by line range.",
   inputSchema:{type:"object",properties:{filePath:{type:"string"},startLine:{type:"number"},endLine:{type:"number"}},required:["filePath"]}},
  {name:"list_index",
   description:"List all repos currently in the Zoekt index.",
   inputSchema:{type:"object",properties:{}}},
  {name:"zoekt_status",
   description:"Check if local Zoekt server is running.",
   inputSchema:{type:"object",properties:{}}},
];

const server = new Server(
  {name:"das-codegrep-mcp",version:"0.1.1"},
  {capabilities:{tools:{}}},
);

server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:TOOLS}));

server.setRequestHandler(CallToolRequestSchema, async(req)=>{
  const {name, arguments:args} = req.params;
  try {
    switch(name) {
      case "search_code": {
        const {query,maxResults=15}=args as {query:string;maxResults?:number};
        const rewritten = rewriteQuery(query);
        const rs=await zoektSearch(query,maxResults);
        if(!rs.length) return {content:[{type:"text",text:`No results for \`${rewritten}\`. Run index_directory first or broaden query.`}]};
        const out=rs.map(r=>{
          const snips=r.lines.map(l=>[
            ...l.before.map((b,i)=>`  ${l.lineNumber-l.before.length+i} | ${b}`),
            `> ${l.lineNumber} | ${l.line}`,
            ...l.after.map((a,i)=>`  ${l.lineNumber+1+i} | ${a}`),
          ].join("\n")).join("\n---\n");
          return `## ${r.fileName} (${r.language||"?"} score:${r.score.toFixed(2)})\n\`\`\`\n${snips}\n\`\`\``;
        }).join("\n\n");
        return {content:[{type:"text",text:`# Trigram: \`${rewritten}\`\n**${rs.length} file(s)**\n\n${out}`}]};
      }
      case "index_directory": {
        const {directories}=args as {directories:string[]};
        fs.mkdirSync(INDEX_DIR,{recursive:true});
        const {stderr}=await zoektIndex(directories);
        return {content:[{type:"text",text:`OK: indexed ${directories.length} dir(s) -> \`${INDEX_DIR}\`\n${stderr||""}`}]};
      }
      case "guard_code": {
        const {code,filename="snippet"}=args as {code:string;filename?:string};
        const findings=guardCode(code,filename);
        if(!findings.length) return {content:[{type:"text",text:`✅ Guard PASS — \`${filename}\` clean.`}]};
        const errors=findings.filter(f=>f.severity==="error");
        const warns=findings.filter(f=>f.severity==="warn");
        const fmt=(f:GuardFinding)=>`**[${f.severity.toUpperCase()}]** \`${f.label}\` L${f.line}\n> \`${f.lineText}\`\n> 💡 ${f.tip}`;
        const blocked = errors.length > 0;
        return {content:[{type:"text",text:[
          `# Guard: \`${filename}\` — ${blocked?"🚫 BLOCKED":"⚠️  WARNINGS"}`,
          errors.length?`## Errors\n${errors.map(fmt).join("\n\n")}`:"",
          warns.length?`## Warnings\n${warns.map(fmt).join("\n\n")}`:"",
          `${errors.length} error(s) · ${warns.length} warning(s)${blocked?" — fix errors before writing to workspace.":""}`,
        ].filter(Boolean).join("\n\n")}]};
      }
      case "guard_file": {
        const {filePath}=args as {filePath:string};
        const code=fs.readFileSync(filePath,"utf8");
        const findings=guardCode(code,path.basename(filePath));
        if(!findings.length) return {content:[{type:"text",text:`✅ Guard PASS — \`${filePath}\``}]};
        const fmt=(f:GuardFinding)=>`- **[${f.severity.toUpperCase()}]** L${f.line}: \`${f.label}\`\n  💡 ${f.tip}`;
        return {content:[{type:"text",text:`# Guard: ${filePath}\n\n${findings.map(fmt).join("\n\n")}`}]};
      }
      case "search_file": {
        const {pattern,searchDir,maxDepth=10}=args as {pattern:string;searchDir?:string;maxDepth?:number};
        const base=searchDir??WORKSPACE;
        const r=child_process.spawnSync("find",[base,"-maxdepth",String(maxDepth),"-name",pattern,"-type","f"],{encoding:"utf8"});
        const files=r.stdout.trim().split("\n").filter(Boolean);
        return {content:[{type:"text",text:files.length
          ?`Found ${files.length} file(s):\n\`\`\`\n${files.join("\n")}\n\`\`\``
          :`No files matching \`${pattern}\` in \`${base}\``}]};
      }
      case "read_file": {
        const {filePath,startLine,endLine}=args as {filePath:string;startLine?:number;endLine?:number};
        const lines=fs.readFileSync(filePath,"utf8").split("\n");
        const sl=startLine?startLine-1:0;
        const el=endLine?endLine:lines.length;
        return {content:[{type:"text",text:`\`\`\`\n${lines.slice(sl,el).join("\n")}\n\`\`\``}]};
      }
      case "list_index": {
        if(!fs.existsSync(INDEX_DIR))
          return {content:[{type:"text",text:`Index dir \`${INDEX_DIR}\` not found. Run index_directory.`}]};
        const repos=fs.readdirSync(INDEX_DIR).filter(f=>f.endsWith(".zoekt")).map(f=>f.replace(/\.zoekt$/,""));
        return {content:[{type:"text",text:`## Indexed (${repos.length})\n${repos.map(r=>`- \`${r}\``).join("\n")||"None."}`}]};
      }
      case "zoekt_status": {
        try {
          await axios.get(`${ZOEKT_BASE}/`,{timeout:2000});
          return {content:[{type:"text",text:`✅ Zoekt running @ \`${ZOEKT_BASE}\`  index: \`${INDEX_DIR}\``}]};
        } catch {
          return {content:[{type:"text",text:`❌ Zoekt not running. Run: ./bin/dev-up`}]};
        }
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch(e:any) {
    return {content:[{type:"text",text:`ERROR: ${e?.message??String(e)}`}],isError:true};
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[das-codegrep-mcp] ready zoekt@${ZOEKT_BASE} index:${INDEX_DIR}\n`);
}
main().catch(e=>{console.error(e);process.exit(1);});
