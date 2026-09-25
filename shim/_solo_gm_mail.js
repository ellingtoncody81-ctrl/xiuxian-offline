"use strict";
/**
 * [单机版] GM 福利邮件模块 _solo_gm_mail.js  v4.22
 * ===================================================================
 * 用途：以【系统/GM】名义给每个真人角色发福利邮件（kind=6 皮肤/幻化附件）。
 *   ① 道童皮肤 100001（buwei=99，开服庆典限定）—— v4.6.4 起
 *   ② 装备幻化皮肤 25 款（buwei 1~4，活动限定 / 零来源）—— v4.19 新增
 *
 * 解锁链路：领取附件 → master.addItem1 case 6 →
 *     · buwei == 99 → ActDongTianModel.addPifu（洞天换装）
 *     · 其它        → ActEquipModel.addPifu(buwei, 皮肤id) → chuan[buwei].hhList[id] = 1（装备幻化）
 *
 * ★ 幂等（v4.19 修复「重复发送」bug）：
 *   · 旧版条件 = 「同标题邮件存在 && ets > now」→ 邮件 15 天过期后条件失效
 *     → 每 15 天自动重发一封（用户实测：同一封道童皮肤邮件收到 2 次）
 *   · 现在 = 「存在同标题邮件（不论是否过期 / 是否已删）」或「状态文件 solo_gm_sent.json 记过」
 *     任一成立 → 跳过，永不再发
 *
 * 自愈：邮件已领取(rts>0) 或 已过期(ets<now) 但附件尚未解锁 → 自动补解锁（幂等）
 *
 * 用法：
 *   node _solo_gm_mail.js <dbDir> [--force] [--dry]
 *   boot 启动：require("./_solo_gm_mail").grantAll()          ← 覆盖全部角色 + 自愈
 *   登录钩子：require("./_solo_gm_mail").grantOne(ctx, uuid)  ← v4.20 新号首登即发
 * ===================================================================
 */
const path = require("path");
const fs = require("fs");
const mongodb_1 = require("./src/util/mongodb");
const redis_1 = require("./src/util/redis");
const game_1 = require("./src/util/game");
const tool_1 = require("./src/util/tool");
const master_1 = require("./src/util/master");
const gameCfg_1 = require("./common/gameCfg");

const _def = (m) => (m && m.__esModule && m.default !== undefined) ? m.default : m;
const game = _def(game_1);
const tool = tool_1.tool;

const FAKE_MIN = 200001, FAKE_MAX = 200200;

/* ── ① 道童皮肤（原 v4.6.4） ── */
const GM_TITLE = "【GM福利】开服庆典限定·道童皮肤";
const GM_CONTENT = "亲爱的道友：\n开服/合服庆典活动已不再开启，庆典限定的道童皮肤现由 GM 直接发放。\n请领取附件后在【洞天 → 换装】中穿戴（拉取速度 +5%）。\n——系统邮件";
const GM_ITEMS = [[6, "100001", 1]];

