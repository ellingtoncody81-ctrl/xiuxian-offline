"use strict";
/**
 * [单机版 · 假人系统 v2] _solo_fakes.js
 * ------------------------------------------------------------------
 * 目标：让单机服"像个有人气的服"。全部复用官方代码 / 官方数据格式，不造假字段。
 *
 *  1) 假角色（200 个）       → data db `user` 集合（kid=userInfo），供榜单/聊天渲染
 *  2) 榜单预填：
 *      · rdsJjc     竞技场榜   → 官方 jjcNpc 3500 人（NPC 分支原生支持）
 *      · rdsPvd     每日挑战榜 → 假角色
 *      · rdsPvw     排位榜     → 假角色
 *      · rdsLiuDao  六道榜     → 假角色
 *      · rdsDouLuo  斗罗榜     → 官方 douLuoNpc 500 人（NPC 分支原生支持）
 *  3) 世界频道假聊天（"全区 all" + "合服 hefu"）→ data db `chat` 集合（格式与官方一致）
 *      + 定时器每几分钟追加一条（有"活人"感）
 *  4) 假仙盟（10 个 ×20 人）→ data db `sev` 集合（kid=club / kid=clubMember），applyAuto=1 可被直接加入
 *
 * 幂等：可反复启动；不会覆盖玩家真实数据；假人分数每次启动按配置重置（新赛季感）。
 */
const tool_1 = require("./src/util/tool");
const game_1 = require("./src/util/game");
const gameCfg_1 = require("./common/gameCfg");
const mongodb_1 = require("./src/util/mongodb");
const RdsUserModel_1 = require("./src/model/redis/RdsUserModel");

const _def = (m) => (m && m.__esModule && m.default !== undefined) ? m.default : m;
const game = _def(game_1);
const gameCfg = _def(gameCfg_1);
const tool = tool_1.tool;

