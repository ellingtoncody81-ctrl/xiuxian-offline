"use strict";
/**
 * [单机版托管 · 假人真人化引擎 v4 / M3] _solo_fakes3.js
 * ------------------------------------------------------------------
 * M3 目标（docs/假人真人化-plan.md）：
 *   P4.1 洞天：假人在「洞天附近」出现、矿车可掠夺/打架、日志里出现假人
 *   P4.2 仙盟：假人当上用户仙盟成员；仙盟 BOSS 伤害排行有假人、血线随 tick 前进
 *   P4.3 仙盟附加：成员列表活跃（longgong/count）
 *
 * 实现手段：全部走官方模型 API（SevClubModel / SevClubMemberModel / SevClubBossModel /
 * ActDongTianModel 同款存储），保证客户端读到的东西与官方流程 100% 同构。
 * 不修改任何业务代码；本文件可独立 CLI 自测：
 *   node _solo_fakes3.js <dbDir> [--out 报告文件]
 */
const fs = require("fs");
const path = require("path");

const mongodb_1 = require("./src/util/mongodb");
const redis_1 = require("./src/util/redis");
const game_1 = require("./src/util/game");
const tool_1 = require("./src/util/tool");
const master_1 = require("./src/util/master");
const gameCfg_1 = require("./common/gameCfg");
const RdsUserModel_1 = require("./src/model/redis/RdsUserModel");
const F2 = require("./_solo_fakes2");   // [v4.5] 统一假人档案 fakeFuserFull
const cache_1 = require("./src/util/cache");

const _def = (m) => (m && m.__esModule && m.default !== undefined) ? m.default : m;
const game = _def(game_1);
const gameCfg = _def(gameCfg_1);
const tool = tool_1.tool;
const cache = _def(cache_1);
const DTUSER = master_1.DataType.user;

const FAKE_MIN = 200001, FAKE_MAX = 200200;   // v4.5 扩至 200 人
const TICK_MS = 13 * 60 * 1000;   // [v4.40] 10min 与 fakes2.growTick 撞车，改 13min 错开           // 10 分钟一跳
let ANCHOR = "100003";                   // 主玩家（默认毕业号）；[v4.7] 每 tick 动态解析为"最近登录的真人"（新开小号同样被服务）
const DT_CAR_IDS = ["11", "12", "13", "14", "15"];
let DT_FUSER = {};                                 // [v4.5] 本 tick 假人完整档案（buildDongTianModule 用）
let DT_FUSER_SEV = {};                              // [v4.6] 本 tick 假人完整档案·带 sevBack（战力显示用）
const CLUB_STATE_FILE = "solo_club_state.json";   // P4.3 社交状态（与 solo_fakes_state.json 同目录）
const DT_STATE_FILE = "solo_dt_state.json";       // [v4.7] 洞天邻居榜等级演化状态
function loadDtState() {
    let st = {};
    try { st = JSON.parse(fs.readFileSync(path.join(dbRoot(), DT_STATE_FILE), "utf8")) || {}; } catch (e) { }
    if (!st.dtLv) st.dtLv = {};
    return st;
}
function saveDtState(st) {
    try { fs.writeFileSync(path.join(dbRoot(), DT_STATE_FILE), JSON.stringify(st), "utf8"); } catch (e) { }
}

let _timer = null;

