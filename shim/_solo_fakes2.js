"use strict";
/**
 * [单机版 · 假人真人化引擎 v3] _solo_fakes2.js
 * ==================================================================================
 * 目标：把 24 个假人"按真人处理"。
 *
 *  ① 模块实体化 ensureProfiles()
 *     - 以"模块最全的真人角色"为模板，给每个假人生成真实的 actEquip / actChiBang /
 *       actChengH / actPveInfo / userInfo 模块（直接写 DB + redis 缓存，与官方读写路径一致）
 *     - 装备 eps 完全可控 —— 实测 ep_power 对装备 eps 是【线性】的（见 gm 实验）
 *
 *  ② 成长引擎 growTick()
 *     - 以"最近登录真人"的战力 P 为锚，24 个假人各乘一个分布因子 f_i（1.12 ~ 0.40）
 *     - p_i 平滑逼近 T_i = P * f_i（默认每 10 分钟一次，env SOLO_FAKE_GROW_MS）
 *     - 反解装备系数 k 使实测 ep_power ≈ p_i（一次测量即收敛，线性）
 *     - 每次 tick 给部分假人"随机换装备"（属性分配抖动 + 偶发换幻化/等级）
 *     - 榜单（rdsPvd 每日挑战 / rdsPvw 排位）随战力刷新
 *
 *  ③ 聊天交互 onRequest(ctx)
 *     - 玩家 /chat/send 成功后，1~3 个假人延迟 1~6 秒回复（关键词模板）
 *     - 预留 AI 接口：env SOLO_FAKE_AI_URL（POST JSON {name,player,msg} → {reply}），
 *       未配置或失败自动回退模板
 *
 * 状态文件：<dbDir>/solo_fakes_state.json（随 db 一起备份）
 * CLI：node _solo_fakes2.js <dbDir> [--once] [--chat "文本"]
 * ==================================================================================
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const mongodb_1 = require("./src/util/mongodb");
const redis_1 = require("./src/util/redis");
const game_1 = require("./src/util/game");
const tool_1 = require("./src/util/tool");
const master_1 = require("./src/util/master");
const gm = require("./common/gameMethod").gameMethod;
const RdsUserModel_1 = require("./src/model/redis/RdsUserModel");

const _def = (m) => (m && m.__esModule && m.default !== undefined) ? m.default : m;
const game = _def(game_1);
const tool = tool_1.tool;
const DTUSER = master_1.DataType.user;

const FAKE_MIN = 200001, FAKE_MAX = 200200;   // 假人 uuid 区间（_solo_fakes.js 定义，v4.5 扩至 200 人）
const SEV_DT = master_1.DataType.sev;         // SevChatModel 的 dType（redis 键前缀）
const Setting = _def(require("./src/crontab/setting"));
const GROW_MS = parseInt(process.env.SOLO_FAKE_GROW_MS || "600000", 10); // 默认 10 分钟
const SMOOTH = 0.35;                          // 逼近速度（0~1）
const JITTER = 0.03;                          // 每次 tick 的随机抖动
// v3.1 战力封顶：理论最高战力 ≈ 1,309,185,082（实验脚本 _t_max6.js 跑出的全系统配置天花板）
// 假人目标一律 ≤ 95% × 理论最高 → 玩家即使全满，假人也不会反超
const THEORY_MAX = 1309185082;
const FAKE_CAP = parseInt(process.env.SOLO_FAKE_CAP || String(Math.floor(THEORY_MAX * 0.95)), 10);
const _gcfg = _def(require("./common/gameCfg"));

// ==================== M2 档案池（已与客户端纹理表核对 2026-09-18） ====================
// 客户端 UIUserDetailView 十图标点亮条件（源码核对）：
//   剑灵 actChiBang.hh(1~12幻化) | 称号 chid=actChengH.chuan(title_*纹理) | 圣器 actShengQi.a.chuan
//   法阵 actFazhen.useGzId→list[..].fzid | 宝石 actBaoShi.list+能量>0 | 符石 actFuShi.a.fsku.level>0
//   仙侣 actXianlv.shangzhen.xlid(resIconHead/*) | 命盘 mpList[..].lingmai≠"" | 秘法 mfZhan 非空 | 精怪 szList[szid][i] 非空
const FAKE_HEADS = ["35", "58", "dyHead_1", "dyHead_2", "dyHead_3", "dyHead_4", "dyHead_5", "dyHead_6", "dyHead_7", "dyHead_8", "dyHead_9", "jxf_1", "jxf_2", "jxf_3", "jxf_4", "jxf_5", "skin_1", "xianlv_20", "xianlv_21", "xianlv_22", "xianlv_23", "xianlv_24", "xianlv_25", "xianlv_26"];
const FAKE_TITLES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "51", "101", "102", "151", "152", "153", "154", "155", "156", "157", "158", "159", "160", "161", "162", "163", "164", "165", "166", "167", "168", "169", "170", "171", "172", "173", "174", "175", "176", "177", "178", "501", "502", "503", "504", "505", "506", "601", "602", "603", "701", "702", "703", "704"];
const SHENGQI_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"];
const FAZHEN_IDS = ["1", "2", "3", "51", "52", "53", "101", "102", "103", "104", "105", "106", "151", "152", "153", "154", "155", "156", "157", "158"];
// [v4.60] 只取 type==1 的【真仙侣】——对齐官方 ActXianlvModel 抽取/合成的 `type == 1` 过滤。
//   旧表混入 101~108（经验仙桃 / 仙桃变身，type=2/3）→ 约 8/57 的人机把仙桃当上阵仙侣（一眼假）。
const XIANLV_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49"];
// [v4.48] 旧常量 MINGGE_SLOTS / MIFA_IDS 已废弃 —— 命盘(12 命格)/秘法(76 条) 改为按官方配置表全量生成，
//   见下方 buildWanXiang()。旧实现只用 6 个命格槽 + 12 个低品质秘法 id，是"人机秘法一眼假"的根源。
const JG_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"];
const FAKE_CLUBS = ["2001", "2002", "2003"];
const BAOSHI_GEMS = ["21", "22", "41", "42", "61", "62", "81", "82"];
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ==================== 基础工具 ====================
function statePath() {
    const dir = process.env.SOLO_DB_DIR || path.join(__dirname, "..", "..", "db");
    return path.join(dir, "solo_fakes_state.json");
}
function loadState() {
    try { return JSON.parse(fs.readFileSync(statePath(), "utf8")) || {}; } catch (e) { return {}; }
}
function saveState(st) {
    // [v4.40] 去掉 2 空格缩进：64KB 状态文件每 tick 格式化写会拖慢主线程
    try { fs.writeFileSync(statePath(), JSON.stringify(st), "utf8"); } catch (e) { }
}

// 读全部 user/act 行 → { uuid: { kid: data } }
async function loadAll() {
    const db = mongodb_1.dbSev.getDataDb();
    const map = {};
    for (const coll of ["user", "act"]) {
        const rows = await db.find(coll, {});
        for (const r of rows) {
            const id = String(r.id);
            if (map[id] == null) map[id] = {};
            if (map[id][r.kid] == null || String(r.hdcid) === "1") map[id][r.kid] = r.data;
        }
    }
    return map;
}

// 组装 sevBack（与 UserModel.getFUserAll 同款包装）并计算战力
function wrap(modules) {
    const m = modules || {};
    return {
        actEquip: m.actEquip != null ? { a: m.actEquip } : null,
        actChengH: m.actChengH,
        actChiBang: m.actChiBang,
        actFazhen: m.actFazhen,
        actShengQi: m.actShengQi != null ? { a: m.actShengQi } : null,
        actBaoShi: m.actBaoShi,
        actFuShi: m.actFuShi != null ? { a: m.actFuShi } : null,
        actDongTian: m.actDongTian,
        actClubMj: m.actClubMj,
        actJinxiu: m.actJinxiu,
        actWanXiang: m.actWanXiang,
        actJingGuai: m.actJingGuai,
        actXianlv: m.actXianlv,
        rdsJjcMy: { rid: 0, score: 0 },
        rdsDouLuoMy: { "1": { rid: 501, score: 0 } },
    };
}
function power(modules) {
    try { return gm.ep_power(0, gm.ep_all(wrap(modules))); } catch (e) { return 0; }
}

// 写模块：DB + redis 缓存（官方读取路径：ctx缓存 → redis.hGet → DB）
async function writeModule(uuid, table, kid, data) {
    const db = mongodb_1.dbSev.getDataDb();
    await db.update(table, { id: uuid, kid: kid, hdcid: "1" }, { id: uuid, kid: kid, hdcid: "1", data: data }, true);
    try {
        const rd = redis_1.redisSev.getRedis(DTUSER);
        await rd.hSet(DTUSER + "_" + uuid, table + "_" + kid + "_1", data);
    } catch (e) { }
    // 清 fuser 内存缓存（否则 5 分钟内榜单/战斗仍拿旧数据）
    try {
        const LockCache = require("./src/util/cache").default;
        if (LockCache && LockCache.users) delete LockCache.users[String(uuid)];
    } catch (e) { }
}

// 找锚点真人：默认取【最近登录】的真人角色（谁在玩、世界围绕谁；新开小号同样生效）；
// env SOLO_FAKE_ANCHOR=max 时改为"战力最高"的真人（大世界模式）
function pickAnchor(map) {
    const mode = process.env.SOLO_FAKE_ANCHOR || "recent";
    let best = null;
    for (const uuid in map) {
        if (Number(uuid) >= 200000) continue;
        const ui = map[uuid] && map[uuid].userInfo;
        if (ui == null || ui.level == null) continue;
        const pw = power(map[uuid]);
        if (mode !== "recent" && pw <= 2100) continue;   // max 模式排除纯初始号；recent 模式新号也服务
        if (best == null) { best = { uuid: uuid, ui: ui, power: pw }; continue; }
        if (mode === "recent") {
            if ((ui.lastlogin || 0) > (best.ui.lastlogin || 0)) best = { uuid: uuid, ui: ui, power: pw };
        } else {
            if (pw > best.power) best = { uuid: uuid, ui: ui, power: pw };
        }
    }
    return best;
}
// 找"模块最全的真人"当装备模板
function pickTemplate(map) {
    let best = null, bestN = -1;
    for (const uuid in map) {
        if (Number(uuid) >= 200000) continue;
        const mods = map[uuid];
        if (mods == null || mods.actEquip == null || mods.actEquip.chuan == null) continue;
        const n = Object.keys(mods).length;
        if (n > bestN) { bestN = n; best = mods; }
    }
    return best;
}
function fakeList(map) {
    const out = [];
    for (let u = FAKE_MIN; u <= FAKE_MAX; u++) {
        const ui = map[String(u)] && map[String(u)].userInfo;
        if (ui != null) out.push({ uuid: String(u), name: ui.name || ("侠客" + u) });
    }
    return out;
}

// ==================== ① 模块实体化 ====================
// M2-修复：按部位默认幻化皮肤（equipPifu 中该部位的最高 id）——
// 客户端 getEquipIcon 会读 equipPifu.getItem(装备.hh || 装备.mrhh).icon，空值会直接抛异常断掉整条视图更新链
const EQUIP_DEFAULT_HH = (function () {
    const m = {};
    try {
        const pool = _gcfg.equipPifu && _gcfg.equipPifu.pool;
        for (const key in (pool || {})) {
            const r = pool[key];
            if (r == null || r.id == null || r.buwei == null) continue;
            const b = String(r.buwei);
            if (m[b] == null || Number(r.id) > Number(m[b])) m[b] = String(r.id);
        }
    } catch (e) { }
    return m;
})();
// ==================== v4.21：假人/NPC 幻化独立化 ====================
// 旧行为：buildEquip() 直接继承【真人模板】的 chuan[slot].hh / mrhh / hhList
//   → 玩家一换幻化，200 假人 + 3500 竞技场 NPC 全变成同一款（实机报障"外观全和我一样"）
// 新行为：按【自身 seed（假人 uuid / NPC id）】稳定派生一款幻化 —— 人人不同、重启不变
//   ⚠ PIFU_POOL 必须【惰性构建】：本模块在 gameCfg.init() 之前就被 require，加载期取配置会得到空表
let _PIFU_POOL = null;
function pifuPool() {
    if (_PIFU_POOL != null) return _PIFU_POOL;
    const m = {};
    try {
        const pool = _gcfg.equipPifu && _gcfg.equipPifu.pool;
        for (const key in (pool || {})) {
            const r = pool[key];
            if (r == null || r.id == null || r.buwei == null) continue;
            const n = Number(r.id);
            if (!(n >= 10000 && n < 30000)) continue;      // 基础款(1xxxx) + 仙盟商店款(2xxxx)
            const b = String(r.buwei);
            (m[b] = m[b] || []).push(String(r.id));
        }
    } catch (e) { }
    for (const b in m) m[b].sort(function (a, b2) { return Number(a) - Number(b2); });
    _PIFU_POOL = m;
    return m;
}
function fnv(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h;
}
// v4.22：装备 id 池（旧行为 equipId 直接继承模板 → 200 假人图标全一样）
let _EQUIP_POOL = null;
function equipPool() {
    if (_EQUIP_POOL != null) return _EQUIP_POOL;
    const m = {};
    try {
        const pool = _gcfg.equipInfo && _gcfg.equipInfo.pool;
        for (const key in (pool || {})) {
            const r = pool[key];
            if (r == null || r.id == null || r.buwei == null) continue;
            const b = String(r.buwei);
            (m[b] = m[b] || []).push(String(r.id));
        }
    } catch (e) { }
    for (const b in m) m[b].sort(function (a, b2) { return Number(a) - Number(b2); });
    _EQUIP_POOL = m;
    return m;
}
function fakeEquipId(slot, seed) {
    const pool = equipPool()[String(slot)];
    if (pool == null || pool.length === 0) return null;
    return pool[fnv(String(seed) + "#eq" + slot) % pool.length];
}
function buildWxSk(ctx, wx) {
    const out = {};
    try {
        const gameCfg = require("./common/gameCfg").default;
        wx = wx || {};
        const lingmai = {};
        for (const mpid in (wx.mpList || {})) {
            const lm = (wx.mpList[mpid] || {}).lingmai;
            if (lm == null || lm === "") continue;
            lingmai[lm] = (lingmai[lm] || 0) + 1;
        }
        for (const lmid in lingmai) {
            const cfglm = gameCfg.wanxiangLingmai.getItemCtx(ctx, lmid, String(lingmai[lmid]));
            if (cfglm != null) out["wxlm_" + lmid] = cfglm.cs;
        }
        const czlist = [];
        for (const type in (wx.mfZhan || {})) { if (wx.mfZhan[type] !== "") czlist.push(wx.mfZhan[type]); }
        for (const xfid in (wx.mfList || {})) {
            if (czlist.indexOf(xfid) === -1) continue;
            const step = (wx.mfList[xfid] || {}).step || 0;
            const cfgXf = gameCfg.wanxiangXfinfo.getItemCtx(ctx, xfid);
            if (cfgXf == null) continue;
            const a = [0, 0, 0, 0, 0];
            [cfgXf.cs1, cfgXf.cs2, cfgXf.cs3, cfgXf.cs4].forEach(function (cs, i) {
                if (cs == null || cs[0] == null) return;
                if (step >= 1) a[i] += cs[0];
                for (const seg of (cs[1] || [])) {
                    for (let idx = seg[0]; idx <= seg[1]; idx++) { if (idx <= step) a[i] += seg[2]; else break; }
                }
            });
            out["wxxf_" + xfid] = a;
        }
    } catch (e) { }
    return out;
}
function buildJgSk(ctx, jg) {
    const out = {};
    try {
        const gameCfg = require("./common/gameCfg").default;
        jg = jg || {};
        const list = (jg.szList || {})[jg.szid] || [];
        for (const jgid of list) {
            if (jgid == null || jgid === "") continue;
            const cfgJg = gameCfg.jingguaiInfo.getItem(jgid);
            if (cfgJg == null) continue;
            const level = ((jg.jgList || {})[jgid] || {}).level || 0;
            const a = [0, 0, 0, 0, 0];
            [cfgJg.cs1, cfgJg.cs2, cfgJg.cs3, cfgJg.cs4].forEach(function (cs, i) {
                if (cs == null || cs[0] == null) return;
                if (level >= 1) a[i] += cs[0];
                for (const seg of (cs[1] || [])) {
                    for (let idx = seg[0]; idx <= seg[1]; idx++) { if (idx <= level) a[i] += seg[2]; else break; }
                }
            });
            out["jg_" + jgid] = a;
        }
    } catch (e) { }
    return out;
}
// ★ v4.23：NPC 的「战斗属性 + 技能」—— 与展示档案(sevBack)同源
//   旧状：竞技场/斗罗对 uuid<100000 走官方"裸配置 eps"分支 → 属性虚低 1.4~1.7 倍 + 技能全空（被玩家一刀砍死）
// ★ v4.26：百分比/特殊类属性对齐（"战力高就该强"的机制）
//   背景：per 类（atk_per/增伤/减伤/暴击/连击…）几乎不计入 ep_power 战力，却主导战斗结算。
//   玩家侧这些值来自称号特权等（atk_per 5650），假人/NPC 的档案给不了这么全 ——
//   所以按【自身战力 / 锚点战力】的比例，把这些字段抬到"与战力相符"的水平。
const PER_BASE = {
    atk_per: 5650, def_per: 3250, hp_max_per: 3500, speed_per: 50, hslianbao: 120,
    // v4.26c：装备部分基数 —— 法阵/技能按 e_atk/e_def/e_hp_max 的百分比结算，缺了会削弱技能收益
    e_atk: 13433, e_def: 7595, e_hp_max: 48880,
    zengshang: 2420, jianshang: 2620,
    hsbaoji: 1500, hsxixue: 1500, hslianji: 900, hsshanbi: 1106, hsfanji: 500, hsjiyun: 900,
    baoji: 647, xixue: 2120, lianji: 2419, shanbi: 1307, fanji: 321, jiyun: 1801,
    baonue: 300, renai: 300
};
function bolsterPer(eps, rel) {
    if (eps == null) return eps;
    const r = Math.max(0.3, Math.min(2.5, Number(rel) || 1));
    for (const k in PER_BASE) {
        const tgt = Math.round(PER_BASE[k] * r);
        if ((Number(eps[k]) || 0) < tgt) eps[k] = tgt;
    }
    return eps;
}
function npcRelByScore(score) {
    const sc = Number(score || 1500);
    const tier = Math.max(0, Math.min(1, (sc - 1500) / 1400));
    return 0.80 + tier * 0.45;      // [v4.65] 0.80× ~ 1.25×（原 1.00 → 1.80×；积分 2724 处 1.67× 对玩家=必输，用户实测 0/9 全败）
}
function fakeRelByUuid(rid) {
    try {
        const i = (parseInt(rid) - 200001);
        if (i >= 0 && i < FACTORS.length) return FACTORS[i];
    } catch (e) { }
    return 1.0;
}
// ★ v4.27：斗罗 NPC 增强（douLuoNpc 池）
//   斗罗只读 douLuoNpc 原始配置（无 per/无技能）→ 按名次梯度补 per + 技能
//   tier：id=1 最强（atk 100937）→ 1.0；id=500 最弱（atk 5030）→ 0.0
//   rel：0.30（末尾）~ 1.30（榜首）—— 榜首 per 略强于玩家，符合"越级挑高名次"设计
function _findPoolRow(poolName, id) {
    try {
        const pool = (_gcfg[poolName] && _gcfg[poolName].pool) || null;
        if (pool == null) return null;
        const want = String(id);
        for (const k of Object.keys(pool)) {
            const r = pool[k];
            if (r != null && String(r.id) === want) return r;
        }
    } catch (e) { }
    return null;
}

// [v4.62] 斗罗榜：官方“占位成员”的名字就是【名次字符串】（对齐官方 zSetVal(myrid.toString(), myrid)）
const DL_IS_PH = (n) => /^\d+$/.test(String(n)) && Number(n) >= 1 && Number(n) <= 500;
function douLuoNpcBoost(ctx, id) {
    try {
        // 池直查（同 syncJjcNpc 风格）：不依赖 ctx，返回池内引用 → 回写即生效
        const cfgRef = _findPoolRow("douLuoNpc", id);
        if (cfgRef == null || cfgRef.eps == null) return false;
        const numId = Math.max(1, Number(cfgRef.id != null ? cfgRef.id : id) || 1);
        const tier = clamp01(1 - (numId - 1) / 499);
        bolsterPer(cfgRef.eps, 0.70 + tier * 0.50);          // [v4.64] 0.70× ~ 1.20×（原 1.05 ⇒ 榜首 1.75× 对玩家=必输，用户实测 21 连负）
        if (ctx && cfgRef.__soloDLBoosted == null) {         // 技能构建需真 ctx（buildWxSk 读灵脉配置）
            const seed = (numId * 2654435761) % 2147483647;
            const idx = numId % FAKE_HEADS.length;
            const M2 = buildModules(seed, idx, 0.18 + tier * 0.85);
            cfgRef.soloWxSk = buildWxSk(ctx, M2.actWanXiang);
            cfgRef.soloJgSk = buildJgSk(ctx, M2.actJingGuai);
            cfgRef.soloIsNq = (M2.actWanXiang && M2.actWanXiang.mfZhan && M2.actWanXiang.mfZhan["1"]) ? 1 : 0;
            // [v4.36] 斗罗 NPC 的仙侣战斗数据
            try {
                const _xl2 = M2.actXianlv && M2.actXianlv.shangzhen ? M2.actXianlv.shangzhen : null;
                cfgRef.soloXlid = _xl2 ? String(_xl2.xlid || "") : "";
                cfgRef.soloXlLv = _xl2 ? (Number(_xl2.level) || 1) : 0;
                cfgRef.soloXlZw = (_xl2 && _xl2.xlid) ? xlZwOf(_xl2.xlid) : 0;   // [v4.60] 前后排按仙侣配置
                const _gm2 = require("./common/gameMethod").gameMethod;
                cfgRef.soloXlEps = _gm2.ep_xianlv(wrapAll(M2, buildEquip(_TPL_EQUIP, 1, function () { return 0.5; }, numId * 7919), tier), "0");
            } catch (e) { }
            cfgRef.__soloDLBoosted = 1;
        }
        // [v4.64] 仙侣也按“略强于玩家”定标（每跳重算 ⇒ 玩家变强 NPC 跟着变，不脱钩）
        //   原状：只补主将 per，仙侣却是配置原样生成 ⇒ id=1 的仙侣 966 万 = 玩家 628 万的 1.54 倍，
        //   主将战力已经持平也照样必输。实测（各 10~12 场真 HTTP 战斗，锚点战力 688 万）：
        //     仙侣 = 1.15~1.40×锚点 → 胜率 100%；1.70~1.90× → 25%；**1.50× → 40%（取此档）**；1.60× → 30%
        //   故定标 0.55×~1.50× 锚点战力（id=1 = 1.50×，id=500 = 0.55×），配合主将 per 1.20× ⇒ 榜首“略强但能打”。
        try {
            if (cfgRef.soloXlEpsRaw == null) cfgRef.soloXlEpsRaw = cfgRef.soloXlEps || {};
            if (_ANCHOR_POW > 1000000) {          // 1000000 是 _ANCHOR_POW 的初值（growTick 才刷真值）
                const _xlBase = epsPower(cfgRef.soloXlEpsRaw);
                const _xlWant = _ANCHOR_POW * (0.55 + tier * 0.95);
                if (_xlBase > 0 && _xlWant > 0) {
                    const _k = Math.max(0.1, Math.min(3, _xlWant / _xlBase));
                    cfgRef.soloXlEps = scaleEps(cfgRef.soloXlEpsRaw, _k);
                }
            }
        } catch (e) { }
        return true;
    } catch (e) { return false; }
}
function douLuoNpcBoostAll(ctx) {
    try {
        const pool = (_gcfg.douLuoNpc && _gcfg.douLuoNpc.pool) || null;
        if (pool == null) return 0;
        let c = 0;
        for (const k of Object.keys(pool)) {
            const row = pool[k];
            const id = (row && row.id != null) ? row.id : k;    // ⚠ 池键可能带尾下划线 → 用 row.id 归一化
            if (douLuoNpcBoost(ctx, id)) c++;
        }
        return c;
    } catch (e) { return 0; }
}
async function fakeNpcFightEps(ctx, id) {
    const f = npcFuser(ctx, id);
    if (f == null) return null;
    const sb = f.sevBack || {};
    const gameMethod = require("./common/gameMethod").gameMethod;
    let eps = null;
    try { eps = gameMethod.ep_fight(sb); } catch (e) { eps = null; }
    if (eps == null) return null;
    try { const cn = (_gcfg.jjcNpc && _gcfg.jjcNpc.getItemCtx) ? _gcfg.jjcNpc.getItemCtx(ctx, String(id)) : null; bolsterPer(eps, npcRelByScore(cn && cn.score)); } catch (e) { }
    const wx = sb.actWanXiang || {};
    const xl = (sb.actXianlv || {}).shangzhen || {};
    // [v4.36] 仙侣战斗属性（原来写死 {} → 人机仙侣在战斗里毫无作用）
    let _xleps = {};
    try { _xleps = gameMethod.ep_xianlv(sb, "0"); } catch (e) { _xleps = {}; }
    return {
        xlid: xl.xlid, xlzw: xl.xlid ? xlZwOf(xl.xlid) : 1, xlLv: xl.level,   // [v4.60] 前后排按仙侣配置
        eps: eps, xleps: _xleps,
        wxSk: buildWxSk(ctx, wx),
        isnq: (wx.mfZhan && wx.mfZhan["1"]) ? 1 : 0,
        jgSk: buildJgSk(ctx, sb.actJingGuai),
    };
}
function fakeHh(slot, seed) {
    const pool = pifuPool()[String(slot)];
    if (pool == null || pool.length === 0) {
        try {
            const p2 = _gcfg.equipPifu && _gcfg.equipPifu.pool;
            let best = null;
            for (const k in (p2 || {})) {
                const r = p2[k];
                if (r == null || r.buwei == null) continue;
                if (String(r.buwei) !== String(slot)) continue;
                if (best == null || Number(r.id) > Number(best)) best = String(r.id);
            }
            if (best != null) return best;
        } catch (e) { }
        return EQUIP_DEFAULT_HH[String(slot)] || "";
    }
    return pool[fnv(String(seed) + "#" + slot) % pool.length];
}
// [solo v4.45] linshi/linshiOld/linshixz/cleps 补齐官方 init 默认形状（全场景审计结果）
function buildEquip(tplEquip, k, rnd, hhSeed) {
    const src = (tplEquip && tplEquip.chuan) || {};
    const chuan = {};
    for (const slot in src) {
        const s = src[slot] || {};
        const eps = {};
        for (const e in (s.eps || {})) {
            const base = Number(s.eps[e]) || 0;
            eps[e] = Math.max(1, Math.round(base * k * (0.92 + rnd() * 0.16)));
        }
        chuan[slot] = {
            equipId: (hhSeed != null ? fakeEquipId(slot, hhSeed) : null) || s.equipId,
            level: Math.max(1, Math.min(200, Math.round((s.level || 100) * Math.min(1, 0.25 + k * 0.9) * (0.97 + rnd() * 0.06)))),
            eps: eps,
            hhList: (function () { const _h = (hhSeed != null) ? fakeHh(slot, hhSeed) : (s.hh || s.mrhh || EQUIP_DEFAULT_HH[slot] || ""); const o = {}; o[_h] = 1; return o; })(),
            mrhh: (hhSeed != null) ? fakeHh(slot, hhSeed) : (s.mrhh || EQUIP_DEFAULT_HH[slot] || ""),
            hh: (hhSeed != null) ? fakeHh(slot, hhSeed) : (s.hh || s.mrhh || EQUIP_DEFAULT_HH[slot] || ""),
            newHh: "",
            fmLv: 0, fmBd: 0, fmEps: [], fmZhBd: [], fmZhls: [],
        };
    }
    const t = tplEquip || {};
    return {
        chuan: chuan,
        box: (hhSeed != null) ? (2000 + (fnv(String(hhSeed) + "#box") % 80)) : (t.box || {}), linshi: { equipId: "", mrhh: "", hh: "", level: 0, eps: {}, isNew: 0 }, linshi95: {}, linshiOld: { equipId: "", mrhh: "", hh: "", level: 0, eps: {}, isNew: 0 }, linshixz: "",
        openCount: 0, pingji: 0, count: 0, time: game.getNowTime(), jjc: {}, trader: {},
        czpf: {}, ver: 0, ver1: 0, opAt: 0, verfm: 0, fmCount: 0,
    };
}
function wingById(id, rnd, seed) {
    const wid = Math.max(1, Math.min(2036, id));
    // v4.22：幻化按【自身 seed】取（旧写法同档位必同款 → 93% 假人剑灵一模一样）
    const hh = String(1 + (fnv(String(seed != null ? seed : wid) + "#wing") % 12));
    return { id: wid, exp: 0, hh: hh, hhList: [hh], tsNum: 0, cleps: { hsjiyun: 0, hsshanbi: 0, hslianji: 0, hsfanji: 0, hsbaoji: 0, hsxixue: 0 } };
}
function pickWing(rnd, targetPow, seed) {
    // v3.1：剑灵档位跟随目标战力 —— 高端假人拿高级剑灵（最高 2036 档），战斗里不再只有 1~8 贴图
    let id;
    if (targetPow != null) {
        id = Math.round((targetPow * 0.45 - 150000) / 92000);   // 近似 92k 战力/档（1→2036 档 ≈ 0→1.9 亿）
        id = Math.round(Math.max(1, id) * (0.9 + rnd() * 0.2));
    } else {
        id = 1 + Math.floor(rnd() * 8);
    }
    return wingById(id, rnd, seed);
}
function buildChengH(tplChengH) {
    const t = tplChengH ? JSON.parse(JSON.stringify(tplChengH)) : {};
    t.list = {};
    t.chuan = "";
    return t;
}

// ==================== [v4.49] 万相功率预算 ====================
// v4.48 把命盘/秘法按官方公式全量生成后，万相单独就能贡献≈同段位目标的 2~3 倍战力，
//   而 npcFuser/growTick 的战力求解是「FIXED(非装备部分) + EQ1*k = target」——
//   FIXED 一旦超过 target，k 会被夹到下限 0.004 → 战力被 FIXED 顶穿（实测人机 = 目标的 1.5~3.7 倍）。
// 修法：给万相一个占目标战力的份额上限，超了就把「秘法 step/level 与命盘等级」等比缩下来
//   （条数/品质/铭文/图鉴保持丰富，只是档位压低）——这样求解器恢复正常，战力回到设计区间。
const WX_SHARE = (() => {
    const v = parseFloat(process.env.SOLO_WX_SHARE || "");
    return (isNaN(v) || v <= 0 || v >= 1) ? 0.30 : v;
})();
function wxBudgetScale(M2, target) {
    try {
        if (!(target > 0)) return 1;
        const w1 = power({ actWanXiang: M2.actWanXiang });   // 万相单独贡献（ep_power 为加权和，边际=单独）
        const budget = target * WX_SHARE;
        if (!(w1 > budget) || w1 <= 0) return 1;
        return Math.max(0.02, budget / w1);
    } catch (e) { return 1; }
}

// ==================== [v4.48] 万象（命盘 / 秘法）全局生成器 ====================
// 依据官方源码：ActWanXiangModel（yansuan 的 7 条随机规则 / canwu 抽样+保底 / upLv / upStep / chuzhan）
//   ＋ UserModel 的 wxSk 构建（秘法 → 战斗只算"已上阵"；本文件的 buildWxSk 已忠实复刻该段）。
// ★★ 全局唯一入口：假人成长(growTick L702) / 竞技场·斗罗·登神榜 NPC(syncJjcNpc L375) / 其余按需
//    NPC(npcFuser L1458) 全部经由 buildModules 取档案 ⇒ 本处一改，**全部场景同时生效**。
// 旧实现问题（v4.40 遗留）：只从 12 个硬编码秘法 id 抽、step 恒 1~3、level ≤ 16、chip/mwLock/
//   tjlist/mwlist 恒空、命盘只 6 个槽且 eps 恒为 {atk,hp_max} —— 与官方构成完全不同。
let _WXC = null;
function _wxPool(proxy) {
    // confProxy.pool 的键带尾下划线（"1_"），一律走 Object.keys 取值
    const p = proxy && proxy.pool;
    if (p == null) return [];
    return Array.isArray(p) ? p : Object.keys(p).map((k) => p[k]);
}
function _wxc() {
    // 惰性 + 自愈：配置表在 gameCfg.init() 之前是空的，拿到空表就不缓存（下次重试）
    if (_WXC && _WXC.xfPool.length) return _WXC;
    const g = _gcfg || {};
    let math = null;
    try { math = g.mathInfo ? g.mathInfo.getItem("wanxiang_canwu") : null; } catch (e) { math = null; }
    _WXC = {
        mgPool: _wxPool(g.wanxiangInfo),      // 12 命格 {id,prob,gdep,locklv}
        mgLv: g.wanxiangMingge,               // 命盘等级表 1~100（atk/def/hp_max/speed/ts/kx_1..9）
        kw: g.wanxiangKaiwu,                  // 开悟等级 1~2000 → 品质概率 prob_1..prob_9
        pz: g.wanxiangPinzhi,                 // 品质系数 {jcbase}
        xfPool: _wxPool(g.wanxiangXfinfo),    // 76 秘法 {id,pinzhi,type,fenjie,mwLock,cs1..cs4}
        xfStep: g.wanxiangXfstep,             // 阶 1~20 {maxLv,need}
        mwPool: _wxPool(g.wanxiangMingwen),   // 铭文 12 系 × 6 级
        tjPool: _wxPool(g.wanxiangXftj),      // 图鉴 21 组 {xfids,eps}
        math: math,                           // wanxiang_canwu: {count:200, count1:6}
    };
    return _WXC;
}
function _wxGet(proxy, id) { try { return proxy == null ? null : proxy.getItem(String(id)); } catch (e) { return null; } }
function _wxRandInt(rnd, a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
function _wxPick(rnd, arr) { return (arr && arr.length) ? arr[Math.floor(rnd() * arr.length) % arr.length] : null; }
function _wxPickN(rnd, arr, n) {          // 不重复抽 n 个
    const a = (arr || []).slice(); const out = [];
    n = Math.max(0, Math.min(n, a.length));
    for (let k = 0; k < n; k++) out.push(a.splice(Math.floor(rnd() * a.length) % a.length, 1)[0]);
    return out;
}
function _wxWeighted(rnd, list, wkey) {   // 按 prob 加权抽一个
    let total = 0;
    for (const it of list) total += Number(it[wkey]) || 0;
    if (!(total > 0)) return _wxPick(rnd, list);
    let r = rnd() * total;
    for (const it of list) { r -= Number(it[wkey]) || 0; if (r <= 0) return it; }
    return list[list.length - 1];
}
/** 万象档案：返回与 ActWanXiangModel.init() 同形的信息体；wxScale<1 时等比压低档位（v4.49 功率预算） */
function buildWanXiang(rnd, t, wxScale) {
    const c = _wxc();
    const _sc = (wxScale == null || !(wxScale > 0)) ? 1 : Math.max(0.02, Math.min(1, wxScale));
    // ---- 命盘等级（官方靠演算攒 exp 升，1~100）｜开悟等级（官方 1~2000，决定命格品质概率） ----
    const mgLv = Math.max(1, Math.min(100, Math.round((1 + t * 55 + rnd() * 15) * _sc)));
    const cfgMingge = _wxGet(c.mgLv, mgLv) || _wxGet(c.mgLv, 1) || null;
    const kwd = Math.max(1, Math.min(2000, Math.round(1 + t * 900 + rnd() * 250)));
    const cfgKw = _wxGet(c.kw, kwd) || _wxGet(c.kw, 1) || null;

    // ---- 命盘：官方 yansuan 的 7 条规则 ----
    const mpList = {};
    if (cfgMingge && c.mgPool.length) {
        const count = Math.max(1, Math.min(c.mgPool.length, 2 + Math.floor(rnd() * 8 + t * 3)));
        for (const cfgItem of _wxPickN(rnd, c.mgPool, count)) {
            // ⑤ 品质：开悟等级对应的概率表（官方累积判定，总和 10000）
            let rProb = _wxRandInt(rnd, 1, 10000);
            let pinzhi = 1;
            for (let i = 1; i <= 9; i++) {
                const sp = cfgKw ? (Number(cfgKw["prob_" + i]) || 0) : 0;
                if (sp > 0 && rProb <= sp) { pinzhi = i; break; }
                rProb -= sp;
            }
            const jcbase = Number((_wxGet(c.pz, pinzhi) || {}).jcbase) || 1;
            // ③ 属性等级 = 命盘等级 ±1（下限 1）
            const lv = Math.max(1, mgLv + (_wxRandInt(rnd, 0, 2) - 1));
            // ② 主属性（gdep）；④ 特殊抗性条数（按命盘等级过 locklv，最多 +3 条）
            const eps = {};
            eps[cfgItem.gdep] = 0;
            let kk = 0;
            for (const _lv of (cfgItem.locklv || [])) if (mgLv >= _lv) kk += 1;
            if (kk > 0) for (const key of _wxPickN(rnd, ["speed", "hsjiyun", "hsshanbi", "hslianji", "hsfanji", "hsbaoji", "hsxixue"], kk)) eps[key] = 0;
            // ⑦ 基础属性 = rand(值 ± bd) × jcbase；⑥ 特殊抗性 = kx_<品质> × jcbase
            for (const key in eps) {
                if (key === "atk" || key === "def" || key === "speed" || key === "hp_max") {
                    const base = Number(cfgMingge[key]) || 0, bd = Number(cfgMingge[key + "_bd"]) || 0;
                    eps[key] = Math.floor(_wxRandInt(rnd, base - bd, base + bd) * jcbase);
                } else if (/^(jiyun|shanbi|lianji|fanji|baoji|xixue)$/.test(key)) {
                    const ts = Number(cfgMingge.ts) || 0, bd = Number(cfgMingge.ts_bd) || 0;
                    eps[key] = Math.floor(_wxRandInt(rnd, ts - bd, ts + bd) * jcbase);
                } else {
                    eps[key] = Math.floor((Number(cfgMingge["kx_" + pinzhi]) || 0) * jcbase);
                }
            }
            // 衍生灵脉（官方：命格 id ∈ {9,10,11,12} 才带）
            const lingmai = ["9", "10", "11", "12"].indexOf(String(cfgItem.id)) !== -1 ? String(_wxRandInt(rnd, 1, 6)) : "";
            mpList[String(cfgItem.id)] = { eps: eps, level: lv, pinzhi: pinzhi, lingmai: lingmai };
        }
    }

    // ---- 秘法：官方 canwu（按 prob 抽 + 保底；重复抽到 → chip += fenjie） ----
    const mfList = {}; const mfZhan = {}; const mwlist = {}; const tjlist = {};
    if (c.xfPool.length) {
        const baodiN = Number((c.math && c.math.pram && c.math.pram.count) || 200);    // 官方 200 次
        const baodiPz = Number((c.math && c.math.pram && c.math.pram.count1) || 6);    // 官方保底品质 6
        const draws = Math.max(3, Math.round(4 + t * 120 + rnd() * 30));               // 参悟次数
        for (let k = 1; k <= draws; k++) {
            let cqpinzhi = 0;
            if (k % baodiN === 0) cqpinzhi = baodiPz;                                  // 保底
            if (k === 1) cqpinzhi = 2;                                                 // 官方"首次作假"：pinzhi=2
            let list = c.xfPool.filter((x) => (cqpinzhi === 0 || Number(x.pinzhi) === cqpinzhi));
            if (k === 1) { const only = list.filter((x) => Number(x.type) === 1); if (only.length) list = only; }
            if (!list.length) list = c.xfPool;
            const cfgXf = _wxWeighted(rnd, list, "prob");
            if (!cfgXf) continue;
            const id = String(cfgXf.id);
            if (mfList[id] == null) mfList[id] = { level: 1, step: 1, chip: 0, mwLock: [] };
            else mfList[id].chip += Number(cfgXf.fenjie) || 0;
        }
        // 上阵（官方 chuzhan：mfZhan[cfgInfo.type] = mfid，共 4 个槽；取每个 type 最强的一个）
        const best = {};
        for (const id in mfList) {
            const cfgXf = _wxGet(_gcfg.wanxiangXfinfo, id);
            if (!cfgXf) continue;
            const ty = String(cfgXf.type);
            const sc = (Number(cfgXf.pinzhi) || 0) * 1000 + mfList[id].chip;
            if (!best[ty] || best[ty].sc < sc) best[ty] = { id: id, sc: sc };
        }
        for (const ty in best) mfZhan[ty] = best[ty].id;
        // 成长（官方 upLv 吃道具 / upStep 吃碎片）：上阵的练得高
        for (const id in mfList) {
            const cfgXf = _wxGet(_gcfg.wanxiangXfinfo, id);
            if (!cfgXf) continue;
            const onField = Object.keys(mfZhan).some((ty) => mfZhan[ty] === id);
            const stepMax = 20;                                                         // wanxiangXfstep 1~20
            // [v4.49] _sc 为万相功率预算缩放（1=全额；<1 时压低档位，条数/品质不变）
            const step = onField
                ? Math.max(1, Math.min(stepMax, Math.round((1 + t * (stepMax - 1) + rnd() * 3) * _sc)))
                : Math.max(1, Math.min(stepMax, Math.round((1 + t * (stepMax - 1) * 0.55 + rnd() * 2) * _sc)));
            const cfgStep = _wxGet(c.xfStep, step) || { maxLv: 25, need: 50 };
            const lvCap = Math.max(1, Number(cfgStep.maxLv) || 25);
            const level = Math.max(1, Math.min(lvCap, Math.round(lvCap * (0.40 + rnd() * 0.60))));
            mfList[id].step = step;
            mfList[id].level = level;
            mfList[id].chip = Math.floor(rnd() * (Number(cfgStep.need) || 50) * 1.5) + (onField ? 0 : Math.floor(rnd() * 150));
            // 铭文孔（官方 upLv 解锁："" = 已解锁空槽 / null = 未解锁；已解锁有概率装入铭文）
            const arr = [];
            for (const gate of (cfgXf.mwLock || [])) {
                if (level >= Number(gate)) arr.push(rnd() < 0.45 ? String((_wxPick(rnd, c.mwPool) || {}).id || "") : "");
                else arr.push(null);
            }
            mfList[id].mwLock = arr;
            for (const mw of arr) if (mw) mwlist[mw] = (mwlist[mw] || 0) + 1;            // 官方 mwlist = 拥有的铭文数量
        }
        // 图鉴（官方 tjUplv：要求该组所有 xfids 都在 mfList 且 step > 图鉴等级）
        for (const tj of c.tjPool) {
            const ids = (tj.xfids || []).map(String);
            if (!ids.length || !ids.every((x) => mfList[x] != null)) continue;
            const cap = Math.min.apply(null, ids.map((x) => mfList[x].step)) - 1;
            if (cap > 0 && rnd() < 0.5) tjlist[String(tj.id)] = _wxRandInt(rnd, 1, cap);
        }
    }

    return {
        level: mgLv, exp: 0, mpList: mpList,
        linshi: { id: "", eps: {}, level: 0, pinzhi: 0, lingmai: "", isNew: 0 },
        isYw: 1, dayAt: 0, cons: 50, buycons: 0, isOpen: 0, openAt: 0, kwd: kwd, fjExp: 0, baodi: 0,
        moshi: { pinzhi: 1, hq: 0, upPower: 1, keys: [0, "", ""], lm: [0, ""] },
        mfList: mfList, mfZhan: mfZhan, cwids: [], mwlist: mwlist, tjlist: tjlist, free: 0, cwNum: 0,
    };
}

