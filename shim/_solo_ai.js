"use strict";
/**
 * [单机版 · AI 网关 v1] _solo_ai.js
 * ------------------------------------------------------------------
 * 统一 AI 调用口（MiniMax Token Plan / Anthropic 兼容协议）。
 * 配置（v4.68 起把配置文件放到【游戏根目录】，与 launch_accounts.bat 同级，最方便）：
 *   查找顺序：① 环境变量 SOLO_AI_CONFIG 指定的文件
 *             ② <游戏根目录>/ai-config.json   ← 推荐（不存在会自动生成模板）
 *             ③ <游戏根目录>/ai-config.txt
 *             ④ <dbDir>/solo_ai_config.json    ← 老位置（兼容）
 *   文件可以写成标准 JSON，也可以写成 key=value 纯文本（# 与 // 开头的行是注释）：
 *   { "provider":"minimax",
 *     "base":"https://api.minimax.cn/anthropic",
 *     "key":"<在这里填你的 API key>",
 *     "model":"<模型ID>",
 *     "maxTokens":200, "timeout":15000 }
 *
 * 对外（供 _solo_agents / _solo_fakes2 调用）：
 *   ask({ system, user, maxTokens }) -> Promise<string|null>
 *   listModels() -> Promise<obj>
 *
 * CLI：
 *   node _solo_ai.js <dbDir> --models          列出账号可用模型
 *   node _solo_ai.js <dbDir> --test "你好"      测试一条对话
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

function dbRoot() {
    return process.env.SOLO_DB_DIR || path.join(__dirname, "..", "..", "db");
}
// 游戏根目录 = 放 launch_accounts.bat 的那一层（app 的上一级）
function gameRoot() { return path.join(__dirname, "..", "..", ".."); }
// ★ v4.68 配置文件候选（谁先存在用谁）——默认引导用户去游戏根目录填 ai-config.json
function cfgCands() {
    const list = [];
    if (process.env.SOLO_AI_CONFIG) list.push(String(process.env.SOLO_AI_CONFIG));
    list.push(path.join(gameRoot(), "ai-config.json"));
    list.push(path.join(gameRoot(), "ai-config.txt"));
    list.push(path.join(dbRoot(), "solo_ai_config.json"));   // 老位置，兼容旧档
    return list;
}
// 容错读取：标准 JSON 优先；不是 JSON 就按「key=value / key: value」逐行解析
// （支持 # 与 // 注释、值两侧引号、整数与 true/false）——用户拿记事本手写也能生效
function parseCfgText(text) {
    const s = String(text == null ? "" : text);
    try {
        const j = JSON.parse(s);
        if (j && typeof j === "object" && !Array.isArray(j)) return j;
    } catch (e) { }
    const out = {};
    for (const raw of s.split(/\r?\n/)) {
        let line = raw.trim();
        if (!line || line[0] === "#" || line.startsWith("//") || line[0] === "{" || line[0] === "}") continue;
        line = line.replace(/,\s*$/, "");
        const m = line.match(/^["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*(.*)$/);
        if (!m) continue;
        let v = (m[2] || "").trim().replace(/,\s*$/, "");
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
        else if (v === "true") v = true;
        else if (v === "false") v = false;
        out[m[1]] = v;
    }
    return out;
}

const TEMPLATE = {
    provider: "minimax",
    base: "https://api.minimax.cn/anthropic",
    key: "",
    model: "MiniMax-M2.7",
    maxTokens: 200,
    timeout: 15000,
};

let CFG = null;
function loadCfg() {
    let used = null;
    for (const f of cfgCands()) {
        try { if (f && fs.existsSync(f)) { used = f; break; } } catch (e) { }
    }
    if (!used) {
        // 一个都没有 → 在【游戏根目录】生成模板，用户填 key 即可（老版是生成在 db 里）
        used = path.join(gameRoot(), "ai-config.json");
        try { fs.writeFileSync(used, JSON.stringify(TEMPLATE, null, 2) + "\n"); } catch (e) { }
    }
    let disk = {};
    try { disk = parseCfgText(fs.readFileSync(used, "utf8")); } catch (e) { }
    CFG = Object.assign({}, TEMPLATE, disk);
    CFG.src = used;
    return CFG;
}

function call(pathname, method, body) {
    if (!CFG) loadCfg();
    return new Promise((resolve) => {
        let u;
        try { u = new URL((CFG.base || TEMPLATE.base).replace(/\/+$/, "") + pathname); }
        catch (e) { return resolve({ err: "bad base url" }); }
        const lib = u.protocol === "https:" ? https : http;
        const data = body ? JSON.stringify(body) : null;
        const headers = {
            "x-api-key": CFG.key || "",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        };
        // OpenAI 兼容兜底：也带上 Bearer（服务端只认一种，多余的头一般被忽略）
        headers["authorization"] = "Bearer " + (CFG.key || "");
        if (data) headers["content-length"] = Buffer.byteLength(data);
        const req = lib.request({
            hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + (u.search || ""), method: method || "GET", headers: headers,
            timeout: CFG.timeout || 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try { resolve(JSON.parse(d)); }
                catch (e) { resolve({ err: "bad json", status: res.statusCode, raw: d.slice(0, 300) }); }
            });
        });
        req.on("error", (e) => resolve({ err: String(e && e.message || e) }));
        req.on("timeout", () => { try { req.destroy(); } catch (e) { } resolve({ err: "timeout" }); });
        if (data) req.write(data);
        req.end();
    });
}

async function listModels() {
    return call("/v1/models", "GET");
}

async function ask(opts) {
    opts = opts || {};
    if (!CFG) loadCfg();
    if (!CFG.key) return null;
    const body = {
        model: CFG.model,
        max_tokens: opts.maxTokens || CFG.maxTokens || 200,
        messages: [{ role: "user", content: [{ type: "text", text: String(opts.user || "") }] }],
    };
    if (opts.system) body.system = String(opts.system);
    const j = await call("/v1/messages", "POST", body);
    if (j && Array.isArray(j.content)) {
        for (const b of j.content) {
            if (b && b.type === "text" && b.text) return String(b.text).trim();
        }
    }
    if (j && err2(j)) { try { console.error("[solo-ai] 调用失败: " + err2(j)); } catch (e) { } }
    else if (j) { try { console.error("[solo-ai] 无文本响应(" + (j.stop_reason || j.type || "?") + "): " + JSON.stringify(j).slice(0, 600)); } catch (e) { } }
    return null;
}
function err2(j) {
    if (!j) return "empty response";
    if (j.err) return j.err;
    if (j.type === "error") return (j.error && j.error.message) || "error";
    return null;
}

module.exports = { ask, listModels, loadCfg, CFG: () => CFG };

// ==================== CLI ====================
if (require.main === module) {
    (async () => {
        const dbDir = process.argv[2];
        if (dbDir) process.env.SOLO_DB_DIR = dbDir;
        loadCfg();
        if (process.argv.indexOf("--models") > 0) {
            const r = await listModels();
            console.log(JSON.stringify(r, null, 2).slice(0, 4000));
            process.exit(0);
        }
        const tIdx = process.argv.indexOf("--test");
        if (tIdx > 0) {
            const text = process.argv[tIdx + 1] || "你好";
            const t0 = Date.now();
            const r = await ask({ user: text, system: "你是网游《修仙放置游戏》里的玩家，中文口语，一句话，≤30字。" });
            console.log("用时 " + (Date.now() - t0) + "ms  回复: " + JSON.stringify(r));
            process.exit(0);
        }
        console.log("用法: node _solo_ai.js <dbDir> --models | --test \"你好\"");
        console.log("配置文件: " + CFG.src);
        console.log("当前配置: " + JSON.stringify({ base: CFG.base, model: CFG.model, key: (CFG.key || "").slice(0, 10) + "..." }));
        process.exit(0);
    })().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
}
