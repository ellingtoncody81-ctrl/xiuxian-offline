# 架构与实现（离线化改造）

## 1. 运行形态：把服务端塞进桌面进程
原始形态是「客户端 → HTTP → 常驻服务端 → MySQL / Redis」。
改造后：

```
Electron 主进程
├─ BrowserWindow ── loadURL(http://127.0.0.1:<port>/)   ← 官方 H5 客户端（静态资源）
├─ local-server.js   静态文件服务（把客户端构建目录挂到本地 http）
└─ require('./_solo_boot').start({ dbDir })
     └─ 官方 Koa app 在本进程内 listen()  →  打印 SOLO_READY <port>
```
- **没有独立服务进程**，也没有多进程启停顺序问题（这是"要启动两次"类 bug 的根源）
- 端口冲突、`window-all-closed` 竞态、多实例互踩都在启动器层解决
- 数据目录可由命令行指定，便于"一个目录一个存档集"

## 2. 存储：MySQL → JSON，Redis → JSON 快照 + 语义垫片
| 原 | 现 | 做法 |
|---|---|---|
| MySQL 表 | `db/<库>/<表>.json` | 表级 JSON 文件，读写走同一层 DAO；启动时自动备份到 `db-backups/<时间戳>/` |
| Redis（zset / kv / 过期） | `solo_redis_ph.json` 快照 + 垫片 | 垫片按官方调用契约实现 `zAdd / zRange / expire ...`，**业务代码 0 改动** |
| 定时任务 | 进程内定时器 | 快 tick（如结算 90 秒）替代长周期轮询，保证"离线也动" |

## 3. 垫片层（11 个模块）：运行时接管为主，少量定点改动为辅
通过 require 钩子在模块加载后替换/包裹官方导出的内部函数，例如：
- `_solo_boot.js`  离线启动入口（`start({dbDir})`、打印 `SOLO_READY`、自动备份）
- `_solo_priv.js` / `_solo_reddot.js` / `_solo_gm_mail.js`  私有化改造、红点、GM 邮件
- `_solo_online.js` "在线"状态维护（让人物看起来在线）
- `_solo_powertest.js`  战力自测（用于平衡验证）
- `_solo_agents.js` / `_solo_fakes*.js`  假人系统（见下）
- `_solo_ai.js`  AI 网关

配套的两份**存储替换**（`shim/server_overrides/`）：
- `src/util/redis.js`   官方那份是连真 Redis 的封装（839 行 TS）→ 换成 JSON 快照 + 语义垫片
- `src/util/mongodb.js` 官方那份是连真 Mongo 的封装（720 行 TS）→ 换成 JSON 文件库

**收益**：绝大部分改造不碰官方文件；升级官方包时只需重新对齐少数锚点。
**代价（要诚实说）**：仍有 **18 个服务端官方文件**必须做「带标记的定点插入/替换」——
它们要么在函数体内部生效（登录链路、战斗阵容构造），要么是官方 bug；
逐条列在 [`改造点清单.md`](改造点清单.md)，每条都带注释标记，便于版本对齐。

## 4. 假人系统：让离线世界"有活人感"
- **规模**：L1 假人 200（分布在若干"盟"里）+ L2 活跃 NPC 100
- **行为**：世界频道聊天、竞技场挑战、仙盟 BOSS 输出、榜单占位
- **生成方式**：由「种子 + 序号 + 档位」确定性生成档案（战力/仙侣/技能），保证**同一 id 每次结果一致**（否则会出现"详情页显示的人物 ≠ 战斗中的人物"这类不一致）
- **强度分档**：按积分/名次映射档位系数，可整体升降（如竞技场高分段系数 1.00 → 0.45）
- **文案**：优先走 AI 网关；未配置 key 时退回内置台词库（0ms、无异常）

## 5. AI 网关：可插拔 + 优雅降级
```js
ask({ system, user, maxTokens }) → Promise<string|null>
```
- 兼容 Anthropic / OpenAI 协议（`base` 可指向自建代理）
- 配置文件查找四级回退：`SOLO_AI_CONFIG` → 根目录 `ai-config.json` → 根目录 `ai-config.txt` → 旧位置
- 容错解析：JSON 优先，否则按 `key=value` 逐行读（支持 `#` / `//` 注释、引号、行尾逗号）
- **无 key ⇒ 直接返回 `null`（0ms）**，业务侧自动降级，不抛异常

## 6. 客户端补丁：最小改动
拿官方原始构建（1.26 万文件）与改造后逐字节对比，**只有 9 个文件不同**：
```
index.html                        启动页调整（+615 B）
assets/main/index.js              入口逻辑（+566 B）
assets/scriptAsset/index.js       客户端主逻辑：登录 / 红点 / 引导分流（+1487 B，散布多处）
cocos2d-js-min.js                 引擎层兼容性小改（+165 B）
assets/pzwj/import/**.json        5 个数据资源：文案与条目调整（-1919 / -768 / -72 / -6 / -3 B）
```
改动点与意图逐条见 [`改造点清单.md`](改造点清单.md)。

## 7. 工程化
- Conventional Commits + `tools/git-hooks/commit-msg` 校验（不合规直接拦下）
- `CHANGELOG.md` 按版本分节；版本号走 git tag