// ==================== [v4.60] 仙侣站位（1 前排 / 2 后排） ====================
// 症状：全服人机 / 假人的仙侣一律站【前排】（替主将挡刀），没有前后排之分。
// 根因：buildModules 把 shangzhen.zhanwei 写死成 1；而官方站位由【仙侣配置】决定 ——
//   ActXianlvModel 的 setZw / hecheng / huhuan / dandan 与 getInfo 的 bugver 纠偏
//   统一按 `zhanwei == 2 ? 2 : 1` 落库（配置 2 → 后排，其余 → 前排）。
// 取法完全对齐官方，不额外发明随机：后排占比 = 配置里 zhanwei==2 的仙侣占比（约 4 成）。
function xlZwOf(xlid) {
    try {
        const info = _gcfg.xianlvInfo;
        const c = info && info.getItem ? info.getItem(String(xlid)) : null;
        if (c != null && Number(c.zhanwei) === 2) return 2;
    } catch (e) { }
    return 1;
}

// ==================== ②a M2 档案模块工厂 ====================
// 每个假人一套"迷你但真实"的多系统模块；数值随档位 t（0~1）成长
function buildModules(seed, idx, t, wxScale) {
    const rnd = mulberry32(seed);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
    const lvl = (max) => 1 + Math.floor(rnd() * Math.max(1, max * (0.5 + t * 0.5)));
    const M = {};

    // v4.25：称号数量对齐真实玩家 —— 玩家在特权版本里补齐了 45 个称号（actChengH 合计 atk_per +56%），
    //   而旧版假人/NPC 只有 1~3 个 → 战斗属性被甩开 18~37 倍（"战力比我高却被一刀砍死"的真凶）
    const tCount = Math.max(1, Math.min(FAKE_TITLES.length, Math.round(28 + t * 22)));
    const tlist = {};
    for (let k = 0; k < tCount; k++) tlist[FAKE_TITLES[(idx * 7 + k) % FAKE_TITLES.length]] = { red: 0, at: 0, gq: 0 };
    const tChuan = pick(Object.keys(tlist));
    M.actChengH = { list: tlist, chuan: tChuan, getId: tChuan, hook: {}, buy174: 0, buy175: 0, buy176: 0 };

    // 圣器
    const sqid = pick(SHENGQI_IDS);
    M.actShengQi = { time: 0, cons: 0, chip: 0, chuan: sqid, list: {}, log: [], zuojia: 0 };
    M.actShengQi.list[sqid] = { level: lvl(12) };

    // 法阵（useGzId → 1 号格子；形状对齐 ActFazhenModel.init，含 shouyiList/炼金等字段）
    const fzid = pick(FAZHEN_IDS);
    const fzSlot = (over) => Object.assign({
        fzid: "", saveId: 0, otherEps: {}, zaddp: 0, faddp: 0, sk: {}, pinzhi: 0,
        lsSkid: ["", 0], lsfz: { fzid: "", sk: {}, saveId: 0, pinzhi: 0, skpx: [] },
        star: 0, xietong: "", skpx: [],
    }, over || {});
    M.actFazhen = {
        time: 0, isInit: 1, pt: 0, ptBaodi: 0, pttqBaodi: 0, gj: 0, gjBaodi: 0, cqId: "0", cqType: 0,
        list: {
            "1": fzSlot({ fzid: fzid, saveId: lvl(6), pinzhi: 2, star: Math.floor(t * 3 + rnd() * 1.99) }),
            "2": fzSlot(), "3": fzSlot(), "4": fzSlot(), "5": fzSlot(),
        },
        useGzId: "1",
        shouyiList: [], shouyiAt: 0, shouyiNum: 0, bugVer: 4, bugVer1: 2, gbver: 11,
        cqIds: { "1": 0, "2": 0, "3": 0 }, kind11: 0, kind11At: 0, gjBd: 0, jiban: {},
        mubiao: "", mbNum: {},
    };

    // 宝石（能量>0：list[xt].xqs 数字键槽位 → items → baoshiItem；槽位数 ≤ 星图 count，否则 eps 数组越界）
    const bsLv = lvl(4);
    const items = {}; const xqs = {};
    let bsCap = 4;
    try {
        const bi = _gcfg.baoshiInfo && _gcfg.baoshiInfo.getItem ? _gcfg.baoshiInfo.getItem("1") : null;
        if (bi != null && Array.isArray(bi.eps)) bsCap = bi.eps.length;
        else if (bi != null && bi.count != null) bsCap = bi.count;
    } catch (e) { }
    const gCount = Math.max(1, Math.min(bsCap, 2 + Math.floor(t * 2 + rnd() * 1.99)));
    for (let k = 0; k < bsCap; k++) {
        if (k < gCount) { const iid = "s" + k; xqs[String(k + 1)] = { iid: iid }; items[iid] = pick(BAOSHI_GEMS); }
        else xqs[String(k + 1)] = "";
    }
    M.actBaoShi = {
        list: { "1": { xqs: xqs, level: bsLv } }, items: items,
        tssx: { jiyun: 0, shanbi: 0, lianji: 0, fanji: 0, baoji: 0 },
        tskx: { hsjiyun: 0, hsshanbi: 0, hslianji: 0, hsfanji: 0, hsbaoji: 0 },
        iid: 0, ver: 1, zuojia: 0,
    };

    // 符石（fsku.level>0 才有图标；形状对齐 ActFuShiModel.init）
    M.actFuShi = {
        time: 0,
        tili: { con: 0, at: 0, linshi: { type: 0, id: "", pf: 0, eps: {}, isp: 0, isNew: 0, isTask: 0 } },
        fangan: "", pf: {},
        fsku: { level: lvl(5), exp: 0, upType: 0, endAt: 0, time: 0, lqAt: 0,
                list: { "1": { "1": { itemid: "12", pf: 5, eps: { hp_max: 600 + Math.floor(t * 3000), atk: 80 + Math.floor(t * 400) } } } } },
        task: {}, shouce: { id: 0, hook: {}, useId: 0 },
        tujian: {}, useType: 1, nowId: "1000",
        jitan: { "1": { saveid: 1, cons: 0, epList: {}, linshi: {} } },
        jtEpVer: 1, bugVer: 1, taskVer: 1, opAt: 0,
    };

    // 仙侣（点亮图标；战力公式不含它；形状对齐 ActXianlvModel.init）
    const xlid = pick(XIANLV_IDS);
    const hecheng = {};
    try {
        const gp = _gcfg.xianlvGezi && _gcfg.xianlvGezi.pool;
        for (const key in (gp || {})) if (gp[key] && gp[key].count === 0) hecheng[gp[key].id] = { xlid: "", level: 0, exp: 0, lock: 0, zhanwei: 0, dandan: 0 };
    } catch (e) { }
    for (let g = 1; g <= 8; g++) if (hecheng[String(g)] == null) hecheng[String(g)] = { xlid: "", level: 0, exp: 0, lock: 0, zhanwei: 0, dandan: 0 };
    M.actXianlv = {
        // [v4.60] 站位按仙侣配置（原来写死 1 → 全服人机仙侣都挤在前排）
        shangzhen: { xlid: xlid, level: lvl(30), exp: 0, lock: 0, zhanwei: xlZwOf(xlid), dandan: 0 },
        zhuzhan: {}, hecheng: hecheng,
        mu_count: 5, mu_at: 0, lv_count: 0, zi_count: 0, tujian: {}, hcBd: {}, zuojia: 0, bugver: "1",
    };

    // 万象：命盘（lingmai 非空点亮）+ 秘法（mfZhan 非空）
    // [v4.48] 改为按官方公式全量生成（见文件上方 buildWanXiang）—— 全局唯一入口，全部假人/NPC 同时生效
    // [v4.49] wxScale：万相功率预算缩放（由调用方按目标战力标定）
    M.actWanXiang = buildWanXiang(rnd, t, wxScale);

    // 精怪（上阵 3 只 → 详情页图标；值别太大，免得吃掉装备档）
    const jgList = {}; const sz3 = [];
    for (let k = 0; k < 3; k++) {
        const jgid = JG_IDS[(idx + k * 3) % JG_IDS.length];
        sz3.push(jgid);
        jgList[jgid] = { jihuo: 1, level: lvl(8), chip: 0 };
    }
    M.actJingGuai = {
        baodi: 0, jgList: jgList,
        szList: { "1": sz3, "2": ["", "", ""], "3": ["", "", ""] }, szid: "1",
        fjcons: 0, dzItem: [], dzcount: 0,
    };

    // 锦绣 / 仙盟（形状对齐各自 Model.init）
    M.actJinxiu = { list: {} };
    M.actClub = {
        clubId: FAKE_CLUBS[idx % FAKE_CLUBS.length],
        active7D: (game.active7D_init ? game.active7D_init() : {}),
        tbAtAt: 0, outClubTime: 0, outClubNum: 0, itime: 0, outTime: 0,
        applyIds: {},
        help: { hnum: 0, htype: { box: 0, boxStep: 0, fushi: 0, dongtian: 0 } },
        boss: { hnum: 0, htime: 0 }, alimit: {}, md1205: 0, md1235: 0,
        qifu: 0, gaiyun: 0, gaiyunAll: 0, qfRwd: [], fxs: [], chatTime: 0,
    };

    return M;
}

