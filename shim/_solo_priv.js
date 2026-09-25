"use strict";
/**
 * [单机版特权 v4.18] _solo_priv.js
 * ------------------------------------------------------------------
 * 用户约定（2026-09-19）：
 *   1) 补齐「单机永远拿不到」的称号 —— 每次登录检查，幂等
 *      · 永久类（28 个）→ at: 0
 *        （v4.18 起含同名双版本的永久版：154/155/156/161/162/163/164/165/166/171
 *          —— 用户改主意「永久版也要」，v4.17 的"只留限时版"已回退）
 *      · 限时类（16 个，含九龙系列 501/502/503/504/505）→ 按配置 sxTime 计时
 *        过期后会被 ActChengHModel.getInfo() 清理 → 本次登录在这里**自动重补**（= 无限续期）
 *   2) 同名「永久版 + 限时版」**两版都要**
 *   3) 保留可正常获得的：1~10 阶梯晋升、175/176 龙宫
 */

const PRIV_FOREVER = [
    "151",
    "152",
    "153",
    "157",
    "158",
    "159",
    "160",
    "167",
    "168",
    "169",
    "170",
    "172",
    "173",
    "174",
    "154",
    "155",
    "156",
    "161",
    "162",
    "163",
    "164",
    "165",
    "166",
    "171",
    "177",
    "178",
    "10001",
    "10002"
];

const PRIV_TIMED = [
    "51",
    "101",
    "102",
    "501",
    "502",
    "503",
    "504",
    "505",
    "506",
    "601",
    "602",
    "603",
    "701",
    "702",
    "703",
    "704"
];

// v4.18：用户改主意「永久版也要」→ 不再移除；这 10 个的永久版已并入 PRIV_FOREVER 补齐
const REMOVE_PERM_DUP = [];

async function applyChengHao(ctx, uuid) {
    try {
        const ActChengHModel = require("./src/model/act/ActChengHModel").ActChengHModel;
        const cfg = require("./common/gameCfg").default.chenghaoInfo;
        const m = ActChengHModel.getInstance(ctx, uuid);
        const info = await m.getInfo();          // 注意：getInfo 会先清掉已过期的称号
        let dirty = false, add = 0, del = 0;

        // 1) 移除「只留限时版」对应的永久版
        for (const chid of REMOVE_PERM_DUP) {
            if (info.list[chid] != null) {
                delete info.list[chid];
                del++; dirty = true;
                if (info.chuan == chid) info.chuan = info.getId;
            }
        }
        // 2) 永久类补齐
        for (const chid of PRIV_FOREVER) {
            if (cfg.getItem(chid) == null) continue;
            if (info.list[chid] != null) continue;
            info.list[chid] = { red: 0, at: 0, gq: 0 };
            add++; dirty = true;
        }
        // 3) 限时类补齐（过期后下次登录自动重置）
        //    · 已有且仍有有效期 → 不动
        //    · 已有但是"永久"(at=0，v4.16 历史遗留) → 纠正为限时
        //    · 没有 → 新补（按 sxTime 计时）
        for (const chid of PRIV_TIMED) {
            const c = cfg.getItem(chid);
            if (c == null) continue;
            const days = Number(c.sxTime) || 0;
            const cur = info.list[chid];
            if (cur != null) {
                if (days > 0 && (cur.at === 0 || cur.at == null)) {
                    cur.at = ctx.state.newTime + days * 86400;
                    cur.gq = 0;
                    add++; dirty = true;
                }
                continue;
            }
            const at = days > 0 ? (ctx.state.newTime + days * 86400) : 0;
            info.list[chid] = { red: 0, at: at, gq: 0 };
            add++; dirty = true;
        }
        if (dirty) {
            await m.update(info);
            console.log("[solo-priv] 特权称号 " + uuid + "：补 " + add + " / 移除 " + del);
        }
        return { add: add, del: del };
    } catch (e) {
        console.error("[solo-priv] 异常 " + ((e && e.stack) || e));
        return { add: 0, del: 0 };
    }
}

module.exports = { applyChengHao: applyChengHao, PRIV_FOREVER: PRIV_FOREVER, PRIV_TIMED: PRIV_TIMED, REMOVE_PERM_DUP: REMOVE_PERM_DUP };
