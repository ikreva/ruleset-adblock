#!/usr/bin/env bun
// build.mjs — 解析 adblock 名单 → 准入剔除 → 双格式产物（json source / srs / mrs / clash list）
// 用法：bun scripts/build.mjs  （在仓库根目录执行；需要 PATH 中有 sing-box 与 mihomo，
//       或用环境变量 SINGBOX_BIN / MIHOMO_BIN 指定二进制）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const singbox = process.env.SINGBOX_BIN ?? "sing-box";
const mihomo = process.env.MIHOMO_BIN ?? "mihomo";
const log = (s) => console.log("[build] " + s);
const fail = (s) => { console.error("[build][错误] " + s); process.exit(1); };

function run(bin, args, label) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) fail(`${label} 失败（退出码 ${r.status}）：${(r.stderr || r.stdout || "").slice(0, 500)}`);
  return r;
}

function loadAllow(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").map(l => l.trim().toLowerCase())
    .filter(l => l && !l.startsWith("#"));
}
const isAllowed = (d, allow) => allow.some(a => d === a || d.endsWith("." + a));

// ---------- 解析 ----------
const stats = { raw: 0, block: 0, upstreamAllow: 0, invalid: 0, excluded: 0, final: 0 };
const block = new Set();
const meta = existsSync(join(root, "upstream", "meta.json"))
  ? JSON.parse(readFileSync(join(root, "upstream", "meta.json"), "utf8")) : {};

for (const name of ["hagezi-pro"]) {
  const text = readFileSync(join(root, "upstream", `${name}.txt`), "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("[Adblock")) continue;
    if (line.startsWith("@@")) { stats.upstreamAllow++; continue; } // 上游自带放行（pro 无）
    if (!line.startsWith("||")) { stats.invalid++; continue; }
    stats.raw++;
    let d = line.slice(2);
    const dollar = d.indexOf("$");
    if (dollar !== -1) d = d.slice(0, dollar);       // 去修饰符（$all/$dnsrewrite 等）
    if (d.endsWith("^")) d = d.slice(0, -1);
    d = d.toLowerCase();
    if (!d || d.includes("/") || d.includes("*") || d.includes("=") || !d.includes(".")) { stats.invalid++; continue; }
    stats.block++;
    block.add(d);
  }
}

// ---------- 剔除（allow.list：等于或子域） ----------
const allow = loadAllow(join(root, "sources", "allow.list"));
for (const d of [...block]) if (isAllowed(d, allow)) { block.delete(d); stats.excluded++; }
const sorted = [...block].sort();
stats.final = sorted.length;
log(`解析完成：原始 ${stats.block} 条 → 剔除两用域 ${stats.excluded} → 最终 ${stats.final} 条`);
if (stats.final < 200000) fail(`最终条数 ${stats.final} 低于规模阈值 200000，中止发布`);
if (!sorted.length) fail("产出为空");

// ---------- 产物 ----------
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

// sing-box source（domain_suffix，不含前导点——sing-box 后缀匹配含自身）
const source = { version: 3, rules: [{ domain_suffix: sorted }] };
writeFileSync(join(dist, "hagezi-pro.json"), JSON.stringify(source) + "\n");

// mihomo payload（+.d）与 clash list（同一份）
const payload = sorted.map(d => "+." + d).join("\n") + "\n";
writeFileSync(join(dist, "hagezi-pro.list"), payload);

// manifest（含上游版本与统计）
writeFileSync(join(dist, "manifest.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  upstream: meta["hagezi-pro"] ?? {},
  stats, allowCount: allow.length,
}, null, 2) + "\n");

// ---------- 编译 ----------
log("编译 srs（sing-box rule-set compile）...");
run(singbox, ["rule-set", "compile", "-o", join(dist, "hagezi-pro.srs"), join(dist, "hagezi-pro.json")], "sing-box compile");
log("编译 mrs（mihomo convert-ruleset）...");
run(mihomo, ["convert-ruleset", "domain", "text", join(dist, "hagezi-pro.list"), join(dist, "hagezi-pro.mrs")], "mihomo convert-ruleset");

log("build 阶段完成：dist/hagezi-pro.{json,srs,mrs,list} + manifest.json");