// ================= 假角色名单 =================
const FAKE_NAMES = [
    "青云剑客", "风清扬", "醉里挑灯", "孤舟蓑笠", "夜雨寄北", "一剑霜寒",
    "沧海月明", "烟波钓叟", "白露横江", "清风徐来", "山高水长", "剑胆琴心",
    "踏雪寻梅", "月下独酌", "白衣卿相", "长风破浪", "落霞孤鹜", "秋水长天",
    "松间明月", "石上清泉", "云深不知", "笑傲江湖", "逍遥游侠", "止水如镜",
    "山月听雨", "野渡行舟", "松风拾薪", "寒江卧松", "夜阑揽星", "秋浦访鹤",
    "断桥钓雪", "枯藤眠鸥", "鹿鸣卧松", "鹿鸣扫云", "烟霞观云", "空谷眠鸥",
    "浮生观澜", "斜阳煮酒", "沧浪烹茶", "春江拾翠", "暗香揽星", "山月鼓琴",
    "残阳踏月", "夜阑枕石", "孤舟听涛", "冷月行舟", "野渡煮酒", "江雪听涛",
    "春江拾薪", "白露扫云", "浮生漱泉", "暮雪煮酒", "竹露问月", "浮生眠鸥",
    "春江执墨", "冷月煮酒", "寒山鼓琴", "寒山寻梅", "龙吟听雨", "暗香鼓琴",
    "梅影钓雪", "夜阑煮酒", "寒江揽星", "断桥执墨", "枯藤逐风", "泉声揽星",
    "泉声望岳", "白露载酒", "流水鼓琴", "寒山渡江", "斜阳放歌", "烟霞系舟",
    "梅影听雨", "云帆烹茶", "龙吟鼓琴", "落叶听雨", "枯藤牧鹤", "竹露望岳",
    "枯藤垂纶", "远岫问樵", "竹露揽星", "鹤唳踏月", "龙吟枕石", "疏影寻梅",
    "长歌烹茶", "烟霞望岳", "鹿鸣负笈", "落叶观云", "断桥观澜", "寒江问月",
    "长歌漱泉", "枯藤分茶", "秋浦烹茶", "鹤唳烹茶", "斜阳漱泉", "残阳问樵",
    "云帆扫云", "春江钓雪", "江雪问月", "云帆听涛", "秋浦牵牛", "云帆弈棋",
    "星垂横笛", "梅影听雪", "残阳寻梅", "梅影行舟", "孤舟分茶", "残阳访鹤",
    "白露寻梅", "暮雪踏月", "孤舟放歌", "暮雪载酒", "浮云漱泉", "春江扫云",
    "流水逐风", "暗香听涛", "山月负笈", "轻烟问樵", "梅影逐风", "星垂听雪",
    "寒江漱泉", "龙吟横笛", "残阳枕石", "寒山观澜", "斜阳踏歌", "泉声踏月",
    "龙吟牧鹤", "竹露听雪", "林风拾薪", "泉声眠鸥", "野渡分茶", "空谷牧鹤",
    "斜阳牵牛", "断桥临风", "竹露垂纶", "长歌拾薪", "秋浦卧松", "暮雪眠鸥",
    "白露拾薪", "断桥问月", "云帆行舟", "野渡弈棋", "江雪行舟", "冷月牵牛",
    "薄暮枕石", "星垂踏月", "轻烟垂纶", "流水系舟", "鹤唳观云", "浮生问月",
    "寒山载酒", "涧水分茶", "薄暮访鹤", "冷月观云", "流水执墨", "落叶听涛",
    "烟霞弈棋", "空谷寻梅", "江雪听雪", "泉声观云", "轻烟渡江", "沧浪系舟",
    "落叶弈棋", "秋浦问樵", "涧水枕石", "寒江横笛", "鹤唳问樵", "暗香横笛",
    "星垂听雨", "落叶载酒", "暮雪拾翠", "野渡听雪", "星垂分茶", "远岫弈棋",
    "夜阑抚剑", "鹤唳扫云", "山月逐风", "林风望岳", "涧水访鹤", "长歌横笛",
    "林风负笈", "林风载酒", "轻烟抚剑", "流水拾翠", "江雪观澜", "白露负笈",
    "薄暮望岳", "孤舟观澜", "疏影临风", "孤舟逐风", "林风访鹤", "松风抚剑",
    "冷月垂纶", "涧水拾翠", "沧浪垂纶", "远岫拾翠", "浮生牵牛", "沧浪踏歌",
    "松风负笈", "空谷钓雪",
];
const FAKE_UUID_BASE = 200001;
const FAKE_LEVELS_24 = [200, 198, 195, 192, 190, 188, 185, 182, 180, 178, 175, 172, 170, 168, 165, 162, 160, 158, 155, 152, 150, 148, 145, 142];
const FAKE_LEVELS = FAKE_NAMES.map((_, i) => i < 24 ? FAKE_LEVELS_24[i] : Math.max(100, 142 - Math.round((i - 24) * 0.24)));

function fakeUsers() {
    return FAKE_NAMES.map((name, i) => ({
        uuid: String(FAKE_UUID_BASE + i),
        name: name,
        level: FAKE_LEVELS[i] || 150,
        idx: i,
    }));
}

// ================= 1) 假角色数据 =================
async function ensureFakeUsers() {
    const db = mongodb_1.dbSev.getDataDb();
    const nowT = game.getNowTime();
    const users = fakeUsers();
    for (const u of users) {
        const data = {
            uuid: u.uuid, uid: "3" + u.uuid, sid: "1", name: u.name, sex: 1, head: "skin_1",
            wxhead: "", tzid: "", level: u.level, exp: 0,
            lastlogin: nowT - 3600 * (1 + (u.idx % 12)),
            regtime: nowT - 86400 * (30 + u.idx),
            lang: "zh", token: "", iscz: 100 + u.idx * 7,
        };
        await db.update("user", { id: u.uuid, kid: "userInfo", hdcid: "1" },
            { id: u.uuid, kid: "userInfo", hdcid: "1", data: data }, true);
    }
    return users;
}