// ==================== ② 成长引擎 ====================
// v3.1 分布细化：1.30 → 0.40 的 24 档阶梯（用户要求"1.3,1.25,…1.0…0.9…0.7…0.4"）
const FACTORS24 = [1.30, 1.25, 1.20, 1.15, 1.10, 1.05, 1.00, 0.97, 0.94, 0.90, 0.87,
    0.84, 0.80, 0.77, 0.74, 0.70, 0.67, 0.64, 0.60, 0.55, 0.50, 0.46, 0.42, 0.40];
// [v4.5] 扩至 200 人：前 24 原班；其余确定性长尾 0.32~0.58（种子固定、重启不变）
const _FBASE = 0.55, _FK = 0.80;   // [v4.33] 0.87~1.59×（中位≈1.16、头顶 1.59）
const FACTORS = FACTORS24.map((v) => Math.round((_FBASE + v * _FK) * 100) / 100).concat(Array.from({ length: 176 }, (_, j) => {
    const x = Math.sin((j + 1) * 12.9898) * 43758.5453;
    return Math.round((_FBASE + (0.32 + (x - Math.floor(x)) * 0.26) * _FK) * 100) / 100;
}));

let _TPL_EQUIP = null;
let _ANCHOR_POW = 1000000;   // v4.23c：锚点玩家战力（growTick 刷新；NPC 战力梯度基准）   // 模板装备（官方 NPC 合成档案用；growTick 时刷新）

