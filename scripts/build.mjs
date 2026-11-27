#!/usr/bin/env bun
// build.mjs — 解析 adblock 名单（五档）→ 准入双向剔除 → 后缀剪枝 → 双格式产物（json / srs / mrs / list）
// 用法：bun scripts/build.mjs  （在仓库根目录执行；需要 PATH 中有 sing-box 与 mihomo，
//       或用环境变量 SINGBOX_BIN / MIHOMO_BIN 指定二进制）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const singbox = process.env.SINGBOX_BIN ?? "sing-box";
const mihomo = process.env.MIHOMO_BIN ?? "mihomo";
const log = (s) => console.log("[build] " + s);
const fail = (s) => { console.error("[build][错误] " + s); process.exit(1); };

// 严格域名格式（排除 IPv4/非法字符/单标签）
const VALID_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// 允许视为全域名封锁的 ABP 修饰符（不含条件限定或重写）
const SAFE_BLOCK_MODIFIERS = new Set(["important", "all"]);

function run(bin, args, label) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 120000 });
  if (r.error) fail(`${label} 无法启动：${r.error.message}`);
  if (r.status !== 0) fail(`${label} 失败（退出码 ${r.status}）：${(r.stderr || r.stdout || "").slice(0, 500)}`);
  return r;
}

// 档位清单与规模下限来自 sources/upstream.txt（与 fetch.mjs 同一解析规则）
function parseUpstream(text) {
  const lists = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s+@\s+(\S+)(?:\s+\|\s+(\S+))?(?:\s+#\s*floor=(\d+))?$/);
    if (!m) fail(`upstream.txt 行无法解析：${line}`);
    if (!m[4]) fail(`upstream.txt 条目 ${m[1]} 缺少 floor=N 下限声明`);
    lists.push({ name: m[1], floor: Number(m[4]) });
  }
  if (!lists.length) fail("upstream.txt 无有效条目");
  return lists;
}

function loadAllow(file) {
  if (!existsSync(file)) return [];
  const entries = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(l => l.split("#", 1)[0].trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(entries)];
}

function parseAbpDomain(body) {
  let d = body.toLowerCase();
  if (d.endsWith("^")) d = d.slice(0, -1);
  if (!d || IPV4_RE.test(d) || !VALID_DOMAIN_RE.test(d)) return null;
  return d;
}

// 双向校验：剔除 allow 自身及其子域，同时阻断任何会误杀 allow 条目的父域
function allowConflict(domain, allow) {
  for (const a of allow) {
    if (domain === a || domain.endsWith("." + a)) return { type: "sub", target: a };
    if (a.endsWith("." + domain)) return { type: "ancestor", target: a };
  }
  return null;
}

// O(N * labels) 后缀包含剪枝：若父后缀已在集合中，移除冗余子后缀
function pruneRedundantSuffixes(set) {
  let pruned = 0;
  for (const d of [...set]) {
    let idx = d.indexOf(".");
    while (idx !== -1) {
      const parent = d.slice(idx + 1);
      if (set.has(parent)) {
        set.delete(d);
        pruned++;
        break;
      }
      idx = d.indexOf(".", idx + 1);
    }
  }
  return pruned;
}

const tiers = parseUpstream(readFileSync(join(root, "sources", "upstream.txt"), "utf8"));
const allow = loadAllow(join(root, "sources", "allow.list"));
const meta = existsSync(join(root, "upstream", "meta.json"))
  ? JSON.parse(readFileSync(join(root, "upstream", "meta.json"), "utf8")) : {};

const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const manifestTiers = {};

