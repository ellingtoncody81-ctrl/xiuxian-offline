"use strict";
/**
 * [单机版托管引导 v1] _solo_boot.js
 * ------------------------------------------------------------------
 * 不修改任何业务代码：用真 koa + 真中间件链（逐字移植自 dist/app.js），
 * 仅跳过 cluster / worker_threads / worker_thread.js，改为进程内监听随机端口。
 * 数据库/redis 由同目录 src/util/mongodb.js、redis.js 两个垫片承接（JSON/内存）。
 *
 * 用法一（进程内，Electron 主进程）：
 *   const { start } = require('<dist目录>/_solo_boot');
 *   const { port, close } = await start({ dbDir: 'D:\\...\\app\\db' });
 * 用法二（命令行冒烟）：
 *   node _solo_boot.js [dbDir]     → 打印 "SOLO_READY <port>"
 *
 * ------------------------------------------------------------------
 * ⛔ 永久不开启的活动（2026-09-21 用户决定）：
 *   登神榜 hdDengShen —— 明确不做；另有 10 个官方活动无配置数据，同样不会开启。
 *   规则：除非用户明确要求，不要给这些 key 添加 a_huodong 配置行
 *         （没有配置行 = 服务端不下发 = 客户端不显示入口）。
 *   清单与理由见根目录 README.md「⛔ 永久不开启的活动」。
 */
const fs = require("fs");
const path = require("path");
const koa = require("koa");
const koaCors = require("koa2-cors");
const koaBodyparser = require("koa-bodyparser");

const tool_1 = require("./src/util/tool");
const master_1 = require("./src/util/master");
const mongodb_1 = require("./src/util/mongodb");
const redis_1 = require("./src/util/redis");
const lock_1 = require("./src/util/lock");
const game_1 = require("./src/util/game");
const gameMethod_1 = require("./common/gameMethod");
const gameCfg_1 = require("./common/gameCfg");
const setting_1 = require("./src/crontab/setting");
const ActAdokSevModel_1 = require("./src/model/act/ActAdokSevModel");

const _def = (m) => (m && m.__esModule && m.default !== undefined) ? m.default : m;
const game = _def(game_1);
const lock = _def(lock_1);
const gameCfg = _def(gameCfg_1);
const Setting = _def(setting_1);
const tool = tool_1.tool;