async function growTick(opts) {
    opts = opts || {};
    installNpcPatch();   // v3.3.2：钩住官方 NPC 档案（幂等）
    installJjcPatch();   // v3.4：列表/排行/战斗三处 NPC 条目也换成完整档案（幂等）
    installLiuDaoPatch(); // v4.58：罗浮仙域 全服成就名单"请求路径即时补齐"（防被官方写入覆盖 → 人数时有时无）
    const report = [];
    const map = await loadAll();
    const anchor = pickAnchor(map);
    const tpl = pickTemplate(map);
    if (anchor == null || tpl == null) return { ok: false, report: ["缺锚点或模板"] };
    if (tpl.actEquip) _TPL_EQUIP = tpl.actEquip;
    const P2 = anchor.power;
    _ANCHOR_POW = P2;   // v4.23c
    report.push("锚点玩家(" + (anchor.ui.name || anchor.uuid) + ") 战力=" + P2);

    const st = loadState();
    st.fakes = st.fakes || {};
    const fakes = fakeList(map);
    const nowT = game.getNowTime();
    const _anchorSwitched = (st.anchorUuid != null && st.anchorUuid !== anchor.uuid);   // [v4.7] 换玩家 → 世界立即重排（不再等若干跳平滑）
    for (let i = 0; i < fakes.length; i++) {
        const f = fakes[i];
        const rnd = Math.random;
        const fS = st.fakes[f.uuid] = st.fakes[f.uuid] || {};
        const T = Math.max(800, Math.min(P2 * (FACTORS[i] != null ? FACTORS[i] : 0.5), FAKE_CAP)); // v3.1 全局封顶
        let cur = Number(fS.power) || T;   // 首次直接落位；之后平滑跟进
        const _bigJump = (cur > 1000) && (Math.abs(T - cur) > cur * 0.20);   // [v4.30] 目标大幅变化（如因子调整/换锚点）→ 直接到位，不再等 5~8 个 tick
        let next = (_anchorSwitched || _bigJump) ? T : (cur + (T - cur) * SMOOTH + cur * (rnd() - 0.5) * 2 * JITTER);
        next = Math.max(500, Math.min(next, FAKE_CAP)); // 抖动也绝不越过封顶
        if (next > T && next - T < T * 0.03) next = T;  // 已在目标附近就不再上浮

        // —— M2 档案模块（详情页十图标 + 卡面完整）；档位随分布因子
        const tier = clamp01(((FACTORS[i] != null ? FACTORS[i] : 0.5) - 0.40) / 0.90);
        // [v4.49] 万相功率预算（同 npcFuser）：万相贡献 ≤ next×WX_SHARE，保证求解器能命中 target
        let M2 = buildModules(1000003 + i * 7919, i, tier);
        try {
            const _scWx = wxBudgetScale(M2, next);
            if (_scWx < 1) M2 = buildModules(1000003 + i * 7919, i, tier, _scWx);
        } catch (e) { }

        // —— 反解装备系数（线性）：固定部分（档案+剑灵）+ 装备部分 EQ1*k = 目标
        let wid = 1, w = pickWing(rnd, next, f.uuid), base, FIXED;
        {
            wid = w.id;
            base = Object.assign({}, M2, { actChiBang: w });
            FIXED = power(base);
            for (let it = 0; it < 8 && FIXED > next * 0.9 && wid > 1; it++) {
                wid = Math.max(1, Math.floor(wid * 0.55));
                w = wingById(wid, rnd, f.uuid);
                base = Object.assign({}, M2, { actChiBang: w });
                FIXED = power(base);
            }
        }
        const EQ1 = Math.max(1, power(Object.assign({ actEquip: buildEquip(tpl.actEquip, 1, () => 0.5) }, base)) - FIXED);
        let k = (next - FIXED) / EQ1;
        k = Math.max(0.004, Math.min(280, k));           // v3.1：上限 280（≈15 亿战力空间）

        // 写入模块（装备 + 剑灵 + M2 档案全套）
        const equip = buildEquip(tpl.actEquip, k, rnd, f.uuid);
        await writeModule(f.uuid, "act", "actEquip", equip);
        await writeModule(f.uuid, "act", "actChiBang", w);
        for (const kid2 in M2) { try { await writeModule(f.uuid, "act", kid2, M2[kid2]); } catch (e) { } }
        // userInfo：等级随档位 + 头像/性别/活跃时间（档案个性化）
        const ui = Object.assign({}, map[f.uuid] && map[f.uuid].userInfo || {});
        ui.level = Math.max(90, Math.min(200, Math.round(90 + 110 * Math.min(1.3, k) / 1.3)));
        ui.head = FAKE_HEADS[i % FAKE_HEADS.length];
        ui.sex = i % 2;
        if (ui.tzid == null) ui.tzid = "";
        ui.lastlogin = nowT - Math.floor(rnd() * 7200); // 2 小时内活跃
        await writeModule(f.uuid, "user", "userInfo", ui);
        // 实测战力（回读）
        const after = Object.assign({}, (map[f.uuid] || {}), M2);
        after.actEquip = equip; after.actChiBang = w;
        after.userInfo = ui;
        const real = power(after);
        fS.power = real; fS.target = Math.round(T); fS.k = k; fS.t = nowT; fS.tier = tier;

        // 榜单刷新
        try {
            const m1 = new RdsUserModel_1.RdsUserModel("rdsPvd", "x", "1", String(game.getTodayId(nowT)));
            // [v4.6.6] 每日挑战"伤害"= 战力 × (0.14~0.42)（官方档位量级 ×3.5，用户拍板）；战力越高打得越多，当日稳定
            const _pvdRnd = ((((parseInt(String(f.uuid).slice(-4), 10) || 7) * 137) + ((Number(game.getTodayId(nowT)) || 0) % 977)) % 1000) / 1000;
            await m1.zSetVal(f.uuid, Math.max(10000, Math.round(real * (0.14 + 0.28 * _pvdRnd))));
            const m2 = new RdsUserModel_1.RdsUserModel("rdsPvw", "x", "1", String(game.getWeekId()));
            await m2.zSetVal(f.uuid, Math.max(100, Math.round(real / 2500)));
        } catch (e) { }

        if (report.length < 8) report.push("  " + f.name + " 战力 " + real + " / 目标 " + Math.round(T) + " (k=" + k.toFixed(3) + ")");
    }
    // —— M2-8/9：假人进竞技场榜/斗罗榜（排位系统按榜匹配对手）
    try {
        const jjcKey = String(tool.jjcWeekId(nowT));
        // v3.3.2：假人分数围绕“玩家实时积分”布阵（-60 ~ +260），保证玩家名次窗口里永远有多个假人可抽，
        // 修复“刷新永远同一个人”（旧逻辑固定 1500~2900，窗口里只够到一个）
        let pScore = 1500;
        try { const pm = new RdsUserModel_1.RdsUserModel("rdsJjc", "x", "1", jjcKey); const s0 = await pm.zScore(anchor.uuid); if (s0 != null) pScore = Math.ceil(parseFloat(s0)); } catch (e) { }
        st.jjcOff = st.jjcOff || {};   // [v4.7] 偏移持久化 + 每跳微移（榜有流动感，不再每跳重写同一值）
        for (let i = 0; i < fakes.length; i++) {
            const fU = fakes[i].uuid;
            if (st.jjcOff[fU] == null) st.jjcOff[fU] = Math.round(-10 + (i / Math.max(1, fakes.length - 1)) * 30); // -10~+20：全部挤进玩家名次窗口
            if (Math.random() < 0.4) st.jjcOff[fU] = Math.max(-14, Math.min(24, st.jjcOff[fU] + (Math.random() < 0.5 ? -1 : 1)));
            const score = Math.max(1500, Math.min(2900, pScore + st.jjcOff[fU]));
            const m = new RdsUserModel_1.RdsUserModel("rdsJjc", "x", "1", jjcKey);
            await m.zSetVal(fU, score);
        }
        report.push("竞技场榜 rdsJjc: " + fakes.length + " 人（围绕玩家 " + pScore + " 布阵 -10~+20）");
    } catch (e) { report.push("rdsJjc ERR " + e.message); }
    // —— 斗罗榜：假人"接管"官方占位名次（[v4.62]）
    //   ★官方隐含不变量：【积分 == 名次 == 索引+1】（整榜 1~500 稠密，每个名次恰好 1 个成员）
    //     · `HdDouLuoModel._refresh()` 抽出的 tzList 是【名次】，`ActDouLuoFightModel.fight_one`
    //       用 `hdinfo.tzList.indexOf(rid)` 校验 —— 所以 rid 必须是"名次"
    //     · 但 `HdDouLuoModel.getOutPut_outf()` 是【按索引取人】(getRankBetween(rid,rid))，
    //       而 `RdsUserModel.getInfo`（斗罗分支 L118 `rid = Number(score)`）又把该成员的【积分】
    //       当名次下发 ⇒ 客户端显示/回传的是【积分】
    //     ⇒ 一旦"积分 != 名次"，玩家点卡片就会被判「名次错误 请刷新」
    //   ★旧实现（v3.5）让假人用自己的 uuid 另占一个积分 → 与官方占位成员撞分/留洞
    //     ⇒ 全榜 701 人 / 只有 500 个不同积分 / 695 条索引与积分错位 ⇒ 打完一场再打必踩
    //   ★现改法：假人只"接管"官方占位成员的名次（删占位 → 用同一积分插入假人），腾出的名次补回
    //     官方占位（名字 = 名次字符串，对齐官方 `zSetVal(myrid.toString(), myrid)` 的语义）；
    //     同时把历史上错位的占位改名、清掉同分重复成员、补齐空洞 ⇒ 整榜永远稠密。
    try {
        const HdDouLuoModel_1 = require("./src/model/hd/HdDouLuoModel");
        const cfgDL = Setting.getHuodong2 ? Setting.getHuodong2("1", "hdDouLuo") : null;
        if (cfgDL) {
            const ctxU = await tool.ctxCreate("user", anchor.uuid);
            const hd = HdDouLuoModel_1.HdDouLuoModel.getInstance(ctxU, anchor.uuid, "1");
            const dlinfo = await hd.getBaseInfo();
            if (dlinfo && dlinfo.ksid != null && dlinfo.weekId != null) {
                const m = new RdsUserModel_1.RdsUserModel("rdsDouLuo", "1", String(dlinfo.ksid), String(dlinfo.weekId));
                m._sortType = -1;   // 与官方 RdsUserModel.getInstance(rdsDouLuo) 一致（升序：名次越小越靠前）
                const _dlKey = m.getKey();
                const _rds = redis_1.redisSev.getRedis(m.dType);
                // 玩家名次（斗罗里"积分"就是名次）
                let pDl = null;
                try { const s0 = await m.zScore(anchor.uuid); if (s0 != null) pDl = Math.round(parseFloat(s0)); } catch (e) { }
                if (pDl == null) { pDl = 300; try { await m.zSetVal(anchor.uuid, pDl); } catch (e) { } }
                const base = Math.max(20, Math.min(480, pDl));
                // 读全榜 → 名次(积分) -> 成员；同一名次上的多余成员另行记下待删
                const _flat = await _rds.zRangeWithScores(_dlKey, 0, -1);
                const _cur = new Map(); const _extra = [];
                for (let i = 0; i + 1 < (_flat || []).length; i += 2) {
                    const _n = String(_flat[i]), _s = Number(_flat[i + 1]);
                    if (!_cur.has(_s)) { _cur.set(_s, _n); continue; }
                    const _a = _cur.get(_s);
                    if (DL_IS_PH(_a) && !DL_IS_PH(_n)) { _extra.push(_a); _cur.set(_s, _n); }
                    else _extra.push(_n);
                }
                // 假人名次演化（沿用 v3.5/v4.7 的窗口与漂移；目标必须【独占】名次）
                st.dlRankK = st.dlRankK || {};
                st.dlRankK[_dlKey] = st.dlRankK[_dlKey] || {};
                const DLR = st.dlRankK[_dlKey];
                const _fresh = Object.keys(DLR).length === 0;
                try { const _kks = Object.keys(st.dlRankK); while (_kks.length > 4) delete st.dlRankK[_kks.shift()]; } catch (e) { }
                const DL_N = fakes.length;
                const W_LO = Math.max(2, base - 12), W_HI = Math.min(499, base + 27);
                for (let i = 0; i < DL_N; i++) {
                    const fU = String(fakes[i].uuid);
                    if (DLR[fU] == null) DLR[fU] = Math.max(2, Math.min(499, Math.round(2 + 497 * i / Math.max(1, DL_N - 1) + (Math.random() - 0.5) * 4)));
                    // 吸收榜上实际名次（玩家打赢 = 官方把该假人换到玩家旧名次 ⇒ 必须以榜为准，否则会把玩家的胜利撤销）
                    if (!_fresh) {
                        let cs = null;
                        try { const c0 = await m.zScore(fU); if (c0 != null) cs = Math.round(parseFloat(c0)); } catch (e) { }
                        if (cs != null && cs >= 2 && cs <= 499 && cs !== DLR[fU]) DLR[fU] = cs;
                    }
                    // 演化：5% 微移 ±1~2（假人之间也在互相打）
                    if (Math.random() < 0.05) DLR[fU] = Math.max(2, Math.min(499, DLR[fU] + (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.25 ? 2 : 1)));
                }
                // 窗口保底 40 人（挑战表在玩家名次附近永远有对象）
                const inWin = new Set(), slotUsed = new Set();
                for (let i = 0; i < DL_N; i++) { const fU = String(fakes[i].uuid); if (DLR[fU] >= W_LO && DLR[fU] <= W_HI) { inWin.add(fU); slotUsed.add(DLR[fU]); } }
                const need = 40 - inWin.size;
                if (need > 0) {
                    const free = [];
                    for (let j = W_LO; j <= W_HI && free.length < need + 8; j++) if (!slotUsed.has(j) && j !== pDl) free.push(j);
                    const outs = [];
                    for (let i = 0; i < DL_N; i++) { const fU = String(fakes[i].uuid); if (!inWin.has(fU)) outs.push({ u: fU, d: Math.abs(DLR[fU] - base) }); }
                    outs.sort((a, b) => a.d - b.d);
                    for (let t2 = 0; t2 < need && t2 < free.length && t2 < outs.length; t2++) DLR[outs[t2].u] = free[t2];
                }
                // 目标表：名次 -> 成员（玩家保持自己的名次；假人各占一个；其余用官方占位补齐，名字=名次）
                const want = new Map();
                const _fakeSet = new Set();
                for (let i = 0; i < DL_N; i++) _fakeSet.add(String(fakes[i].uuid));
                // ① 保护：非占位、且不是假人的成员（真人 / 其它异常成员）→ 原地保留，绝不删
                for (const [s, n] of _cur) if (!DL_IS_PH(n) && !_fakeSet.has(n)) want.set(s, n);
                // ② 玩家：自己的名次
                want.set(pDl, String(anchor.uuid));
                // ③ 假人：各占一个独占名次
                for (let i = 0; i < DL_N; i++) {
                    const fU = String(fakes[i].uuid);
                    let r = Math.max(2, Math.min(499, Math.round(DLR[fU]) || 2));
                    if (r === pDl || want.has(r)) {
                        let ok = -1;
                        for (let d = 1; d <= 498 && ok < 0; d++) {
                            const a = r - d, b = r + d;
                            if (a >= 2 && a <= 499 && a !== pDl && !want.has(a)) ok = a;
                            else if (b >= 2 && b <= 499 && b !== pDl && !want.has(b)) ok = b;
                        }
                        if (ok < 0) { continue; }   // 500 个槽 vs 201 人，正常不会发生
                        r = ok;
                    }
                    want.set(r, fU);
                    DLR[fU] = r;
                }
                for (let r = 1; r <= 500; r++) if (!want.has(r)) want.set(r, String(r));
                // 差量修正（幂等）：换人先删旧，再补写
                const _del = _extra.slice(), _put = [];
                for (const [s, n] of _cur) if (want.get(s) !== n) _del.push(n);
                for (const [s, n] of want) if (_cur.get(s) !== n) _put.push([s, n]);
                for (const n of _del) { try { await m.zDel(n); } catch (e) { } }
                for (const _p of _put) { try { await m.zSetVal(_p[1], _p[0]); } catch (e) { } }
                report.push("斗罗榜 rdsDouLuo: " + DL_N + " 人接管占位（键 " + _dlKey + "，1~500 稠密，删 " + _del.length + " / 写 " + _put.length + "，玩家名次 " + base + (_fresh ? "，首铺" : "") + "）");
            } else report.push("斗罗榜：活动未开，跳过");
        }
    } catch (e) { report.push("rdsDouLuo 跳过: " + e.message); }
    // —— §3.3 六道榜 rdsLiuDao：[v4.9b] 锚定玩家演化（层数围绕玩家爬，不脱轨）
    //    旧版“其余铺满 30~500 + 每天爬 ~79 层”会把玩家甩到 201/201 名；改为“上限=玩家+60、初始围绕玩家”
    try {
        const ld = (map[anchor.uuid] || {}).actLiuDao || {};
        const pLd = Math.max(1, Number(ld.maxId) || 1);
        const CAP = 500;
        const LAG = 60;                                   // [v4.9b] 假人可领先玩家的最大层数（玩家爬则放开）
        const m = new RdsUserModel_1.RdsUserModel("rdsLiuDao", "x", "1", "1");
        st.liudao = st.liudao || {};
        let top6 = 0, climbN = 0;
        for (let i = 0; i < fakes.length; i++) {
            const fU = fakes[i].uuid;
            const s6 = st.liudao[fU] = st.liudao[fU] || { layer: 0 };
            const capNow = Math.min(CAP, pLd + LAG);
            if (!(s6.layer > 0)) {
                // [v4.9b] 初始：3 人贴玩家脚下（±2），其余从 玩家-8 到 玩家+55 渐进排开（梯队感）
                if (i < 3) s6.layer = Math.max(1, Math.min(CAP, pLd + (i - 1) * 2 + (i === 0 ? -1 : 0)));
                else s6.layer = Math.max(1, Math.min(CAP, Math.round(pLd - 8 + 63 * (i - 3) / Math.max(1, fakes.length - 3))));
            } else {
                // [v4.9b] 演化：爬塔机制保留（55% +1 / 15% 爆 2），但顶到“玩家+60”后原地等玩家
                let step = Math.random() < 0.55 ? (Math.random() < 0.15 ? 2 : 1) : 0;
                if (s6.layer < pLd && Math.random() < 0.25) step += 1;
                if (s6.layer >= capNow) step = 0;                       // 顶格：等玩家追上（不再刷到 500）
                if (s6.layer < pLd - 10 && Math.random() < 0.35) step = Math.max(step, 1);  // 掉队 >10 层 → 保底追
                s6.layer = Math.min(capNow, s6.layer + step);
                if (step > 0) climbN++;
            }
            await m.zSetVal(fU, s6.layer);
            if (s6.layer > top6) top6 = s6.layer;
        }
        report.push("六道榜 rdsLiuDao: " + fakes.length + " 人演化（玩家 maxId=" + pLd + "，榜首=" + top6 + "，本跳 " + climbN + " 人在爬，上限=玩家+" + LAG + "）");
    } catch (e) { report.push("rdsLiuDao 布阵跳过: " + e.message); }

    // —— §3.3b [v4.57] 罗浮仙域「全服成就」名单：让假人真进榜（修复成就永远领不了）
    //    官方门槛：ActLiuDaoModel.sevCjRwd(id) 要求 sevLiuDao.cj[id].length >= 5（该层有 5 名玩家进榜）
    //    官方写入点：玩家首次突破第 L 层时 SevLiuDaoModel.addFuuid(uuid, L)（L 只认 liudaoSevCj 表里的 10/20/…/300，上限 10 人）
    //    单机只有玩家 1 人 ⇒ 全服成就永远卡在"参数错误"。
    //    这里把「层数 ≥ L」的假人补进 cj[L]（他们确实通关过第 L 层，语义成立）：
    //      · 只补「玩家已通关」的层（L <= 玩家 maxId）→ 不会提前发未来层数的奖励
    //      · 每层补到 5 人即停（不占满官方 10 人上限，也给真人留位）
    //      · 每层用偏移换一批人 → 各档名单不一样，像真实服务器
    //      · 同时给进榜假人补 actLiuDao 记录，否则成就里的「5 名玩家」分数会显示 0
    try {
        const pLd2 = Math.max(0, Number((((map[anchor.uuid] || {}).actLiuDao) || {}).maxId) || 0);
        const cjTbl = require("./common/excel/liudaoSevCj.json");
        const levels = (Array.isArray(cjTbl) ? cjTbl : []).map((x) => Number(x.id)).filter((n) => n > 0).sort((a, b) => a - b);
        const openLv = levels.filter((L) => L <= pLd2);
        if (!openLv.length) report.push("罗浮仙域 全服成就名单: 玩家未到第 10 层，跳过（0/" + levels.length + " 档）");
        else {
            const db2 = mongodb_1.dbSev.getDataDb();
            const row = await db2.findOne("sev", { id: "1", kid: "sevLiuDao", hdcid: "1" });
            const sData = (row && row.data) || { cj: {} };
            sData.cj = sData.cj || {};
            const cand = [];
            for (let i = 0; i < fakes.length; i++) {
                const L6 = (st.liudao[fakes[i].uuid] || {}).layer || 0;
                if (L6 > 0) cand.push({ u: fakes[i].uuid, layer: L6 });
            }
            cand.sort((a, b) => b.layer - a.layer);
            let won = 0;
            const touched = {};
            for (const L of openLv) {
                const cur = (sData.cj[L] = sData.cj[L] || []);
                if (cur.length >= 5) continue;
                const pool = cand.filter((c) => c.layer >= L);
                if (!pool.length) continue;
                const off = (Math.floor(L / 10) * 3) % pool.length;
                for (let k = 0; k < pool.length && cur.length < 5; k++) {
                    const c = pool[(k + off) % pool.length];
                    if (cur.indexOf(c.u) >= 0 || cur.indexOf(String(c.u)) >= 0) continue;
                    cur.push(c.u);
                    won++;
                    touched[c.u] = Math.max(touched[c.u] || 0, c.layer);
                }
            }
            if (won > 0) {
                await db2.update("sev", { id: "1", kid: "sevLiuDao", hdcid: "1" }, { id: "1", kid: "sevLiuDao", hdcid: "1", data: sData }, true);
                try { await redis_1.redisSev.getRedis(SEV_DT).hSet("sev_1", "sev_sevLiuDao_1", sData); } catch (e2) { }
            }
            // 名单里所有假人都要有 actLiuDao 记录（否则成就界面的「5 名玩家」分数显示 0）——缺失才写
            try {
                const have = {};
                const dbAct = await db2.find("act", { kid: "actLiuDao" });
                for (const r2 of (dbAct || [])) have[String(r2.id)] = 1;
                for (const L of openLv) {
                    for (const fu of (sData.cj[L] || [])) {
                        const fs2 = String(fu);
                        if (Number(fs2) < 200000 || have[fs2]) continue;
                        const lyr = ((st.liudao || {})[fs2] || {}).layer || L;
                        await writeModule(fs2, "act", "actLiuDao", {
                            time: 0, maxId: lyr, sevRwd: [], actRwd: [], nowId: lyr,
                            start: { from: "", seed: 0, teams: {} }, end: { win: 0, items: [] }, itemLock: {}
                        });
                        have[fs2] = 1;
                    }
                }
            } catch (e2) { }
            if (won > 0) report.push("罗浮仙域 全服成就名单: 补进 " + won + " 人次 / " + Object.keys(touched).length + " 名假人（覆盖 " + openLv.length + "/" + levels.length + " 档，玩家 maxId=" + pLd2 + "）");
            else report.push("罗浮仙域 全服成就名单: 已满足（" + openLv.length + "/" + levels.length + " 档，玩家 maxId=" + pLd2 + "）");
        }
    } catch (e) { report.push("罗浮仙域 全服成就名单跳过: " + e.message); }

    st.anchorUuid = anchor.uuid;               // [v4.7] 记录当前锚点（跑马灯等复用）
    saveState(st);
    report.push("小计 " + fakes.length + " 人已刷新");
    // M4-1：缓存假人名册（跑马灯播报用）
    try {
        st.paomaNames = fakes.map((f) => {
            const ui = (map[f.uuid] || {}).userInfo || {};
            return { uuid: f.uuid, name: ui.name || ("玩家" + String(f.uuid).slice(-3)) };
        });
        saveState(st);
    } catch (e) { }
    // v3.1：竞技场 NPC 假人化
    try {
        const n = syncJjcNpc(P2, anchor.ui && anchor.ui.level, report);
        report.push("竞技场NPC 假人化 " + n + " 条（封顶 " + FAKE_CAP + "）");
    } catch (e) { report.push("竞技场NPC ERR " + e.message); }
    // v4.2：六大活动榜假人化（活榜；必须放在最后——本函数内部自行 loadState/saveState）
    try { await hdRankTick(fakes.slice(0, 24), report, anchor.uuid); } catch (e) { report.push("hdRank ERR " + (e && e.message)); }
    // [v4.27 / v4.58 修] 斗罗 NPC 增强（全量 500：per 每次补，技能/秘法/仙侣只算一次）
    //   ⚠ 原来传 null → douLuoNpcBoost 里的 `if (ctx && ...)` 永不成立 ⇒ 500 个斗罗 NPC 的
    //   soloWxSk（秘法/灵脉）/soloJgSk（精怪）/soloIsNq/仙侣数据**从未构建**（只有真进战斗时对那 1 个临时构）
    //   ⇒ 斗罗人机"秘法都没有了"。改用真 ctx 全量构建；实测 500 个共 844 ms（单个 3 ms）。
    //   （不能直接用上面的 ctxU：它在 HdDouLuo 那个 try 块内，块级作用域看不到 → 曾报 ctxU is not defined）
    try {
        const ctxDL = await tool.ctxCreate("user", anchor.uuid);
        const dn = douLuoNpcBoostAll(ctxDL);
        if (dn) report.push("斗罗NPC增强 " + dn + "（per + 秘法/精怪/仙侣）");
    } catch (e) { report.push("斗罗NPC ERR " + (e && e.message)); }
    return { ok: true, report: report };
}