// 假角色的"玩家展示对象"（与官方 NPC 分支同形，客户端可正常渲染）
function fakeFuser(u, nowT) {
    return {
        uid: "", uuid: u.uuid, sid: "1", name: u.name, sex: 1, head: "skin_1",
        wxhead: "", tzid: "", level: u.level, lastlogin: nowT,
        rid: 0, score: 0, clubName: "", chid: "1", cbid: "1",
    };
}

// ================= 2) 榜单预填 =================
async function seedBoards() {
    const report = [];
    const nowT = game.getNowTime();
    const users = fakeUsers();

    // --- 竞技场榜：官方 NPC（3500 人） ---
    try {
        const rows = Object.values(gameCfg.jjcNpc.pool);
        const m = new RdsUserModel_1.RdsUserModel("rdsJjc", "x", "1", String(tool.jjcWeekId(nowT)));
        for (const row of rows) await m.zSetVal(String(row.id), Number(row.score) || 1000);
        report.push("rdsJjc:" + rows.length);
    } catch (e) { report.push("rdsJjc:失败 " + e.message); }

    // --- 每日挑战榜 rdsPvd：假角色 ---
    try {
        const m = new RdsUserModel_1.RdsUserModel("rdsPvd", "x", "1", String(game.getTodayId(nowT)));
        let n = 0;
        // [v4.6.6] 与 fakes2 同口径（×3.5）：伤害=官方档位量级（按名次递减，头部千万级）
        for (const u of users) { await m.zSetVal(u.uuid, Math.max(10000, Math.round(9100000 / Math.pow(1.035, u.idx) * (0.8 + ((u.idx * 37) % 40) / 100)))); n++; }
        report.push("rdsPvd:" + n);
    } catch (e) { report.push("rdsPvd:失败 " + e.message); }

    // --- 排位榜 rdsPvw：假角色 ---
    try {
        const m = new RdsUserModel_1.RdsUserModel("rdsPvw", "x", "1", String(game.getWeekId()));
        let n = 0;
        for (const u of users) { await m.zSetVal(u.uuid, Math.max(100, 3200 - u.idx * 15)); n++; }
        report.push("rdsPvw:" + n);
    } catch (e) { report.push("rdsPvw:失败 " + e.message); }

    // --- 六道榜 rdsLiuDao：假角色 ---
    try {
        const m = new RdsUserModel_1.RdsUserModel("rdsLiuDao", "x", "1", "1");
        let n = 0;
        for (const u of users) { await m.zSetVal(u.uuid, Math.max(1, 60 - Math.floor(u.idx * 0.3))); n++; }
        report.push("rdsLiuDao:" + n);
    } catch (e) { report.push("rdsLiuDao:失败 " + e.message); }

    // --- 斗罗榜 rdsDouLuo：官方 NPC（500 人），键 hdcid 两种都填 ---
    try {
        const dw = String(game.getDouLuoWeek());
        const rows = Object.values(gameCfg.douLuoNpc.pool || {});
        let n = 0;
        for (const hid of ["x", "1"]) {
            const m = new RdsUserModel_1.RdsUserModel("rdsDouLuo", hid, "1", dw);
            for (const row of rows) { await m.zSetVal(String(row.id), Math.max(1, 501 - Number(row.id || 0))); n++; }
        }
        report.push("rdsDouLuo:" + n);
    } catch (e) { report.push("rdsDouLuo:失败 " + e.message); }

    return report;
}

// ================= 3) 世界频道假聊天 =================
const CHAT_LINES = [
    "有没有人一起打竞技场呀？",
    "刚出了一把橙装，运气爆棚！",
    "六道第30层怎么过，求大佬指点",
    "仙盟【青云阁】收人啦，活跃优先～",
    "今天历练翻了三次车…心态崩了",
    "斗法场遇到个土豪，战力吓人",
    "洞天挖到好东西了，嘿嘿",
    "谁在线？组队打世界BOSS",
    "这游戏画面真不错，回归第三天",
    "附魔又失败了，心态爆炸",
    "求问符石怎么搭配收益高？",
    "刚把武器升到满级，帅！",
    "签到第100天，纪念一下",
    "跨服大佬轻点打，我号太脆了",
];

