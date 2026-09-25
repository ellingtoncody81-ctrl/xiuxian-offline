# 提交与分支规范

目标：让看历史的人 30 秒内知道每个版本做了什么。

## 一、标题：`<type>(<scope>): <描述>`
```
fix(douluo): 榜位对手改为与战斗同源
feat(tools): 新增合成概率查询页面
docs: 补上「永久不开启的活动」判定标准
```
- 标题 ≤ **50 字**（硬上限 72），不加句号，动词开头，只写「做了什么」
- **版本号不写进标题**（用 git tag 表达）；症状/原因写正文
- type / scope 用小写英文（便于过滤与被工具解析），描述用中文

| type | 用途 | 本项目 scope |
|---|---|---|
| `feat` | 新功能 | `douluo` 榜位 / `arena` 竞技场 / `boss` 仙盟BOSS / `xianlv` 仙侣 |
| `fix` | 修 bug | `launcher` 启动器 / `ai` AI 网关 / `redis` 垫片 / `tools` 工具 |
| `docs` | 文档 | `repo` 仓库工程 |
| `chore` `refactor` `perf` `test` `build` `revert` | 常规语义 | — |

## 二、正文（必写）
```
为什么这么改（问题/现象/根因）
改法（关键点，2~3 行）
验证（实测数据 / 用户可见效果）
```
`git commit` 会带出 `.gitmessage` 模板。

## 三、分支与合并
- `main` 始终保持可用；改动走短分支 `fix/xxx`、`feat/xxx`、`docs/xxx`
- 合并用 **Squash**（GitHub 上点 Squash and merge）⇒ `main` 上每个功能只留 1 条提交
- 合并后删分支

## 四、版本与发布
- 版本号只出现在 **git tag** 与 `CHANGELOG.md`
- 发布：`git tag -a v1.0 -m "..."` + 在 `CHANGELOG.md` 顶部加一节

## 五、红线
- **不提交任何第三方游戏资源**（客户端 / 服务端 / 素材 / 配置表）
- 不提交密钥：`ai-config.json` 已被 `.gitignore` 忽略，仓库里只留 `ai-config.example.json`
- 单文件 > 100MB 不能推 GitHub

## 六、启用规范工具（每台机器一次）
```bash
git config commit.template .gitmessage
git config core.hooksPath tools/git-hooks
```
临时跳过校验：`git commit --no-verify`
