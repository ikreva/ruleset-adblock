#!/usr/bin/env bun
// assert.mjs — 发布前断言矩阵：格式读回 / 探针域必中必不中 / 规模阈值 / 一致性
// 用法：bun scripts/assert.mjs  （在仓库根目录执行；需要 PATH 中有 sing-box）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const singbox = process.env.SINGBOX_BIN ?? "sing-box";
const dist = join(root, "dist");
const log = (s) => console.log("[assert] " + s);
const fail = (s) => { console.error("[assert][错误] " + s); process.exit(1); };
let failures = 0;
const assert = (name, cond, detail = "") => {
  log(`${cond ? "✓" : "✗"} ${name}${detail ? " | " + detail : ""}`);
  if (!cond) failures++;
};

const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const source = JSON.parse(readFileSync(join(dist, "hagezi-pro.json"), "utf8"));
const suffixes = new Set(source.rules[0].domain_suffix);
const listLines = readFileSync(join(dist, "hagezi-pro.list"), "utf8").split("\n").filter(l => l.trim());

// A) 规模与一致性
assert("A1 规模阈值（≥200000）", suffixes.size >= 200000, `实际 ${suffixes.size}`);
assert("A2 source json 与 clash list 条数一致", listLines.length === suffixes.size,
  `list=${listLines.length} json=${suffixes.size}`);
assert("A3 manifest 统计一致", manifest.stats.final === suffixes.size, JSON.stringify(manifest.stats));

// B) 探针域：广告/追踪域必中（选取 HaGeZi pro 实际封锁的稳定条目）
const probeBlock = ["google-analytics.com", "2mdn.net", "ad.ae.doubleclick.net", "googlesyndication.com"];
for (const d of probeBlock) {
  const covered = suffixes.has(d) || [...suffixes].some(s => d.endsWith("." + s));
  assert(`B 探针必中 ${d}`, covered, suffixes.has(d) ? "直连条目" : (covered ? "后缀命中" : "未覆盖"));
}

// C) 探针域：两用域/基础设施域必不中（误杀防线）
const probeAllow = ["gstatic.com", "msftconnecttest.com", "time.apple.com", "pool.ntp.org", "www.baidu.com", "www.jd.com"];
for (const d of probeAllow) {
  const hit = suffixes.has(d) || [...suffixes].some(s => d.endsWith("." + s) || s.endsWith("." + d));
  assert(`C 探针必不中 ${d}`, !hit, hit ? "被误杀！" : "未入名单");
}

// D) srs 格式读回（decompile 成功且条数一致）
{
  const out = join(dist, ".readback.json");
  const r = spawnSync(singbox, ["rule-set", "decompile", join(dist, "hagezi-pro.srs"), "-o", out],
    { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) fail(`srs 反编译失败：${(r.stderr || r.stdout || "").slice(0, 300)}`);
  const back = JSON.parse(readFileSync(out, "utf8"));
  const backCount = (back.rules[0].domain_suffix ?? []).length;
  assert("D1 srs 反编译读回条数一致", backCount === suffixes.size, `srs=${backCount} json=${suffixes.size}`);
}
// E) mrs 产物存在且非空
{
  const p = join(dist, "hagezi-pro.mrs");
  assert("E1 mrs 产物存在且 >1MB", existsSync(p) && readFileSync(p).length > 1000000,
    existsSync(p) ? `${readFileSync(p).length} 字节` : "缺失");
}

if (failures) { console.error(`[assert][失败] ${failures} 项断言未通过——不发布`); process.exit(1); }
log("全部断言通过 ✓");