// ==================== ④ 竞技场 NPC 假人化（v3.2·全池） ====================
// jjcNpc 3500 个 NPC 档案（竞技场匹配池）；战斗直接用 cfgNpc.eps（ActJjcFightModel：feps=ep_merge(ep_init, cfgNpc.eps)）。
// v3.2：全池按【积分梯度】缩放 —— 分数最低 0.30× → 最高 1.30×（按 id 稳定抖动 ±6%）。
// 玩家在任意分段遇到的对手都随锚点成长；score 不动（匹配规则不变），等级随积分档位。
// 注意：getItemCtx 返回的是池内对象引用（confProxy 无拷贝），原地改字段即时生效。
let _NPC_ORIG = null;
function npcOrig() {
    if (_NPC_ORIG) return _NPC_ORIG;
    _NPC_ORIG = {};
    try {
        const pool = _gcfg.jjcNpc && _gcfg.jjcNpc.pool;
        for (const k in (pool || {})) {
            const eps = JSON.parse(JSON.stringify(pool[k].eps || {}));
            _NPC_ORIG[k] = {
                eps: eps,
                score: pool[k].score || 0, level: pool[k].level || 1,
                power: epsPower(eps),   // 原始战力（反解缩放系数用，只算一次）
            };
        }
    } catch (e) { }
    return _NPC_ORIG;
}
function scaleEps(eps, k) {
    const out = {};
    for (const key in (eps || {})) out[key] = Math.max(0, Math.round((Number(eps[key]) || 0) * k));
    return out;
}
function epsPower(eps) {
    try { return gm.ep_power(0, gm.ep_merge(gm.ep_init(), eps)); } catch (e) { return 0; }
}
function syncJjcNpc(P2, aLv, report) {
    const pool = _gcfg.jjcNpc && _gcfg.jjcNpc.pool;
    if (!pool) return 0;
    const orig = npcOrig();
    const keys = Object.keys(pool);
    // v3.2 全池积分梯度：rel 0（最低分）→ 1（最高分），档位 0.30× → 1.30×
    let scMin = Infinity, scMax = -Infinity;
    for (const k of keys) { const s = (orig[k] && orig[k].score) || 1500; if (s < scMin) scMin = s; if (s > scMax) scMax = s; }
    const span = Math.max(1, scMax - scMin);
    const lvTop = Math.max(9, Math.min(200, aLv || 150));
    let n = 0;
    for (const k of keys) {
        const e = pool[k]; const o = orig[k];
        if (!e || !o) continue;
        const rel = Math.max(0, Math.min(1, ((o.score || scMin) - scMin) / span));
        const idn = Number(k) || 0;
        const jit = 0.94 + ((idn * 2654435761 % 997) / 997) * 0.12;   // 稳定伪随机 ±6%
        const f = npcRelByScore(o.score) * jit;   // v4.28：统一口径（原 0.30+1.00*rel）
        const T = Math.max(800, Math.min(P2 * f, FAKE_CAP));
        const q0 = Math.max(1, o.power || epsPower(o.eps));
        const kk = Math.max(0.05, Math.min(50000, T / q0));
        e.eps = scaleEps(o.eps, kk);
        bolsterPer(e.eps, npcRelByScore(o.score));   // v4.27：静态版也补 per（战斗侧另有 npcFuser 保险）
        e.level = Math.max(9, Math.min(200, Math.round(9 + (lvTop - 9) * rel + ((idn % 5) - 2))));
        n++;
    }
    return n;
}

// ==================== ④.5 活动榜假人化（v4.2：六大活动榜“活榜”） ====================
// 键：<heId>_<kid>_<hdcid>_<hid>（RModel.getKey；heId=1；hid=活动配置 info.id）
//   rdsHdChumo       1_rdsHdChumo_1_20230621         分数=除魔进度（关）
//   rdsHdChongBang   1_rdsHdChongBang_1_20230905     分数=充值额
//   rdsHdQiYuan      1_rdsHdQiYuan_1_20230905        分数=祈愿积分
//   rdsHdHuanJing    1_rdsHdHuanJing_1_20230905      分数=幻境分数
//   rdsHdChou        1_rdsHdChou_{1|2|3}_20230905    分数=秘宝积分（三档全写，读的只有当前档）
//   rdsHdTianGong    1_rdsHdTianGong_1_<weekId>      分数=乐舞分（本服）
//   rdsHdTianGongKua 1_rdsHdTianGongKua_1_<weekId>   分数=乐舞分（跨服）
// 活榜：玩家在榜 → 24 人按 0.60P~1.45P 梯度铺在玩家上下（前几名高于玩家）；玩家没分 →
//       历史基准每 tick 缓慢演化（增长 + 偶发漂移），随时可被玩家追赶/超越。
const HD_RANK_DEFS = [
    { kid: "rdsHdChumo", hid: "20230621", lo: 3, hi: 14, grow: 0.010, hd: "hdChumo" },
    { kid: "rdsHdChongBang", hid: "20230905", lo: 6, hi: 198, grow: 0.004, hd: "hdChongbang" },
    { kid: "rdsHdQiYuan", hid: "20230905", lo: 300, hi: 4800, grow: 0.015, hd: "hdQiYuan" },
    { kid: "rdsHdHuanJing", hid: "20230905", lo: 600, hi: 6500, grow: 0.015, hd: "hdHuanJing" },
    { kid: "rdsHdChou", hid: "20230905", lo: 60, hi: 1800, grow: 0.012, hdcids: ["1", "2", "3"], hd: "hdChou" },
    { kid: "rdsHdTianGong", hid: null, lo: 400, hi: 4200, grow: 0.015, week: true, kua: true },
];
async function hdRankTick(fakes, report, anchorUuid) {
    report = report || [];
    const st = loadState();
    st.hdRanks = st.hdRanks || {};
    const weekId = String(game.getWeekId());
    for (const def of HD_RANK_DEFS) {
        try {
            const hdcids = def.hdcids || ["1"];
            // v4.2.1：每档的“期号”以【运行时活动缓存】为准 —— 循环活动（如 hdChou）的 cfg.info.id 是动态的
            //（模板里 20230905，当期实际 20260917；用模板值写键 = 服务端读不到 → 榜单上看不到假人）
            const pairs = hdcids.map((hd) => {
                let h = def.week ? weekId : def.hid;
                if (def.hd) {
                    h = null;   // [v4.9b] 默认 null=取不到当期；取不到 = 活动未开 → 该档跳过（不再回退写模板键，防脏键增长）
                    try {
                        const rt = Setting.getHuodong3("1", def.hd, hd);
                        if (rt && rt.info && rt.info.id != null)
                            h = String(rt.info.id);
                    }
                    catch (e) { }
                }
                return { hd: hd, hid: h };
            });
            const live = pairs.filter((p) => p.hid != null);
            if (live.length === 0) { report.push("活动榜 " + def.kid + ": 活动未开（无当期期号），跳过"); continue; }
            const hid = live[0].hid;   // 跨服/报告用
            // 玩家锚（九龙：三档取最大；其余读主档）
            let pScore = null;
            for (const pr of live) {
                try {
                    const s0 = await new RdsUserModel_1.RdsUserModel(def.kid, pr.hd, "1", pr.hid).zScore(anchorUuid || "100003");
                    if (s0 != null) { const v = Math.ceil(parseFloat(s0)); if (pScore == null || v > pScore) pScore = v; }
                } catch (e) { }
            }
            st.hdRanks[def.kid] = st.hdRanks[def.kid] || {};
            const baseMap = st.hdRanks[def.kid];
            const n = fakes.length;
            let upN2 = 0;
            for (let i = 0; i < n; i++) {
                const u = fakes[i].uuid;
                if (baseMap[u] == null) {
                    // [v4.7] 初始化：玩家在榜 → 以玩家为锚铺 0.55P~1.55P（有对手可打）；否则官方量级铺开
                    if (pScore != null && pScore > 0) baseMap[u] = Math.round(pScore * (0.55 + 1.00 * (i / Math.max(1, n - 1))));
                    else baseMap[u] = Math.round(def.lo + (def.hi - def.lo) * (i / Math.max(1, n - 1)));
                }
                // 基准演化（每 tick 都走：缓慢增长 + 偶发漂移）
                let b = baseMap[u] * (1 + def.grow * Math.random());
                if (Math.random() < 0.30) b = b * (1 + (Math.random() - 0.5) * 0.04);
                // [v4.7] 与玩家互动：被甩开 → 加速追赶；反超太多 → 缓降（各自演化，排序会真实变动）
                if (pScore != null && pScore > 0) {
                    if (b < pScore * 0.5) b += (pScore - b) * 0.10;
                    else if (b > pScore * 2.2) b = b * 0.985;
                }
                const hlo = (pScore != null && pScore > 0) ? pScore * 0.3 : def.lo * 0.4;
                const hhi = (pScore != null && pScore > 0) ? pScore * 2.6 : def.hi * 1.8;
                const nb = Math.round(Math.max(hlo, Math.min(hhi, b)));
                if (nb !== baseMap[u]) upN2++;
                baseMap[u] = nb;
                // 出分：直接用各自基准（不再固定比例 → 玩家可超越、假人可反超）
                let s = Math.max(1, Math.round(baseMap[u]));
                for (const pr of live)
                    await new RdsUserModel_1.RdsUserModel(def.kid, pr.hd, "1", pr.hid).zSet(u, s);
                if (def.kua)
                    await new RdsUserModel_1.RdsUserModel(def.kid + "Kua", "1", "1", hid).zSet(u, s);
            }
            report.push("活动榜 " + def.kid + ": " + n + " 人演化（" + (pScore != null ? "玩家 " + pScore + " 为锚" : "自然分布") + "，本跳 " + upN2 + " 人变动）" + (def.kua ? " +跨服" : ""));
        }
        catch (e) { report.push(def.kid + " 异常: " + (e && e.message)); }
    }
    saveState(st);
    return report;
}

