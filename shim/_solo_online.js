"use strict";
/**
 * [单机版] 在线奖励：在线每 N 秒 +1 代金券（道具 id 8）
 * ------------------------------------------------------------------
 * 设计：不改任何业务代码，由 _solo_boot.js 的请求中间件在每个请求里调用 tick(ctx)。
 *   - 以「客户端每次请求携带的 uuid + token」标识一次在线会话；token 变了（重新登录/换号）= 新会话，重新计时
 *   - 按 会话时长 / 间隔 计算“应发次数”，与已发次数比对，补发差额（挂机也能补上，单次上限防呆）
 *   - 发奖走官方模型 ActItemModel.add()，因此会随 au 下发，客户端界面上的代金券数量会自己刷新
 *
 * 环境变量（都可选）：
 *   SOLO_ONLINE_GAP   间隔秒，默认 15
 *   SOLO_ONLINE_ITEM  道具 id，默认 8（代金券）
 *   SOLO_ONLINE_COUNT 每次给几个，默认 1
 *   SOLO_ONLINE_TIP   每累计多少次给一次飘字提示，默认 0（=静默发奖，不提示）；
 *                     想恢复提示就设成 4（每 60 秒提示一次）
 *   SOLO_ONLINE_MAX   单次补发上限（防长时间挂机一次刷爆），默认 240 次
 *
 * v2（2026-09-18）：默认 TIP=0 —— 提示会频繁弹窗影响游戏交互，按用户要求默认静默
 */
const tool_1 = require("./src/util/tool");
const _def = (m) => (m && m.__esModule && m.default !== undefined) ? m.default : m;
const ActItemModel = require("./src/model/act/ActItemModel").ActItemModel;
const tool = tool_1.tool;
const fs = require("fs");
const path = require("path");
const LOGF = path.join(__dirname, "_solo_online.log");
function LOG(msg) { try { fs.appendFileSync(LOGF, new Date().toISOString() + " " + msg + "\n"); } catch (e) { } }

function envInt(k, dft, min) {
    const v = parseInt(process.env[k] || "", 10);
    if (isNaN(v) || v < min) return dft;
    return v;
}

const GAP = envInt("SOLO_ONLINE_GAP", 15, 2);
const ITEM = envInt("SOLO_ONLINE_ITEM", 8, 1);
const COUNT = envInt("SOLO_ONLINE_COUNT", 1, 1);
const TIP = envInt("SOLO_ONLINE_TIP", 0, 0);
const MAX = envInt("SOLO_ONLINE_MAX", 240, 1);

const sess = Object.create(null);   // uuid -> { token, start, ev, tipEv }

async function tick(ctx) {
    const params = tool.getParams(ctx);
    const uuid = params.uuid, token = params.token;
    if (!uuid || !token) { if (process.env.SOLO_ONLINE_DEBUG) LOG("skip(no uuid/token) url=" + ctx.url + " keys=" + Object.keys(params).join(",")); return; }

    const now = Math.floor(Date.now() / 1000);
    let s = sess[uuid];
    if (!s || s.token !== token) {                     // 新会话
        LOG("新会话 uuid=" + uuid + " tok=" + String(token).slice(0, 8));
        sess[uuid] = s = { token: token, start: now, ev: 0, tipEv: 0 };
        return;
    }

    const ev = Math.floor((now - s.start) / GAP);       // 至今应有的事件次数
    if (process.env.SOLO_ONLINE_DEBUG) console.log("[solo-online] t=" + (now - s.start) + "s ev=" + ev + " done=" + s.ev + " tok=" + String(token).slice(0, 8));
    if (ev <= s.ev) return;
    let times = ev - s.ev;
    if (times > MAX) times = MAX;                       // 防呆
    s.ev += times;

    const model = ActItemModel.getInstance(ctx, uuid, "1");
    await model.add(ITEM, times * COUNT);
    LOG("发放 uuid=" + uuid + " times=" + times + " item=" + ITEM + " -> 共 " + (times * COUNT));

    if (TIP > 0 && s.ev - s.tipEv >= TIP) {
        const tipTimes = s.ev - s.tipEv;
        s.tipEv = s.ev;
        try { ctx.state.master.addTypeMsg(0, "msg", "在线奖励：代金券 +" + (tipTimes * COUNT)); } catch (e) { }
    }
}

module.exports = { tick, sess, cfg: { GAP: GAP, ITEM: ITEM, COUNT: COUNT, TIP: TIP, MAX: MAX } };