/* ── ② 装备幻化（v4.19）：活动限定 / 零来源的 25 款，按系列分 8 封 ── */
const _PIFU_NOTE = "（该皮肤原属活动奖励，单机环境下活动无法开启，由 GM 直接发放）";
const _PIFU_TAIL = "\n请领取附件后，在【角色 → 幻化/换装】对应部位中穿戴。\n——系统邮件";
const PIFU_GIFTS = [
    {
        key: "pifu_xinren", title: "【GM福利】限定幻化·新手套（武器/衣服/神光）",
        content: "亲爱的道友：\n限定幻化「新手套」共 3 件" + _PIFU_NOTE + _PIFU_TAIL,
        items: [[6, "50000", 1], [6, "50001", 1], [6, "50002", 1]]
    },
    {
        key: "pifu_lieyan", title: "【GM福利】限定幻化·烈焰套（头/衣/武/神光）",
        content: "亲爱的道友：\n限定幻化「烈焰套」共 4 件" + _PIFU_NOTE + _PIFU_TAIL,
        items: [[6, "50101", 1], [6, "50102", 1], [6, "50103", 1], [6, "50104", 1]]
    },
    {
        key: "pifu_qingguang", title: "【GM福利】连冲限定幻化·青光·衣",
        content: "亲爱的道友：\n限定幻化「青光·衣」原为累计充值活动奖励，单机无充值渠道，由 GM 直接发放。" + _PIFU_TAIL,
        items: [[6, "50301", 1]]
    },
    {
        key: "pifu_xianyuan", title: "【GM福利】限定幻化·仙缘套（簪/衣/笛/神光）",
        content: "亲爱的道友：\n限定幻化「仙缘套」共 4 件" + _PIFU_NOTE + _PIFU_TAIL,
        items: [[6, "50401", 1], [6, "50402", 1], [6, "50403", 1], [6, "50404", 1]]
    },
    {
        key: "pifu_qingxin", title: "【GM福利】限定幻化·清心套（簪/衣/刃）",
        content: "亲爱的道友：\n限定幻化「清心套」共 3 件" + _PIFU_NOTE + _PIFU_TAIL,
        items: [[6, "50601", 1], [6, "50602", 1], [6, "50603", 1]]
    },
    {
        key: "pifu_qiyuan", title: "【GM福利】兽灵起源限定幻化·起源套（簪/衣/尘）",
        content: "亲爱的道友：\n「兽灵起源」活动限定幻化共 3 件（原为排名奖励，单机活动窗口期短、假人常驻榜首）" + _PIFU_NOTE + _PIFU_TAIL,
        items: [[6, "50501", 1], [6, "50502", 1], [6, "50503", 1]]
    },
    {
        key: "pifu_huanjing", title: "【GM福利】云中仙居限定幻化·幻境套（簪/衣/笔）",
        content: "亲爱的道友：\n「云中仙居」活动限定幻化共 3 件" + _PIFU_NOTE + _PIFU_TAIL,
        items: [[6, "50701", 1], [6, "50702", 1], [6, "50703", 1]]
    },
    {
        key: "pifu_shengyan", title: "【GM福利】合服庆典限定幻化·圣衍套（簪/衣/戟/神光）",
        content: "亲爱的道友：\n合服庆典限定幻化「圣衍套」共 4 件（庆典活动已不再开启）\n由 GM 直接发放。" + _PIFU_TAIL,
        items: [[6, "50801", 1], [6, "50802", 1], [6, "50803", 1], [6, "50804", 1]]
    },
    /* ── v4.22：九龙秘宝系列（原为循环活动排名/积分奖励，一并直发） ── */
    {
        key: "pifu_jiulong_ly", title: "【GM福利】九龙秘宝限定幻化·两仪套（簪/衣/斩/神光）",
        content: "亲爱的道友：\n「九龙秘宝·开鼎」限定幻化「两仪套」共 4 件（原为活动积分/排名奖励）" + _PIFU_NOTE + _PIFU_TAIL,
        items: [[6, "50201", 1], [6, "50202", 1], [6, "50203", 1], [6, "50204", 1]]
    },
    {
        key: "pifu_jiulong_bx", title: "【GM福利】九龙秘宝限定幻化·碧血套（簪/衣/枪/神光）",
        content: "亲爱的道友：\n「九龙秘宝·斗法」限定幻化「碧血套」共 4 件（原为活动积分/排名奖励）" + _PIFU_NOTE + _PIFU_TAIL,
        items: [[6, "50211", 1], [6, "50212", 1], [6, "50213", 1], [6, "50214", 1]]
    },
    {
        key: "pifu_jiulong_qf", title: "【GM福利】九龙秘宝限定幻化·清风套（簪/衣/笛/神光）",
        content: "亲爱的道友：\n「九龙秘宝·洞天」限定幻化「清风套」共 4 件（原为活动积分/排名奖励）" + _PIFU_NOTE + _PIFU_TAIL,
        items: [[6, "50221", 1], [6, "50222", 1], [6, "50223", 1], [6, "50224", 1]]
    }
];

/* 全部福利邮件（道童 + 幻化 8 封） */
const GM_GIFTS = [{ key: "dt_skin_100001", title: GM_TITLE, content: GM_CONTENT, items: GM_ITEMS }].concat(PIFU_GIFTS);

function dbRoot() {
    return process.env.SOLO_DB_DIR || path.join(__dirname, "..", "db");
}

