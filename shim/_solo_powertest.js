"use strict";
if (process.argv[2]) process.env.SOLO_DB_DIR = process.argv[2];
const _def = (m) => (m && m.__esModule && m.default !== undefined) ? m.default : m;
const mongodb = require("./src/util/mongodb");
const gameCfg = _def(require("./common/gameCfg"));
const gm = require("./common/gameMethod").gameMethod;

(async () => {
  try {
    await mongodb.dbSev.init();
    try { gameCfg.init(); } catch (e) { console.log("cfg init:", e.message); }
    const db = mongodb.dbSev.getDataDb();
    async function load(uuid) {
      const sevBack = {};
      for (const coll of ["user", "act", "hd"]) {
        const rows = await db.find(coll, {});
        for (const r of rows) {
          if (String(r.id) !== String(uuid)) continue;
          if (sevBack[r.kid] == null || String(r.hdcid) === "1") sevBack[r.kid] = r.data;
        }
      }
      return sevBack;
    }
    // 用官方 getFUserAll 同款包装
    function wrap(raw) {
      return {
        actEquip: { a: raw.actEquip },
        actChengH: raw.actChengH,
        actChiBang: raw.actChiBang,
        actFazhen: raw.actFazhen,
        actShengQi: { a: raw.actShengQi },
        actBaoShi: raw.actBaoShi,
        actFuShi: { a: raw.actFuShi },
        actDongTian: raw.actDongTian,
        actClubMj: raw.actClubMj,
        actJinxiu: raw.actJinxiu,
        actWanXiang: raw.actWanXiang,
        actJingGuai: raw.actJingGuai,
        actXianlv: raw.actXianlv,
        rdsJjcMy: { rid: 0, score: 0 },
        rdsDouLuoMy: { "1": { rid: 501, score: 0 } },
      };
    }
    function power(sb) { return gm.ep_power(0, gm.ep_all(sb)); }
    function scaleEquip(raw, k) {
      const c = JSON.parse(JSON.stringify(raw));
      if (c.actEquip && c.actEquip.chuan) {
        for (const b in c.actEquip.chuan) {
          const slot = c.actEquip.chuan[b];
          if (slot.eps) for (const e in slot.eps) slot.eps[e] = Math.floor(slot.eps[e] * k);
          if (slot.fmEps) slot.fmEps = slot.fmEps.map(function (x) { return [x[0], Math.floor(x[1] * k)]; });
          if (slot.hhList) slot.hhList = {};
        }
      }
      return c;
    }
    const raw = await load("100003");
    const full = wrap(raw);
    console.log("100003 全量 => " + power(full));
    for (const k of [1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01]) {
      const sb = wrap(scaleEquip(raw, k));
      console.log("装备eps x" + k + " => " + power(sb));
    }
    // 只留基础（去掉所有模块）
    console.log("纯基础 => " + power({ rdsJjcMy: { rid: 0, score: 0 }, rdsDouLuoMy: { "1": { rid: 501, score: 0 } } }));
  } catch (e) { console.log("异常:", (e && e.stack) || e); }
  process.exit(0);
})();
