# ruleset-adblock — HaGeZi 五档自建转换仓

将 [HaGeZi DNS Blocklists](https://github.com/hagezi/dns-blocklists) Multi 系列五档转换为双格式规则集并每日自动发布：

| 产物档位 | 对应 HaGeZi | 强度 | 规模（2026-11-23） | 适用 |
| --- | --- | --- | --- | --- |
| `hagezi-light` | Multi LIGHT（light.txt） | 基础 | 82,066 | 低误杀优先、低内存设备 |
| `hagezi-normal` | Multi NORMAL（multi.txt） | 均衡 | 188,620 | 日常默认可选 |
| `hagezi-pro` | Multi PRO（pro.txt，作者推荐档） | 加强 | 242,054 | **默认推荐** |
| `hagezi-proplus` | Multi PRO++（pro.plus.txt） | 进取 | 252,983 | 更激进，可接受少量误杀 |
| `hagezi-ultimate` | Multi ULTIMATE（ultimate.txt） | 最高 | 285,115 | 最激进，误杀风险最高 |

每档产物（以 `X` 代档位名）：

| 文件 | 格式 | 用途 |
| --- | --- | --- |
| `dist/X.srs` | sing-box source 编译（domain behavior） | sing-box 路由规则 / DNS 规则 |
| `dist/X.mrs` | mihomo domain mrs（`convert-ruleset` 生成） | mihomo rule-provider（路由 / nameserver-policy） |
| `dist/X.list` | mihomo payload（`+.域名` 行） | 人读与二次转换 |
| `dist/X.json` | sing-box source json | 透明可审计 |
| `dist/manifest.json` | 各档构建统计与上游版本 | 溯源 |

TIF（威胁情报叠加）不随档发布，需要时单独评估。

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
      { "rule_set": "allow-list", "outbound": "direct" },
      { "rule_set": "hagezi-pro", "action": "reject" }
    ]
  }
}
```

### sing-box（DNS 层）

```json
{ "dns": { "rules": [ { "rule_set": "hagezi-pro", "query_type": ["A", "AAAA"], "action": "reject" } ] } }
```

> DNS 层拒绝更高效（应用拿不到地址立即失败）；路由层拒绝在 fake-ip 场景按域名拒绝连接。二者选一或并存。URL 中 `hagezi-pro` 按需替换为其他档位。

## 放行例外（误杀防线）

`sources/allow.list`：**两用域 / 基础设施域在构建期剔除**（连网检测、NTP、云厂商基础设施等），不会出现在任何档位产物中。新增例外直接追加一行后触发 `workflow_dispatch`，或提 issue。

## 构建与本地验证

```bash
bun scripts/fetch.mjs     # 下载五档（主备双链重试 + ABP 头/行数下限校验 + 新鲜度告警）
bun scripts/build.mjs     # 逐档解析 → 剔除 → 去重 → json/list/srs/mrs
bun scripts/assert.mjs    # 逐档断言矩阵（探针域 + 规模阈值 + decompile 读回）
```

- 各档规模下限（`sources/upstream.txt` 的 `floor=`）：light 60000 / normal 150000 / pro 200000 / proplus 210000 / ultimate 240000，低于下限即中止发布。
- 依赖：Bun、`sing-box` v1.14.4、`mihomo` v1.19.34（PATH 或 `SINGBOX_BIN`/`MIHOMO_BIN`）。
- 五档首建验证（2026-11-23）：五档 58 项断言全绿；剔除两用域 light 1 / normal 3 / pro 4 / proplus 4 / ultimate 5 条；pro 上游自身由 281,640 缩至 242,058（上游清理，新鲜度告警按设计触发）。构建记录见 `dist/manifest.json`。

## CI

`.github/workflows/update.yml`：每日 UTC 21:00 自动构建五档；**任一档断言失败不提交**；产物无变化跳过提交；上游失败沿用本地缓存并 `::warning`。

## 许可

HaGeZi 名单遵循 [GPL-3.0](https://github.com/hagezi/dns-blocklists/blob/main/LICENSE)；本仓转换产物与脚本同以 GPL-3.0 发布。名单内容归 HaGeZi 所有。
