# ruleset-adblock — HaGeZi Pro 自建转换仓

将 [HaGeZi DNS Blocklists](https://github.com/hagezi/dns-blocklists)（**pro** 档）转换为双格式规则集并每日自动发布：

| 产物 | 格式 | 用途 |
| --- | --- | --- |
| `dist/hagezi-pro.srs` | sing-box source 编译（domain behavior） | sing-box 路由规则 / DNS 规则 |
| `dist/hagezi-pro.mrs` | mihomo domain mrs（`convert-ruleset` 生成） | mihomo rule-provider（路由 / nameserver-policy） |
| `dist/hagezi-pro.list` | mihomo payload（`+.域名` 行） | 人读与二次转换 |
| `dist/hagezi-pro.json` | sing-box source json | 透明可审计 |
| `dist/manifest.json` | 构建统计与上游版本 | 溯源 |

## 使用

### mihomo

```yaml
rule-providers:
  hagezi-pro:
    type: http
    behavior: domain
    format: mrs
    url: "https://cdn.jsdelivr.net/gh/ikreva/ruleset-adblock@main/dist/hagezi-pro.mrs"
    path: ./ruleset/hagezi-pro.mrs
    interval: 86400
rules:
  - RULE-SET,hagezi-pro,REJECT
  # 放行例外必须置于广告集之前
  - RULE-SET,allow-list,DIRECT
  - MATCH,默认代理
```

### sing-box（路由层）

```json
{
  "route": {
    "rule_set": [
      { "type": "remote", "tag": "hagezi-pro", "format": "binary",
        "url": "https://cdn.jsdelivr.net/gh/ikreva/ruleset-adblock@main/dist/hagezi-pro.srs" }
    ],
    "rules": [
      { "inbound": "dns-in", "protocol": "dns", "action": "hijack-dns" },
      { "rule_set": "hagezi-pro", "action": "reject" },
      { "rule_set": "allow-list", "outbound": "direct" }
    ]
  }
}
```

### sing-box（DNS 层）

```json
{ "dns": { "rules": [ { "rule_set": "hagezi-pro", "query_type": ["A", "AAAA"], "action": "reject" } ] } }
```

> DNS 层拒绝更高效（应用拿不到地址立即失败）；路由层拒绝在 fake-ip 场景按域名拒绝连接。二者选一或并存。

## 放行例外（误杀防线）

`sources/allow.list`：**两用域 / 基础设施域在构建期剔除**（连网检测、NTP、云厂商基础设施等），不会出现在产物中。新增例外直接追加一行后触发 `workflow_dispatch`，或提 issue。

## 构建与本地验证

```bash
bun scripts/fetch.mjs     # 下载（主备双链重试 + ABP 头/行数校验 + 新鲜度告警）
bun scripts/build.mjs     # 解析 → 剔除 → 去重 → json/list/srs/mrs
bun scripts/assert.mjs    # 断言矩阵（探针域 + 规模阈值 + decompile 读回）
```

依赖：Bun、`sing-box` v1.14.4、`mihomo` v1.19.34（PATH 或 `SINGBOX_BIN`/`MIHOMO_BIN`）。构建记录见 `dist/manifest.json`（上游版本 2026.1122.1534.57 首建验证：原始 281640 → 剔除 4 → 281636）。

## CI

`.github/workflows/update.yml`：每日 UTC 21:00 自动构建；**任一断言失败不提交**；产物无变化跳过提交；上游失败沿用本地缓存并 `::warning`。

## 许可

HaGeZi 名单遵循 [GPL-3.0](https://github.com/hagezi/dns-blocklists/blob/main/LICENSE)；本仓转换产物与脚本同以 GPL-3.0 发布。名单内容归 HaGeZi 所有。