async function seedChat() {
    const report = [];
    const db = mongodb_1.dbSev.getDataDb();
    const nowT = game.getNowTime();
    const users = fakeUsers();
    const F2 = require("./_solo_fakes2");   // [v4.5] 统一档案

    const channels = [
        { _id: "0", hdcid: "all", label: "全区" },
        { _id: "1", hdcid: "hefu", label: "合服" },
    ];
    for (const ch of channels) {
        try {
            const cur = await db.findOne("chat", { id: ch._id, kid: "chat", hdcid: ch.hdcid });
            const curList = (cur && cur.data && cur.data.list) || {};
            const curId = (cur && cur.data && cur.data.id) || 0;
            if (curId >= 10) { report.push(ch.hdcid + ":已有 " + curId + " 条，跳过"); continue; }
            const list = Object.assign({}, curList);
            let id = curId;
            for (let i = 0; i < CHAT_LINES.length; i++) {
                const u = users[i % users.length];
                id += 1;
                list[id] = {
                    id: id, type: "1",
                    user: await F2.fakeFuserFull(u.uuid),
                    msg: CHAT_LINES[i],
                    time: nowT - (CHAT_LINES.length - i) * 97,
                };
            }
            await db.update("chat", { id: ch._id, kid: "chat", hdcid: ch.hdcid },
                { id: ch._id, kid: "chat", hdcid: ch.hdcid, data: { list: list, id: id } }, true);
            try { await require("./_solo_fakes2").writeChat(ch._id, ch.hdcid, { list: list, id: id }); } catch (e) { }
            report.push(ch.hdcid + ":" + CHAT_LINES.length + " 条");
        } catch (e) { report.push(ch.hdcid + ":失败 " + e.message); }
    }
    return report;
}

// 定时追加一条（"活人"感）；间隔默认 4 分钟
let _chatTimer = null;
function startChatTimer(intervalMs) {
    if (_chatTimer) return;
    const every = intervalMs || 4 * 60 * 1000;
    _chatTimer = setInterval(async () => {
        try {
            const db = mongodb_1.dbSev.getDataDb();
            const nowT = game.getNowTime();
            const users = fakeUsers();
            const u = users[Math.floor(Math.random() * users.length)];
            const line = CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)];
            const f2 = require("./_solo_fakes2");
            let fuser = null; try { fuser = await f2.fakeFuserFull(u.uuid); } catch (e) { }
            if (!fuser) fuser = fakeFuser(u, nowT);
            await f2.writeChatLine("0", "all", fuser, line);
            await f2.writeChatLine("1", "hefu", fuser, line);
            try {
                const kuaId = await f2.getKuaId();
                if (kuaId != null) await f2.writeChatLine(String(kuaId), "kua", fuser, line);
            } catch (e) { }
            console.log("[solo-fakes] 世界频道 +1：" + u.name + "：" + line);
        } catch (e) { }
    }, every);
    try { _chatTimer.unref && _chatTimer.unref(); } catch (e) { }
}

// ================= 4) 假仙盟 =================
// v4.5：10 个仙盟（每盟 20 假人，按 idx 段分配 [k*20, k*20+20)）
const CLUBS = [
    { id: "2001", name: "青云阁", notice: "青云直上，广纳贤才！" },
    { id: "2002", name: "听雨轩", notice: "听雨论剑，休闲养老盟。" },
    { id: "2003", name: "醉仙楼", notice: "来即是缘，一起喝酒打本～" },
    { id: "2004", name: "落霞谷", notice: "落霞与孤鹜齐飞，秋水共长天一色。" },
    { id: "2005", name: "听风楼", notice: "听风辨雨，静待知音。" },
    { id: "2006", name: "揽月阁", notice: "欲上青天揽明月，同好共聚此间。" },
    { id: "2007", name: "无双城", notice: "天下无双，唯我独行。" },
    { id: "2008", name: "烟雨楼", notice: "烟雨江南，楼中论道。" },
    { id: "2009", name: "万剑宗", notice: "万剑归宗，一剑霜寒十四州。" },
    { id: "2010", name: "星垂野", notice: "星垂平野阔，月涌大江流。" },
];