/* ── 发放状态文件（防"邮件被删/过期后再发"）── */
function sentPath() { return path.join(dbRoot(), "solo_gm_sent.json"); }
function loadSent() {
    try { return JSON.parse(fs.readFileSync(sentPath(), "utf-8")) || {}; } catch (e) { return {}; }
}
function saveSent(o) {
    try { fs.writeFileSync(sentPath(), JSON.stringify(o)); } catch (e) { console.log("[solo-gm] 状态写入失败 " + ((e && e.message) || e)); }
}

// 自建轻量 ctx（与 _solo_fakes3.ctxLite 同构；AModel.update 依赖真 Master）
function ctxLite() {
    const now = game.getNowTime();
    let sid = "1";
    try {
        const Setting = _def(require("./src/crontab/setting"));
        const qs = Setting.getQufus && Setting.getQufus();
        if (qs && Object.keys(qs).length) sid = String(Object.keys(qs)[0]);
    } catch (e) { }
    const ctx = {
        state: {
            model: {}, sid: sid, newTime: now, new0: game.getToDay_0(now),
            apidesc: "", locks: [], addLock: false, fuuid: "",
        },
        throw(msg) { throw new Error(String(msg)); },
    };
    ctx.state.master = new master_1.Master(ctx);
    return ctx;
}

/** 自愈：邮件已领取或已过期 → 附件逐个补解锁（幂等） */
async function selfHeal(ctx, uuid, gift, mail, report) {
    try {
        const claimed = mail.rts > 0;
        const expired = !(mail.ets > ctx.state.newTime);
        if (!claimed && !expired) return;          // 未领取也未过期 → 等玩家自己领
        const items = mail.items || [];
        for (const it of items) {
            if (Number(it[0]) !== 6) continue;
            const iid = String(it[1]);
            let bw = null;
            try { bw = gameCfg_1.default.equipPifu.getItemCtx(ctx, iid).buwei; } catch (e) { }
            if (bw == null) continue;
            if (bw == 99) {
                const DT = require("./src/model/act/ActDongTianModel").ActDongTianModel;
                const dt = DT.getInstance(ctx, uuid);
                const di = await dt.getInfo();
                if (!di.pfList) di.pfList = {};
                if (!di.pfList[iid]) {
                    await dt.addPifu(iid);
                    report.push("补偿(道童) " + uuid + " -> " + iid);
                }
            } else {
                const AE = require("./src/model/act/ActEquipModel").ActEquipModel;
                const ae = AE.getInstance(ctx, uuid);
                const ai = await ae.getInfo();
                const cur = ai.chuan && ai.chuan[bw];
                if (cur == null || cur.hhList == null || cur.hhList[iid] == null) {
                    await ae.addPifu(String(bw), iid);
                    report.push("补偿(幻化) " + uuid + " -> " + iid + " (buwei " + bw + ")");
                }
            }
        }
    } catch (e) {
        report.push("自愈 err " + uuid + " " + ((e && e.message) || e));
    }
}

/**
 * 给全部真人角色发 GM 福利邮件（幂等）
 * @param {object} opts { force:boolean, dry:boolean }
 */
/**
 * ★ v4.20 单角色发放（供 boot grantAll 与【登录钩子 grantOne】共用）
 *   —— 新号建号后**首次登录即收到全部 GM 福利**，不必等下一次重启
 *   注意：不调用 distroy()，依赖请求末/启动末的统一 flush
 */
async function grantForOne(ctx, uuid, sentState, opts) {
    opts = opts || {};
    const MailModel = require("./src/model/user/MailModel").MailModel;
    const mm = MailModel.getInstance(ctx, uuid);
    const list = await mm.getInfoList();                 // { mid: info }
    const byTitle = {};
    for (const mid in (list || {})) {
        const info = list[mid];
        if (info && info.title) byTitle[info.title] = info;
    }
    const done = sentState[uuid] || (sentState[uuid] = []);
    const report = [];
    let sent = 0, skipped = 0, healed = 0;
    for (const g of GM_GIFTS) {
        const mail = byTitle[g.title];
        // ① 自愈（邮件存在才做）
        if (mail) { const b4 = report.length; await selfHeal(ctx, uuid, g, mail, report); if (report.length > b4) healed++; }
        // ② 幂等判定：邮件存在（不论过期/已删标记）或状态记过 → 跳过
        if (opts.force) { /* 强制模式：仍然发 */ }
        else if (mail != null || done.indexOf(g.key) >= 0) { skipped++; continue; }
        if (opts.dry) { report.push("[dry] " + uuid + " 将发 " + g.key); continue; }
        await mm.sendMail(g.title, g.content, g.items, 1);
        if (done.indexOf(g.key) < 0) done.push(g.key);
        sent++;
        report.push("已发 " + uuid + " " + g.key);
    }
    return { sent: sent, skipped: skipped, healed: healed, report: report };
}