for (const { name, floor } of tiers) {
  const stats = {
    raw: 0,
    block: 0,
    upstreamAllow: 0,
    skippedModifier: 0,
    invalid: 0,
    excluded: 0,
    pruned: 0,
    final: 0,
  };
  const block = new Set();
  const upstreamAllow = new Set();
  const badfilters = new Set();

  const text = readFileSync(join(root, "upstream", `${name}.txt`), "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("[Adblock")) continue;

    // 上游自带放行规则 @@||domain^（仅处理无条件或安全修饰符的全局放行）
    if (line.startsWith("@@")) {
      stats.upstreamAllow++;
      if (line.startsWith("@@||")) {
        const rest = line.slice(4);
        const dollar = rest.indexOf("$");
        let body = rest;
        let safe = true;
        if (dollar !== -1) {
          body = rest.slice(0, dollar);
          const mods = rest.slice(dollar + 1).toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
          safe = mods.every(m => SAFE_BLOCK_MODIFIERS.has(m));
        }
        if (safe) {
          const d = parseAbpDomain(body);
          if (d) upstreamAllow.add(d);
        }
      }
      continue;
    }

    if (!line.startsWith("||")) { stats.invalid++; continue; }
    stats.raw++;

    const rest = line.slice(2);
    const dollar = rest.indexOf("$");
    let body = rest;
    if (dollar !== -1) {
      body = rest.slice(0, dollar);
      const mods = rest.slice(dollar + 1).toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
      if (mods.includes("badfilter")) {
        const d = parseAbpDomain(body);
        if (d) badfilters.add(d);
        stats.skippedModifier++;
        continue;
      }
      if (!mods.every(m => SAFE_BLOCK_MODIFIERS.has(m))) {
        stats.skippedModifier++;
        continue;
      }
    }

    const d = parseAbpDomain(body);
    if (!d) { stats.invalid++; continue; }
    stats.block++;
    block.add(d);
  }

  // 扣除上游 $badfilter 撤销条目与 @@ 放行（双向剔除子域与覆盖它的父域）
  for (const d of badfilters) block.delete(d);
  if (upstreamAllow.size) {
    const upAllowArr = [...upstreamAllow];
    for (const d of [...block]) {
      if (allowConflict(d, upAllowArr)) block.delete(d);
    }
  }

  // ---------- 双向剔除（allow.list：子域 + 误杀父域） ----------
  for (const d of [...block]) {
    const conflict = allowConflict(d, allow);
    if (conflict) {
      if (conflict.type === "ancestor") {
        log(`⚠ ${name} 剔除误杀父域 ${d}（会覆盖 allow.list 中的 ${conflict.target}）`);
      }
      block.delete(d);
      stats.excluded++;
    }
  }

  // ---------- 后缀包含剪枝 ----------
  stats.pruned = pruneRedundantSuffixes(block);

  const sorted = [...block].sort();
  stats.final = sorted.length;
  log(
    `${name} 解析完成：原始 ${stats.block} 条 → 剔除两用域 ${stats.excluded} → 后缀剪枝 ${stats.pruned} → 最终 ${stats.final} 条`
  );
  if (stats.final < floor) fail(`${name} 最终条数 ${stats.final} 低于规模阈值 ${floor}，中止发布`);
  if (!sorted.length) fail(`${name} 产出为空`);

  // ---------- 产物 ----------
  // sing-box source（domain_suffix，不含前导点——sing-box 后缀匹配含自身）
  const source = { version: 3, rules: [{ domain_suffix: sorted }] };
  writeFileSync(join(dist, `${name}.json`), JSON.stringify(source) + "\n");

  // mihomo domain text（+.d 行，behavior: domain, format: text）
  const payload = sorted.map(d => "+." + d).join("\n") + "\n";
  writeFileSync(join(dist, `${name}.list`), payload);

  manifestTiers[name] = { upstream: meta[name] ?? {}, stats, floor };

  // ---------- 编译 ----------
  log(`编译 ${name}.srs（sing-box rule-set compile）...`);
  run(singbox, ["rule-set", "compile", "-o", join(dist, `${name}.srs`), join(dist, `${name}.json`)], `sing-box compile ${name}`);
  log(`编译 ${name}.mrs（mihomo convert-ruleset）...`);
  run(mihomo, ["convert-ruleset", "domain", "text", join(dist, `${name}.list`), join(dist, `${name}.mrs`)], `mihomo convert-ruleset ${name}`);
}

// manifest 幂等写入：若 allowCount 与 tiers 均未变化则沿用旧 generatedAt，避免无意义 git diff
const manifestPath = join(dist, "manifest.json");
const prevManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
const unchanged = prevManifest
  && prevManifest.allowCount === allow.length
  && JSON.stringify(prevManifest.tiers) === JSON.stringify(manifestTiers);

const nextManifest = {
  generatedAt: unchanged ? prevManifest.generatedAt : new Date().toISOString(),
  allowCount: allow.length,
  tiers: manifestTiers,
};
writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2) + "\n");

log(`build 阶段完成：${tiers.map(t => t.name).join(" / ")} 的 {json,srs,mrs,list} + manifest.json`);
