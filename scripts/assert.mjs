#!/usr/bin/env bun
// assert.mjs — 发布前断言矩阵（五档逐档）：结构不变量 / 探针域必中必不中 / SRS 反编译全探针读回 / MRS 二进制头校验
// 用法：bun scripts/assert.mjs  （在仓库根目录执行；需要 PATH 中有 sing-box 或 SINGBOX_BIN）
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
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
const BLOCK_PROBES = {
  "hagezi-light":    ["google-analytics.com", "ad.ae.doubleclick.net", "googlesyndication.com"],
  "hagezi-normal":   ["google-analytics.com", "ad.ae.doubleclick.net", "googlesyndication.com"],
  "hagezi-pro":      ["google-analytics.com", "ad.ae.doubleclick.net", "googlesyndication.com", "2mdn.net"],
  "hagezi-proplus":  ["google-analytics.com", "ad.ae.doubleclick.net", "googlesyndication.com", "2mdn.net", "doubleclick.net", "adservice.google.com"],
  "hagezi-ultimate": ["google-analytics.com", "ad.ae.doubleclick.net", "googlesyndication.com", "2mdn.net", "doubleclick.net", "adservice.google.com"],
};

// 常规正常大站探针（除 sources/allow.list 全部条目外额外核验）
const EXTRA_ALLOW_PROBES = [
  "www.baidu.com",
  "www.jd.com",
  "github.com",
  "connectivitycheck.gstatic.com",
  "dns.msftncsi.com",
  "pool.ntp.org",
];

// mrs 最低字节数 ≈ floor × 5（pro 实测 ~8.5 字节/条，留足余量）
const MRS_MIN_BYTES = (floor) => floor * 5;

// O(labels) 检查域名是否被 suffix 集合命中（等于或任意父后缀命中）
function hitsSuffixSet(suffixes, domain) {
  if (suffixes.has(domain)) return domain;
  let idx = domain.indexOf(".");
  while (idx !== -1) {
    const parent = domain.slice(idx + 1);
    if (suffixes.has(parent)) return parent;
    idx = domain.indexOf(".", idx + 1);
  }
  return null;
}

// 检查集合内是否存在冗余子后缀
function findRedundantSuffix(suffixes) {
  for (const d of suffixes) {
    let idx = d.indexOf(".");
    while (idx !== -1) {
      const parent = d.slice(idx + 1);
      if (suffixes.has(parent)) return `${d} (covered by ${parent})`;
      idx = d.indexOf(".", idx + 1);
    }
  }
  return null;
}

// 检查 sources/allow.list 全部条目：既不能被任何后缀命中，也不能有其子域进入名单
function loadAllowEntries() {
  const file = join(root, "sources", "allow.list");
  if (!existsSync(file)) return [];
  return [...new Set(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map(l => l.split("#", 1)[0].trim().toLowerCase())
      .filter(Boolean)
  )];
}

// 防脏文件回归：dist/.readback.json 绝不应残留在产物目录
assert("00 dist/.readback.json 不存在（无临时文件残留）", !existsSync(join(dist, ".readback.json")));

const allowEntries = loadAllowEntries();
const allowSet = new Set(allowEntries);
const probeAllow = [...new Set([...allowEntries, ...EXTRA_ALLOW_PROBES])];
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const workDir = mkdtempSync(join(tmpdir(), "adblock-assert-"));