async function seedClubs() {
    const report = [];
    const db = mongodb_1.dbSev.getDataDb();
    const nowT = game.getNowTime();
    const users = fakeUsers();   // 200 人
    // ---- 1) club 行：不存在才建（10 盟；旧 2001-2003 保留既有数据）----
    for (let k = 0; k < CLUBS.length; k++) {
        const c = CLUBS[k];
        try {
            const cur = await db.findOne("sev", { id: c.id, kid: "club", hdcid: "1" });
            if (cur != null && cur.data && cur.data.createTime > 0) continue;
            const leader = users[Math.min(k * 20, users.length - 1)];
            const clubData = {
                uuid: leader.uuid, sid: "1", name: c.name, notice: c.notice,
                applyLevelNeed: 1, applyAuto: 1, canselect: 1,
                createTime: nowT - 86400 * 12, rstMstTime: 0, outTime: 0,
                cash_memberCount: 20, cash_active: 30 + k * 5,
                boss: { unlock: 1, md1220: 0, open: 0, hurt: 0, kill: "" },
                hfVer: "", gmNum: 0, lgLv: 3, lgExp: 200,
            };
            await db.update("sev", { id: c.id, kid: "club", hdcid: "1" },
                { id: c.id, kid: "club", hdcid: "1", data: clubData }, true);
            report.push("新建盟 " + c.name + "(" + c.id + ")");
        } catch (e) { report.push(c.name + ":失败 " + e.message); }
    }
    // ---- 2) 成员分配（幂等迁移）：假人 i → 盟 k=i/20；非假人成员（玩家 100003 等）原样保留 ----
    try {
        const members = {};
        for (const c of CLUBS) {
            const row = await db.findOne("sev", { id: c.id, kid: "clubMember", hdcid: "1" });
            members[c.id] = (row != null && row.data && row.data.list) ? Object.assign({}, row.data.list) : {};
        }
        // actClub 模板：克隆现有假人 200001 的行（保证字段形状一致）
        const tplRow = await db.findOne("act", { id: "200001", kid: "actClub", hdcid: "1" });
        const tplClub = (tplRow != null && tplRow.data) ? tplRow.data : {
            clubId: "", active7D: { all: 1, list: {} }, tbAtAt: 0, outClubTime: 0, outClubNum: 0, itime: 0, outTime: 0,
            applyIds: {}, help: { hnum: 0, htype: { box: 0, boxStep: 0, fushi: 0, dongtian: 0 } },
            boss: { hnum: 0, htime: 0 }, alimit: {}, md1205: 0, md1235: 0, qifu: 0, gaiyun: 0, gaiyunAll: 0, fxs: [], qfRwd: [], chatTime: 0,
        };
        // ---- 2.5) [v4.6.4] 字段自愈（幂等）：active7D 补值 + actClub.clubId 对齐 + club.cash_active 补值 ----
        // 背景：v4.5 之前成员行用的字段名是 active（读到 active7D 为 undefined → 客户端“活跃值:undefined”）；
        //       历史迁移里部分 actClub.clubId 与成员表不一致（聊天/详情显示的“仙盟”不跟随实际盟）。
        let healedA = 0, healedC = 0, synced = 0;
        for (const c of CLUBS) {
            const lst = members[c.id] || {};
            for (const u2 in lst) {
                const n2 = parseInt(u2);
                if (!(n2 >= 200001 && n2 <= 200200)) continue;               // 只动假人，玩家条目原样
                if (lst[u2].active7D == null) {
                    const oldA = parseInt(lst[u2].active);
                    lst[u2].active7D = (oldA > 0 && oldA < 500) ? oldA : (10 + (n2 % 20) * 3);
                    healedA++;
                }
                const aRow2 = await db.findOne("act", { id: u2, kid: "actClub", hdcid: "1" });
                const cur2 = (aRow2 != null && aRow2.data) ? String(aRow2.data.clubId || "") : "";
                if (cur2 !== c.id) {
                    const d3 = Object.assign({}, tplClub, (aRow2 != null && aRow2.data) ? aRow2.data : {}, { clubId: c.id });
                    await db.update("act", { id: u2, kid: "actClub", hdcid: "1" },
                        { id: u2, kid: "actClub", hdcid: "1", data: d3 }, true);
                    synced++;
                }
            }
            const cRow = await db.findOne("sev", { id: c.id, kid: "club", hdcid: "1" });
            if (cRow != null && cRow.data && cRow.data.cash_active == null) {
                let sum = 0;
                for (const u3 in lst) { sum += (parseInt(lst[u3].active7D) || 0); }
                cRow.data.cash_active = sum;
                await db.update("sev", { id: c.id, kid: "club", hdcid: "1" },
                    { id: c.id, kid: "club", hdcid: "1", data: cRow.data }, true);
                healedC++;
            }
        }
        if (healedA || healedC || synced) report.push("字段自愈: active7D+" + healedA + " cash_active+" + healedC + " clubId同步 " + synced);
        let moved = 0, added = 0;
        for (let i = 0; i < users.length; i++) {
            const u = users[i];
            const want = CLUBS[Math.floor(i / 20)];
            const inClubs = [];
            for (const c of CLUBS) { if (members[c.id] && members[c.id][u.uuid] != null) inClubs.push(c.id); }
            if (inClubs.length === 1 && inClubs[0] === want.id) continue;   // 已就位（幂等）
            for (const c of CLUBS) { if (members[c.id]) delete members[c.id][u.uuid]; }
            const nIdx = i % 20;
            members[want.id][u.uuid] = {
                post: nIdx === 0 ? 1 : (nIdx === 1 ? 2 : (nIdx === 2 ? 3 : 0)),
                time: nowT - 3600 * (2 + nIdx),
                active7D: 10 + nIdx * 3,   // [v4.6.4] 字段名对齐 SevClubMemberModel（旧字段 active 导致成员列表渲染“活跃值:undefined”）
                longgong: 0,
            };
            if (inClubs.length) moved++; else added++;
            const aRow = await db.findOne("act", { id: u.uuid, kid: "actClub", hdcid: "1" });
            const d2 = Object.assign({}, tplClub, (aRow != null && aRow.data) ? aRow.data : {}, { clubId: want.id });
            await db.update("act", { id: u.uuid, kid: "actClub", hdcid: "1" },
                { id: u.uuid, kid: "actClub", hdcid: "1", data: d2 }, true);
        }
        for (const c of CLUBS) {
            const list = members[c.id] || {};
            await db.update("sev", { id: c.id, kid: "clubMember", hdcid: "1" },
                { id: c.id, kid: "clubMember", hdcid: "1", data: { time: nowT, list: list, count: Object.keys(list).length } }, true);
        }
        report.push("假人盟分配: 新建 " + added + " / 迁移 " + moved + "（10 盟×20）");
    } catch (e) { report.push("成员分配:失败 " + e.message); }
    return report;
}

// ================= 入口 =================
async function seedFakes(opts) {
    opts = opts || {};
    let out = [];
    try { await ensureFakeUsers(); out.push("假角色 " + FAKE_NAMES.length + " 人"); } catch (e) { out.push("假角色:失败 " + e.message); }
    try { out = out.concat(await seedBoards()); } catch (e) { out.push("榜单:失败 " + e.message); }
    try { out = out.concat(await seedChat()); } catch (e) { out.push("聊天:失败 " + e.message); }
    try { out = out.concat(await seedClubs()); } catch (e) { out.push("仙盟:失败 " + e.message); }
    if (opts.timer !== false) startChatTimer(opts.timerMs);
    console.log("[solo-fakes] " + out.join(" | "));
    return out;
}

module.exports = { seedFakes, startChatTimer };
