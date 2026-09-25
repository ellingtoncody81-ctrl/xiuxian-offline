"use strict";
// ============================================================================
// v4.34：功能红点"已读标记"补齐（修"已解锁的东西又冒红点"）
// ----------------------------------------------------------------------------
// 机制（源码 TypeConst.ts + bundle 实证）：
//   checkGongNengJustOpenRed(t) = page.checkOpen(t) != 0 && (actRed == null || actRed[t] == null || actRed[t] == 1)
//   → 功能开放 && (缺 key || 值=1) 就显示"新功能"红点；
//   客户端打开对应界面会 sendGongNengOpen(t) 上报 {key:t, val:0} 清除。
// 问题：从没打开过界面的功能永远缺 key → 功能一开放就永久冒红点（"解锁了还冒"）。
// 修复：登录时把"常驻功能"缺的 key 补成 0（已读）；只补缺失，不覆盖已有值。
// ============================================================================
let _ActRedModel = null;
function _redModel() {
    if (_ActRedModel == null) {
        try { _ActRedModel = require("./src/model/act/ActRedModel").ActRedModel; } catch (e) { _ActRedModel = false; }
    }
    return _ActRedModel || null;
}

// TypeConst.OpenType 里挑出的"常驻功能"（不含 hd* 活动类：活动开放提示保留）
const PERM_KEYS = [
    "1201", "1600", "2400", "3100", "3200", "5000", "5200", "5201", "5800",
    "6000", "6100", "6150", "6200", "6300", "6400", "6401", "6420", "6600",
    "6700", "6800", "7000", "7200", "7201", "7202", "7203", "7250", "7300",
    "7350", "7351", "7400", "7500", "7600", "7700", "7800", "8000", "9000",
    "9001", "10000", "10001", "10002", "10003",
];

/**
 * 补齐功能红点已读标记（幂等；只补缺失键）
 * @returns {Promise<number>} 补齐数量（-1 失败）
 */
async function fixRed(ctx, uuid) {
    try {
        const M = _redModel();
        if (M == null) return -1;
        const m = M.getInstance(ctx, String(uuid));
        const info = await m.getInfo();
        let n = 0;
        for (let i = 0; i < PERM_KEYS.length; i++) {
            const k = PERM_KEYS[i];
            if (info[k] == null) { info[k] = 0; n++; }
        }
        if (n > 0) {
            await m.update(info);
            try { console.log("[solo-red] 功能红点标记补齐 " + n + " 项（uuid=" + uuid + "）"); } catch (e) { }
        }
        return n;
    } catch (e) {
        try { console.error("[solo-red] " + ((e && e.message) || e)); } catch (e2) { }
        return -1;
    }
}

module.exports = { fixRed, PERM_KEYS };