async function start(opts) {
    opts = opts || {};
    if (opts.dbDir) process.env.SOLO_DB_DIR = opts.dbDir;

    if (await mongodb_1.dbSev.init() !== true) throw new Error("dbSev.init 失败");
    if (await redis_1.redisSev.init() !== true) throw new Error("redisSev.init 失败");
    try { gameCfg.init(); } catch (e) { console.error("[solo-be] gameCfg.init 异常", e && e.message); }

    // ===== 主进程职责（等价于原 worker_thread.js 的启动段，去掉 cluster 相关） =====
    try { await tool.mongoTableCount(); } catch (e) { console.error("[solo-be] mongoTableCount 异常", e && e.message); }
    try { await tool.mongoIndex(2); } catch (e) { console.error("[solo-be] mongoIndex 异常", e && e.message); }
    try { await tool.mongoFlow(2); } catch (e) { console.error("[solo-be] mongoFlow 异常", e && e.message); }
    try { await redis_1.redisSev.getRedis(master_1.DataType.user).del("fBackBuf"); } catch (e) { }
    // [v4.6.2] await 它：crontabStart_zhu 内部会立刻跑一次 createCash（15 秒节流阀）
    //   之前没 await → boot 随后的 createCash 被 nextAt 节流跳过 → createAt 恒 0 → qufus 空
    //   → 限时活动任务钩子（refreHook）读 getQufus()[sid].heid 崩 → dongtian/lache 等全挂
    try { await require("./src/crontab/start").crontabStart_zhu(); } catch (e) { console.error("[solo-be] crontabStart_zhu 异常", (e && e.message)); }
    // 立即生成一次活动/区服缓存（否则 Setting.createAt=0，全部请求被“服务器繁忙”拦截）
    try {
        const _nowT = game.getNowTime();
        await Setting.createCash(game.getToDay_0(_nowT), _nowT, false);
        // [v4.6.2] 兜底：若区服缓存仍为空（被节流跳过/crontab 后台未及时完成），直接补建
        if (gameMethod_1.gameMethod.isEmpty(Setting.qufus)) {
            if (gameMethod_1.gameMethod.isEmpty(Setting.a_qufus)) {
                let fa = {};
                for (const _r of await mongodb_1.dbSev.getDataDb().find("a_qufu")) fa[_r.sid] = _r;
                Setting.a_qufus = fa;
            }
            await Setting.qufuCash(game.getToDay_0(_nowT), _nowT);
        }
        console.log("[solo-be] 活动缓存就绪 createAt=" + Setting.createAt + " qufus=[" + Object.keys(Setting.qufus || {}).join(",") + "]");
    } catch (e) { console.error("[solo-be] createCash 异常", (e && e.stack) || e); }

    // ===== 假人/榜单填充：把配置表里的 NPC 预填进榜单（竞技场榜/对手） =====
    try { await require("./_solo_fakes").seedFakes(); } catch (e) { console.error("[solo-be] seedFakes 异常", (e && e.stack) || e); }
    // ===== 假人真人化引擎 v3：模块实体化 + 随玩家战力成长 + 聊天回复 =====
    try { await require("./_solo_fakes2").init(); } catch (e) { console.error("[solo-be] fakes2 异常", (e && e.stack) || e); }
    // ===== 假人真人化引擎 v4：M3 洞天矿车 + 仙盟成员/BOSS 血线 =====
    try { await require("./_solo_fakes3").init(); } catch (e) { console.error("[solo-be] fakes3 异常", (e && e.stack) || e); }
    // ===== GM 福利邮件（幂等）：开服庆典限定·道童皮肤 [6,100001]（活动永不开启 → 改直发）=====
    try {
        const _gm = await require("./_solo_gm_mail").grantAll();
        if (_gm && _gm.ok) console.log("[solo-be] GM邮件: " + _gm.report[_gm.report.length - 1]);
    } catch (e) { console.error("[solo-be] GM邮件 异常", (e && e.stack) || e); }
    // ===== 智能体引擎：NPC+假人统一调度（聊天/行动；AI 插槽可配置） =====
    try { await require("./_solo_agents").init(); } catch (e) { console.error("[solo-be] agents 异常", (e && e.stack) || e); }


    const app = new koa();
    app.use(koaCors({
        origin: function () { return "*"; },
        maxAge: 3600,
        credentials: false,
        allowMethods: ["GET", "POST"],
        allowHeaders: ["Content-Type", "Authorization", "Accept"],
    }));
    app.use(koaBodyparser({ enableTypes: ["json", "form", "text"] }));

    const DBG = !!process.env.SOLO_DEBUG;
    app.on("error", (err) => { console.error("[dbg:koa-error]", (err && err.stack) || err); });

    // 最外层侦测（无论链子里发生什么，这里都能记录最终状态）
    app.use(async (ctx, next) => {
        try { await next(); }
        catch (e) { console.error("[dbg:outer-catch]", ctx.url, (e && e.stack) || e); ctx.status = 599; }
        finally { if (DBG) console.log("[dbg:outer] " + ctx.url + " status=" + ctx.status + " hasBody=" + !!ctx.body); }
    });
    app.use(async (ctx, next) => {
        if (DBG) console.log("[dbg:mw1] url=" + ctx.url + " createAt=" + Setting.createAt + " new0=" + ctx.state.new0);
        if (ctx.url == "/favicon.ico") return;
        let addAt = 0;
        let cfgAddTime = Setting.getSetting("1", "addTime");
        if (cfgAddTime != null && cfgAddTime["add"] != null) addAt += cfgAddTime["add"] * 86400;
        ctx.state.newTime = game.getNowTime() + addAt;
        ctx.state.new0 = game.getToDay_0(ctx.state.newTime);
        ctx.state.model = {};
        ctx.state.master = new master_1.Master(ctx);
        ctx.state.locks = [];
        ctx.state.addLock = true;
        ctx.state.apidesc = "";
        // 获取版本信息要让通过
        if (ctx.url.indexOf("/player/getVersion") == -1
            && ctx.url.indexOf("/player/btml") == -1
            && ctx.url.indexOf("/player/pay") == -1
            && ctx.url.indexOf("/player/btUuinfo") == -1) {
            // 关服维护
            let cfgCloseQufu = Setting.getSetting("1", "closeQufu");
            if (cfgCloseQufu != null && gameMethod_1.gameMethod.isEmpty(cfgCloseQufu.msg) == false) {
                let pass = false;
                let myIp = tool.getClientIP(ctx);
                let cfgSystem = Setting.getSetting("1", "system");
                if (cfgSystem != null && cfgSystem.ips != null && cfgSystem.ips.length > 0) {
                    for (const _ip of cfgSystem.ips) {
                        if (myIp.indexOf(_ip) != -1) { pass = true; break; }
                    }
                }
                if (pass == false) {
                    ctx.body = { type: 0, win: { msgOut: cfgCloseQufu.msg } };
                    return;
                }
            }
        }
        // 保证当前活动已经更新（Setting 未初始化时 createAt 为 undefined → NaN 比较恒 false，不拦）
        if (Setting.createAt + addAt < ctx.state.new0) {
            ctx.body = { type: 0, win: { msg: ["服务器繁忙！"] } };
            return;
        }
        await next();
        if (DBG) console.log("[dbg:mw1-after-next] " + ctx.url);
    });

    // ===== 中间件2（移植自 dist/app.js，末尾增加 JSON 落盘） =====
    app.use(async (ctx, next) => {
        if (DBG) console.log("[dbg:mw2-in] " + ctx.url);
        let isClose = true;
        let cfgSystem = Setting.getSetting("1", "system");
        if (cfgSystem != null && cfgSystem.log_open == 1) isClose = false;
        if (ctx.url.indexOf("/user/adok") != -1) isClose = true;
        try {
            // 已经账号登陆 和 角色登陆
            if (ctx.url.indexOf("/player") == -1) {
                await ctx.state.master.getUser();
            }
            await next();
            // ===== 单机版：在线奖励（默认每 15 秒 +1 代金券；见 _solo_online.js）=====
            try { await require("./_solo_online").tick(ctx); } catch (e) { console.error("[solo-online] 异常 " + ((e && e.message) || e)); }
            // ===== 单机版：假人聊天回复（/chat/send 成功后 1~3 条回复；见 _solo_fakes2.js）=====
            try { await require("./_solo_fakes2").onRequest(ctx); } catch (e) { }
            // 互动信息检查下发
            const params = tool.getParams(ctx);
            const uuid = params.uuid, token = params.token;
            if (gameMethod_1.gameMethod.isEmpty(uuid) != true && gameMethod_1.gameMethod.isEmpty(token) != true) {
                let actAdokSevModel = ActAdokSevModel_1.ActAdokSevModel.getInstance(ctx, uuid);
                await actAdokSevModel.clickAllSev();
                // 设置离线点
                if (uuid == ctx.state.qhao) {
                    mongodb_1.dbSev.getFlowDb().update("LoginDown", { "uuid": uuid }, { "uuid": uuid, "sid": ctx.state.sid, "dAt": ctx.state.newTime + 30 }, true);
                }
            }
            await ctx.state.master.updateFBuf();
            await ctx.state.master.distroy();
        }
        catch (error) {
            ctx.state.fuuid = "";
            try {
                console.error("===API异常===", ctx.url,
                    "status=" + (error && error.status),
                    "msg=" + (error && error.message) + "\n" +
                    (error && error.stack ? error.stack : "(无堆栈)"));
            } catch (e) { }
            if (error.status == 500) {
                ctx.state.master.addTypeMsg(0, "msg", error.message);
            }
            else if (error.status == 501) {
                ctx.state.master.addTypeMsg(0, "msgOut", "已在其他地方登陆");
            }
            else if (error.status == 502) {
                ctx.state.master.addTypeMsg(0, "msgOut", error.message);
            }
            else if (error.status == 503) {
                ctx.status = 200;
            }
            else if (error.status == 504) {
                ctx.status = 404;
            }
            else {
                ctx.state.master.addTypeMsg(0, "msg", "异常错误");
                tool.addServerError(ctx.url, tool.getParams(ctx), error);
            }
        }
        await lock.unLock(ctx);
        await ctx.state.master.mergeBackBuf();
        // 原版此处为日志判断：if (ctx.state.master.backDataAll() == 1 && !isClose) { ... }
        // 注意：backDataAll() 有副作用——组装并写入 ctx.body（响应体就在这里产生）
        try { ctx.state.master.backDataAll(); } catch (e) { console.error("[solo-be] backDataAll 异常", (e && e.stack) || e); }
        // ===== 单机版附加：请求结束把脏数据落盘 =====
        try { mongodb_1.dbSev.flushSync(); } catch (e) { }
    });

    // ===== 自动路由：挂载 src/api 下全部路由文件（与原版同款 readdir 方式） =====
    const dirApi = path.resolve(__dirname, "./src/api");
    let routesTotal = 0;
    for (const file of fs.readdirSync(dirApi)) {
        if (file.indexOf(".js") === -1) continue;
        if (file.indexOf(".js.map") !== -1) continue;
        const route = require(path.join(dirApi, file.split(".js")[0]));
        routesTotal += route.router.stack.length;
        app.use(route.router.routes());
    }
    console.log("[solo-be] 路由挂载完成，共 " + routesTotal + " 条");
    if (DBG) app.use(async (ctx, next) => { await next(); console.log("[dbg:end] " + ctx.url + " status=" + ctx.status + " hasBody=" + !!ctx.body); });

    const server = app.listen(0, "127.0.0.1");
    await new Promise((res, rej) => {
        server.once("listening", res);
        server.once("error", rej);
    });
    const port = server.address().port;
    console.log("[solo-be] READY 127.0.0.1:" + port);
    return { app, server, port, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { start };

if (require.main === module) {
    if (process.argv[2]) process.env.SOLO_DB_DIR = process.argv[2];
    process.on("uncaughtException", (err) => {
        console.error("==solo-be 捕获node错误==", (err && err.stack) || err);
    });
    process.on("unhandledRejection", (err) => {
        console.error("==solo-be 未处理Promise==", (err && err.stack) || err);
    });
    start().then(({ port }) => {
        console.log("SOLO_READY " + port);
    }).catch((e) => {
        console.error("[solo-be] 启动失败", (e && e.stack) || e);
        process.exit(1);
    });
}
