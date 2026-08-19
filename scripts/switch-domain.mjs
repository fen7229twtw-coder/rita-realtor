#!/usr/bin/env node
// 官網搬家開關：在「GitHub Pages 舊網址」與「Rita 的自訂網域」之間切換。
//
// 用法（在專案根目錄執行）：
//   node scripts/switch-domain.mjs check       只看現況，不動任何檔案
//   node scripts/switch-domain.mjs to-domain   換成 0981456399rita.com，並建立 CNAME
//   node scripts/switch-domain.mjs to-github   換回 github.io，並刪掉 CNAME
//
// ⚠ CNAME 檔一旦推上 GitHub，Pages 就會把舊網址 301 導到自訂網域。
//   DNS 還沒設好就推 = 整個官網對客戶變成打不開。順序一定是「先設 DNS，再推」。

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const SELF = fileURLToPath(import.meta.url); // 這支腳本自己也寫著兩個網址，不能被自己換掉
const DOMAIN = "0981456399rita.com";
const OLD = "https://fen7229twtw-coder.github.io/rita-realtor/";
const NEW = `https://${DOMAIN}/`;
const CNAME = join(ROOT, "CNAME");

const EXTS = new Set([".html", ".js", ".mjs", ".css", ".json", ".md"]);
const SKIP = new Set(["node_modules", ".next", ".git", ".tools", ".claude", "cache", "profiles"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(extname(name))) out.push(p);
  }
  return out;
}

const mode = process.argv[2] ?? "check";
if (!["check", "to-domain", "to-github"].includes(mode)) {
  console.error("用法：node scripts/switch-domain.mjs [check|to-domain|to-github]");
  process.exit(1);
}

// check 模式要能自己看出「現在指向哪一邊」，不能寫死方向
const present = (needle) => walk(ROOT).some((f) => f !== SELF && readFileSync(f, "utf8").includes(needle));
const [from, to] =
  mode === "to-github" ? [NEW, OLD]
  : mode === "to-domain" ? [OLD, NEW]
  : present(NEW) ? [NEW, OLD] : [OLD, NEW];
let files = 0, hits = 0;

for (const file of walk(ROOT)) {
  if (file === SELF) continue;
  const text = readFileSync(file, "utf8");
  const n = text.split(from).length - 1;
  if (!n) continue;
  files++; hits += n;
  const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
  console.log(`  ${rel}  ${n} 處`);
  if (mode !== "check") writeFileSync(file, text.split(from).join(to), "utf8");
}

if (mode === "check") {
  console.log(hits ? `\n目前指向：${from}\n共 ${hits} 處、${files} 個檔案` : "\n沒找到任何要換的網址。");
  console.log(existsSync(CNAME) ? `CNAME：有（${readFileSync(CNAME, "utf8").trim()}）` : "CNAME：沒有（官網還在 github.io）");
  process.exit(0);
}

if (mode === "to-domain") {
  writeFileSync(CNAME, DOMAIN + "\n", "utf8");
  console.log(`\n已換成 ${NEW}（${hits} 處、${files} 個檔案），並建立 CNAME。`);
  console.log("下一步：確認 DNS 已生效，再 commit 並 push。");
} else {
  if (existsSync(CNAME)) unlinkSync(CNAME);
  console.log(`\n已換回 ${OLD}（${hits} 處、${files} 個檔案），並刪除 CNAME。`);
}