// ==================== ③ 聊天交互 ====================
const REPLIES = {
    hi: ["{me} 好呀，刚上线就看到你了", "在的在的，{me}有什么事？", "欢迎欢迎，一起玩呀"],
    team: ["组队打本可以叫我，我随时有空", "缺人吗？算我一个", "走走走，一起干一票大的"],
    equip: ["装备强化别急，慢慢来都会满的", "附魔是真烧钱，我碎了三次了…", "先把主力装备拉满，其他随缘"],
    fight: ["竞技场最近高手好多，被打哭了", "排位我卡在瓶颈了，求带", "斗法场随缘吧，赢一把开心一整天"],
    club: ["仙盟收人，活跃的来～", "我们盟今晚打BOSS，来凑热闹", "祈福别忘了，白嫖奖励"],
    dongtian: ["洞天被人抢了两次，气死", "挖矿记得收，不然白挖", "掠夺别人好爽，哈哈"],
    ask: ["这个问题问得好，我也想知道", "应该是多堆点战力就行吧", "问问群里大佬，他们懂"],
    generic: ["哈哈哈", "有道理", "确实确实", "我也是这么觉得的", "晚上一起玩啊", "冒个泡，今天大家都在嘛", "这游戏真好玩，就是有点肝"],
};
function pickReply(msg, me, name, rnd) {
    const s = String(msg || "");
    let cat = "generic";
    if (/你好|在吗|hi|hello|大家好|新人/i.test(s)) cat = "hi";
    else if (/组队|一起|来|打本|副本|boss|Boss|BOSS/i.test(s)) cat = "team";
    else if (/装备|强化|附魔|宝石|符石|战力/i.test(s)) cat = "equip";
    else if (/竞技|排位|斗法|打架|jjc|PK/i.test(s)) cat = "fight";
    else if (/仙盟|公会|帮派|联盟/i.test(s)) cat = "club";
    else if (/洞天|挖矿|掠夺|矿车/i.test(s)) cat = "dongtian";
    else if (/[?？]|怎么|如何|哪个|多少/i.test(s)) cat = "ask";
    const arr = REPLIES[cat] || REPLIES.generic;
    let t = arr[Math.floor(rnd() * arr.length)];
    return t.replace(/\{me\}/g, me || "兄弟");
}
function aiReply(info) {
    // 1) 内置 AI 网关（MiniMax：db/solo_ai_config.json 配好 key 即生效）
    try {
        const ai = require("./_solo_ai");
        const c = ai.loadCfg && ai.loadCfg();
        if (c && c.key) {
            return ai.ask({
                system: "你是网游《修仙放置游戏》里的玩家" + info.name + "。要求：用中文口语化地回复世界频道消息，只输出回复那一句话本身（≤40 字），不要加引号、不要解释。",
                user: (info.player ? info.player + ": " : "") + info.msg,
                maxTokens: 300,
            }).then((t) => {
                if (t == null) return null;
                const clean = String(t).replace(/^["'“”「」]+|["'“”「」]+$/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
                return clean || null;
            });
        }
    } catch (e) { }
    // 2) 预留 AI 接口：POST JSON → {reply:"..."}（失败返回 null 走模板）
    const url = process.env.SOLO_FAKE_AI_URL;
    if (!url) return Promise.resolve(null);
    return new Promise((resolve) => {
        let u;
        try { u = new URL(url); } catch (e) { return resolve(null); }
        const lib = u.protocol === "https:" ? https : http;
        const body = JSON.stringify({
            name: info.name, player: info.player, msg: info.msg,
            system: "你是网游《修仙放置游戏》里的玩家" + info.name + "，用中文口语化地回复世界频道消息，一句话，别超过40字。",
        });
        const req = lib.request({
            hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + (u.search || ""), method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
            timeout: 6000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const j = JSON.parse(d);
                    resolve(j.reply || j.text || j.msg || null);
                } catch (e) { resolve(null); }
            });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { try { req.destroy(); } catch (e) { } resolve(null); });
        req.write(body); req.end();
    });
}
// —— 聊天存储读写（SevChatModel 规范：table/kid=chat, dType=sev, 2级key=hdcid）——
function chatKey1(chId) { return SEV_DT + "_" + chId; }
function chatKey2(hdcid) { return "chat_chat_" + hdcid; }
async function readChat(chId, hdcid) {
    try {
        const rd = redis_1.redisSev.getRedis(SEV_DT);
        const v = await rd.hGet(chatKey1(chId), chatKey2(hdcid));
        if (v != null && v.list != null) return v;
    } catch (e) { }
    const db = mongodb_1.dbSev.getDataDb();
    const cur = await db.findOne("chat", { id: String(chId), kid: "chat", hdcid: hdcid });
    return (cur && cur.data) ? cur.data : { list: {}, id: 0 };
}
async function writeChat(chId, hdcid, data) {
    const db = mongodb_1.dbSev.getDataDb();
    await db.update("chat", { id: String(chId), kid: "chat", hdcid: hdcid },
        { id: String(chId), kid: "chat", hdcid: hdcid, data: data }, true);
    try { await redis_1.redisSev.getRedis(SEV_DT).hSet(chatKey1(chId), chatKey2(hdcid), data); } catch (e) { }
}
async function writeChatLine(chId, hdcid, user, msg) {
    const data = await readChat(chId, hdcid);
    if (!data.list) data.list = {};
    data.id = (Number(data.id) || 0) + 1;
    data.list[data.id] = { id: data.id, type: "1", user: user, msg: msg, time: game.getNowTime() };
    const keys = Object.keys(data.list).sort((a, b) => Number(a) - Number(b));
    while (keys.length > 100) delete data.list[keys.shift()];
    await writeChat(chId, hdcid, data);
    // [v4.6.6] 盟聊天：同步推进 adokClub 水位 —— 否则心跳永不推假人消息（玩家必须自己发言、借"自己的 add"顺带刷新）
    try {
        if (hdcid === "club") {
            const c2 = await tool.ctxCreate("user", "100003");
            const SM = require("./src/model/sev/SevAdokClubModel").SevAdokClubModel;
            await SM.getInstance(c2, String(chId)).setVer("clubChat", data.id);
            await c2.state.master.distroy();
        }
    } catch (e) { try { console.log("[solo-fakes2] 推进盟 chat 水位失败: " + ((e && e.message) || e)); } catch (e2) { } }
    try { console.log("[solo-fakes2] 聊天写入[" + hdcid + "/" + chId + "]: " + user.name + ": " + msg); } catch (e) { }
}
function fakeFuser(uuid, name) {
    return {
        uid: "", uuid: uuid, sid: "1", name: name, sex: 1, head: "skin_1",
        wxhead: "", tzid: "", level: 150, lastlogin: game.getNowTime(),
        rid: 0, score: 0, clubName: "", chid: "1", cbid: "1",
    };
}
// ==================== [v4.5] 统一假人档案（完整 fuser，含 sevBack） ====================
// 所有"假人露脸处"（聊天 / 洞天 / 仙盟 / 跑马灯…）统一走这里 —— 与全站 getFUser 完全一致
const _fuCache = {};
let _fuCtx = null;
async function fakeFuserFull(uuid) {
    const key = String(uuid);
    const nowT = game.getNowTime();
    const c = _fuCache[key];
    if (c != null && nowT - c.t < 300) return c.f;
    let out = null;
    try {
        if (_fuCtx == null) { try { _fuCtx = await tool.ctxCreate("user", "100003"); } catch (e) { _fuCtx = null; } }
        if (_fuCtx != null) {
            try { _fuCtx.state.newTime = nowT; } catch (e) { }
            const cache = _def(require("./src/util/cache"));
            const f = await cache.getFUser(_fuCtx, key, 1);
            if (f != null && f.uuid != null) out = f;
        }
    } catch (e) { }
    if (out == null) {
        try {
            const db = mongodb_1.dbSev.getDataDb();
            const row = await db.findOne("user", { id: key, kid: "userInfo", hdcid: "1" });
            const ui = (row != null && row.data) ? row.data : {};
            out = { uid: "3" + key, uuid: key, sid: "1", name: ui.name || ("侠客" + key), sex: ui.sex != null ? ui.sex : 1,
                    head: ui.head || "skin_1", wxhead: "", tzid: "", level: ui.level || 150, lastlogin: nowT,
                    rid: 0, score: 0, clubName: "", chid: "1", cbid: "1" };
        } catch (e) { out = fakeFuser(key, "侠客" + key); }
    }
    _fuCache[key] = { t: nowT, f: out };
    return out;
}
// ==================== [v4.6] 完整档案·带 sevBack ====================
// 与 fakeFuserFull 相同，但 getFUser(…, 0) 不裁 sevBack（~10KB）→ 客户端 getOtherTotalZhanLi 能算出真实战力
// 用途：洞天矿车里的 user 快照（"掠夺者战力"显示）等需要真实战力的假人露脸处
const _fuSevCache = {};
async function fakeFuserSev(uuid) {
    const key = String(uuid);
    const nowT = game.getNowTime();
    const c = _fuSevCache[key];
    if (c != null && nowT - c.t < 300) return c.f;
    let out = null;
    try {
        if (_fuCtx == null) { try { _fuCtx = await tool.ctxCreate("user", "100003"); } catch (e) { _fuCtx = null; } }
        if (_fuCtx != null) {
            try { _fuCtx.state.newTime = nowT; } catch (e) { }
            const cache = _def(require("./src/util/cache"));
            const f = await cache.getFUser(_fuCtx, key, 0);
            if (f != null && f.uuid != null) out = f;
        }
    } catch (e) { }
    if (out == null) { try { out = await fakeFuserFull(key); } catch (e) { out = fakeFuser(key, "侠客" + key); } }
    _fuSevCache[key] = { t: nowT, f: out };
    return out;
}
let kuaIdCache = null;
async function getKuaId() {
    if (kuaIdCache != null) return kuaIdCache;
    try {
        const c = await tool.ctxCreate("sev", "1");
        kuaIdCache = await c.state.master.getChatKuaId("1");
    } catch (e) { kuaIdCache = null; }
    return kuaIdCache;
}
async function onRequest(ctx) {
    if (!ctx || !ctx.url) return;
    // [v4.6.10] 求助发布（/club/helpMe，任意类型 box/boxStep/fushi/dongtian）→ 2~5 秒后让假人立刻来帮（不再等 10 分钟 tick）
    //   （v4.6.8 只覆盖了 dongtian → 发 box/升阶/符石求助后没人来帮，用户报"没有用"）
    if (ctx.url.indexOf("/club/helpMe") !== -1) {
        try {
            const p2 = tool.getParams(ctx);
            const ACM2 = require("./src/model/act/ActClubModel").ActClubModel;
            const cid2 = String((await ACM2.getInstance(ctx, p2.uuid).getInfo()).clubId || "");
            if (cid2 && cid2 !== "0") {
                setTimeout(() => {
                    try { require("./_solo_fakes3").nudgeHelp(cid2).catch(() => { }); } catch (e) { }
                }, 2000 + Math.random() * 3000);
            }
        } catch (e) { }
        return;
    }
    // 只在 /chat/send 成功时触发（在 boot 中间件2 的 try 内、backDataAll 之前：ctx 仍存活）
    if (ctx.url.indexOf("/chat/send") === -1) return;
    const params = tool.getParams(ctx);
    const hdcid = params.hdcid;
    if (hdcid !== "all" && hdcid !== "hefu" && hdcid !== "kua" && hdcid !== "club") return;   // [v4.6.4] +仙盟频道
    const str = params.str;
    if (!str) return;
    const puuid = params.uuid;
    let chId = null;
    try {
        if (hdcid === "all") chId = "0";
        else if (hdcid === "hefu") {
            const list = Setting.getQufus();
            chId = (list && list[ctx.state.sid] && list[ctx.state.sid].heid) || "1";
        } else if (hdcid === "kua") {
            chId = String(await ctx.state.master.getChatKuaId(ctx.state.sid));
            kuaIdCache = chId;
        } else if (hdcid === "club") {
            // [v4.6.4] 仙盟频道：chId = 玩家所在盟 ID（与官方 /chat/send 的 clickClub 结果一致）
            const ACM = require("./src/model/act/ActClubModel").ActClubModel;
            chId = String((await ACM.getInstance(ctx, puuid).getInfo()).clubId || "");
        }
    } catch (e) { }
    if (chId === "") return;          // 无仙盟 → 不发回复
    if (chId == null) return;
    setTimeout(() => { scheduleReplies(str, hdcid, chId, puuid).catch(() => { }); }, 400 + Math.random() * 1200);
    // [v4.6.4] 求助快速响应：/chat/send 的 type=4/5（洞天/鼎炉求助卡片）→ 4~10 秒后让假人立刻来帮
    if ((params.type === "4" || params.type === "5") && hdcid === "club") {
        setTimeout(() => {
            try { require("./_solo_fakes3").nudgeHelp(chId).catch(() => { }); } catch (e) { }
        }, 4000 + Math.random() * 6000);
    }
    // [v4.6.10] "喊助力真来帮"：盟频道消息含助力关键词 → 60 秒节流 → 1.5~4 秒后 nudge
    //   （呼应假人回复话术"来了来了，已助力！"——以前只嘴上说，现在真的来帮）
    if (hdcid === "club" && /助力|帮忙|帮帮|求助|加速|帮下|帮一/.test(String(str))) {
        const tnow = Date.now();
        if (!onRequest._lastSeekNudge || tnow - onRequest._lastSeekNudge > 60000) {
            onRequest._lastSeekNudge = tnow;
            setTimeout(() => {
                try { require("./_solo_fakes3").nudgeHelp(chId).catch(() => { }); } catch (e) { }
            }, 1500 + Math.random() * 2500);
        }
    }
}
async function scheduleReplies(playerMsg, hdcid, chId, playerUuid) {
    if (chId == null) chId = hdcid === "all" ? "0" : "1";
    const map = await loadAll();
    let fakes = fakeList(map);
    // [v4.6.4] 仙盟频道：只让“该盟成员表里的假人”回复（同盟成员才像真盟友，不穿帮）
    if (hdcid === "club" && chId) {
        try {
            const M = require("./src/model/sev/SevClubMemberModel").SevClubMemberModel;
            const c2 = await tool.ctxCreate("user", "100003");
            const mi = await M.getInstance(c2, chId).getInfo();
            const us = Object.keys(mi.list || {}).filter((u) => { const n = parseInt(u); return n >= FAKE_MIN && n <= FAKE_MAX; });
            const sub = [];
            for (const u of us) {
                const f = fakes.find((x) => String(x.uuid) === u);
                sub.push(f || { uuid: u, name: "侠客" + String(u).slice(-3) });
            }
            if (sub.length > 0) fakes = sub;
        } catch (e) { }
    }
    if (fakes.length === 0) return;
    const me = (playerUuid && map[String(playerUuid)] && map[String(playerUuid)].userInfo && map[String(playerUuid)].userInfo.name) || "";
    const n = 1 + Math.floor(Math.random() * 3);      // 1~3 条
    for (let i = 0; i < n; i++) {
        const f = fakes[Math.floor(Math.random() * fakes.length)];
        const delay = 800 + i * (1200 + Math.random() * 2500) + Math.random() * 1500;
        setTimeout(async () => {
            let text = null;
            try { text = await aiReply({ name: f.name, player: me, msg: playerMsg }); } catch (e) { }
            if (!text) text = pickReply(playerMsg, me, f.name, Math.random);
            let fu1 = null; try { fu1 = await fakeFuserFull(f.uuid); } catch (e) { }
            try { await writeChatLine(chId, hdcid, fu1 || fakeFuser(f.uuid, f.name), text); } catch (e) { }
        }, delay);
    }
}

// —— 跨服频道（kua）种子：让跨服聊天不是空的 ——
const KUA_LINES = [
    "跨服的大佬们，轻点打…", "这服排行第几了？", "求带一趟六道秘境", "跨服BOSS什么时候开？",
    "刚来这个服，人还挺多", "有没有跨服群，拉我一个", "跨服斗法赢了，嘿嘿", "低调低调，别被大佬盯上",
];
async function seedKuaChat() {
    const kuaId = await getKuaId();
    if (kuaId == null) {
        console.error("[solo-fakes2] 跨服种子：拿不到跨服ID，跳过");
        return;
    }
    const data = await readChat(String(kuaId), "kua");
    // 已有多少条"假人"发言（uuid 2000xx）——不足 4 条就补语料
    let fakeCnt = 0;
    for (const k in (data.list || {})) {
        const uu = String((data.list[k].user || {}).uuid || "");
        if (uu.startsWith("20")) fakeCnt++;
    }
    if (fakeCnt >= 4) return;
    if ((Number(data.id) || 0) > 60) return;
    const map = await loadAll();
    const fakes = fakeList(map);
    if (fakes.length === 0) return;
    for (let i = 0; i < KUA_LINES.length; i++) {
        const f = fakes[i % fakes.length];
        data.id = (Number(data.id) || 0) + 1;
        let fuK = null; try { fuK = await fakeFuserFull(f.uuid); } catch (e) { }
        data.list[data.id] = { id: data.id, type: "1", user: fuK || fakeFuser(f.uuid, f.name), msg: KUA_LINES[i], time: game.getNowTime() - (KUA_LINES.length - i) * 83 };
    }
    await writeChat(String(kuaId), "kua", data);
    console.log("[solo-fakes2] 跨服频道种子 " + KUA_LINES.length + " 条");
}

// ==================== 入口 ====================
let _timer = null;
async function init() {
    try { await getKuaId(); } catch (e) { }
    try { await seedKuaChat(); } catch (e) { console.error("[solo-fakes2] 跨服种子异常 " + ((e && e.message) || e)); }
    installJjcPatch();   // v3.4：列表/排行/战斗 NPC 档案统一（幂等，启动即生效）
    try {
        const r0 = await growTick();
        console.log("[solo-fakes2] 初始成长: " + (r0.report[0] || "") + " | " + (r0.report[r0.report.length - 1] || ""));
    } catch (e) { console.error("[solo-fakes2] 初始成长异常 " + ((e && e.stack) || e)); }
    // M4-1：跑马灯播报（启动即塞 2 条，之后定时）
    try { await paomaTick(); await paomaTick(); } catch (e) { }
    if (_pmTimer == null) {
        _pmTimer = setInterval(() => { paomaTick().catch(() => { }); }, PAOMA_MS);
        try { _pmTimer.unref && _pmTimer.unref(); } catch (e) { }
    }
    if (_timer == null && GROW_MS > 0) {
        _timer = setInterval(() => { growTick().catch(() => { }); }, GROW_MS);
        try { _timer.unref && _timer.unref(); } catch (e) { }
    }
    return true;
}

