# patches/ —— 客户端改造规则

> **不含任何原版文件。** 这里只有「改动点 + 少量上下文」规则，用来施加到**你自己持有**的官方客户端构建上。

## `client_rules.json`

来源：把**官方原始 H5 构建**（12,623 个文件）与改造版逐字节对比 —— **只有 9 个文件不同**，
这 9 个文件的每一处改动都导出成一条 `{find, replace}` 规则，共 **121 条**。

```json
{ "files": [ {
    "path": "assets/scriptAsset/index.js",
    "bytes_in": 5165669, "bytes_out": 5167156,
    "sha256_in": "…", "sha256_out": "…",
    "rules": [ { "find": "…原片段（带唯一上下文）…", "replace": "…新片段…" } ]
} ] }
```

| 文件 | 体积变化 | 规则数 |
|---|---|---|
| `index.html` | +615 B | 5 |
| `assets/main/index.js` | +566 B | 2 |
| `assets/scriptAsset/index.js` | +1487 B | 51 |
| `cocos2d-js-min.js` | +165 B | 3 |
| `assets/pzwj/import/8c/8c76ddfa-….json` | −768 B | 30 |
| `assets/pzwj/import/89/89203c37-….json` | −72 B | 24 |
| `assets/pzwj/import/32/322ae7cd-….json` | −3 B | 3 |
| `assets/pzwj/import/59/591892d5-….json` | −6 B | 2 |
| `assets/pzwj/import/6d/6dead4e8-….json` | −1919 B | 1 |

**规则特性（生成时已断言）**
- 规则必须**按数组顺序**施加
- 每条 `find` 在文件中**唯一命中**（上下文 40 ~ 2560 字符，不够唯一就自动加长）
- 全部规则施加完的结果 = 改造版**逐字节一致**（生成脚本自校验 + `apply_client_rules.py` 复校验）
- `sha256_in/out` 用于三态判定：**参考版本** → 施加并校验；**已是改造版** → 跳过（幂等）；**其它版本** → 逐条试施加，失败不写盘

## 用法
```bash
python tools/apply_client_rules.py --client "<你的客户端构建目录>" --check   # 先试跑
python tools/apply_client_rules.py --client "<你的客户端构建目录>"           # 施加（会写盘）
```

## 服务端为什么不在这里
服务端各版本差异更大、锚点对齐成本高于直接照清单改，因此**以清单形式给出**：
见 [`../docs/改造点清单.md`](../docs/改造点清单.md) §二 —— 18 个官方文件定点改动
+ 2 个存储层文件整文件替换（后者直接取 [`../shim/server_overrides/`](../shim/server_overrides/)）。
