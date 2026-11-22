#!/usr/bin/env bun
// assert.mjs — 发布前断言矩阵（五档逐档）：格式读回 / 探针域必中必不中 / 规模阈值 / 一致性
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

// 探针按档位递增：common 三域全档必中；pro 起含 2mdn；proplus/ultimate 含 doubleclick 全域
// （proplus/ultimate 的 ad.ae.doubleclick.net 经 doubleclick.net 后缀覆盖）
const BLOCK_PROBES = {
  "hagezi-light":    ["google-analytics.com", "ad.ae.doubleclick.net", "googlesyndication.com"],
  "hagezi-normal":   ["google-analytics.com", "ad.ae.doubleclick.net", "googlesyndication.com"],
  "hagezi-pro":      ["google-analytics.com", "ad.ae.doubleclick.net", "googlesyndication.com", "2mdn.net"],
  "hagezi-proplus":  ["google-analytics.com", "ad.ae.doubleclick.net", "googlesyndication.com", "2mdn.net", "doubleclick.net", "adservice.google.com"],
  "hagezi-ultimate": ["google-analytics.com", "ad.ae.doubleclick.net", "googlesyndication.com", "2mdn.net", "doubleclick.net", "adservice.google.com"],
};
// mrs 最低字节数 ≈ floor × 5（pro 实测 ~8.5 字节/条，留足余量）
const MRS_MIN_BYTES = (floor) => floor * 5;

// 探针域：两用域/基础设施域必不中（误杀防线，全档一致）
const probeAllow = ["gstatic.com", "msftconnecttest.com", "time.apple.com", "pool.ntp.org", "www.baidu.com", "www.jd.com"];

const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));

for (const [name, tier] of Object.entries(manifest.tiers)) {
  log(`—— ${name}（floor=${tier.floor}）——`);
  const source = JSON.parse(readFileSync(join(dist, `${name}.json`), "utf8"));
  const suffixes = new Set(source.rules[0].domain_suffix);
  const listLines = readFileSync(join(dist, `${name}.list`), "utf8").split("\n").filter(l => l.trim());

  // A) 规模与一致性
  assert(`A1 ${name} 规模阈值（≥${tier.floor}）`, suffixes.size >= tier.floor, `实际 ${suffixes.size}`);
  assert(`A2 ${name} source json 与 clash list 条数一致`, listLines.length === suffixes.size,
    `list=${listLines.length} json=${suffixes.size}`);
  assert(`A3 ${name} manifest 统计一致`, tier.stats.final === suffixes.size, JSON.stringify(tier.stats));

  // B) 探针域：广告/追踪域必中（选取 HaGeZi 各档实际封锁的稳定条目，2026-11-23 逐档核验）
  for (const d of BLOCK_PROBES[name] ?? []) {
    const covered = suffixes.has(d) || [...suffixes].some(s => d.endsWith("." + s));
    assert(`B ${name} 探针必中 ${d}`, covered, suffixes.has(d) ? "直连条目" : (covered ? "后缀命中" : "未覆盖"));
  }

  // C) 探针域：两用域/基础设施域必不中（误杀防线）
  for (const d of probeAllow) {
    const hit = suffixes.has(d) || [...suffixes].some(s => d.endsWith("." + s) || s.endsWith("." + d));
    assert(`C ${name} 探针必不中 ${d}`, !hit, hit ? "被误杀！" : "未入名单");
  }

  // D) srs 格式读回（decompile 成功且条数一致）
  {
    const out = join(dist, ".readback.json");
    const r = spawnSync(singbox, ["rule-set", "decompile", join(dist, `${name}.srs`), "-o", out],
      { encoding: "utf8", timeout: 120000 });
    if (r.status !== 0) fail(`${name} srs 反编译失败：${(r.stderr || r.stdout || "").slice(0, 300)}`);
    const back = JSON.parse(readFileSync(out, "utf8"));
    const backCount = (back.rules[0].domain_suffix ?? []).length;
    assert(`D1 ${name} srs 反编译读回条数一致`, backCount === suffixes.size, `srs=${backCount} json=${suffixes.size}`);
  }
  // E) mrs 产物存在且不低于档位规模下限推算的字节数
  {
    const p = join(dist, `${name}.mrs`);
    const minBytes = MRS_MIN_BYTES(tier.floor);
    assert(`E1 ${name} mrs 产物存在且 ≥${minBytes} 字节`, existsSync(p) && readFileSync(p).length >= minBytes,
      existsSync(p) ? `${readFileSync(p).length} 字节` : "缺失");
  }
}

if (failures) { console.error(`[assert][失败] ${failures} 项断言未通过——不发布`); process.exit(1); }
log("全部断言通过 ✓");