// ==================== ⑦ 跑马灯假人播报（M4-1） ====================
// 每 2 分钟往跑马灯塞一条“假人”事件（竞技场排名/符石升级/斗罗超越），营造大服活跃感。
// 模板来自官方：pmid 4=[名字,名次] 竞技场；pmid 3=[名字,等级] 符石；pmid 5=[我,对方,名次] 斗罗。
let _pmTimer = null;
const PAOMA_MS = Math.max(60000, parseInt(process.env.SOLO_PAOMA_MS || "120000", 10) || 120000);
async function paomaTick() {
    try {
        const st = loadState();
        const names = st.paomaNames || [];
        if (!names.length) return;
        const pick = () => names[Math.floor(Math.random() * names.length)];
        const ctxU = await tool.ctxCreate("user", st.anchorUuid || "100003");
        const SevPaoMaModel_1 = require("./src/model/sev/SevPaoMaModel");
        const pm = SevPaoMaModel_1.SevPaoMaModel.getInstance(ctxU, "1");
        const A = pick();
        // [v4.6.13] 8 类播报全覆盖（客户端 pmid 1~8）：
        //   1器鼎升级 / 2器鼎锻造 / 3鱼塘升级 / 4斗法榜(真实名次) / 5斗罗超越(真实名次) / 6月卡 / 7终身卡 / 8垂钓卡
        const roll = Math.random();
        if (roll < 0.16) {
            const PIN = ["凡品", "下品", "中品", "上品", "极品", "仙品", "传奇"];
            await pm.addList("1", [A.name, String(14 + Math.floor(Math.random() * 7)), PIN[Math.floor(Math.random() * PIN.length)]]);
        } else if (roll < 0.30) {
            await pm.addList("2", [A.name, String(6 + Math.floor(Math.random() * 7)), String(3 + Math.floor(Math.random() * 5))]);
        } else if (roll < 0.44) {
            await pm.addList("3", [A.name, String(3 + Math.floor(Math.random() * 9))]);
        } else if (roll < 0.64) {
            let rank4 = 2 + ((parseInt(String(A.uuid).slice(-3), 10) || 7) % 60);
            try {
                const mJ = new RdsUserModel_1.RdsUserModel("rdsJjc", "x", "1", String(tool.jjcWeekId(game.getNowTime())));
                const rk = await mJ.zRevrank(A.uuid);
                if (rk != null && rk >= 0) rank4 = rk + 1;
            } catch (e) { }
            await pm.addList("4", [A.name, String(rank4)]);
        } else if (roll < 0.84) {
            let B = pick(), guard = 0;
            while (B.uuid === A.uuid && guard++ < 8) B = pick();
            let rank5 = 1 + ((parseInt(String(A.uuid).slice(-3), 10) || 7) % 494);
            try {
                const HdDouLuoModel_1 = require("./src/model/hd/HdDouLuoModel");
                const cfgDL = Setting.getHuodong2 ? Setting.getHuodong2("1", "hdDouLuo") : null;
                if (cfgDL) {
                    const hd = HdDouLuoModel_1.HdDouLuoModel.getInstance(ctxU, st.anchorUuid || "100003", "1");
                    const dlinfo = await hd.getBaseInfo();
                    if (dlinfo && dlinfo.ksid != null && dlinfo.weekId != null) {
                        const mD = new RdsUserModel_1.RdsUserModel("rdsDouLuo", "1", String(dlinfo.ksid), String(dlinfo.weekId));
                        const sc = await mD.zScore(A.uuid);
                        if (sc != null) rank5 = Math.max(1, Math.round(parseFloat(sc)));
                    }
                }
            } catch (e) { }
            await pm.addList("5", [A.name, B.name, String(rank5)]);
        } else if (roll < 0.90) {
            await pm.addList("6", [A.name]);
        } else if (roll < 0.95) {
            await pm.addList("7", [A.name]);
        } else {
            await pm.addList("8", [A.name]);
        }
        await ctxU.state.master.distroy();   // 官方落盘（写 db + redis）
    } catch (e) { }
}

// ==================== ⑤ 官方竞技场 NPC 完整档案（v3.3.2） ====================
// 让 uuid<100000 的 3500 个官方机器人也能点开“有血有肉”的个人信息（十图标/装备/角色形象）
function wrapAll(m, equip, jjcScore) {
    return {
        actEquip: { a: equip },
        actChengH: m.actChengH,
        actChiBang: m.actChiBang,
        actFazhen: m.actFazhen,
        rdsJjcMy: { rid: 0, score: jjcScore },
        actShengQi: { a: m.actShengQi },
        actBaoShi: m.actBaoShi,
        actFuShi: { a: m.actFuShi },
        actDongTian: null,
        actClubMj: null,
        actJinxiu: m.actJinxiu,
        actWanXiang: m.actWanXiang,
        actJingGuai: m.actJingGuai,
        actXianlv: m.actXianlv,
        rdsDouLuoMy: { "1": { rid: 501, score: 0 } },
    };
}
// [v4.64] “详情页”虚拟玩家号：展示 uuid = DL_VUUID_BASE + jjcNpc 池 id
//   客户端 UIHdDouLuoItem.onUserBtnTouch() 有 `if (!gameMethod.isNpc(itemData.uuid))` 门槛
//   （客户端 isNpc = `Number(uuid) < 10000`）⇒ 展示 uuid 若是池 id（1~3500）会被**静默吞掉**（点了没反应）。
//   故展示 uuid 统一取 50000+nid（≥10000 过客户端门槛，且 <100000 仍走 lookFuuidAll 的“机器人”分支），
//   再由 npcFuser 反解回池 id ⇒ 列表 / 详情 / 战报 三处永远同一个人。
const DL_VUUID_BASE = 50000;
const _isVUuid = (v) => { const n = Number(v); return Number.isFinite(n) && n >= DL_VUUID_BASE && n < 100000; };
const dlVUuid = (nid) => String(DL_VUUID_BASE + (Math.max(1, Number(nid) || 1)));
function npcFuser(ctx, npcId) {
    try {
        // [v4.66] 斗罗（虚拟号 50000+n）的档案必须按【斗罗池 douLuoNpc】建，与战斗同一份数据。
        //   病根：面板/详情走 jjcNpc（竞技场机器人池）、战斗走 douLuoNpc —— 两张表同号不同内容，
        //   于是「详情页写雷震子、打起来是昊天上帝」（实测 id=1：详情 雷震子19 / 战斗 昊天上帝46）。
        let _isDL = false;
        if (_isVUuid(npcId)) { _isDL = true; npcId = String(Number(npcId) - DL_VUUID_BASE); }   // [v4.64] 虚拟号反解
        const id = String(npcId);
        const cfg = (_gcfg.jjcNpc && _gcfg.jjcNpc.getItem) ? _gcfg.jjcNpc.getItem(id) : null;
        // [v4.66] 斗罗池那一行：档位/仙侣/剑灵/守灵 都按它（= 战斗读的那份）
        const cfgDL = (_isDL && _gcfg.douLuoNpc && _gcfg.douLuoNpc.getItem) ? _gcfg.douLuoNpc.getItem(id) : null;
        const _cfgSrc = (cfgDL != null) ? cfgDL : cfg;          // 斗罗优先（缺则回退竞技场池）
        if (_cfgSrc == null) return null;
        const _numId = Math.max(1, Number(_cfgSrc.id != null ? _cfgSrc.id : id) || 1);
        // 斗罗档位与 douLuoNpcBoost 同口径（1 - (id-1)/499）⇒ buildModules 出来的 M2 与战斗同源（仙侣自然一致）
        const tier = (_isDL) ? clamp01(1 - (_numId - 1) / 499) : clamp01((Number(cfg.score || 1500) - 1500) / 1400);
        const seed = ((Number(id) || 1) * 2654435761) % 2147483647;
        const idx = (Number(id) || 0) % FAKE_HEADS.length;
        const _tt = 0.18 + tier * 0.85;
        // [v4.65] 目标战力改调 npcRelByScore（原来内联复制了一份 1.00 系数 → 两处容易走偏）
        //   斗罗没有 score 字段 → 把斗罗档位映射回同一梯度（档位 1 ⇒ 2900 分 ⇒ 1.25×锚点）
        const _targetNpc = _ANCHOR_POW * npcRelByScore(_isDL ? (1500 + tier * 1400) : cfg.score);   // 0.80× ~ 1.25×锚点
        // [v4.49] 万相功率预算：WX_SHARE=0.30（万相贡献 ≤ 目标 30%）——否则 FIXED>target → k 触底 → 战力被顶穿
        let M2 = buildModules(seed, idx, _tt);
        try {
            const _scWx = wxBudgetScale(M2, _targetNpc);
            if (_scWx < 1) M2 = buildModules(seed, idx, _tt, _scWx);
        } catch (e) { }
        // 剑灵按原配置（jianling = [hh, wingId]）——[v4.66] 斗罗用斗罗池的剑灵
        const jl = (_cfgSrc.jianling && _cfgSrc.jianling.length >= 2) ? _cfgSrc.jianling : [1, 1];
        const hh0 = String(jl[0]);
        M2.actChiBang = { id: Math.max(1, Math.min(2036, Number(jl[1]) || 1)), exp: 0, hh: hh0, hhList: [hh0], tsNum: 0, cleps: { hsjiyun: 0, hsshanbi: 0, hslianji: 0, hsfanji: 0, hsbaoji: 0, hsxixue: 0 } };
        // 守灵优先用配置的 shouling = [fzid, saveId]
        if (Array.isArray(_cfgSrc.shouling) && _cfgSrc.shouling.length >= 2) {
            M2.actFazhen.list["1"] = Object.assign({}, M2.actFazhen.list["1"] || {}, { fzid: String(_cfgSrc.shouling[0]), saveId: Number(_cfgSrc.shouling[1]) || 1 });
        }
        // v4.23c：装备系数按【锚点玩家战力 × score 梯度】反解
        //  旧状固定 0.6+tier*2.2 → NPC 战力与玩家脱钩（玩家变强后 NPC 不变）
        let _kk = 0.6 + tier * 2.2;
        try {
            const _target = _targetNpc;        // [v4.49] 改用上文已算好的目标（同一口径）
            const _wBase = { id: 1, exp: 0, hh: "1", hhList: ["1"], tsNum: 0, cleps: {} };
            const _FIXED = power(Object.assign({}, M2, { actChiBang: _wBase }));
            const _EQ1 = Math.max(1, power(Object.assign({ actEquip: buildEquip(_TPL_EQUIP, 1, function () { return 0.5; }, seed) }, M2, { actChiBang: _wBase })) - _FIXED);
            _kk = Math.max(0.004, Math.min(280, (_target - _FIXED) / _EQ1));
        } catch (e) { }
        const equip = buildEquip(_TPL_EQUIP, _kk, mulberry32(seed + 7), seed);
        // ★ v4.23：把「战斗属性 / 技能」回写到配置对象（getItemCtx 是池内引用 → 改完即时生效）
        //   否则战斗读到的仍是裸 eps（虚低 1.4~1.7 倍）且 wxSk/jgSk 恒空 → 玩家一刀砍死
        try {
            const cfgRef = (!_isDL && _gcfg.jjcNpc.getItemCtx) ? _gcfg.jjcNpc.getItemCtx(ctx, id) : null;   // [v4.23e] 本文件配置入口是 _gcfg
            // [v4.66] 斗罗分支不回写配置：斗罗池那行（含 soloXlEps 每跳定标）由 douLuoNpcBoost 独占，互相写会踩掉
            if (cfgRef != null) {
                const gameMethod = require("./common/gameMethod").gameMethod;
                const sbTmp = wrapAll(M2, equip, Number(cfg.score || 1500));
                cfgRef.eps = gameMethod.ep_fight(sbTmp);
                bolsterPer(cfgRef.eps, npcRelByScore(cfg.score));   // v4.26：per 类按 score 梯度对齐
                cfgRef.soloWxSk = buildWxSk(ctx, M2.actWanXiang);
                cfgRef.soloJgSk = buildJgSk(ctx, M2.actJingGuai);
                cfgRef.soloIsNq = (M2.actWanXiang && M2.actWanXiang.mfZhan && M2.actWanXiang.mfZhan["1"]) ? 1 : 0;
                // [v4.36] 仙侣战斗数据（原来缺这段 → NPC 有仙侣模型但战斗里没属性）
                try {
                    const _xl = M2.actXianlv && M2.actXianlv.shangzhen ? M2.actXianlv.shangzhen : null;
                    cfgRef.soloXlid = _xl ? String(_xl.xlid || "") : "";
                    cfgRef.soloXlLv = _xl ? (Number(_xl.level) || 1) : 0;
                    cfgRef.soloXlZw = (_xl && _xl.xlid) ? xlZwOf(_xl.xlid) : 0;   // [v4.60] 前后排按仙侣配置
                    cfgRef.soloXlEps = gameMethod.ep_xianlv(sbTmp, "0");
                } catch (e) { }
            }
            // [v4.66] 斗罗分支：仙侣显式对齐【战斗用的那份】（douLuoNpcBoost 写的 soloXlid/soloXlLv/soloXlZw）
            //   M2 同源时本来就一致，这里再兜一层，保证「详情页仙侣 == 战斗里出场的仙侣」
            if (_isDL && cfgDL != null && M2.actXianlv && M2.actXianlv.shangzhen) {
                const _xr = String(cfgDL.soloXlid || M2.actXianlv.shangzhen.xlid || "");
                if (_xr !== "") {
                    M2.actXianlv.shangzhen.xlid = _xr;
                    M2.actXianlv.shangzhen.level = Number(cfgDL.soloXlLv || M2.actXianlv.shangzhen.level || 1) || 1;
                    const _zw = Number(cfgDL.soloXlZw || xlZwOf(_xr) || 0);
                    if (_zw > 0) M2.actXianlv.shangzhen.zhanwei = _zw;
                }
            }
        } catch (e) { }
        return {
            uid: id, uuid: id, sid: (ctx && ctx.state ? ctx.state.sid : "1"),
            name: (cfg ? cfg.name : _cfgSrc.name), sex: (Number(id) % 2), head: FAKE_HEADS[idx],
            wxhead: "", tzid: "", level: (cfg ? cfg.level : _cfgSrc.level),
            lastlogin: (ctx && ctx.state ? ctx.state.newTime : 0),
            clubName: "", chid: M2.actChengH.chuan, cbid: hh0,
            sevBack: wrapAll(M2, equip, (cfg ? Number(cfg.score || 1500) : 1500)),
        };
    } catch (e) { return null; }
}
// ==================== ⑦ [v4.58] 罗浮仙域「全服成就」名单：请求路径即时补齐 ====================
// 症状：玩家打到 20 层以后，成就里的"5 名玩家"人数【时有时无】。
// 机制：sevCjRwd(id)/getCj5(id) 要求 sevLiuDao.cj[id].length >= 5（该层要有 5 名玩家进榜）。
//   ① growTick 的 §3.3b 每跳会把假人补进名单（直写 DB + 刷 redis）；
//   ② 但玩家突破新层时走官方 ActLiuDaoModel.fight_one → SevLiuDaoModel.addFuuid：
//      它拿【玩家请求 ctx 的缓存快照】读 sevLiuDao 再【整行写回】⇒ 把 §3.3b 补的假人条目覆盖掉；
//   ③ 两条写入路径互相覆盖 ⇒ “有时有有时没有”。
// 修法：在 getCj5 / sevCjRwd 入口即时补齐 —— 用官方 SevLiuDaoModel.update()
//   （与官方保存同批落盘，不另开写盘路径 ⇒ 无竞争）。
//  安全阀：只补"玩家已通关的层"（maxId >= lv）+ 每层补到 5 人即停。
async function liudaoEnsureCj(model, id) {
    try {
        const lv = Number(id) || 0;
        if (!(lv > 0)) return 0;
        const self = await model.getInfo();
        if (Number(self.maxId || 0) < lv) return 0;
        const SLD = require("./src/model/sev/SevLiuDaoModel").SevLiuDaoModel;
        const heid = await model.getHeIdByUuid(model.id);
        const sm = SLD.getInstance(model.ctx, heid);
        const sInfo = await sm.getInfo();
        sInfo.cj = sInfo.cj || {};
        const cur = sInfo.cj[lv] = sInfo.cj[lv] || [];
        if (cur.length >= 5) return 0;
        const st = loadState();
        const cand = [];
        for (const u in (st.liudao || {})) {
            const L6 = (st.liudao[u] || {}).layer || 0;
            if (L6 >= lv) cand.push({ u: u, layer: L6 });
        }
        cand.sort((a, b) => b.layer - a.layer);
        let add = 0;
        const added = [];
        for (let k = 0; k < cand.length && cur.length < 5; k++) {
            if (cur.indexOf(cand[k].u) >= 0) continue;
            cur.push(cand[k].u);
            added.push(cand[k]);
            add++;
        }
        if (add > 0) await sm.update(sInfo);
        // 顺手给刚进榜的假人补 actLiuDao 记录（否则成就界面里他们的层数显示 0）——已有则跳过
        if (added.length) {
            try {
                const db2 = require("./src/util/mongodb").dbSev.getDataDb();
                const have = {};
                const rows = await db2.find("act", { kid: "actLiuDao" });
                for (const r2 of (rows || [])) have[String(r2.id)] = 1;
                for (const c of added) {
                    if (have[String(c.u)]) continue;
                    await writeModule(String(c.u), "act", "actLiuDao", {
                        time: 0, maxId: c.layer, sevRwd: [], actRwd: [], nowId: c.layer,
                        start: { from: "", seed: 0, teams: {} }, end: { win: 0, items: [] }, itemLock: {}
                    });
                    have[String(c.u)] = 1;
                }
            } catch (e2) { }
        }
        return add;
    } catch (e) { return 0; }
}
function installLiuDaoPatch() {
    try {
        const M = require("./src/model/act/ActLiuDaoModel").ActLiuDaoModel;
        if (!M || M.prototype.__soloCjEnsure) return;
        const o5 = M.prototype.getCj5;
        M.prototype.getCj5 = async function (id) {
            try { await liudaoEnsureCj(this, id); } catch (e) { }
            return o5.call(this, id);
        };
        const oR = M.prototype.sevCjRwd;
        M.prototype.sevCjRwd = async function (id) {
            try { await liudaoEnsureCj(this, id); } catch (e) { }
            return oR.call(this, id);
        };
        M.prototype.__soloCjEnsure = 1;
    } catch (e) { }
}
function installNpcPatch() {
    try {
        const UM = require("./src/model/user/UserModel").UserModel;
        if (UM && !UM.prototype.__soloNpcAll) {
            const orig = UM.prototype.getFUserAll;
            UM.prototype.getFUserAll = async function (realId) {
                const rid = (realId == null ? this.id : realId);
                if (rid != null && parseInt(rid) < 100000) {
                    try { const f = npcFuser(this.ctx, rid); if (f != null) return f; } catch (e) { }
                }
                return orig.call(this, realId);
            };
            UM.prototype.__soloNpcAll = 1;
        }
        // ★ v4.23：NPC 的 getFightEps —— 旧状对 NPC 返回空档案（洞天/龙宫/斗罗里 NPC 变纸糊）
        if (UM && !UM.prototype.__soloNpcFeps) {
            const origFeps = UM.prototype.getFightEps;
            UM.prototype.getFightEps = async function (isPvp) {
                const rid = (this.id == null ? "" : String(this.id));
                if (rid !== "" && parseInt(rid) < 100000) {
                    try { const r = await fakeNpcFightEps(this.ctx, rid); if (r != null) return r; } catch (e) { }
                }
                const r0 = await origFeps.call(this, isPvp);
                // v4.26：假人（200001~200200）也按自身战力比补齐 per 类
                try {
                    if (/^20\d{4}$/.test(rid) && r0 && r0.eps) bolsterPer(r0.eps, fakeRelByUuid(rid));
                } catch (e) { }
                return r0;
            };
            UM.prototype.__soloNpcFeps = 1;
        }
    } catch (e) { }
}