// ==================== 基础工具 ====================
function fakeList() {
    const out = [];
    for (let i = FAKE_MIN; i <= FAKE_MAX; i++) out.push(String(i));
    return out;
}
function dbRoot() {
    return process.env.SOLO_DB_DIR || path.join(__dirname, "..", "db");
}
let _jsonCache = null;   // [v4.5] tick 级 fs 快照缓存（避免 200 人循环里反复读整表）
function clearJsonCache() { _jsonCache = null; }
function readJson(name, def) {
    if (_jsonCache == null) _jsonCache = {};
    if (_jsonCache[name] !== undefined) return _jsonCache[name];
    try { _jsonCache[name] = JSON.parse(fs.readFileSync(path.join(dbRoot(), "shanhaitbkf", name), "utf8")); }
    catch (e) { _jsonCache[name] = def; }
    return _jsonCache[name];
}
function rowOf(table, id, kid) {
    const rows = readJson(table + ".json", []);
    const list = Array.isArray(rows) ? rows : (rows.rows || []);
    for (const r of list) {
        if (String(r.id) === String(id) && (!kid || r.kid === kid)) return r.data || null;
    }
    return null;
}
async function writeRow(table, id, kid, data) {
    const db = mongodb_1.dbSev.getDataDb();
    // [v4.6.4+] 回归检测：向玩家洞天写行时，若新数据把“已解锁皮肤(100001)”写丢 → 打警告（疑似旧快照覆盖）
    try {
        if (String(id) === ANCHOR && kid === "actDongTian" && data && data.pfList && data.pfList["100001"] == null) {
            let old = null;
            try { const h = await db.findOne("act", { id: String(ANCHOR), kid: "actDongTian", hdcid: "1" }); old = h ? h.data : null; } catch (e) { }
            if (old == null) old = rowOf("act", ANCHOR, "actDongTian") || {};
            if (old.pfList && old.pfList["100001"] != null) {
                console.warn("[solo-fakes3] ⚠ 洞天写行回退警告: pfList 丢失 100001（旧快照覆盖？）old=" + JSON.stringify(old.pfList) + " new=" + JSON.stringify(data.pfList));
            }
        }
    } catch (e) { }
    const where = { id: String(id), kid: kid, hdcid: "1" };
    await db.update(table, where, Object.assign({}, where, { data: data }), true);
    try { await redis_1.redisSev.getRedis(DTUSER).hSet(DTUSER + "_" + id, table + "_" + kid + "_1", data); } catch (e) { }
    try {
        const LockCache = require("./src/util/cache").default;
        if (LockCache && LockCache.users) delete LockCache.users[String(id)];
    } catch (e) { }
}
function ctxLite() {
    const now = game.getNowTime();
    let sid = "1";
    try {
        const Setting = require("./src/crontab/setting").default;
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
    // 用真 Master（AModel.getInfo/update 依赖 master.getInfo/setInfo/addBackBuf 等）
    ctx.state.master = new master_1.Master(ctx);
    return ctx;
}
function rand(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

// [v4.7] 动态锚点：谁最近在玩，玩家侧服务（洞天/仙盟/求助/掠夺）就围绕谁
async function resolveAnchor() {
    try {
        const envA = process.env.SOLO_FAKE_ANCHOR_UUID;
        if (envA) return String(envA);
        const rows = readJson("user.json", []);
        const list = Array.isArray(rows) ? rows : (rows.rows || []);
        let best = null;
        for (const r of list) {
            if (!r || r.kid !== "userInfo" || !r.data) continue;
            const id = String(r.id || "");
            const n2 = Number(id);
            if (!(n2 > 0) || n2 >= 200000) continue;
            if (r.data.level == null) continue;
            const ll = Number(r.data.lastlogin) || 0;
            if (best == null || ll > best.ll) best = { id: id, ll: ll };
        }
        if (best != null) return best.id;
    } catch (e) { }
    return null;
}

// ==================== P4.3 仙盟社交：状态与工具 ====================
function loadClubState() {
    const today = game.getToDay_0(game.getNowTime());
    let st = {};
    try { st = JSON.parse(fs.readFileSync(path.join(dbRoot(), CLUB_STATE_FILE), "utf8")) || {}; } catch (e) { }
    if (st.day !== today) { st.day = today; st.qifu = {}; st.helpAdded = 0; st.dtRaid = 0; st.dtRaidAt = {}; }
    // [solo v4.39] 每号入侵配额/下次时间：{ uuid: { n: 已入侵次数, nextAt: 下次时间 } }
    if (!st.dtRaidAt || typeof st.dtRaidAt !== "object") st.dtRaidAt = {};
    if (!st.qifu) st.qifu = {};
    if (st.helpAdded == null) st.helpAdded = 0;
    return st;
}
function saveClubState(st) {
    try { fs.writeFileSync(path.join(dbRoot(), CLUB_STATE_FILE), JSON.stringify(st), "utf8"); } catch (e) { }
}
function fakeUserOf(p) {
    return {
        uid: "3" + p.uuid, uuid: p.uuid, sid: "1", name: p.name, sex: p.sex || 0,
        head: p.head || "skin_1", wxhead: "", tzid: "", level: p.level || 150,
        lastlogin: game.getNowTime(), rid: 0, score: 0, clubName: "", chid: "1", cbid: "3",
    };
}
async function clubFakeMembers(ctx, clubId, profs) {
    // 参与社交的假人 = 仙盟成员列表里的假人（兜底取前 14 个档案）
    try {
        const SevClubMemberModel_1 = require("./src/model/sev/SevClubMemberModel");
        const mInfo = await SevClubMemberModel_1.SevClubMemberModel.getInstance(ctx, clubId).getInfo();
        const list = Object.keys(mInfo.list || {}).filter((u) => { const n = parseInt(u); return n >= FAKE_MIN && n <= FAKE_MAX; });
        if (list.length > 0) return list;
    } catch (e) { }
    return profs.slice(0, 14).map((p) => p.uuid);
}

// ==================== 假人档案（名字/等级/头像/战力） ====================
async function readFakeProfiles() {
    // [v4.5] 从 db 垫片读 user 全表（垫片内存=权威；不依赖 fs 落地）
    const st = readJson("solo_fakes_state.json", null) || {};
    const map = {};
    try {
        const db = require("./src/util/mongodb").dbSev.getDataDb();
        const rows = await db.find("user", {});
        for (const r of (rows || [])) {
            if (r && r.kid === "userInfo") map[String(r.id)] = r.data || {};
        }
    } catch (e) { }
    const profs = [];
    for (const uuid of fakeList()) {
        const ui = map[uuid] || {};
        const stF = (st.fakes && st.fakes[uuid]) || {};
        profs.push({
            uuid: uuid,
            name: ui.name || ("玩家" + uuid.slice(-3)),
            sex: ui.sex != null ? ui.sex : (parseInt(uuid) % 2),
            head: ui.head || "",
            level: ui.level || rand(90, 120),
            power: stF.power || 1000000,
            tier: stF.tier != null ? stF.tier : 0.5,
        });
    }
    return profs;
}

// ==================== P4.1 洞天 ====================
function buildDongTianModule(prof, dtLevel) {
    const now = game.getNowTime();
    const carCount = (parseInt(prof.uuid) - FAKE_MIN) % 2 === 0 ? 5 : 3;   // 一半人 5 车（优先被刷出）
    const cars = {};
    for (let i = 0; i < carCount; i++) {
        const pos = String(i + 1);
        // [v4.6.3] 全车=官方初始形态（对齐 getOneCar）：未开始(stime=0/etime=0)、my/he 空
        // 修复"拉取"崩链：旧版 stime=now-600..5400 + dpos=rand(1,360) + pow=80..100(rate200) + wkVel=10
        // → getDongTianCar 里 dtime(600..5400s) >= allTime(=ceil(dpos/20)≈1..18s) 判"已完成" edtime=0
        // → lache 写 etime=now+0=now → update 触发 getInfo 清理(etime<=now→delete cars[pos]) → 704 行崩
        cars[pos] = {
            id: DT_CAR_IDS[i % DT_CAR_IDS.length],
            pos: pos,
            dpos: rand(162, 198),   // 官方 rand(lengs[0], lengs[1])（lengs=[162,198,360]）
            stime: 0,
            etime: 0,
            my: { user: null, knum: 0, pow: 0, fevCard: false, pfid: "" },
            he: { user: null, knum: 0, pow: 0, fevCard: false, pfid: "" },
            pklog: [],
        };
    }
    // [v4.6.1] rob[自uuid] = 自己的拉车信息（对齐官方 lache=自己：info.rob[this.id][pos]=car）
    // ——修复：玩家来"拉取"时官方代码写 `rob[fuuid][pos]`，rob[fuuid] 缺失会崩（异常错误）
    const rob = {};
    rob[prof.uuid] = {};
    for (const pos in cars) { if (((cars[pos].my || {}).knum || 0) > 0) rob[prof.uuid][pos] = cars[pos]; }
    return {
        cars: cars, adokCars: {}, rob: rob, rntime: 0, nears: [], npc: {}, enemy: {},
        outTime: now + 86400, level: dtLevel, giftId: 0, giftTime: 0,
        power: rand(80, 100), snum: 0, rstcars: 0,   // [v4.6] 洞天心情值（官方 1~100；影响道童动画/拉取速度）
        kind11: 0, kindAt: 0, myCount: rand(2, 9), heCount: rand(2, 9), mdAt: 0, md1105At: 0,
        pifu: ["100000"], pfList: { "100000": 0 }, xlStep: 0, xlLv: {}, pvdt: 1,
        ver: 2, sb: 0, dtlv: rand(6, 12), dtNum: 0, verNpc: 3,
    };
}
async function writeDongTianBoard(profs, pLevel, report) {
    // 官方读取路径：RdsUserModel.getInstance(ctx, Xys.RdsUser.dongtian, heId).getScoreBetween(level-1, level+1)
    // score = 洞天等级。[v4.7] 演化式：每个假人有自己的洞天等级（持久化、每跳升级/追赶玩家），榜上数字真正在动。
    const st = loadDtState();
    const n = profs.length;
    let lvHi = 0, upN = 0;
    for (let i = 0; i < n; i++) {
        const u = profs[i].uuid;
        let lv = st.dtLv[u];
        if (!(lv > 0)) {
            // 初始化：围绕玩家等级分布（多数同级、少数略高/略低 → 榜上"有人在前也在后"）
            const OFF8 = [0, 0, 0, 0, 1, 1, -1, 2];
            lv = Math.max(1, pLevel + OFF8[i % 8]);
        } else {
            // 演化：越接近/超过玩家越难升；落后玩家会追赶
            let pUp = 0.15;
            if (lv > pLevel + 1) pUp = 0.08;
            if (lv > pLevel + 3) pUp = 0.04;
            if (Math.random() < pUp && lv < pLevel + 6) { lv++; upN++; }
            if (lv < pLevel - 1 && Math.random() < 0.5) { lv++; upN++; }
        }
        st.dtLv[u] = lv;
        if (lv > lvHi) lvHi = lv;
    }
    saveDtState(st);
    const heidCands = ["1", "0", "x", ""];
    let ok = "";
    for (const heid of heidCands) {
        try {
            const m = new RdsUserModel_1.RdsUserModel("dongtian", "x", "1", String(heid));
            for (const p of profs) await m.zSetVal(p.uuid, st.dtLv[p.uuid]);
            const back = await m.getScoreBetween(pLevel - 1, pLevel + 1);
            const hit = (back || []).filter((u) => { const nn = parseInt(String(u), 10) || 0; return nn >= 200001 && nn <= 299999; }).length;
            if (hit > 0) { ok = String(heid); break; }
        } catch (e) { report.push("  洞天榜候选后缀 '" + heid + "' 失败: " + (e && e.message)); }
    }
    report.push("  洞天榜 dongtian: " + n + " 人演化（玩家 " + pLevel + "，最高 " + lvHi + "，本跳 " + upN + " 人升级）后缀=" + (ok || "未确认"));
    return ok;
}
async function tickDongTian(profs, anchor, report) {
    // [v4.6.4+] ⚠ 玩家行读改写一律走【模型】（权威=垫片内存/redis）；
    //   旧写法 `rowOf`（读磁盘文件）会拿到滞后快照，全量写回会把新数据（如刚解锁的皮肤 pfList）覆盖掉
    const pctx = ctxLite();
    const ActDongTianModel_1 = require("./src/model/act/ActDongTianModel").ActDongTianModel;
    const pdt = ActDongTianModel_1.getInstance(pctx, ANCHOR);
    const dtA = await pdt.getInfo();
    const dtLevel = parseInt(dtA.level) || 20;
    // [v4.6.11] 自愈：自家项 rob[ANCHOR][pos].my.user=null → 填玩家档案（UI showItem 读 my.user.uuid；null 崩→召回 51B"异常错误"）
    try {
        let fixN = 0;
        const ownRob = dtA.rob && dtA.rob[ANCHOR];
        if (ownRob) {
            for (const p2 in ownRob) {
                const it = ownRob[p2];
                if (it && it.my && !it.my.user) {
                    try { it.my.user = await cache_1.default.getFUser(pctx, ANCHOR, 1); } catch (e) { }
                    if (!it.my.user) it.my.user = { uuid: ANCHOR, name: "玩家" };
                    fixN++;
                }
            }
        }
        // [v4.8] 空壳清理：无 pos 的 rob[fuuid]（旧版回调半程崩留下的脏结构 → "被掠夺列表"空条目）
        if (dtA.rob) {
            for (const fu2 in dtA.rob) {
                const r2 = dtA.rob[fu2];
                if (r2 != null && typeof r2 === "object" && Object.keys(r2).length === 0) { delete dtA.rob[fu2]; fixN++; }
            }
        }
        if (fixN > 0) { await pdt.update(dtA); try { await pctx.state.master.distroy(); } catch (e) { } report.push("  洞天rob自愈: 修 " + fixN + " 条（含空壳清理）"); }
    } catch (e) { report.push("  洞天rob自愈 ERR " + ((e && e.message) || e)); }
    // 玩家侧：官方要求 heCount+myCount>=10 才会把真人（假人）刷进“附近”
    if ((parseInt(dtA.myCount) || 0) + (parseInt(dtA.heCount) || 0) < 10) {
        dtA.myCount = Math.max(12, parseInt(dtA.myCount) || 0);
        await pdt.update(dtA);
        try { await pctx.state.master.distroy(); } catch (e) { }
        report.push("  玩家洞天 myCount 提升到 " + dtA.myCount + "（解锁“附近真人”条件）");
    }
    // 假人侧：每人都要有洞天模块 + 矿车（车里有 he.user → 可被掠夺/打架）
    // [v4.5] 预取统一完整档案（假人露脸处与全站 getFUser 完全一致）
    DT_FUSER = {}; DT_FUSER_SEV = {};
    for (const p of profs) { try { DT_FUSER[p.uuid] = await F2.fakeFuserFull(p.uuid); } catch (e) { } }
    for (const p of profs) { try { DT_FUSER_SEV[p.uuid] = await F2.fakeFuserSev(p.uuid); } catch (e) { } }   // [v4.6] 带 sevBack（矿车档案→战力可算）
    for (const p of profs) {
        const m = buildDongTianModule(p, dtLevel);
        await writeRow("act", p.uuid, "actDongTian", m);
    }
    report.push("  假人洞天模块: " + profs.length + " 份（含矿车+he.user，可被掠夺）");
    // [v4.6.7] 重建后对齐：玩家车上"假人掠夺者"的 rob[玩家][pos] 必须存在（官方 lache 依赖；重建会抹掉上一 tick 的写入）
    let raidFix = 0;
    try {
        for (const pos in (dtA.cars || {})) {
            const c = dtA.cars[pos];
            if (!c || !c.id) continue;
            if (!(c.he && parseInt(c.he.knum) > 0 && c.he.user)) continue;
            const uu = String(c.he.user.uuid); const nn = parseInt(uu);
            if (!(nn >= 200001 && nn <= 299999)) continue;
            const am = ActDongTianModel_1.getInstance(pctx, uu);
            const ar = await am.getInfo();
            let ch = false;
            if (!ar.rob) { ar.rob = {}; ch = true; }
            if (!ar.rob[ANCHOR]) { ar.rob[ANCHOR] = {}; ch = true; }
            if (!ar.rob[ANCHOR][pos]) { ar.rob[ANCHOR][pos] = JSON.parse(JSON.stringify(c)); ch = true; }
            if (ch) { await am.update(ar); raidFix++; }
        }
        if (raidFix) { try { await pctx.state.master.distroy(); } catch (e) { } }
    } catch (e) { report.push("  洞天rob对齐 ERR " + ((e && e.message) || e)); }
    if (raidFix) report.push("  洞天rob对齐: 补 " + raidFix + " 条（掠夺者侧）");
    await writeDongTianBoard(profs, dtLevel, report);
}

// ==================== P4.2/4.3 仙盟 ====================
// ===== [v4.59] 仙盟 BOSS 独立结算（主 tick 与 fastTick 共用；预算按时间片） =====
let _lastBossMs = 0;
const BOSS_SLICE_MS = 90 * 1000;                 // fastTick 间隔（预算时间片折算基准）
// [v4.63] 假人输出模型（A 难度档 + C 一小时冲刺）：
//   target   = hp × (0.50 + (难度-1) × 0.05)        → #1 50% … #7 80%
//   每跳步进 = max(hp×0.02%, (target - 已打) × 7.2%)  → 约 40 跳(1h) 冲到目标，之后保底缓慢爬升
//   硬顶     = hp × 85%   → 假人绝不越顶，「最后一击」永远留给玩家（假人打不死 BOSS）
const BOSS_SPRINT_K = 0.072;                     // 每跳吃掉「距目标还差」的 7.2% ⇒ 40 跳达标 ~95%
const BOSS_CRAWL = 0.0002;                       // 达标后的保底爬升：每跳 0.02% 血（血线持续在动）
const BOSS_TGT_BASE = 0.50;                      // #1 的目标血线 50%
const BOSS_TGT_STEP = 0.05;                      // 每升一级难度 +5%（#7 = 80%）
const BOSS_TGT_CAP = 0.85;                       // 硬顶 85%（最后一击永远留给玩家）
// [v4.63] monClubBoss 表内最后一只 BOSS 的 id（按表推导，不写死 7）
function bossLastId() {
    let mx = 0;
    try {
        const pool = gameCfg.monClubBoss.pool || {};
        for (const k in pool) { const n = parseInt(k); if (n > 0 && n < 1000) mx = Math.max(mx, n); }
    } catch (e) { }
    return mx > 0 ? mx : 7;
}
// [v4.63] 官方同款回退（ActClubModel.bossFight L619-626：unlock 无对应配置 → open = unlock - 1）：
//   unlock 被官方写到表外（打完 #7 → unlock=8）时，open 一律拉回表内最后一只，绝不指向不存在的配置
function bossOpenId(unlock) {
    const last = bossLastId();
    const id = Math.max(1, parseInt(unlock) || 1);
    return id > last ? last : id;
}
const _bossOpenNoticed = {};                     // [v4.59] 开点播报标记（模块级，不写进 sev 数据）
async function clubNotice(ctx, clubId, uuid, text, report) {
    try {
        const C = require("./src/model/sev/SevChatModel").SevChatModel;
        let fu = null;
        try { fu = await F2.fakeFuserFull(uuid); } catch (e) { }
        if (!fu) return false;
        await C.getInstance(ctx, clubId, "club").add({ id: 0, type: "1", user: fu, msg: text, time: ctx.state.newTime });
        if (report) report.push("  仙盟播报: " + text);
        return true;
    } catch (e) { if (report) report.push("  仙盟播报 err " + ((e && e.message) || e)); return false; }
}
async function bossTick(ctx, clubId, aClub, acm, report, opts) {
    opts = opts || {};
    // ---- ② 假人打 BOSS：伤害排行 + 血线（[v4.9] 官方语义修正：时间窗 / 一天一只 / 击杀邮件 / 盟成员出手） ----
    try {
        const { model: sevClub, info: clubInfo } = await readSevClub(ctx, clubId);
        if (!clubInfo.boss) clubInfo.boss = { open: 0, unlock: 1, hurt: 0, kill: "", md1220: 0 };
        const boss = clubInfo.boss;
        // 官方配置 mathInfo.club_bossStartDayHour = [开始, 自动开点, 结束] 秒（官方值 [36000,48600,79200]=10:00/13:30/22:00）
        let cfg_bdhr = [36000, 48600, 79200];
        try { const miB = gameCfg.mathInfo.getItem("club_bossStartDayHour"); if (miB && miB.pram && miB.pram.item) cfg_bdhr = miB.pram.item; } catch (e) { }
        let nowSec = ctx.state.newTime - ctx.state.new0; // 今日秒数
        if (process.env.SOLO_CLUB_NOW_SEC) nowSec = parseInt(process.env.SOLO_CLUB_NOW_SEC); // [测试] 假"今日秒数"
        const inWindow = nowSec >= cfg_bdhr[0] && nowSec <= cfg_bdhr[2]; // 官方：10:00~22:00 可挑战
        // 自动开启（复刻官方 bossFight L614-626：过了自动开点且未开 → open=unlock）
        // [v4.52] 单机放宽：官方自动开点 = cfg_bdhr[1] = 13:30，但本作盟主恒为假人 ⇒ 玩家非盟主、手动开必被
        //   /club/bossOpen 的 isMaster() 拒，10:00~13:30 就成了「谁都开不了」的空窗。
        //   故改为【进入窗口(10:00)即自动开】——与官方「自动开」同一语义，仅把时点提前到窗口起点。
        if (!(parseInt(boss.open) > 0) && inWindow) {
            // [v4.63] 官方同款回退：unlock 在表外（打完 #7 后官方 unlock+=1=8）→ 拉回表内最后一只，不写死 7
            boss.open = bossOpenId(boss.unlock);
            boss.kill = "";
        }
        let bossId = String(parseInt(boss.open) || 0);
        let hp = 0, bossName = "";
        const _readBossCfg = () => { try { const bcfg = gameCfg.monClubBoss.getItem(bossId); if (bcfg && bcfg.eps && bcfg.eps.hp_max) hp = bcfg.eps.hp_max; if (bcfg && bcfg.name) bossName = bcfg.name; } catch (e) { } };
        _readBossCfg();
        // [v4.63] 脏状态自愈：open 指向表内不存在的难度（旧版把 unlock=8 原样写进 open → hp=0 → 当天 BOSS
        //   既开不了也打不了，整只卡死）→ 拉回表内最后一只，并把脏 unlock 一并修正
        if (hp <= 0 && parseInt(boss.open) > 0) {
            const _fb = bossOpenId(Math.min(parseInt(boss.open) || 1, parseInt(boss.unlock) || 1));
            if (String(_fb) !== bossId) {
                bossId = String(_fb); boss.open = _fb;
                if ((parseInt(boss.unlock) || 1) > _fb) boss.unlock = _fb;
                _readBossCfg();
            }
        }
        // 脏状态自愈：kill 挂着但血线没打满（旧版"击杀后立即续打"的产物）→ 清 kill 继续打
        if (boss.kill && hp > 0 && (parseInt(boss.hurt) || 0) < hp) { boss.kill = ""; }
        let dmg = 0, crewN = 0, killed = "", skipMsg = "", mailInfo = "", tgtPct = 0;
        if (parseInt(boss.open) > 0 && hp > 0 && inWindow && !boss.kill) {
            // 出手机人 = 本盟成员里的假人（轮换出手；修正旧版"取全局前 8 人"→ 别盟假人也会上榜的 bug）
            const SevClubMemberModel_1 = require("./src/model/sev/SevClubMemberModel");
            const mmB = SevClubMemberModel_1.SevClubMemberModel.getInstance(ctx, clubId);
            const miB2 = await mmB.getInfo();
            const fakesB = Object.keys(miB2.list || {}).filter((u) => { const n = parseInt(u); return n >= FAKE_MIN && n <= FAKE_MAX; });
            const crew = [];
            if (fakesB.length > 0) {
                const off = Math.floor(nowSec / 600) % fakesB.length;
                for (let i = 0; i < Math.min(8, fakesB.length); i++) crew.push(fakesB[(off + i) % fakesB.length]);
            }
            if (crew.length > 0) {
                // [v4.63] 输出预算（A 难度档 + C 一小时冲刺；按 elapsed 折算跳数 → 13min 主 tick 与 90s 快 tick 同一公式）
                //   #1：目标 50% → 首跳 max(2000, 10,000,000×50%×7.2% = 360,000)，约 1h 达标，之后保底爬升
                //   #7：目标 80% → 首跳 max(96,000, 480,000,000×80%×7.2% = 27,648,000)，8 人分摊 ≈ 345 万/人
                //   硬顶 85%：假人到顶即停手，那 15% 留给玩家补刀（假人永远打不死 BOSS）
                const _nowMs = Date.now();
                let _elapsed = _lastBossMs > 0 ? (_nowMs - _lastBossMs) : BOSS_SLICE_MS;
                _elapsed = Math.max(30 * 1000, Math.min(_elapsed, 180 * 1000));
                _lastBossMs = _nowMs;
                const _tier = Math.max(1, Math.min(9, parseInt(bossId) || 1));
                const _tgtPct = Math.min(BOSS_TGT_CAP, BOSS_TGT_BASE + (_tier - 1) * BOSS_TGT_STEP);
                const _tgt = Math.floor(hp * _tgtPct);
                const _cap = Math.floor(hp * BOSS_TGT_CAP);
                const _hurt0 = parseInt(boss.hurt) || 0;
                const _slices = _elapsed / BOSS_SLICE_MS;                      // 折算跳数 0.33~2
                const _k = 1 - Math.pow(1 - BOSS_SPRINT_K, _slices);           // 本跳冲刺步进比例
                let budget = Math.max(Math.round(hp * BOSS_CRAWL * _slices), Math.round((_tgt - _hurt0) * _k));
                if (_hurt0 >= _cap) budget = 0;                                // 已到硬顶 → 停手，等玩家补刀
                else if (_hurt0 + budget > _cap) budget = _cap - _hurt0;
                tgtPct = Math.round(_tgtPct * 100);
                if (budget > 0) {
                    const SevClubBossModel_1 = require("./src/model/sev/SevClubBossModel");
                    const sevBoss = SevClubBossModel_1.SevClubBossModel.getInstance(ctx, clubId);
                    let last = "";
                    for (const u of crew) {
                        const h = Math.max(1, Math.round(budget / crew.length * (0.7 + Math.random() * 0.6)));
                        dmg += h; last = u;
                        try { await sevBoss.addHurt(bossId, u, h); } catch (e) { report.push("  addHurt err " + (e && e.message)); break; }
                    }
                    crewN = crew.length;
                    boss.hurt = (parseInt(boss.hurt) || 0) + dmg;
                    // [v4.59] 首次出手在仙盟频道报一句血线（原来完全无声 → 玩家感知不到人机在打）
                    if (dmg > 0 && !_bossOpenNoticed[clubId + "#" + bossId]) {
                        _bossOpenNoticed[clubId + "#" + bossId] = 1;
                        if (boss.__soloOpenNotice) { try { delete boss.__soloOpenNotice; } catch (e) { } }   // 清理旧版污染字段
                        if (!opts.silent) await clubNotice(ctx, clubId, crew[0], "【仙盟BOSS】大妖" + (bossName || "") + "已现身，还剩 " + Math.max(0, hp - (parseInt(boss.hurt) || 0)) + " 血，兄弟们上！", report);
                    }
                    if (boss.hurt >= hp) {
                        // 击杀（官方语义：kill 非空 = 今日已击杀，当天不再打；次日 0 点重置后自动开下一只）
                        // [v4.63] 有 85% 硬顶后这里正常走不到——击杀只可能由玩家补刀走官方路径触发（保留兜底）
                        killed = last; boss.kill = last;
                        if (parseInt(boss.open) === parseInt(boss.unlock)) {
                            boss.unlock = Math.min(bossLastId(), (parseInt(boss.unlock) || 1) + 1); // 解锁下一只（官方 L651；表内最后一只为止）
                        }
                        // 击杀奖励邮件 → 全盟真人成员（复刻官方 L654-676；假人不发，免撑库）
                        let cfgRwd = null;
                        try {
                            try { cfgRwd = gameCfg.monClubBoss.getItem(bossId); } catch (e) { }
                            let mailSent = 0, mailErr = "";
                            for (const fuuid in miB2.list) {
                                const n2 = parseInt(fuuid);
                                if (n2 >= FAKE_MIN && n2 <= FAKE_MAX) continue; // 假人不发
                                try {
                                    ctx.state.fuuid = fuuid;
                                    await ctx.state.master.sendMail(fuuid, {
                                        title: "仙盟BOSS奖励",
                                        content: "剑气纵横三万里，一剑霜寒十四州，大妖" + (cfgRwd ? cfgRwd.name : "") + "已被封印，仙盟论功行赏：",
                                        items: cfgRwd ? cfgRwd.killrwd : [],
                                    });
                                    mailSent++;
                                } catch (e2) { mailErr = (e2 && e2.message) || String(e2); }
                            }
                            ctx.state.fuuid = "";
                            mailInfo = " 邮件" + mailSent + "封" + (mailErr ? " ERR:" + mailErr : "");
                        } catch (e) { mailInfo = " BOSS奖励邮件块 ERR " + ((e && e.message) || e); }
                        // [v4.59] 击杀后在仙盟频道报一句（以击杀者身份）
                        if (!opts.silent) { try { await clubNotice(ctx, clubId, last, "大妖" + (cfgRwd ? cfgRwd.name : "") + "已被封印！论功行赏已发至邮箱，兄弟们辛苦了～", report); } catch (e2) { } }
                    }
                } else {
                    skipMsg = "（假人输出已达 " + Math.round(BOSS_TGT_CAP * 100) + "% 血线硬顶，最后一击留给玩家）";
                }
            } else {
                skipMsg = "（本盟无假人成员）";
            }
        } else if (parseInt(boss.open) > 0 && boss.kill) {
            skipMsg = "（今日已被击杀，等次日重置自动开下一只）";
        } else if (parseInt(boss.open) > 0 && !inWindow) {
            skipMsg = "（不在挑战时间 10:00~22:00）";
        } else {
            skipMsg = "（未开启" + (inWindow ? "（会长可手动开）" : "，不在挑战时间 10:00~22:00") + "）";
        }
        await sevClub.update(clubInfo);
        // 玩家 actClub 镜像（客户端 showClub 读这里）——走模型写（内存权威）
        aClub.boss = Object.assign({}, aClub.boss || {}, {
            open: boss.open, unlock: boss.unlock, hurt: boss.hurt, kill: boss.kill || "",
        });
        await acm.update(aClub);
        await ctx.state.master.distroy();   // 官方落盘函数（写 db + redis）
        report.push("  BOSS#" + (bossId || "-") + " 血线 " + (parseInt(boss.hurt) || 0) + "/" + hp +
            (tgtPct ? "[假人目标 " + tgtPct + "%]" : "") +
            (dmg > 0 ? "（本跳假人输出 " + dmg + "，" + crewN + " 人出手）" : "") +
            (killed ? " ※ 击杀！" + killed + " → 下一只 #" + boss.unlock + "（明日自动开启）" : "") + mailInfo + skipMsg);
    } catch (e) { report.push("  仙盟BOSS ERR " + ((e && e.stack) || e)); }
}
async function readSevClub(ctx, clubId) {
    const SevClubModel_1 = require("./src/model/sev/SevClubModel");
    const m = SevClubModel_1.SevClubModel.getInstance(ctx, clubId);
    return { model: m, info: await m.getInfo() };
}
async function tickClub(profs, ctx, report) {
    // [v4.6.4+] ⚠ 玩家 actClub 读改写走【模型】（同上：不再用 rowOf 磁盘快照全量写回）
    const ActClubModel_0 = require("./src/model/act/ActClubModel").ActClubModel;
    const acm = ActClubModel_0.getInstance(ctx, ANCHOR);
    const aClub = await acm.getInfo();
    const clubId = aClub.clubId;
    if (!clubId || clubId === "0") { report.push("  仙盟：玩家尚未入盟，跳过（建盟后下一跳自动接管）"); return; }
    report.push("  仙盟 clubId=" + clubId);

    // ---- ① 假人入盟（成员列表里有假人） ----
    try {
        const SevClubMemberModel_1 = require("./src/model/sev/SevClubMemberModel");
        const mm = SevClubMemberModel_1.SevClubMemberModel.getInstance(ctx, clubId);
        const info = await mm.getInfo();
        if (!info.list) info.list = {};
        // 从已有真人成员条目克隆字段形状（避免结构不匹配导致客户端渲染报错）
        let tpl = null;
        for (const u in info.list) { if (String(u) === ANCHOR) { tpl = info.list[u]; break; } }
        if (tpl == null) for (const u in info.list) { tpl = info.list[u]; break; }
        // [v4.5] 10 盟由 seedFakes 满编分配（20 人/盟）；旧"补 8 人"逻辑退役（玩家自建盟由 clubMoveTick 管理）
        // [v4.6.5] 自愈：玩家成员条目缺失时补入（否则客户端成员列表/祈福榜/详情入口都看不见玩家自己）
        if (!info.list[ANCHOR]) {
            try {
                info.list[ANCHOR] = { post: 0, time: ctx.state.newTime, active: 10, longgong: 0, active7D: 96 };
                info.count = Object.keys(info.list).length;
                await mm.update(info);
                try { await require("./src/model/sev/SevAdokClubModel").SevAdokClubModel.getInstance(ctx, clubId).setVer("clubMember"); } catch (e2) { }
                report.push("  仙盟成员: [自愈] 补入玩家条目 → " + info.count + " 人");
            } catch (e2) { report.push("  仙盟成员自愈 ERR " + ((e2 && e2.message) || e2)); }
        }
        info.count = Object.keys(info.list).length;
        report.push("  仙盟成员: 现有 " + info.count + " 人");
        await ctx.state.master.distroy();   // 官方落盘函数（写 db + redis）
    } catch (e) { report.push("  仙盟成员 ERR " + ((e && e.message) || e)); }

    // ---- ② 假人打 BOSS（[v4.59] 抽成 bossTick()：主 tick 与 90s 快 tick 共用，预算按时间片） ----
    try { await bossTick(ctx, clubId, aClub, acm, report, {}); } catch (e) { report.push("  仙盟BOSS ERR " + ((e && e.stack) || e)); }

    // ---- ④ P4.3 福星祈福：假人自动抽 + 领取 → 全盟 cons 增长 ----
    try { await fxSocialTick(ctx, profs, clubId, report); } catch (e) { report.push("  福星 ERR " + ((e && e.stack) || e)); }
    // ---- ⑤ P4.3 互助：假人求助 / 假人帮玩家求助 ----
    try { await helpSocialTick(ctx, profs, clubId, report); } catch (e) { report.push("  互助 ERR " + ((e && e.stack) || e)); }
    // ---- ⑥ P4.4 假人搬家：玩家自建盟 → 假人陆续退原盟 / 申请加入 ----
    try { await clubMoveTick(ctx, profs, clubId, report); } catch (e) { report.push("  搬家 ERR " + ((e && e.stack) || e)); }
    // ---- ⑦ P4.5 仙盟自主流动：假人在 10 盟之间换盟 ----
    try { await roamTick(ctx, profs, report); } catch (e) { report.push("  流动 ERR " + ((e && e.stack) || e)); }
    // ---- ⑧ P4.6 仙盟聊天：假人主动发言（AI 优先 / 模板兜底） ----
    try { await clubChatTick(ctx, profs, clubId, report); } catch (e) { report.push("  仙盟聊天 ERR " + ((e && e.stack) || e)); }
}

// ==================== P4.3 仙盟社交：福星祈福 ====================
// 复刻官方 qifu()+lingqu()：六连抽（30% 出 6）→ 按 clubFuxing[count6] 领灵力/金豆/贡献 → 计入全盟 cons
async function fxSocialTick(ctx, profs, clubId, report) {
    const st = loadClubState();
    const members = await clubFakeMembers(ctx, clubId, profs);
    const SevClubFxModel_1 = require("./src/model/sev/SevClubFxModel");
    let acted = 0, consAdd = 0;
    for (const u of members) {
        const used = st.qifu[u] || 0;
        if (used >= 10) continue;                         // 官方上限 mathcfg club_chouFu.count1=10 次/日
        if (Math.random() > 0.08) continue;               // 10 分钟一跳 → 约 8~10 次/日/人
        let count6 = 0;                                    // 官方六连抽分布
        for (let i = 0; i < 6; i++) { if (rand(1, 10000) <= 3000) count6++; }
        let yl = 0, jjd = 0, gx = 0;
        try {
            const cfg = gameCfg.clubFuxing.getItem(String(count6));
            for (const it of (cfg && cfg.items) || []) {
                if (it[0] == 1) {
                    if (it[1] == 7) gx += it[2];
                    if (it[1] == 912) yl += it[2];
                    if (it[1] == 913) jjd += it[2];
                }
            }
        } catch (e) { }
        try {
            await SevClubFxModel_1.SevClubFxModel.getInstance(ctx, clubId).addList(u, count6, yl, jjd, gx);
            st.qifu[u] = used + 1; acted++; consAdd += count6;
        } catch (e) { report.push("  福星 addList err " + ((e && e.message) || e)); break; }
    }
    if (acted > 0) {
        try { await ctx.state.master.distroy(); } catch (e) { }
        report.push("  福星: " + acted + " 名假人祈福（cons +" + consAdd + "）");
    }
    saveClubState(st);
    return { acted: acted, consAdd: consAdd };
}

// ==================== P4.3 仙盟社交：互助 ====================
// ① 假人发起求助（写 clubHelp 列表 + 公会频道 type5 消息）→ 玩家可去“帮忙”
// ② 玩家发起求助后，假人自动来帮（复刻 helpTask：记录 helps + 触发玩家侧 clubZhuLi）
async function helpSocialTick(ctx, profs, clubId, report) {
    const now = ctx.state.newTime;
    const st = loadClubState();
    const H = require("./src/model/sev/SevClubHelpModel").SevClubHelpModel;
    const hm = H.getInstance(ctx, clubId);
    const uuidMap = {}; for (const p of profs) uuidMap[p.uuid] = p;

    // ① 补假人求助（维持在 1~2 条活跃，每天最多 3 条）
    let info = await hm.getInfo();
    const live = Object.keys(info.list || {}).filter((lid) => {
        const t = info.list[lid];
        return t.otime > now && parseInt(t.uuid) >= FAKE_MIN;
    });
    if (live.length < 2 && st.helpAdded < 3) {
        const usedUuids = {};
        for (const lid in info.list) usedUuids[info.list[lid].uuid] = 1;
        const members = await clubFakeMembers(ctx, clubId, profs);
        const cand = members.filter((u) => !usedUuids[u]);
        if (cand.length > 0) {
            const u = cand[Math.floor(Math.random() * cand.length)];
            const p = uuidMap[u] || { uuid: u, name: "玩家" + u.slice(-3), sex: 0, head: "", level: 150 };
            const type = ["box", "boxStep", "fushi"][rand(0, 2)];
            try {
                const lid = await hm.add({ uuid: p.uuid, type: type, helps: {}, cars: {}, otime: now + rand(2, 5) * 3600 });
                st.helpAdded++;
                report.push("  互助: 假人[" + p.name + "] 发起 " + type + " 求助（lid=" + lid + "）");
                try {
                    let fuser = null;
                    try { fuser = await cache.getFUser(ctx, p.uuid, 1); } catch (e) { }
                    if (!fuser) { try { fuser = await F2.fakeFuserFull(p.uuid); } catch (e) { } } if (!fuser) fuser = fakeUserOf(p);
                    const C = require("./src/model/sev/SevChatModel").SevChatModel;
                    await C.getInstance(ctx, clubId, "club").add({ id: 0, type: "5", user: fuser, msg: String(lid), time: now });
                } catch (e) { report.push("  求助聊天 err " + ((e && e.message) || e)); }
                try { await ctx.state.master.distroy(); } catch (e) { }
            } catch (e) { report.push("  互助 add err " + ((e && e.message) || e)); }
        }
    }

    // ② 假人帮玩家的求助（未过期、未被该假人帮过）
    await helpPlayerSeeks(ctx, profs, clubId, report);
    saveClubState(st);
}

// ② 独立段（供 tick 与 nudgeHelp 复用）：假人帮玩家的求助
async function helpPlayerSeeks(ctx, profs, clubId, report) {
    const now = ctx.state.newTime;
    const hm = require("./src/model/sev/SevClubHelpModel").SevClubHelpModel.getInstance(ctx, clubId);
    const info = await hm.getInfo();
    for (const lid in info.list) {
        const t = info.list[lid];
        if (String(t.uuid) !== ANCHOR) continue;
        if (t.type === "dongtian") {
            // [v4.6.8] 官方对 dongtian 求助不写 otime（ActClubModel 恒 0）→ 不能再用 t.otime 判"过期"（否则假人永远跳过）。
            //   过期与否由 helpDongTianSeek 自行判定：无被占车(busy=0)直接返回；有则继续来帮，直到驱赶成功。
            try { await helpDongTianSeek(ctx, profs, clubId, lid, t, report); } catch (e) { report.push("  洞天求助 err " + ((e && e.message) || e)); }
            continue;
        }
        if (!(t.otime > now)) continue;
        if (t.type !== "box" && t.type !== "boxStep" && t.type !== "fushi") continue;
        let n = 0;
        for (const p of profs) {
            if (n >= 4) break;                              // [v4.6.4] 提速：2 → 4 人/跳（10 分钟一跳，更快帮满）
            if (t.helps && t.helps[p.uuid]) continue;
            try { await hm.helpTask(p.uuid, lid); n++; }
            catch (e) { report.push("  helpTask err " + ((e && e.message) || e)); break; }
        }
        if (n > 0) {
            report.push("  互助: " + n + " 名假人帮了你的求助（lid=" + lid + "）");
            try { await ctx.state.master.distroy(); } catch (e) { }
        }
    }
}

// ==================== [v4.6.4] 求助快速响应（不等 10 分钟 tick） ====================
// 触发：fakes2.onRequest 感知 /chat/send 的 type=4/5（洞天/鼎炉求助卡片）→ 延迟 4~10 秒执行本函数。
// 用独立 ctx（请求已结束）；只跑“帮玩家求助”段（含 dongtian 驱赶）。
async function nudgeHelp(clubId) {
    const report = [];
    try {
        clearJsonCache();
        const profs = await readFakeProfiles();
        const ctx = ctxLite();
        await helpPlayerSeeks(ctx, profs, String(clubId), report);
    } catch (e) {
        try { console.error("[solo-fakes3] nudgeHelp 异常 " + ((e && e.stack) || e)); } catch (e2) { }
    }
    if (report.length) { try { console.log("[solo-fakes3] 求助快响: " + report.join(" | ")); } catch (e) { } }
    return report;
}

// ==================== P4.4 仙盟·假人搬家（玩家自建盟招人） ====================
// 玩家建新盟后：假人陆续"退原盟 → 申请加入"（可审批；20 分钟未审自动入盟）
const FAKE_CLUB_IDS = ["2001", "2002", "2003", "2004", "2005", "2006", "2007", "2008", "2009", "2010"];   // v4.5：10 盟
async function clubMoveTick(ctx, profs, clubId, report) {
    const M = String(clubId || "");
    if (M === "" || FAKE_CLUB_IDS.indexOf(M) >= 0) return;      // 玩家没盟 / 在假人盟 → 不管
    const st = loadClubState();
    if (st.moveClub !== M) { st.moveClub = M; st.moved = {}; st.applied = {}; }   // 换盟时重置
    if (!st.moved) st.moved = {};
    if (!st.applied) st.applied = {};
    if (!st.refused) st.refused = {};
    const now = ctx.state.newTime;
    const SevClubMemberModel = require("./src/model/sev/SevClubMemberModel").SevClubMemberModel;
    const SevClubApplyModel = require("./src/model/sev/SevClubApplyModel").SevClubApplyModel;
    const SevClubFxModel = require("./src/model/sev/SevClubFxModel").SevClubFxModel;
    const ActClubModel = require("./src/model/act/ActClubModel").ActClubModel;
    const nameOf = (u) => { for (const p of profs) { if (String(p.uuid) === String(u)) return p.name; } return "假人" + String(u).slice(-3); };
    // 0) 同步申请结果：已入盟 → moved；申请表消失 → 被拒（24h 内不再来）
    try {
        const m0 = await SevClubMemberModel.getInstance(ctx, M).getInfo();
        const a0 = await SevClubApplyModel.getInstance(ctx, M).getInfo();
        for (const u of Object.keys(st.applied)) {
            if ((m0.list || {})[u]) { st.moved[u] = now; delete st.applied[u]; report.push("  仙盟: 假人[" + nameOf(u) + "] 已入我的仙盟"); continue; }
            if (!(a0.list || {})[u]) { st.refused[u] = now; delete st.applied[u]; report.push("  仙盟: 假人[" + nameOf(u) + "] 的申请被拒（24h 内不再来）"); }
        }
    } catch (e) { report.push("  仙盟同步 ERR " + ((e && e.message) || e)); }
    // 1) 申请超时兜底：假人申请 >20 分钟未审 → 自动入盟（拟盟主同意）
    try {
        const am = SevClubApplyModel.getInstance(ctx, M);
        const aInfo = await am.getInfo();
        for (const fuuid in (aInfo.list || {})) {
            if (parseInt(fuuid) < FAKE_MIN || parseInt(fuuid) > FAKE_MAX) continue;
            if (st.refused[fuuid] && now - st.refused[fuuid] < 86400) { await am.del(fuuid); continue; }
            const t = parseInt(aInfo.list[fuuid]) || 0;
            if (now - t < 20 * 60) continue;
            await am.del(fuuid);
            try {
                await ActClubModel.getInstance(ctx, fuuid).joinClub(M);
                st.moved[fuuid] = now; delete st.applied[fuuid];
                report.push("  仙盟: 假人[" + nameOf(fuuid) + "] 申请超时 → 自动入盟（拟盟主同意）");
                try { await ctx.state.master.distroy(); } catch (e) { }
            } catch (e) { report.push("  仙盟自动入盟 err " + fuuid + " " + ((e && e.message) || e)); }
        }
    } catch (e) { report.push("  仙盟兜底 ERR " + ((e && e.message) || e)); }
    // 2) 招新：目标 10 名假人；无待审申请时，每跳 1 人"退原盟 → 申请加入"
    try {
        const mInfo = await SevClubMemberModel.getInstance(ctx, M).getInfo();
        const fakeCnt = Object.keys(mInfo.list || {}).filter((u) => { const n = parseInt(u); return n >= FAKE_MIN && n <= FAKE_MAX; }).length;
        if (fakeCnt >= 10) { saveClubState(st); return; }
        const a2 = await SevClubApplyModel.getInstance(ctx, M).getInfo();
        const pendingFake = Object.keys(a2.list || {}).filter((u) => { const n = parseInt(u); return n >= FAKE_MIN && n <= FAKE_MAX && !(st.refused[u] && now - st.refused[u] < 86400); }).length;
        if (pendingFake > 0) { saveClubState(st); return; }     // 先等申请被处理
        const cands = [];
        for (const p of profs) {
            if (st.moved[p.uuid]) continue;
            if (st.refused[p.uuid] && now - st.refused[p.uuid] < 86400) continue;
            const cid = String((rowOf("act", p.uuid, "actClub") || {}).clubId || "");
            if (FAKE_CLUB_IDS.indexOf(cid) < 0) continue;       // 只搬还在假人盟的
            cands.push(p);
        }
        if (cands.length === 0) { saveClubState(st); return; }
        const p = cands[rand(0, cands.length - 1)];
        const oldId = String((rowOf("act", p.uuid, "actClub") || {}).clubId || "");
        // a) 退出原假人盟（清成员表 + 福星 + 旧盟频道"退出了仙盟"）
        try {
            for (const cid of FAKE_CLUB_IDS) {
                try {
                    const mm = SevClubMemberModel.getInstance(ctx, cid);
                    const mi = await mm.getInfo();
                    if (mi.list && mi.list[p.uuid]) { delete mi.list[p.uuid]; mi.count = Object.keys(mi.list).length; await mm.update(mi); }
                    const fx = SevClubFxModel.getInstance(ctx, cid);
                    const fi = await fx.getInfo();
                    if (fi.list && fi.list[p.uuid]) { delete fi.list[p.uuid]; await fx.update(fi); }
                } catch (e) { }
            }
            if (FAKE_CLUB_IDS.indexOf(oldId) >= 0) {
                let oldName = "仙盟" + oldId;
                try { const SM = require("./src/model/sev/SevClubModel").SevClubModel; oldName = ((await SM.getInstance(ctx, oldId).getInfo()).name) || oldName; } catch (e) { }
                try {
                    const C = require("./src/model/sev/SevChatModel").SevChatModel;
                    await C.getInstance(ctx, oldId, "club").add({ id: 0, type: "3", user: (await F2.fakeFuserFull(p.uuid)) || fakeUserOf(p), msg: p.name + "退出了仙盟", time: now });
                } catch (e) { }
                report.push("  仙盟: 假人[" + p.name + "] 退出[" + oldName + "]");
            }
            const fmA = ActClubModel.getInstance(ctx, p.uuid);
            const acInfo = await fmA.getInfo();
            acInfo.clubId = "";
            await fmA.update(acInfo);
            try { await ctx.state.master.distroy(); } catch (e) { }
        } catch (e) { report.push("  仙盟退盟 err " + p.name + " " + ((e && e.message) || e)); }
        // b) 申请加入我的仙盟（官方 joinClubApplyIds：申请表 + 假人 applyIds）
        try {
            await ActClubModel.getInstance(ctx, p.uuid).joinClubApplyIds(M);
            st.applied[p.uuid] = now;
            try { await ctx.state.master.distroy(); } catch (e) { }
            report.push("  仙盟: 假人[" + p.name + "] 申请加入我的仙盟（等审批 / 20min 自动）");
        } catch (e) { report.push("  仙盟申请 err " + p.name + " " + ((e && e.message) || e)); }
    } catch (e) { report.push("  仙盟招新 ERR " + ((e && e.stack) || e)); }
    saveClubState(st);
}

// ==================== P4.5 仙盟·自主流动（假人换盟） ====================
// 每 ~30 分钟 1 人：在 10 个假人盟之间随机换盟（玩家所在盟不参与）；双频道播报
async function roamTick(ctx, profs, report) {
    if (Math.random() > 0.33) return;
    const aClub = rowOf("act", ANCHOR, "actClub") || {};
    const myClub = String(aClub.clubId || "");
    const ids = FAKE_CLUB_IDS.filter((c) => c !== myClub);
    if (ids.length < 2) return;
    const SevClubMemberModel = require("./src/model/sev/SevClubMemberModel").SevClubMemberModel;
    const srcId = ids[rand(0, ids.length - 1)];
    const dstCands = ids.filter((c) => c !== srcId);
    const dstId = dstCands[rand(0, dstCands.length - 1)];
    let mi = null;
    try { mi = await SevClubMemberModel.getInstance(ctx, srcId).getInfo(); } catch (e) { return; }
    const cands = Object.keys(mi.list || {}).filter((u) => { const n = parseInt(u); return n >= FAKE_MIN && n <= FAKE_MAX; });
    if (!cands.length) return;
    const u = cands[rand(0, cands.length - 1)];
    const p = profs.find((x) => String(x.uuid) === String(u)) || { uuid: u, name: "侠客" + u };
    const now = ctx.state.newTime;
    let fus = null; try { fus = await F2.fakeFuserFull(u); } catch (e) { }
    // 退 src
    try {
        delete mi.list[u];
        mi.count = Object.keys(mi.list).length;
        await SevClubMemberModel.getInstance(ctx, srcId).update(mi);
        try {
            const fx = require("./src/model/sev/SevClubFxModel").SevClubFxModel.getInstance(ctx, srcId);
            const fi = await fx.getInfo();
            if (fi.list && fi.list[u]) { delete fi.list[u]; await fx.update(fi); }
        } catch (e) { }
        let srcName = "仙盟" + srcId;
        try { const SM = require("./src/model/sev/SevClubModel").SevClubModel; srcName = ((await SM.getInstance(ctx, srcId).getInfo()).name) || srcName; } catch (e) { }
        try {
            const C = require("./src/model/sev/SevChatModel").SevChatModel;
            await C.getInstance(ctx, srcId, "club").add({ id: 0, type: "3", user: fus || fakeUserOf(p), msg: p.name + "退出了仙盟", time: now });
        } catch (e) { }
        report.push("  仙盟流动: [" + p.name + "] 退出[" + srcName + "]");
    } catch (e) { report.push("  流动退盟 ERR " + ((e && e.message) || e)); return; }
    // 进 dst
    try {
        const md = SevClubMemberModel.getInstance(ctx, dstId);
        const mid = await md.getInfo();
        if (!mid.list) mid.list = {};
        mid.list[u] = { post: 0, time: now, active: 10, longgong: rand(0, 120) };
        mid.count = Object.keys(mid.list).length;
        await md.update(mid);
        const ActClubModel = require("./src/model/act/ActClubModel").ActClubModel;
        const fac = ActClubModel.getInstance(ctx, u);
        const ai = await fac.getInfo();
        ai.clubId = dstId;
        await fac.update(ai);
        let dstName = "仙盟" + dstId;
        try { const SM2 = require("./src/model/sev/SevClubModel").SevClubModel; dstName = ((await SM2.getInstance(ctx, dstId).getInfo()).name) || dstName; } catch (e) { }
        try {
            const C2 = require("./src/model/sev/SevChatModel").SevChatModel;
            await C2.getInstance(ctx, dstId, "club").add({ id: 0, type: "3", user: fus || fakeUserOf(p), msg: p.name + "加入了仙盟", time: now });
        } catch (e) { }
        try { await ctx.state.master.distroy(); } catch (e) { }
        report.push("  仙盟流动: [" + p.name + "] 加入[" + dstName + "]");
    } catch (e) { report.push("  流动入盟 ERR " + ((e && e.message) || e)); }
}

// ==================== P4.6 仙盟聊天：假人主动发言（AI 优先 / 模板兜底） ====================
// 每跳（10 分钟）约 1/3 概率由一名同盟假人在仙盟频道说一句；文本走 MiniMax AI（fakes2.aiReply），
// 失败回退模板。写入 SevChatModel（club 频道）→ 客户端 clickAllSev 对比 ver 后随心跳下发（~15s 内上屏）。
const CLUB_LINES = [
    "今天谁打BOSS？缺个输出的", "求带一趟六道秘境，有空的喊我", "福星祈福别忘了点，白嫖也是赚",
    "晚上约一波斗法场啊", "刚上香出了好东西，今天运气不错", "洞天又被抢了，谁帮我打回去😤",
    "新装备终于成型了，战力小涨", "有人在吗，冒个泡", "仙盟BOSS还有半管血，兄弟们冲", "跨服斗法被人吊打了，求安慰",
];
async function clubChatTick(ctx, profs, clubId, report) {
    if (Math.random() > 0.34) return;
    const members = await clubFakeMembers(ctx, clubId, profs);
    if (members.length === 0) return;
    const u = members[rand(0, members.length - 1)];
    const p = profs.find((x) => String(x.uuid) === String(u)) || { uuid: u, name: "侠客" + String(u).slice(-3) };
    let text = null;
    try {
        text = await F2.aiReply({
            name: p.name, player: "",
            msg: "（仙盟频道里随口聊一句：约打BOSS/求组队/聊装备/吐槽被抢矿车之类，20字以内，只输出这句话）",
        });
    } catch (e) { }
    if (!text) text = CLUB_LINES[rand(0, CLUB_LINES.length - 1)];
    try {
        const C = require("./src/model/sev/SevChatModel").SevChatModel;
        let fus = null;
        try { fus = await F2.fakeFuserFull(p.uuid); } catch (e) { }
        if (!fus) fus = fakeUserOf(p);
        await C.getInstance(ctx, clubId, "club").add({ id: 0, type: "1", user: fus, msg: text, time: ctx.state.newTime });
        report.push("  仙盟聊天: [" + p.name + "] " + text);
    } catch (e) { report.push("  仙盟聊天 ERR " + ((e && e.message) || e)); }
}

// ==================== P4.6 洞天求助：假人帮驱赶掠夺者 ====================
// 官方语义（UIMineBoxView.onClickSeek）：洞天求助 = “邀请仙盟成员帮助驱赶掠夺者”。
// 假人“帮”的动作 = 去玩家洞天把占车掠夺者打掉（对齐官方 /dongtian/fight 的 win==1 分支）。
async function helpDongTianSeek(ctx, profs, clubId, lid, task, report) {
    const now = ctx.state.newTime;
    const ActDongTianModel = require("./src/model/act/ActDongTianModel").ActDongTianModel;
    const gameMethod = require("./common/gameMethod").gameMethod;
    const pm = ActDongTianModel.getInstance(ctx, ANCHOR);
    const info = await pm.getInfo();
    if (!info.cars) return;
    // 找被占着的车（he.knum>0 未结算）
    const busy = Object.keys(info.cars).filter((pos) => {
        const c = info.cars[pos] || {};
        return c.he && parseInt(c.he.knum) > 0 && c.he.user && (parseInt(c.etime) || 0) > now;
    });
    if (busy.length === 0) return;
    const pos = busy[rand(0, busy.length - 1)];
    const car = info.cars[pos];
    // 帮忙的假人（同盟成员里挑一个没帮过的）
    const members = await clubFakeMembers(ctx, clubId, profs);
    const hm = require("./src/model/sev/SevClubHelpModel").SevClubHelpModel.getInstance(ctx, clubId);
    const hList = await hm.getInfo();
    const hTask = hList.list[lid];
    if (!hTask) return;
    if (!hTask.helps) hTask.helps = {};
    const avail = members.filter((m) => !hTask.helps[m]);
    if (avail.length === 0) return;
    const helperUuid = avail[rand(0, avail.length - 1)];
    const helper = profs.find((x) => String(x.uuid) === String(helperUuid)) || { uuid: helperUuid, name: "侠客" + String(helperUuid).slice(-3) };
    hTask.helps[helperUuid] = { time: now };
    await hm.update(hList, [""]);
    // 驱赶判定：72% 成功；失败留待下一跳
    if (Math.random() > 0.72) {
        report.push("  洞天求助: [" + helper.name + "] 驱赶失败（下跳再试）");
        try { await ctx.state.master.distroy(); } catch (e) { }
        return;
    }
    const rotFuser = car.he.user;
    const rotUuid = rotFuser && rotFuser.uuid ? String(rotFuser.uuid) : "";
    // ① 矿主车恢复（对齐官方 win==1）
    let carShow = gameMethod.getDongTianCar(car, now);
    if (carShow && carShow.nowpos != null) car.dpos = carShow.nowpos;
    car.he = { user: null, knum: 0, pow: 0, fevCard: false, pfid: "" };
    car.stime = 0;
    car.etime = 0;
    const myK = parseInt(car.my && car.my.knum) || 0;
    if (myK > 0) {
        car.stime = now;
        carShow = gameMethod.getDongTianCar(car, now);
        if (carShow && carShow.edtime > 0) {
            car.dpos = carShow.nowpos;
            car.etime = now + carShow.edtime;
        }
        if (!info.rob) info.rob = {};
        if (!info.rob[ANCHOR]) info.rob[ANCHOR] = {};
        info.rob[ANCHOR][pos] = gameMethod.objCopy(car);
    }
    if (!car.pklog) car.pklog = [];
    let hfus = null;
    try { hfus = await F2.fakeFuserSev(helper.uuid); } catch (e) { }
    car.pklog.push({ time: now, win: 1, user1: hfus, user2: rotFuser });
    await pm.update(info);
    // ② 掠夺者侧：删 rob 记录 + fight_b 日志（“掠夺时被驱赶”）
    if (rotUuid && parseInt(rotUuid) >= FAKE_MIN && parseInt(rotUuid) <= FAKE_MAX) {
        try {
            const rm = ActDongTianModel.getInstance(ctx, rotUuid);
            const rInfo2 = await rm.getInfo();
            if (rInfo2.rob && rInfo2.rob[ANCHOR]) { delete rInfo2.rob[ANCHOR]; await rm.update(rInfo2); }
            const LM = require("./src/model/act/ActDongTianLogModel").ActDongTianLogModel;
            await LM.getInstance(ctx, rotUuid).addLog("fight_b", car.id, helper.uuid, now);
        } catch (e) { report.push("  掠夺者日志 err " + ((e && e.message) || e)); }
    }
    // ③ 仙盟频道系统消息（type3 自由文本卡片）
    try {
        const C = require("./src/model/sev/SevChatModel").SevChatModel;
        if (!hfus) hfus = fakeUserOf(helper);
        await C.getInstance(ctx, clubId, "club").add({ id: 0, type: "3", user: hfus, msg: "盟友 " + helper.name + " 帮你驱赶了掠夺者，矿车已归位", time: now });
    } catch (e) { report.push("  求助频道消息 err " + ((e && e.message) || e)); }
    try { await ctx.state.master.distroy(); } catch (e) { }
    report.push("  洞天求助: [" + helper.name + "] 帮你驱赶了矿车#" + pos + " 上的掠夺者" + (rotFuser && rotFuser.name ? "(" + rotFuser.name + ")" : ""));
}

// ==================== P4.6 龙宫运宝：假人跑图 + 龙王显圣 ====================
// 存储：sev 表 kid=sevLonggong（id=合服ID "1"）：{time, xhuo:{fuuid,fAt}, list:{fuuid:yun}, ver}
// yun 语义（官方 ActLonggongYun）：ybSat=最后一次结算点 / ybpos=已走距离（1秒=1距离）/
//   ybEat=到站时间；总距离 = longgongJiaofu.miao；显圣期间速度 ×100/longgong_xiansheng.count
const LG_TARGET = 48;      // 维持 48 个假人运宝（客户端最多显示 30 个 + 剩余供下拉 get5 补充）
function lgPickJiaofu() {
    // ⚠️ 坑：gameCfg 的 pool 键带尾下划线（"1_"），必须用配置对象 id 归一化（与 jjcNpc.pool 同坑）
    const pool = (gameCfg.longgongJiaofu && gameCfg.longgongJiaofu.pool) || {};
    const arr = [];
    let total = 0;
    for (const k in pool) { const pr = parseInt(pool[k].prob) || 1; total += pr; arr.push([String(pool[k].id || k).replace(/_+$/, ""), pr]); }
    let r = Math.random() * total;
    for (const it of arr) { r -= it[1]; if (r <= 0) return it[0]; }
    return arr.length ? arr[0][0] : "1";
}
async function longgongTick(ctx, profs, report) {
    const now = ctx.state.newTime;
    const SM = require("./src/model/sev/SevLonggongModel").SevLonggongModel;
    const sm = SM.getInstance(ctx, "1");
    const info = await sm.getInfo();
    if (!info.list) info.list = {};
    if (!info.xhuo) info.xhuo = { fuuid: "", fAt: 0 };
    const gameMethod = require("./common/gameMethod").gameMethod;

    // ① 清理过期（对齐官方 clearYunOver 语义：ybEat<=now 删）
    let expired = 0;
    for (const u in info.list) {
        if ((parseInt(info.list[u].ybEat) || 0) <= now) { delete info.list[u]; expired++; }
    }
    // ② 补充假人运宝（维持 LG_TARGET 人，随机进度）
    let started = 0;
    const live = Object.keys(info.list);
    const pool2 = profs.filter((p) => live.indexOf(p.uuid) < 0);
    for (let i = pool2.length - 1; i > 0; i--) { const j = rand(0, i); const t = pool2[i]; pool2[i] = pool2[j]; pool2[j] = t; }
    while (Object.keys(info.list).length < LG_TARGET && pool2.length > 0) {
        const p = pool2.pop();
        const jiaofu = lgPickJiaofu();
        let miao = 600;
        try { miao = parseInt(gameCfg.longgongJiaofu.getItem(jiaofu).miao) || 600; } catch (e) { }
        const done = rand(0, Math.floor(miao * 0.6));                 // 已走距离（像真人陆续出发）
        let ybSat, ybEat;
        if ((parseInt(info.xhuo.fAt) || 0) > now) {
            // [v4.6.5] 显圣活跃期：数据必须与官方显圣加速公式同构（客户端按公式重算 pos，否则“跑图错误数据”刷屏）
            let xsCount = 10;
            try { xsCount = tool.mathcfg_count(ctx, "longgong_xiansheng") || 10; } catch (e) { }
            ybSat = now;
            const leftMiao = miao - done;
            const jsMax = Math.floor(((parseInt(info.xhuo.fAt) || 0) - now) * 100 / xsCount);
            if (jsMax > leftMiao) ybEat = now + leftMiao / (100 / xsCount);
            else { ybEat = now + jsMax / (100 / xsCount); ybEat += (leftMiao - jsMax); }
        } else {
            ybSat = now - done;
            ybEat = ybSat + miao;
        }
        info.list[p.uuid] = {
            ybFuuid: "", ybpos: done, ybSat: ybSat, ybEat: ybEat,
            jiaofu: jiaofu, beida: 0, lgLv: rand(0, 8),
        };
        started++;
    }
    // ③ 显圣（过期后 25% 概率触发；整合官方 sevXiansheng 的结算/加速算法，但不扣道具）
    let xs = "";
    if ((parseInt(info.xhuo.fAt) || 0) <= now && Math.random() < 0.25) {
        let count = 10, count1 = 3600;
        try { count = tool.mathcfg_count(ctx, "longgong_xiansheng") || 10; } catch (e) { }
        try { count1 = tool.mathcfg_count1(ctx, "longgong_xs_need") || 3600; } catch (e) { }
        // 先结算（官方：把活动中的 yun 推到 now）
        for (const u in info.list) {
            if ((parseInt(info.list[u].ybEat) || 0) <= now) continue;
            info.list[u] = gameMethod.longgong_run(info.list[u], info.xhuo, now);
        }
        const oldxsAt = Math.max(parseInt(info.xhuo.fAt) || 0, now);
        const p = profs[rand(0, profs.length - 1)];
        info.xhuo.fuuid = p.uuid;
        info.xhuo.fAt = now + count1;
        info.ver = (parseInt(info.ver) || 1) + 1;
        const newxsAt = info.xhuo.fAt;
        // 重新结算到站时间（官方 sevXiansheng 后段：显圣期间多跑的距离 → 提前到站）
        if (newxsAt > oldxsAt) {
            for (const u in info.list) {
                const y = info.list[u];
                if ((parseInt(y.ybEat) || 0) <= now) continue;
                if ((parseInt(y.ybEat) || 0) <= oldxsAt) continue;
                let miao = 600;
                try { miao = parseInt(gameCfg.longgongJiaofu.getItem(y.jiaofu).miao) || 600; } catch (e) { }
                const jsMax = Math.floor((newxsAt - y.ybSat) * 100 / count);
                const leftMiao = miao - y.ybpos;
                if (jsMax > leftMiao) y.ybEat = y.ybSat + leftMiao / (100 / count);
                else { y.ybEat = y.ybSat + jsMax / (100 / count); y.ybEat += (leftMiao - jsMax); }
            }
        }
        xs = p.name;
    }
    await sm.update(info, [""]);
    try { await ctx.state.master.distroy(); } catch (e) { }
    report.push("  龙宫: 运宝假人 " + Object.keys(info.list).length + " 人（本跳 +" + started + " / 清 " + expired + "）" + (xs ? " ※ [" + xs + "] 龙王显圣开启！" : ""));
}

// ==================== P4.4 洞天·假人入侵（假人掠夺我的矿车） ====================
// ==================== [v4.39] 洞天假人入侵（覆盖所有真人号 - 每号每天 5 次） ====================
// 官方语义（ActDongTianModel.ts 的 NPC 抢洞天分支）：
//   info.rob[入侵者uuid][pos] = 车副本，其中 my = 入侵者、he = 被抢者
//   客户端 getCarPullList()/getDongTianShow() 按 "key == 自己 ? my.knum : he.knum" 区分
//   —— 若 key 写成"被抢者自己"，客户端会当成"我方出征"，界面上永远看不到有人来抢。
// 官方 robOver() 会在车到点后结算，并写 actDongTianLog 的 rob_f_b / rob_s_b，同时删掉 rob 条目。
function listRealUuids() {
    const out = [];
    try {
        const rows = readJson("user.json", []);
        const list = Array.isArray(rows) ? rows : (rows.rows || []);
        for (const r of list) {
            if (!r || r.kid !== "userInfo" || !r.data) continue;
            const id = String(r.id || "");
            const n2 = Number(id);
            if (!(n2 > 0) || n2 >= 200000) continue;      // 排除假人 200001+
            if (!(Number(r.data.level) > 0)) continue;
            out.push(id);
        }
    } catch (e) { }
    return out;
}

async function dtRaidOne(ctx, victim, profs, report) {
    // [v4.39b] 所有写入字段一律用"纯标量字面量"构造。
    //   若把 fakeFuserSev()/getFUser() 返回的富对象直接塞进 rob，redis hmSet 的
    //   JSON.stringify 会因 BigInt/循环引用抛错，导致整块 rob 值被丢弃（只剩空壳 key）。
    const now = ctx.state.newTime;
    const ActDongTianModel = require("./src/model/act/ActDongTianModel").ActDongTianModel;
    const gameMethod = require("./common/gameMethod").gameMethod;
    ctx.state.fuuid = victim;
    const pm = ActDongTianModel.getInstance(ctx, victim);
    const info = await pm.getInfo();
    if (!(parseInt(info.level) > 0) || !info.cars) { ctx.state.fuuid = ""; return false; }
    const posList = Object.keys(info.cars).filter((pos) => {
        const c = info.cars[pos] || {};
        if (!c.id) return false;
        const busy = c.he && c.he.knum > 0 && (parseInt(c.etime) || 0) > now;
        return !busy;
    });
    if (posList.length === 0) { ctx.state.fuuid = ""; return false; }
    const pos = posList[rand(0, posList.length - 1)];
    const car = info.cars[pos];
    const A = profs[rand(0, profs.length - 1)];
    const myK = parseInt(car.my && car.my.knum) || 0;
    let raidK = Math.max(1, Math.min(5, myK + (Math.random() < 0.55 ? 1 : -1)));
    try {
        const carCfg = gameCfg.dongtianCar.getItemCtx(ctx, car.id);
        if (carCfg && carCfg.post && raidK > carCfg.post) raidK = carCfg.post;
    } catch (e) { }

    // 被抢者身份：只取标量
    let vicName = "", vicLevel = parseInt(info.level) || 1;
    try {
        const vu = await cache_1.default.getFUser(ctx, victim, 1);
        if (vu) { vicName = String(vu.name || ""); vicLevel = Number(vu.level) || vicLevel; }
    } catch (e) { }
    if (!vicName) { try { vicName = String(info.user ? (info.user.name || "") : ""); } catch (e) { } }
    const atkName = String((A && A.name) || "");

    const inv = {
        id: String(car.id),
        pos: String(pos),
        dpos: parseInt(car.dpos) || 0,
        stime: now,
        etime: 0,
        my: { knum: raidK, pow: rand(60, 100), fevCard: false, pfid: "",
              user: { uuid: String(A.uuid), name: atkName, level: 200, head: "dyHead_1", sex: 0 } },
        he: { knum: myK, pow: parseInt(car.my && car.my.pow) || 0, fevCard: false, pfid: "",
              user: { uuid: String(victim), name: vicName, level: vicLevel, head: "35", sex: 0 } },
        pklog: [],
    };
    let ed = 1800;
    try { const cs = gameMethod.getDongTianCar(inv, now); if (cs && cs.edtime > 0) ed = cs.edtime; } catch (e) { }
    inv.etime = now + ed;

    if (!info.rob) info.rob = {};
    if (!info.rob[A.uuid]) info.rob[A.uuid] = {};
    info.rob[A.uuid][pos] = inv;
    if (!info.enemy) info.enemy = {};
    info.enemy[A.uuid] = now;
    await pm.update(info);
    ctx.state.fuuid = "";
    try { await ctx.state.master.distroy(); } catch (e) { report.push("  raid distroy ERR " + ((e && e.message) || e)); }
    report.push("  raid: [" + atkName + "] -> " + victim + " #" + pos + " " + raidK + "vs" + myK + " ed=" + ed);
    return true;
}

async function dtRaidTick(ctx, profs, report) {
    const st = loadClubState();
    if (!st.dtRaidAt) st.dtRaidAt = {};
    const now = ctx.state.newTime;
    const DAILY = 5;                                        // [v4.39] 每号每天 5 次（原全局 3 次）
    const victims = listRealUuids();
    if (victims.length === 0) return;
    let dirty = false;
    for (const uid of victims) {
        let rec = st.dtRaidAt[uid];
        if (!rec) { rec = { n: 0, nextAt: 0 }; st.dtRaidAt[uid] = rec; dirty = true; }
        if (rec.n >= DAILY) continue;
        if (rec.nextAt && now < rec.nextAt) continue;
        let ok = false;
        try { ok = await dtRaidOne(ctx, uid, profs, report); }
        catch (e) { report.push("  raid ERR " + ((e && e.message) || e)); }
        if (ok) {
            rec.n += 1;
            rec.nextAt = now + 7200 + Math.floor(Math.random() * 10800);   // 2~5 小时后
        } else {
            rec.nextAt = now + 600 + Math.floor(Math.random() * 1200);     // 10~30 分后再试
        }
        dirty = true;
    }
    if (dirty) saveClubState(st);
}

// ==================== [v4.6.5] 聊天快照升级（存量旧消息头像 → 与详情页一致） ====================
async function chatSnapshotFix(ctx, report) {
    const st = loadClubState();
    if ((st.chatFixAt || 0) > ctx.state.newTime - 21600) return;   // 每 6 小时最多一轮
    st.chatFixAt = ctx.state.newTime;
    saveClubState(st);
    let fixed = 0, rows = 0;
    try {
        const mongodb_1 = require("./src/util/mongodb");
        const db = mongodb_1.dbSev.getDataDb();
        const all = await db.find("chat", {});
        for (const row of all) {
            const data = row.data || {};
            const list = data.list || {};
            let changed = false;
            for (const k in list) {
                const m = list[k];
                if (!m || !m.user) continue;
                const uu = String(m.user.uuid || "");
                const n = parseInt(uu, 10);
                if (!(n >= 200001 && n <= 299999)) continue;      // 仅假人
                let fu = null;
                try { fu = await F2.fakeFuserFull(uu); } catch (e) { }
                if (!fu) continue;
                if (fu.head !== m.user.head || fu.name !== m.user.name || fu.level !== m.user.level || fu.sex !== m.user.sex) {
                    m.user.head = fu.head; m.user.name = fu.name; m.user.level = fu.level; m.user.sex = fu.sex;
                    changed = true; fixed++;
                }
            }
            if (changed) {
                await db.update("chat", { id: row.id, kid: row.kid, hdcid: row.hdcid }, { data: data });
                rows++;
            }
        }
        report.push("  聊天快照: 修复 " + fixed + " 条 / " + rows + " 频道");
    } catch (e) { report.push("  聊天快照 ERR " + ((e && e.message) || e)); }
}

// ==================== 主入口 ====================
async function tick(opts) {
    opts = opts || {};
    const report = [];
    clearJsonCache();
    const _anchor = await resolveAnchor();
    if (_anchor != null && _anchor !== ANCHOR) { ANCHOR = _anchor; report.push("锚点玩家 -> " + ANCHOR + "（最近登录）"); }
    const profs = await readFakeProfiles();
    const ctx = ctxLite();
    await tickDongTian(profs, ANCHOR, report);
    try { await dtRaidTick(ctx, profs, report); } catch (e) { report.push("  洞天入侵 ERR " + ((e && e.stack) || e)); }
    await tickClub(profs, ctx, report);
    // ---- ⑨ P4.6 龙宫运宝：假人跑图 + 龙王显圣 ----
    try { await longgongTick(ctx, profs, report); } catch (e) { report.push("  龙宫 ERR " + ((e && e.stack) || e)); }
    // ---- ⑩ [v4.6.5] 聊天快照升级（存量旧消息头像 → 与详情页一致） ----
    try { await chatSnapshotFix(ctx, report); } catch (e) { report.push("  聊天快照 ERR " + ((e && e.stack) || e)); }
    if (opts.dump) report.push("DUMP " + JSON.stringify({ fakes: profs.length }));    return { report: report };
}
// ===== [v4.59] 快 tick：只跑仙盟 BOSS（90s 一跳，让血线/伤害榜连续变动）=====
let _fastTimer = null;
async function fastTick() {
    try {
        const ctx = ctxLite();
        const ActClubModel_0 = require("./src/model/act/ActClubModel").ActClubModel;
        const acm = ActClubModel_0.getInstance(ctx, ANCHOR);
        const aClub = await acm.getInfo();
        const clubId = aClub.clubId;
        if (!clubId || clubId === "0") return { report: ["  快tick: 玩家未入盟，跳过"] };
        const report = [];
        await bossTick(ctx, clubId, aClub, acm, report, { fast: true });
        return { report: report };
    } catch (e) { return { report: ["  快tick ERR " + ((e && e.message) || e)] }; }
}
async function init() {
    if (!gameCfg.__inited) { try { gameCfg.init(); } catch (e) { } gameCfg.__inited = true; }
    try {
        const r = await tick({});
        console.log("[solo-fakes3] 初始 M3: " + r.report.join(" | "));
    } catch (e) { console.error("[solo-fakes3] 初始异常 " + ((e && e.stack) || e)); }
    if (_timer == null) {
        _timer = setInterval(() => { tick({}).catch(() => { }); }, TICK_MS);
        try { _timer.unref && _timer.unref(); } catch (e) { }
    }
    // [v4.59] 仙盟 BOSS 快 tick：90s 一跳（原来只在 13min 主 tick 里结算 → 血线/伤害榜变动太慢）
    if (_fastTimer == null) {
        _fastTimer = setInterval(() => { fastTick().then((r) => { try { if (r && r.report && r.report.length) console.log("[solo-fakes3] BOSS快tick: " + r.report.join(" | ")); } catch (e) { } }).catch(() => { }); }, BOSS_SLICE_MS);
        try { _fastTimer.unref && _fastTimer.unref(); } catch (e) { }
    }
    return true;
}

module.exports = { init, tick, fastTick, bossTick, readFakeProfiles, ctxLite, fxSocialTick, helpSocialTick, helpPlayerSeeks, nudgeHelp, clubFakeMembers, clubMoveTick, dtRaidTick, roamTick, clearJsonCache, FAKE_CLUB_IDS };

// ==================== CLI 自测 ====================
if (require.main === module) {
    (async () => {
        const dbDir = process.argv[2];
        if (!dbDir) { console.error("用法: node _solo_fakes3.js <dbDir> [--out 报告文件]"); process.exit(1); }
        process.env.SOLO_DB_DIR = dbDir;
        await mongodb_1.dbSev.init();
        await redis_1.redisSev.init();
        try { gameCfg.init(); } catch (e) { }
        const r = await tick({ dump: true });
        const outIdx = process.argv.indexOf("--out");
        const text = r.report.join("\n");
        if (outIdx > 0 && process.argv[outIdx + 1]) {
            fs.writeFileSync(process.argv[outIdx + 1], text, "utf8");
            console.log("报告已写入 " + process.argv[outIdx + 1]);
        } else {
            console.log(text);
        }
        process.exit(0);
    })().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
}
