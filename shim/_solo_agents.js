"use strict";
/**
 * [单机版 · 智能体引擎 v1] _solo_agents.js
 * ------------------------------------------------------------------
 * 目标（用户需求 2026-09-18）：
 *   “让整个 NPC 和假人都活起来，能参加仙盟、聊天、各种活动；
 *    配置好以后去接 AI，就能调配他们扮演他们去行动。”
 *
 * 设计（三层实体 + 可插拔大脑 + 动作执行器）：
 *   L1 常驻假人 = uuid 200001~200024（已有完整档案）
 *   L2 活跃 NPC = 从官方 jjcNpc 3500 里确定性挑 96 个（人格卡 + 作息）
 *   L3 其余 NPC = 保持“按需合成”（被看/被打时，由 fakes2.npcFuser 生成），不占资源
 *
 *   人格卡 persona（确定性生成，落盘 solo_agents_state.json）：
 *     { uuid, name, kind, style, slot, fav, lines[] }  ← “配置好”的就是这张卡
 *
 *   大脑 brain（可插拔）：
 *     - scriptedBrain（默认）：按作息/偏好挑动作 + 台词
 *     - llmBrain（可选）：配置 solo_agents_config.json 里的 ai.url 后，
 *       POST {agent, world, recent} → {action:"chat"|null, reply:"台词"}
 *       （与 fakes2 的 SOLO_FAKE_AI_URL 同协议，接官方 API/自建代理/本地模型均可）
 *
 *   动作 actions v1：
 *     - chat：往世界频道（all=0 / 本服=1）发言（复用 fakes2.writeChatLine）
 *
 * 用法：
 *   boot 挂接：require("./_solo_agents").init()      // 启动调度（默认每 30s 一轮）
 *   CLI 探针：node _solo_agents.js <dbDir> --tick 5  // 手动跑 5 轮并打印发言
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const fakes2 = require("./_solo_fakes2");
const tool_1 = require("./src/util/tool");
const game_1 = require("./src/util/game");
const gameCfg_1 = require("./common/gameCfg");
const _def = (m) => (m && m.__esModule && m.default !== undefined) ? m.default : m;
const game = _def(game_1);
const tool = tool_1.tool;

// ==================== 配置 ====================
function dbRoot() {
    return process.env.SOLO_DB_DIR || path.join(__dirname, "..", "db");
}
function stateFile() { return path.join(dbRoot(), "solo_agents_state.json"); }
function configFile() { return path.join(dbRoot(), "solo_agents_config.json"); }
function loadJson(p, dft) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return dft; } }
function saveJson(p, v) { try { fs.writeFileSync(p, JSON.stringify(v, null, 2)); } catch (e) { } }

const DEFAULT_CONFIG = {
    // AI 插槽：填了 url 后，发言/行动由 AI 生成（返回 {reply:"..."} 即可）
    // 例：{ "url": "http://127.0.0.1:8787/agent", "model": "local", "timeout": 8000 }
    ai: { url: "", model: "", timeout: 8000 },
    // 调度参数
    tickMs: 30000,        // 每轮间隔
    perTickMax: 1,        // 每轮最多几条发言（防刷屏）
    activeNpc: 96,        // L2 活跃 NPC 数量
    // 时段权重（0~1，表示该时段活跃概率）：0-5 深夜 / 6-11 上午 / 12-17 下午 / 18-23 晚上
    slotWeight: { night: 0.15, morning: 0.5, afternoon: 0.6, evening: 0.9 },
};
let CFG = null;
function loadCfg() {
    CFG = Object.assign({}, DEFAULT_CONFIG, loadJson(configFile(), {}));
    CFG.ai = Object.assign({}, DEFAULT_CONFIG.ai, CFG.ai || {});
    if (!fs.existsSync(configFile())) saveJson(configFile(), CFG);   // 首次生成模板（“配置好”）
    return CFG;
}

// ==================== 人格卡（确定性生成） ====================
const STYLES = ["豪爽", "文艺", "逗逼", "高冷", "热心", "沉默寡言", "话痨", "老成"];
const FAVS = ["chat", "jjc", "dongtian", "club", "liudao"];
const LINES = {
    chat: [
        "今天爆了个橙装，血赚！", "有没有人一起刷六道呀？", "刚上线，世界看看人多不多",
        "这服越来越热闹了", "谁还缺队友？我战力还行", "夜深了，还有活人吗",
        "求个仙盟收留，天天在线", "刚才斗法差点翻车，好险",
    ],
    jjc: [
        "刚在斗法赢了 3 把，感觉还行", "竞技场又被大佬教育了…", "排名冲进前 50 了，开心",
        "谁在斗法榜上盯着我？来打", "斗法连胜中，舒服",
    ],
    dongtian: [
        "洞天里挖矿挖到手酸", "谁的矿车又被我顺走了嘿嘿", "洞天今天爆了双倍，冲",
        "附近有大佬吗，轻点掠夺", "矿车摆好，欢迎来战",
    ],
    club: [
        "仙盟里的兄弟都在吗？", "今天帮贡刷满了", "仙盟 BOSS 快开了，集合", "求加个活跃仙盟",
        "仙盟祈福别忘了点一下",
    ],
    liudao: [
        "六道卡在第 87 关，求攻略", "六道今天又爬了两层", "六道榜往前挪了几名",
        "六道的 BOSS 真难打……", "有没有人六道进度差不多的，交流下",
    ],
};
function hash32(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
}
function makePersona(uuid, name, kind, level) {
    const h = hash32(String(uuid));
    return {
        uuid: String(uuid), name: name, kind: kind, level: level || 0,
        style: STYLES[h % STYLES.length],
        fav: FAVS[(h >>> 3) % FAVS.length],
        slot: ["night", "morning", "afternoon", "evening"][(h >>> 6) % 4],   // 作息档
    };
}
function buildLines(persona) {
    const base = LINES[persona.fav] || LINES.chat;
    const extra = LINES.chat;
    const h = hash32(persona.uuid + persona.style);
    const out = [];
    for (let i = 0; i < 3; i++) out.push(base[(h + i * 7) % base.length]);
    if (persona.style === "话痨" || persona.style === "逗逼") out.push(extra[(h + 11) % extra.length]);
    return Array.from(new Set(out));
}

// ==================== 实体注册 ====================
let AGENTS = [];   // 运行时实体表（persona + lines）
function registerAll() {
    const st = loadJson(stateFile(), {});
    st.agents = st.agents || {};
    const list = [];

    // L1：24 假人（名字从 user 表读）
    try {
        const db = require("./src/util/mongodb").dbSev.getDataDb();
        // 同步读（CLI/初始化时一次性）：直接用文件更快
        const userFile = path.join(dbRoot(), "shanhaitbkf", "user.json");
        const rows = loadJson(userFile, []);
        const urows = Array.isArray(rows) ? rows : (rows.rows || []);
        const nameOf = {};
        for (const r of urows) {
            if (r.kid === "userInfo" && r.data && r.data.name) nameOf[String(r.id)] = r.data.name;
        }
        for (let i = 200001; i <= 200024; i++) {
            const u = String(i);
            const p = st.agents[u] || (st.agents[u] = makePersona(u, nameOf[u] || ("玩家" + u.slice(-3)), "fake", 200));
            list.push(p);
        }
    } catch (e) { }

    // L2：96 个活跃 NPC（从 jjcNpc 池确定性挑）
    //   坑：pool 的 key 带【尾下划线】（"1546_"），而行的真实 id 是 "1546" → 必须归一化，
    //   否则 getItem 查不到 → 名字变占位名（npc_1546_）
    try {
        const cfg = _def(gameCfg_1);
        const pool = (cfg.jjcNpc && cfg.jjcNpc.pool) ? Object.keys(cfg.jjcNpc.pool) : [];
        const clean = (k) => String(k).replace(/_+$/, "");
        // 清理历史脏卡（键/名为占位格式的）
        for (const k of Object.keys(st.agents)) {
            if (/_$/.test(k) || String(st.agents[k].name || "").startsWith("npc_")) delete st.agents[k];
        }
        const want = Math.min(CFG.activeNpc, pool.length);
        const step = Math.max(1, Math.floor(pool.length / want));
        let n = 0;
        for (let i = 0; i < pool.length && n < want; i += step) {
            const id = clean(pool[i]);
            const c = cfg.jjcNpc.getItem(id) || {};
            const p = st.agents[id] || (st.agents[id] = makePersona(id, c.name || ("玩家" + id), "npc", c.level || 0));
            if (c.name && String(p.name).startsWith("npc_")) p.name = c.name;   // 纠错
            list.push(p);
            n++;
        }
        st.npcCount = n;
    } catch (e) { }

    // 补齐台词（不进盘，每次生成）
    for (const p of list) p.lines = buildLines(p);
    saveJson(stateFile(), st);
    AGENTS = list;
    return list;
}

// ==================== 世界快照 ====================
function timeSlot() {
    const h = new Date().getHours();
    if (h < 6) return "night";
    if (h < 12) return "morning";
    if (h < 18) return "afternoon";
    return "evening";
}
function worldSnapshot() {
    return { slot: timeSlot(), ts: Date.now(), online: 1 + Math.floor(Math.random() * 30) };
}

// ==================== 大脑（可插拔） ====================
// scripted：按作息 + 时段权重决定是否醒 + 按偏好挑台词
function scriptedBrain(agent, world) {
    const w = (CFG.slotWeight && CFG.slotWeight[world.slot] != null) ? CFG.slotWeight[world.slot] : 0.5;
    const boost = agent.slot === world.slot ? 1.6 : 1.0;          // 自己的作息档命中 ≈ 更活跃
    const p = Math.min(1, w * boost * (agent.kind === "fake" ? 1.3 : 0.8));
    if (Math.random() > p) return { action: null };
    const text = agent.lines[Math.floor(Math.random() * agent.lines.length)];
    return { action: "chat", reply: text };
}
// llm：把人格卡 + 世界快照 POST 给配置的 AI（协议与 fakes2 的 aiReply 相同）
function llmBrain(agent, world, recent) {
    const url = CFG.ai && CFG.ai.url;
    if (!url) return Promise.resolve(null);
    return new Promise((resolve) => {
        let u; try { u = new URL(url); } catch (e) { return resolve(null); }
        const lib = u.protocol === "https:" ? https : http;
        const body = JSON.stringify({
            name: agent.name, playStyle: agent.style, level: agent.level,
            world: world, recent: recent || [],
            prompt: "你是网游《修仙放置游戏》里的玩家【" + agent.name + "】。性格：" + agent.style +
                "。现在在好世界频道闲聊，说一句像真玩家的话（1 句，≤30 字，可带点游戏话题）。" +
                "若要静默返回空字符串。",
            want: "chat",
        });
        const req = lib.request({
            hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + (u.search || ""), method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
            timeout: (CFG.ai && CFG.ai.timeout) || 8000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try { const j = JSON.parse(d); resolve(j.reply !== undefined ? j.reply : (j.text || null)); }
                catch (e) { resolve(null); }
            });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { try { req.destroy(); } catch (e) { } resolve(null); });
        req.write(body); req.end();
    });
}

// —— 内置 AI 网关（MiniMax：db/solo_ai_config.json 配好 key 即生效）——
function aiEnabled() {
    try { const ai = require("./_solo_ai"); const c = ai.loadCfg(); if (c && c.key) return "builtin"; console.error("[solo-agents] aiEnabled: 无 key (dir=" + (process.env.SOLO_DB_DIR || "?") + ")"); } catch (e) { console.error("[solo-agents] aiEnabled 异常: " + (e && e.message)); }
    if (CFG.ai && CFG.ai.url) return "proxy";
    return null;
}
// 返回：null=失败(走脚本兜底) / ""=AI 静默 / 文本=发言
async function aiLine(agent, world) {
    const mode = aiEnabled();
    if (!mode) return null;
    if (mode === "builtin") {
        try {
            const ai = require("./_solo_ai");
            const t = await ai.ask({
                system: "你是网游《修仙放置游戏》里的玩家【" + agent.name + "】。性格：" + agent.style +
                    "。现在在世界频道闲聊。要求：只输出你要说的那一句话本身（≤30 字，中文，口语化，可带游戏话题），不要加引号、不要解释、不要多句。想沉默就回空。",
                user: "当前时段:" + world.slot + "。最近频道:" + (recentLines(3).join(" / ") || "无"),
                maxTokens: 300,
            });
            if (t == null) { console.error("[solo-agents] aiLine: ask 返回 null"); return null; }
            const clean = String(t).split(/\n/)[0].replace(/^["'“”「」]+|["'“”「」]+$/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
            return clean;
        } catch (e) { console.error("[solo-agents] aiLine 异常: " + (e && e.message)); return null; }
    }
    try { return await llmBrain(agent, world, recentLines(3)); } catch (e) { return null; }
}
// 谁想说话（概率判定；AI 只负责“说什么”）
function wantSpeak(agent, world) {
    const w = (CFG.slotWeight && CFG.slotWeight[world.slot] != null) ? CFG.slotWeight[world.slot] : 0.5;
    const boost = agent.slot === world.slot ? 1.6 : 1.0;
    const p = Math.min(1, w * boost * (agent.kind === "fake" ? 1.3 : 0.8));
    return Math.random() <= p;
}

// ==================== 动作执行器 ====================
async function actChat(agent, text, ch) {
    if (!text) return false;
    if (ch == null) ch = Math.random() < 0.7 ? { chId: "0", hdcid: "all" } : { chId: "1", hdcid: "hefu" };
    let user;
    if (agent.kind === "npc") {
        // NPC 用 fakes2 的完整档案（名字/头像统一）
        try { const nf = fakes2.npcFuser(null, agent.uuid); user = nf || null; } catch (e) { user = null; }
    }
    if (!user) {
        user = { uid: "", uuid: agent.uuid, sid: "1", name: agent.name, sex: 1, head: "skin_1", wxhead: "", tzid: "", level: agent.level || 150, lastlogin: Math.floor(Date.now() / 1000), rid: 0, score: 0, clubName: "", chid: "1", cbid: "1" };
    }
    user = Object.assign({}, user, { name: agent.name });
    await fakes2.writeChatLine(ch.chId, ch.hdcid, user, text);
    return true;
}

let _brain = scriptedBrain;
function setBrain(fn) { if (typeof fn === "function") _brain = fn; }

// ==================== 调度 ====================
let _timer = null;
let _events = [];            // 最近事件（给 AI 做 recent 上下文）
function recentLines(n) { return _events.slice(-n).map((e) => e.name + ": " + e.text); }

async function tick(opts) {
    opts = opts || {};
    const world = worldSnapshot();
    const out = [];
    const rounds = opts.force ? (opts.rounds || 1) : 1;
    const texts = [];                                     // 本次 tick 已用文案（跨轮去重）
    for (let r = 0; r < rounds; r++) {
        let posted = 0;
        // 打乱实体顺序，随机尝试一批
        const arr = AGENTS.slice();
        for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
        for (const agent of arr) {
            if (posted >= (CFG.perTickMax || 1)) break;
            if (!wantSpeak(agent, world)) continue;                      // ① 先决定“谁想说话”
            let text = null;
            if (aiEnabled()) { text = await aiLine(agent, world); }      // ② AI 生成（只对命中者调用）
            if (text == null) text = agent.lines[Math.floor(Math.random() * agent.lines.length)];  // ③ AI 失败/未配置 → 脚本台词
            if (text === "") continue;                                   // AI 明确静默
            if (texts.indexOf(text) !== -1) continue;                    // 本次去重
            if (_events.slice(-20).some((e) => e.text === text)) continue; // 与最近 20 条重了就不发
            const ok = await actChat(agent, text, opts.ch);
            if (ok) {
                posted++;
                texts.push(text);
                _events.push({ name: agent.name, uuid: agent.uuid, text: text, ts: Date.now() });
                if (_events.length > 50) _events.shift();
                out.push(agent.name + ": " + text);
            }
        }
    }
    return { world: world, posted: out };
}

async function init() {
    if (!CFG) loadCfg();
    try { _def(gameCfg_1).init && _def(gameCfg_1).init(); } catch (e) { }
    try { registerAll(); } catch (e) { console.error("[solo-agents] 注册异常 " + ((e && e.message) || e)); }
    let aiTag = "未配置(脚本模式)";
    const _mode = aiEnabled();
    if (_mode === "builtin") { try { aiTag = "MiniMax 内置网关(" + require("./_solo_ai").loadCfg().model + ")"; } catch (e) { aiTag = "MiniMax 内置网关"; } }
    else if (_mode === "proxy") { aiTag = CFG.ai.url; }
    console.log("[solo-agents] 智能体就绪：L1 假人 24 + L2 活跃NPC " + (AGENTS.length - 24) + "（AI接口=" + aiTag + "）");
    // 启动即说 2 句（让世界频道热起来；后台跑，不阻塞启动）
    tick({ force: true, rounds: 2 }).catch(() => { });
    if (_timer == null) {
        _timer = setInterval(() => { tick({}).catch(() => { }); }, CFG.tickMs || 30000);
        try { _timer.unref && _timer.unref(); } catch (e) { }
    }
    return true;
}

module.exports = { init, tick, setBrain, registerAll, AGENTS: () => AGENTS, CFG: () => CFG };

// ==================== CLI 探针 ====================
if (require.main === module) {
    (async () => {
        const dbDir = process.argv[2];
        if (dbDir) process.env.SOLO_DB_DIR = dbDir;
        const nIdx = process.argv.indexOf("--tick");
        const rounds = nIdx > 0 ? (parseInt(process.argv[nIdx + 1], 10) || 3) : 3;
        const mongodb_1 = require("./src/util/mongodb");
        const redis_1 = require("./src/util/redis");
        await mongodb_1.dbSev.init();
        try { await redis_1.redisSev.init(); } catch (e) { }
        try { _def(gameCfg_1).init(); } catch (e) { }
        loadCfg();
        registerAll();
        const r = await tick({ force: true, rounds: rounds });
        console.log("世界时段=" + r.world.slot + " 发言数=" + r.posted.length);
        for (const line of r.posted) console.log("  " + line);
        process.exit(0);
    })().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
}