// ==================== ⑥ 列表 / 排行榜 / 战斗的 NPC 档案统一（v3.4） ====================
// 症状：竞技场对手列表/排行榜/战斗里，NPC 的“外面”（头像/称号/战力）还是官方原样，
//       点开详情才正常；有时刷新后看起来又不一致（混合态）。
// 原因：官方在 get5 / RdsUserModel.getInfo(rdsJjc) / fight_one 里手拼“残缺 fuser”：
//       head:""、chid:"1"、sevBack 只有剑灵+法阵；且详情入口 fuuid 可能指向随机真人。
// 方案：运行时挂钩这三处，把 NPC 条目替换为 npcFuser 的完整档案，
//       同时保留榜单分(score)/名次(rid)/保护时间(bhAt) 等展示态字段；详情 fuuid 统一为自身。
let _nfCache = new Map();   // npcId -> { t, data }（60s 内存缓存，避免榜单循环里重复构建）
async function npcFuserCached(ctx, npcId) {
    const key = String(npcId);
    const now = Date.now();
    const hit = _nfCache.get(key);
    if (hit && now - hit.t < 60000) return hit.data;
    const nf = npcFuser(ctx, key);
    if (_nfCache.size > 256) _nfCache.clear();
    _nfCache.set(key, { t: now, data: nf });
    return nf;
}
const _NPC_MERGE_KEYS = ["uuid", "sid", "name", "sex", "head", "wxhead", "tzid", "level", "lastlogin", "clubName", "chid", "cbid", "sevBack"];
function mergeNpcFuser(entry, nf) {
    if (entry == null || nf == null) return entry;
    for (const k of _NPC_MERGE_KEYS) { if (nf[k] !== undefined) entry[k] = nf[k]; }
    return entry;
}
function installJjcPatch() {
    // ① 排行榜条目（rdsJjc 榜：/jjc/into、rank 页）
    try {
        const RdsUserModel_1 = require("./src/model/redis/RdsUserModel");
        const P = RdsUserModel_1.RdsUserModel && RdsUserModel_1.RdsUserModel.prototype;
        if (P && !P.__soloJjcList) {
            const origGetInfo = P.getInfo;
            P.getInfo = async function (ctx, fuuid, rid, score) {
                // [v4.53] 脏数据防护：斗法榜历史遗留的"非整数成员"（如 1499.999319）会被官方
                //   RdsUserModel.getInfo 直接当作 jjcNpc 表 key → ctx.throw("配置错误…")
                //   → /player/loginPlayer 500 → 客户端只弹错误框、主界面黑屏（有声音）。
                //   这里只对"纯数字形态"的值取整，真人 uuid / 其它值原样透传。
                if (fuuid != null && fuuid !== "" && !isNaN(Number(fuuid)) && !Number.isInteger(Number(fuuid))) {
                    fuuid = String(Math.round(Number(fuuid)));
                }
                const out = await origGetInfo.call(this, ctx, fuuid, rid, score);
                try {
                    if (out && this.kid === "rdsJjc" && parseInt(fuuid) < 100000) {
                        const nf = await npcFuserCached(ctx, fuuid);
                        mergeNpcFuser(out, nf);
                    }
                    else if (out && this.kid === "rdsDouLuo" && parseInt(out.uuid) < 100000) {
                        // v3.5.3：NPC 展示身份统一按【名次 rid】映射到 jjcNpc 池。
                        //   原因：官方“列表取值”与“战斗取值”是两套函数（getRankBetween / getMemberByRid），
                        //   同一名次可能取到不同成员 → 按成员 uuid 映射会让“列表看到的人”与“结算打的人”不是同一人。
                        //   按名次映射后，列表/结算/战报/详情四处永远同一个人。
                        // [v4.66] 名次 → 【斗罗池】id（战斗读的就是 douLuoNpc），并以虚拟号请求 ⇒ npcFuser 走斗罗分支
                        const N = (_gcfg.douLuoNpc && _gcfg.douLuoNpc.pool) ? Math.max(1, Object.keys(_gcfg.douLuoNpc.pool).length) : 500;
                        const nid = (rid != null && Number(rid) > 0)
                            ? ((Number(rid) - 1) % N) + 1
                            : ((Math.max(1, Number(out.uuid)) - 1) % N) + 1;
                        const nf = await npcFuserCached(ctx, dlVUuid(nid));
                        mergeNpcFuser(out, nf);
                        // [v4.64] 展示 uuid 用虚拟玩家号（≥10000）→ 客户端详情页按钮才不吞点击
                        out.uuid = dlVUuid(nid);
                    }
                } catch (e) { }
                return out;
            };
            P.__soloJjcList = 1;
        }
    } catch (e) { }
    // ② 对手列表（/jjc/get5 → actJjcInfo.get5）
    try {
        const ActJjcInfoModel_1 = require("./src/model/act/ActJjcInfoModel");
        const Q = ActJjcInfoModel_1.ActJjcInfoModel && ActJjcInfoModel_1.ActJjcInfoModel.prototype;
        if (Q && !Q.__soloJjcGet5) {
            const origGet5 = Q.get5;
            Q.get5 = async function () {
                const r = await origGet5.call(this);
                try {
                    const info = await this.getInfo();
                    let changed = false;
                    for (const k in (info.get5 || {})) {
                        const e = info.get5[k];
                        if (e && parseInt(k) < 100000) {
                            const nf = await npcFuserCached(this.ctx, k);
                            mergeNpcFuser(e, nf);
                            e.fuuid = k;              // 详情入口统一为自身（原来可能指向随机真人）
                            changed = true;
                        }
                    }
                    if (changed) await this.update(info);   // 覆盖缓冲，最终下发完整档案
                } catch (e) { }
                return r;
            };
            Q.__soloJjcGet5 = 1;
        }
    } catch (e) { }
    // ③ 战斗中的对手展示（fight_one 的 info.fuserAll）
    try {
        const ActJjcFightModel_1 = require("./src/model/act/ActJjcFightModel");
        const F = ActJjcFightModel_1.ActJjcFightModel && ActJjcFightModel_1.ActJjcFightModel.prototype;
        if (F && !F.__soloJjcFight) {
            const origFight = F.fight_one;
            F.fight_one = async function (fuuid, type) {
                const r = await origFight.call(this, fuuid, type);   // 返回胜负数字（不是 info）
                try {
                    if (parseInt(fuuid) < 100000) {
                        const info = await this.getInfo();           // fight_one 内部同一引用
                        if (info && info.fuserAll) {
                            const nf = await npcFuserCached(this.ctx, fuuid);
                            mergeNpcFuser(info.fuserAll, nf);
                            await this.update(info);                 // 覆盖缓冲，下发完整档案
                        }
                    }
                } catch (e) { }
                return r;
            };
            F.__soloJjcFight = 1;
        }
    } catch (e) { }
    // ④ 斗罗战斗（ActDouLuoFightModel.fight_one）
    // v3.5.1：“结算页还是斗罗守卫”根因——对手 NPC 不一定走 rid≥495：
    //   rid<495 时 fuuid = 榜上第 rid 名成员，榜上被塞的是 NPC uuid（<100000）时同样走 NPC 分支。
    //   所以判定改为看实际对手 uuid（info.fuserAll.uuid），而不是看 rid。
    try {
        const ActDouLuoFightModel_1 = require("./src/model/act/ActDouLuoFightModel");
        const D = ActDouLuoFightModel_1.ActDouLuoFightModel && ActDouLuoFightModel_1.ActDouLuoFightModel.prototype;
        if (D && !D.__soloDouLuoFight) {
            const origD = D.fight_one;
            D.fight_one = async function (hdcid, rid) {
                const r = await origD.call(this, hdcid, rid);
                try {
                    const info = await this.getInfo();          // fight_one 内部 info 的同一引用
                    const fu = info && info.fuserAll ? String(info.fuserAll.uuid) : "";
                    if (fu && parseInt(fu) < 100000) {          // NPC 对手（含榜上 NPC 成员）
                        // [v4.66] 同上：斗罗池 + 虚拟号（原走 jjcNpc ⇒ 结算页对手与战斗里的人不是同一个）
                        const N = (_gcfg.douLuoNpc && _gcfg.douLuoNpc.pool) ? Math.max(1, Object.keys(_gcfg.douLuoNpc.pool).length) : 500;
                        const nid = (rid != null && Number(rid) > 0)
                            ? ((Number(rid) - 1) % N) + 1
                            : ((Math.max(1, Number(fu)) - 1) % N) + 1;   // v3.5.3：按名次映射（与列表口径一致）
                        const nf = await npcFuserCached(this.ctx, dlVUuid(nid));
                        mergeNpcFuser(info.fuserAll, nf);
                        // v3.6：战斗回放属性也与“斗法同一个人”一致（用 jjcNpc 缩放后 eps），
                        //   否则同一人：斗法里战力 X、斗罗里战力 Y（官方 douLuoNpc 原始 eps）→ 用户看着奇怪
                        try {
                            // [v4.27] 改同源：结算用的是 douLuoNpc 增强后的数据 → 播片也用同一份（原 v3.6 用 jjcNpc 池数据，回放与结果不符）
                            const _fu2 = String((info.fuserAll && info.fuserAll.uuid) || "");
                            const jc = (_gcfg.douLuoNpc && _gcfg.douLuoNpc.getItemCtx) ? _gcfg.douLuoNpc.getItemCtx(this.ctx, _fu2) : null;
                            if (jc && jc.eps && info.start && info.start.teams && info.start.teams["20"]) {
                                info.start.teams["20"].eps = gm.ep_merge(gm.ep_init(), jc.eps);
                                // v4.24：技能也要与档案同源（否则斗罗对手"属性够格但没技能"）
                                info.start.teams["20"].wxSk = jc.soloWxSk || {};
                                info.start.teams["20"].isnq = jc.soloIsNq || 0;
                                info.start.teams["20"].jgSk = jc.soloJgSk || {};
                            }
                        } catch (e) { }
                        await this.update(info);                // 覆盖缓冲，下发完整档案
                    }
                } catch (e) { }
                return r;
            };
            D.__soloDouLuoFight = 1;
        }
    } catch (e) { }
    // ⑤ 斗罗战报日志（HdDouLuoLogModel.addLog 收到的是 objCopy 后的 log，需在存储前替换对手 user）
    try {
        const HdDouLuoLogModel_1 = require("./src/model/hd/HdDouLuoLogModel");
        const L = HdDouLuoLogModel_1.HdDouLuoLogModel && HdDouLuoLogModel_1.HdDouLuoLogModel.prototype;
        if (L && !L.__soloDouLuoLog) {
            const origAdd = L.addLog;
            L.addLog = async function (log) {
                try {
                    if (log && Array.isArray(log.users)) {
                        // [v4.66] 同上：斗罗池 + 虚拟号（战报里的对手 = 打的那个人）
                        const N = (_gcfg.douLuoNpc && _gcfg.douLuoNpc.pool) ? Math.max(1, Object.keys(_gcfg.douLuoNpc.pool).length) : 500;
                        for (const u of log.users) {
                            const uu = u && u.user && u.user.uuid;
                            if (uu != null && parseInt(uu) < 100000) {
                                const nid = (u.rid != null && Number(u.rid) > 0)
                                    ? ((Number(u.rid) - 1) % N) + 1
                                    : ((Math.max(1, Number(uu)) - 1) % N) + 1;   // v3.5.3：按名次映射（与列表口径一致）
                                const nf = await npcFuserCached(this.ctx, dlVUuid(nid));
                                mergeNpcFuser(u.user, nf);
                            }
                        }
                    }
                } catch (e) { }
                return origAdd.call(this, log);
            };
            L.__soloDouLuoLog = 1;
        }
    } catch (e) { }
    // ⑥ [v4.64] 虚拟玩家号的档案（cache.getFUser）
    //   官方 HdDouLuoModel.getOutPut_outf() 里 `isNpc(fuser.uuid) != true` 时会
    //   `cache.getFUser(fuser.uuid)` 取真人档案 —— 50001 这种号并不存在 ⇒ sevBack 被取空/取脏
    //   （卡片立绘、战力直接塌掉）。这里拦回机器人档案，与列表 merge 的那份完全一致。
    try {
        const cacheMod = require("./src/util/cache");
        const C = (cacheMod && cacheMod.__esModule && cacheMod.default !== undefined) ? cacheMod.default : cacheMod;
        if (C && C.getFUser && !C.__soloVUuid) {
            const origCacheGetFUser = C.getFUser;
            C.getFUser = async function (ctx2, fuuid, jianyi) {
                try {
                    if (_isVUuid(fuuid)) {
                        const nf = await npcFuserCached(ctx2, fuuid);
                        if (nf != null) {
                            const c = JSON.parse(JSON.stringify(nf));
                            if (jianyi == 1) c.sevBack = {};
                            return c;
                        }
                    }
                } catch (e) { }
                return await origCacheGetFUser.call(this, ctx2, fuuid, jianyi);
            };
            C.__soloVUuid = 1;
        }
    } catch (e) { }
}

module.exports = { init, growTick, onRequest, douLuoNpcBoost, douLuoNpcBoostAll, writeChatLine, writeChat, readChat, getKuaId, scheduleReplies, syncJjcNpc, FACTORS, FAKE_CAP, npcFuser, installJjcPatch, npcFuserCached, paomaTick, hdRankTick, HD_RANK_DEFS, fakeFuserFull, fakeFuserSev, aiReply, pickReply };

// ==================== CLI（headless 自检） ====================
if (require.main === module) {
    if (process.argv[2]) process.env.SOLO_DB_DIR = process.argv[2];
    (async () => {
        await mongodb_1.dbSev.init();
        try { await redis_1.redisSev.init(); } catch (e) { console.log("redis init: " + e.message); }
        try { _def(require("./common/gameCfg")).init(); } catch (e) { console.log("cfg init: " + e.message); }
        try {
            const nowT = game.getNowTime();
            await _def(require("./src/crontab/setting")).createCash(game.getToDay_0(nowT), nowT, false);
        } catch (e) { console.log("setting init: " + e.message); }
        const seedIdx = process.argv.indexOf("--seed-kua");
        if (seedIdx >= 0) {
            await getKuaId();
            await seedKuaChat();
            try { mongodb_1.dbSev.flushSync(); } catch (e) { }
            process.exit(0);
        }
        const sendIdx = process.argv.indexOf("--chat-send");
        if (sendIdx >= 0) {
            const msg = process.argv[sendIdx + 1] || "有人在吗，一起打本";
            await scheduleReplies(msg, "all", "100003");
            await new Promise((r) => setTimeout(r, 9000));
            const db = mongodb_1.dbSev.getDataDb();
            const cur = await db.findOne("chat", { id: "0", kid: "chat", hdcid: "all" });
            const list = (cur && cur.data && cur.data.list) || {};
            const ids = Object.keys(list).sort((a, b) => Number(a) - Number(b)).slice(-5);
            ids.forEach((i) => console.log("CHAT " + i + ": " + list[i].user.name + " -> " + list[i].msg));
            process.exit(0);
        }
        const chatIdx = process.argv.indexOf("--chat");
        if (chatIdx >= 0) {
            const msg = process.argv[chatIdx + 1] || "有人吗";
            const saved = process.env.SOLO_FAKE_AI_DRY;
            for (let i = 0; i < 3; i++) {
                console.log("REPLY " + i + ": " + pickReply(msg, "测试玩家", "假人", Math.random));
            }
            process.exit(0);
        }
        const lookIdx = process.argv.indexOf("--look");
        if (lookIdx >= 0) {
            const uuid2 = process.argv[lookIdx + 1] || "200001";
            try {
                const ctxU = await tool.ctxCreate("user", "100003");
                const UserModel_1 = require("./src/model/user/UserModel");
                const um = UserModel_1.UserModel.getInstance(ctxU, uuid2);
                const fuser = await um.getFUserAll(uuid2);
                const sb = fuser.sevBack || {};
                const someJg = sb.actJingGuai != null && (sb.actJingGuai.szList[sb.actJingGuai.szid] || []).some((x) => x !== "" && x != null);
                const someLm = sb.actWanXiang != null && Object.keys(sb.actWanXiang.mpList || {}).some((k) => sb.actWanXiang.mpList[k].lingmai !== "");
                const gate = {
                    wing: sb.actChiBang != null && sb.actChiBang.hh != "",
                    title: fuser.chid != "",
                    shengqi: sb.actShengQi != null && sb.actShengQi.a != null && sb.actShengQi.a.chuan !== "",
                    fazhen: sb.actFazhen != null && sb.actFazhen.list[sb.actFazhen.useGzId] != null && sb.actFazhen.list[sb.actFazhen.useGzId].fzid !== "",
                    baoshi: sb.actBaoShi != null && sb.actBaoShi.list != null && Object.keys(sb.actBaoShi.list).length > 0,
                    fushi: sb.actFuShi != null && sb.actFuShi.a != null && sb.actFuShi.a.fsku.level > 0,
                    xianlv: sb.actXianlv != null && sb.actXianlv.shangzhen.xlid !== "",
                    mingpan: someLm,
                    mifa: sb.actWanXiang != null && Object.keys(sb.actWanXiang.mfZhan || {}).length > 0,
                    jingguai: someJg,
                };
                const all = Object.keys(gate).every((kk) => gate[kk]);
                console.log("LOOK " + uuid2 + " name=" + fuser.name + " head=" + fuser.head + " chid=" + fuser.chid + " club=" + fuser.clubName + " level=" + fuser.level);
                console.log("GATES " + JSON.stringify(gate));
                console.log("ALL10 " + (all ? "PASS" : "FAIL"));
                try { const eps = await um.getFightEps(true); console.log("FEPSSU " + (eps != null && eps.eps != null ? "OK" : "EMPTY")); }
                catch (e2) { console.log("FEPSSU ERR " + e2.message); }
            } catch (e) { console.log("LOOK ERR " + ((e && e.stack) || e)); }
            process.exit(0);
        }
        const r = await growTick();
        console.log("=== growTick " + (r.ok ? "OK" : "失败") + " ===");
        r.report.forEach((x) => console.log("  " + x));
        try { mongodb_1.dbSev.flushSync(); } catch (e) { }
        process.exit(0);
    })().catch((e) => { console.error("CLI 异常:", (e && e.stack) || e); process.exit(1); });
}