/**
 * ★ v4.20 登录钩子版：只处理【当前登录角色】——新号首次登录立即到账
 *   玩家 js 调用点：src/api/player.js 的 user_login_send()（setToken 之后）
 */
async function grantOne(ctx, uuid) {
    try {
        if (!gameCfg_1.default.__inited) { try { gameCfg_1.default.init(); } catch (e) { } gameCfg_1.default.__inited = true; }
        const sentState = loadSent();
        const r = await grantForOne(ctx, uuid, sentState, {});
        if (r.sent > 0) {
            saveSent(sentState);
            console.log("[solo-gm] 福利邮件 " + uuid + "：新发 " + r.sent + " 封（" + r.report.join("；") + "）");
        }
        return r;
    } catch (e) {
        console.error("[solo-gm] 异常 " + ((e && e.stack) || e));
        return { sent: 0, skipped: 0, healed: 0, report: [] };
    }
}

/**
 * 给全部真人角色发 GM 福利邮件（幂等）
 * @param {object} opts { force:boolean, dry:boolean }
 */
async function grantAll(opts) {
    opts = opts || {};
    const report = [];
    if (!gameCfg_1.default.__inited) { try { gameCfg_1.default.init(); } catch (e) { } gameCfg_1.default.__inited = true; }
    const db = mongodb_1.dbSev.getDataDb();
    // 收集真人角色：user 表 userInfo 行（排除 200001~200200 假人）
    let targets = [];
    try {
        const rows = await db.find("user", {});
        const seen = {};
        for (const r of (rows || [])) {
            if (!r || r.kid !== "userInfo") continue;
            const n = parseInt(r.id);
            if (isNaN(n)) continue;
            if (n >= FAKE_MIN && n <= FAKE_MAX) continue;
            if (seen[r.id]) continue;
            seen[r.id] = 1;
            targets.push(String(r.id));
        }
    } catch (e) { report.push("扫描角色失败 " + e.message); return { ok: false, report }; }
    if (targets.length === 0) { report.push("没有真人角色"); return { ok: false, report }; }

    const ctx = ctxLite();
    const sentState = loadSent();
    let sent = 0, skipped = 0, healed = 0;
    for (const uuid of targets) {
        try {
            const r = await grantForOne(ctx, uuid, sentState, opts);
            sent += r.sent; skipped += r.skipped; healed += r.healed;
            for (const s of r.report) report.push(s);
        } catch (e) {
            report.push(uuid + " 失败 " + ((e && e.message) || e));
        }
    }
    if (!opts.dry) {
        saveSent(sentState);
        try { await ctx.state.master.distroy(); } catch (e) { }   // 落 redis + DB
        try { mongodb_1.dbSev.flushSync(); } catch (e) { }
    }
    report.push("GM 邮件：" + targets.length + " 个角色｜发送 " + sent + " / 跳过 " + skipped + (healed ? (" / 自愈 " + healed) : ""));
    return { ok: true, report };
}

module.exports = { grantAll, grantOne, grantForOne, GM_TITLE, GM_ITEMS, GM_GIFTS, PIFU_GIFTS };

// ==================== CLI ====================
if (require.main === module) {
    const dbDir = process.argv[2];
    if (dbDir) process.env.SOLO_DB_DIR = dbDir;
    const dry = process.argv.indexOf("--dry") >= 0;
    const force = process.argv.indexOf("--force") >= 0;
    (async () => {
        await mongodb_1.dbSev.init();
        try { await redis_1.redisSev.init(); } catch (e) { console.log("redis init: " + e.message); }
        try { _def(require("./src/crontab/setting")).createCash(game.getToDay_0(game.getNowTime()), game.getNowTime(), false); } catch (e) { }
        const r = await grantAll({ dry: dry, force: force });
        console.log(r.report.join("\n"));
        process.exit(0);
    })().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
}
