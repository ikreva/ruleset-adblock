#!/usr/bin/env bun
// fetch.mjs — 下载 HaGeZi 上游名单（五档，主备双链 + 重试 + 输入校验 + 新鲜度告警 + 幂等跳过）
// 用法：bun scripts/fetch.mjs  （在仓库根目录执行）
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const upstreamFile = join(root, "sources", "upstream.txt");
const outDir = join(root, "upstream");
const metaFile = join(outDir, "meta.json");
const FRESH_RATIO = 0.95;      // 新鲜度：较上次 <95% 告警
const STALE_DAYS = 5;          // 连续拉取失败距上次成功超过该天数时红灯终止
const RETRIES = 3;

const log = (s) => console.log("[fetch] " + s);
const fail = (s) => { console.error("[fetch][错误] " + s); process.exit(1); };
const sha256Short = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const daysSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 86400000 : 0);

// 行格式：<名称> @ <主链> [| <备链>] [# floor=N]；floor 必填（每档规模差异大，不允许缺省）
function parseUpstream(text) {
  const lists = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s+@\s+(\S+)(?:\s+\|\s+(\S+))?(?:\s+#\s*floor=(\d+))?$/);
    if (!m) fail(`upstream.txt 行无法解析：${line}`);
    if (!m[4]) fail(`upstream.txt 条目 ${m[1]} 缺少 floor=N 下限声明`);
    lists.push({ name: m[1], urls: [m[2], ...(m[3] ? [m[3]] : [])], floor: Number(m[4]) });
  }
  if (!lists.length) fail("upstream.txt 无有效条目");
  return lists;
}

async function download(url, floor) {
  for (let i = 1; i <= RETRIES; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.startsWith("[Adblock Plus")) throw new Error("缺少 ABP 头（可能是错误页）");
      const blockLines = text.split(/\r?\n/).filter(l => l.startsWith("||")).length;
      if (blockLines < floor) throw new Error(`|| 行数 ${blockLines} 低于下限 ${floor}`);
      return { text, blockLines };
    } catch (e) {
      log(`第 ${i}/${RETRIES} 次失败 ${url}：${e.message}`);
      if (i === RETRIES) throw e;
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}

const lists = parseUpstream(readFileSync(upstreamFile, "utf8"));
const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
mkdirSync(outDir, { recursive: true });
let metaChanged = false;
const staleFailures = [];

for (const { name, urls, floor } of lists) {
  log(`拉取 ${name}：${urls[0]}`);
  let got = null;
  const errors = [];
  for (const url of urls) {
    try { got = { url, ...(await download(url, floor)) }; break; }
    catch (e) { errors.push(`${url} → ${e.message}`); }
  }
  const dest = join(outDir, `${name}.txt`);
  if (!got) {
    if (existsSync(dest)) {
      const stale = daysSince(meta[name]?.fetchedAt);
      if (stale >= STALE_DAYS) {
        const msg = `${name} 上游拉取失败且缓存已过期 ${stale.toFixed(1)} 天（上限 ${STALE_DAYS} 天）`;
        console.log(`::error::${msg}`);
        staleFailures.push(msg);
        continue;
      }
      log(`⚠ 主备均失败，沿用本地旧文件继续构建：${errors.join("; ")}`);
      console.log(`::warning::${name} 上游全部失败，沿用本地缓存`);
      continue;
    }
    fail(`主备均失败且无本地缓存：${errors.join("; ")}`);
  }

  const normalized = got.text.replace(/\r\n/g, "\n");
  const existing = existsSync(dest) ? readFileSync(dest, "utf8").replace(/\r\n/g, "\n") : null;
  const version = ((normalized.match(/^! Version:\s*(.+)$/m) ?? [])[1] ?? "").trim();
  const modified = ((normalized.match(/^! Last modified:\s*(.+)$/m) ?? [])[1] ?? "").trim();

  if (existing !== null && existing === normalized && meta[name]?.version === version) {
    log(`${name} 无变化（${got.blockLines} 条，版本 ${version || modified || "未知"}），保留缓存与时间戳`);
    continue;
  }

  writeFileSync(dest, normalized);
  const prev = meta[name]?.blockLines;
  if (prev && got.blockLines < prev * FRESH_RATIO) {
    console.log(`::warning::${name} 行数骤降：${prev} → ${got.blockLines}（<95%），请核查上游`);
  }
  meta[name] = {
    url: got.url,
    blockLines: got.blockLines,
    version,
    modified,
    sha256: sha256Short(normalized),
    fetchedAt: new Date().toISOString(),
  };
  metaChanged = true;
  log(`${name} 完成：${got.blockLines} 条 || 规则，上游版本 ${version || modified || "未知"}`);
}

if (metaChanged || !existsSync(metaFile)) {
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
}
if (staleFailures.length) {
  fail(`存在过期缓存红灯：${staleFailures.join("; ")}`);
}
log("fetch 阶段完成");
