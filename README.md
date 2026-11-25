# ruleset-adblock — HaGeZi 五档自建转换仓

将 [HaGeZi DNS Blocklists](https://github.com/hagezi/dns-blocklists) Multi 系列五档转换为双内核规则集并每日自动发布：

| 产物档位 | 对应 HaGeZi | 强度 | 规模（2026-11-25 上游） | 适用 |
| --- | --- | --- | --- | --- |
| `hagezi-light` | Multi LIGHT（light.txt） | 基础 | 85,415 | 低误杀优先、低内存设备 |
| `hagezi-normal` | Multi NORMAL（multi.txt） | 均衡 | 191,221 | 日常默认可选 |
| `hagezi-pro` | Multi PRO（pro.txt，作者推荐档） | 加强 | 247,196 | **默认推荐** |
| `hagezi-proplus` | Multi PRO++（pro.plus.txt） | 进取 | 263,171 | 更激进，可接受少量误杀 |
| `hagezi-ultimate` | Multi ULTIMATE（ultimate.txt） | 最高 | 291,363 | 最激进，误杀风险最高 |

每档产物（以 `X` 代档位名）：

| 文件 | 格式 | 用途 |
| --- | --- | --- |
| `dist/X.srs` | sing-box source 编译（domain 语义） | sing-box 路由规则 / DNS 规则 |
| `dist/X.mrs` | mihomo domain mrs（`convert-ruleset` 生成） | mihomo `rule-providers`（路由 / `nameserver-policy`） |
| `dist/X.list` | mihomo domain text（`+.域名` 行，`behavior: domain, format: text`） | 人读与二次转换 |
| `dist/X.json` | sing-box source json（version 3） | 透明可审计 |
| `dist/manifest.json` | 各档构建统计与上游版本 | 溯源（内容未变时幂等保留时间戳） |

TIF（威胁情报叠加）与 DoH/VPN-Bypass 类名单不随档发布，避免阻断自用加密 DNS 造成自杀。

## 使用

### mihomo

```yaml
rule-providers:
  hagezi-pro:                      # 档位可换 light / normal / proplus / ultimate
    type: http
    behavior: domain
    format: mrs
    url: "https://cdn.jsdelivr.net/gh/ikreva/ruleset-adblock@main/dist/hagezi-pro.mrs"
    path: ./ruleset/hagezi-pro.mrs
    interval: 86400
rules:
  # 放行例外必须置于广告集之前
  - RULE-SET,allow-list,DIRECT
  - RULE-SET,hagezi-pro,REJECT
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
      { "rule_set": "allow-list", "outbound": "direct" },
      { "rule_set": "hagezi-pro", "action": "reject" }
    ]
  }
}
```

### sing-box（DNS 层硬拒绝，模式 A）

```json
{
  "dns": {
    "rules": [
      { "rule_set": "hagezi-pro", "action": "predefined", "rcode": "NXDOMAIN" }
    ]
  }
}
```

> **互斥原则**：在「DNS 层硬拒绝（零 Fake-IP 分配、零连接建立；置于 Fake-IP 规则之前且不限 `query_type`，一并拦截 `HTTPS`/`SVCB`）」与「面板可切换开关组（仅路由层指向 `[REJECT, DIRECT]` 组、不进 DNS 拒绝）」之间二选一，勿混写导致面板开关失效。URL 中 `hagezi-pro` 按需替换为其他档位。

## 放行例外（误杀防线）

`sources/allow.list`：**两用域 / 基础设施域在构建期双向剔除**（连网检测/Captive Portal、NTP、公共加密 DNS 防自杀），既剔除其自身与全部子域，也阻断任何会覆盖它们的上游父域。新增例外直接追加一行后触发 `workflow_dispatch`，或提 issue。

## 构建与本地验证

```bash
bun scripts/fetch.mjs     # 下载五档（主备双链重试 + ABP 头/行数下限校验 + 新鲜度告警 + 无变化幂等跳过）
bun scripts/build.mjs     # 逐档解析 → 双向剔除 → 后缀剪枝 → json/list/srs/mrs
bun scripts/assert.mjs    # 逐档断言矩阵（全量 allow.list + 探针域 + 规模阈值 + SRS 反编译读回 + MRS Zstd/头校验）
```

- 各档规模下限（`sources/upstream.txt` 的 `floor=`）：light 60000 / normal 150000 / pro 200000 / proplus 210000 / ultimate 240000，低于下限即中止发布。
- 依赖：Bun、`sing-box` v1.14.4、`mihomo` v1.19.34（PATH 或 `SINGBOX_BIN`/`MIHOMO_BIN`）。
- 断言过程所有临时反编译文件均写入系统临时目录并自动清理，绝不污染 `dist/`。构建记录见 `dist/manifest.json`。

## CI

`.github/workflows/update.yml`：每日 UTC 21:00 自动构建五档（含并发互斥保护）；**任一档断言失败不提交**；上游与构建统计无变化时幂等跳过提交；上游失败沿用本地缓存并 `::warning`。

## 许可

HaGeZi 名单遵循 [GPL-3.0](https://github.com/hagezi/dns-blocklists/blob/main/LICENSE)；本仓转换产物与脚本同以 GPL-3.0 发布。名单内容归 HaGeZi 所有。