try {
  for (const [name, tier] of Object.entries(manifest.tiers)) {
    log(`—— ${name}（floor=${tier.floor}）——`);
    const source = JSON.parse(readFileSync(join(dist, `${name}.json`), "utf8"));
    const jsonList = source.rules[0].domain_suffix;
    const suffixes = new Set(jsonList);
    const listLines = readFileSync(join(dist, `${name}.list`), "utf8")
      .split(/\r?\n/)
      .filter(l => l.trim());

    // A) 规模、结构不变量与 .list 一致性
    assert(`A1 ${name} 规模阈值（≥${tier.floor}）`, suffixes.size >= tier.floor, `实际 ${suffixes.size}`);
    assert(`A2 ${name} source json 与 domain .list 条数与内容一致`,
      listLines.length === suffixes.size && listLines.every((l, i) => l === "+." + jsonList[i]),
      `list=${listLines.length} json=${suffixes.size}`);
    assert(`A3 ${name} manifest 统计一致`, tier.stats.final === suffixes.size, JSON.stringify(tier.stats));
    const redundant = findRedundantSuffix(suffixes);
    assert(`A4 ${name} 无后缀自包含冗余`, !redundant, redundant ?? "clean");

    // B) 探针域：广告/追踪域必中
    const blockProbes = BLOCK_PROBES[name] ?? [];
    for (const d of blockProbes) {
      const hitBy = hitsSuffixSet(suffixes, d);
      assert(`B ${name} 探针必中 ${d}`, Boolean(hitBy), hitBy ? `命中 ${hitBy}` : "未覆盖");
    }

    // C) 误杀防线：全量 allow.list + 常规大站均不可被命中，且名单中无 allow.list 的子域
    const allowViolations = [];
    for (const d of probeAllow) {
      const hitBy = hitsSuffixSet(suffixes, d);
      if (hitBy) allowViolations.push(`${d}<-${hitBy}`);
    }
    for (const s of suffixes) {
      if (hitsSuffixSet(allowSet, s)) allowViolations.push(`sub:${s}`);
    }
    assert(`C1 ${name} 两用域/基础设施防线（${probeAllow.length} 条探针 + 全集子域扫描）`,
      allowViolations.length === 0,
      allowViolations.length ? `误杀：${allowViolations.slice(0, 5).join(", ")}` : "0 误杀");

    // D) srs 反编译读回（临时目录，零产物污染）+ 条数与探针全对称校验
    {
      const out = join(workDir, `${name}.readback.json`);
      const r = spawnSync(singbox, ["rule-set", "decompile", join(dist, `${name}.srs`), "-o", out],
        { encoding: "utf8", timeout: 120000 });
      if (r.error) fail(`${name} 无法启动 sing-box：${r.error.message}`);
      if (r.status !== 0) fail(`${name} srs 反编译失败：${(r.stderr || r.stdout || "").slice(0, 300)}`);
      const back = JSON.parse(readFileSync(out, "utf8"));
      const backSet = new Set(back.rules[0].domain_suffix ?? []);
      assert(`D1 ${name} srs 反编译读回条数一致`, backSet.size === suffixes.size,
        `srs=${backSet.size} json=${suffixes.size}`);
      const srsMiss = blockProbes.filter(d => !hitsSuffixSet(backSet, d));
      const srsFalsePos = probeAllow.filter(d => hitsSuffixSet(backSet, d));
      assert(`D2 ${name} srs 反编译读回探针全通过`, srsMiss.length === 0 && srsFalsePos.length === 0,
        srsMiss.length || srsFalsePos.length ? `miss=${srsMiss} fp=${srsFalsePos}` : `${blockProbes.length}+${probeAllow.length} 探针通过`);
    }

    // E) mrs 二进制真实校验：大小阈值 + Zstd 解压 + "MRS" 魔数 + behavior=domain(0) + 精确条数一致
    {
      const p = join(dist, `${name}.mrs`);
      const minBytes = MRS_MIN_BYTES(tier.floor);
      const buf = existsSync(p) ? readFileSync(p) : null;
      assert(`E1 ${name} mrs 产物存在且 ≥${minBytes} 字节`, Boolean(buf && buf.length >= minBytes),
        buf ? `${buf.length} 字节` : "缺失");
      if (buf) {
        const raw = zstdDecompressSync(buf);
        const magic = raw.subarray(0, 3).toString("ascii");
        const version = raw[3];
        const behavior = raw[4]; // 0 = domain, 1 = ipcidr
        const count = Number(raw.readBigUInt64BE(5));
        assert(`E2 ${name} mrs Zstd/头魔数/behavior=domain/条数一致`,
          magic === "MRS" && version >= 1 && behavior === 0 && count === suffixes.size,
          `magic=${magic} v=${version} behavior=${behavior} count=${count} json=${suffixes.size}`);
      }
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`[assert][失败] ${failures} 项断言未通过——不发布`); process.exit(1); }
log("全部断言通过 ✓");
