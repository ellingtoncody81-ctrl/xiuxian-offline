/* 单机版 —— 本地服务层（跑在 Electron 主进程内）v3
 * 职责：
 *   0) v3 新增：托管官方后端（app/backend/dist，全套 468 路由）——请求优先转发给它
 *   1) 持有【可写存档】 save/save.json（仅作回退：后端不可用时的降级路径）
 *   2) 按路由返回响应：内建处理器（有状态） → fixtures/*.json（只读快照）
 *   3) v2：配置表加载（app/tables/）+ equip/openBox95、equip/xuanzhong
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function weightedPick(items) {
  let total = 0;
  for (const it of items) total += Math.max(0, Number(it[1]) || 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const it of items) { r -= Math.max(0, Number(it[1]) || 0); if (r < 0) return it[0]; }
  return items[items.length - 1][0];
}

class LocalServer {
  constructor(opts) {
    this.fixturesDir = opts.fixturesDir;
    this.saveDir = opts.saveDir;
    this.tablesDir = path.join(opts.fixturesDir, '..', 'tables');
    this.saveFile = path.join(this.saveDir, 'save.json');
    this._fix = {};
    this.tbl = null;
    this.stats = { hit: 0, fixture: 0, miss: [], backend: 0 };
    this.backendPort = 0;
    this._dirty = false;
    this.state = null;
    fs.mkdirSync(this.saveDir, { recursive: true });
    this._seedOrLoad();
    setInterval(() => { if (this._dirty) this.flush(); }, 3000);
  }

  _seedOrLoad() {
    try {
      if (fs.existsSync(this.saveFile)) {
        this.state = JSON.parse(fs.readFileSync(this.saveFile, 'utf8'));
        console.log('[srv] 存档已加载: ' + this.saveFile + ' (' + fs.statSync(this.saveFile).size + 'B)');
        return;
      }
    } catch (e) { console.log('[srv] 存档读取失败(将重建): ' + e.message); }
    const lu = this._fixture('player/loginUser');
    if (!lu) { console.log('[srv] !! 缺少 player_loginUser.json 夹具'); this.state = { format: 'solo-save-v1', sev: {} }; return; }
    const sev = JSON.parse(JSON.stringify(lu));
    delete sev.type; delete sev.time;
    this.state = { format: 'solo-save-v1', createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000), pos: 0, sev: sev };
    this._dirty = true; this.flush();
    console.log('[srv] 已从夹具播种新存档 (sev=' + JSON.stringify(sev).length + 'B)');
  }

  _fixture(route) {
    if (Object.prototype.hasOwnProperty.call(this._fix, route)) return this._fix[route];
    const f = path.join(this.fixturesDir, route.replace('/', '_') + '.json');
    let v = null;
    try { v = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { v = null; }
    this._fix[route] = v;
    return v;
  }

  // ---------- 配置表 ----------
  _loadTables() {
    if (this.tbl) return this.tbl;
    const rd = (n) => { try { const d = JSON.parse(fs.readFileSync(path.join(this.tablesDir, n + '.json'), 'utf8')); return Array.isArray(d) ? d : (d.list || []); } catch (e) { console.log('[srv] 表缺失 ' + n); return []; } };
    const equipInfo = rd('equipInfo'), equipBox = rd('equipBox'), equipLevel = rd('equipLevel');
    const tsChi = rd('equipTsChi'), tsEp = rd('equipTsEp'), pifu = rd('equipPifu');
    const zuojia = rd('equipZuojia'), math = rd('mathInfo');
    const infoById = {}, infoByPinzhi = {}, infoByBwPz = {};
    for (const r of equipInfo) {
      infoById[r.id] = r;
      (infoByPinzhi[r.pinzhi] = infoByPinzhi[r.pinzhi] || []).push(r);
      infoByBwPz[r.buwei + '_' + r.pinzhi] = r;
    }
    const boxByLevel = {}; for (const r of equipBox) boxByLevel[String(r.level)] = r;
    const lvByKey = {}; for (const r of equipLevel) lvByKey[r.pinzhi + '_' + r.level] = r;
    const tsChiBy = {}; for (const r of tsChi) (tsChiBy[r.id] = tsChiBy[r.id] || []).push(r);
    const tsEpBy = {}; for (const r of tsEp) { (tsEpBy[r.pinzhi] = tsEpBy[r.pinzhi] || {})[r.epkey] = r; }
    const pifuByBw = {}; for (const r of pifu) (pifuByBw[r.buwei] = pifuByBw[r.buwei] || []).push(r);
    const zjByCount = {}; for (const r of zuojia) zjByCount[String(r.count)] = r;
    const mathByKey = {}; for (const r of math) mathByKey[r.key || r.id] = r;
    this.tbl = { equipInfo, infoById, infoByPinzhi, infoByBwPz, boxByLevel, lvByKey, tsChiBy, tsEpBy, pifuByBw, zjByCount, mathByKey };
    console.log('[srv] 表已加载: equipInfo=' + equipInfo.length + ' equipLevel=' + equipLevel.length + ' equipPifu=' + pifu.length + ' math=' + math.length);
    return this.tbl;
  }

  _rollOne(A, actBox) {
    const T = this._loadTables();
    const sev = this.state.sev;
    const userLv = Number((sev.userInfo || {}).level || 1);
    let pinzhi, buwei, level, equipId, tsCid;
    const zj = T.zjByCount[String((A.count || 0) + 1)];
    if (zj) {
      pinzhi = Number(zj.pinzhi); buwei = Number(zj.buwei); level = Number(zj.level);
      const row = T.infoByBwPz[buwei + '_' + pinzhi];
      equipId = row.id; tsCid = row.tsCid || [];
    } else {
      const boxRow = T.boxByLevel[String(actBox.level)] || T.boxByLevel['1'];
      const prob = [];
      for (const p of boxRow.ePinZhiProb) if (p[1] > 0) prob.push([p[0], p[1]]);
      pinzhi = weightedPick(prob) || 1;
      const list = T.infoByPinzhi[pinzhi] || T.infoByPinzhi[1];
      const row = list[Math.floor(Math.random() * list.length)];
      equipId = row.id; buwei = row.buwei; tsCid = row.tsCid || [];
      const math = T.mathByKey['box_equip_lv'];
      const dl = math ? (weightedPick(math.pram.items) || 0) : 0;
      level = Math.max(1, userLv + Number(dl));
    }
    const lvRow = T.lvByKey[pinzhi + '_' + level] || null;
    const eps = {};
    if (lvRow) {
      eps.hp_max = Math.max(0, lvRow.hp_max + randInt(-lvRow.hp_max_bd, lvRow.hp_max_bd));
      eps.atk = Math.max(0, lvRow.atk + randInt(-lvRow.atk_bd, lvRow.atk_bd));
      eps.def = Math.max(0, lvRow.def + randInt(-lvRow.def_bd, lvRow.def_bd));
      eps.speed = Math.max(0, lvRow.speed + randInt(-lvRow.speed_bd, lvRow.speed_bd));
    }
    for (const tcid of tsCid) {
      const pool = T.tsChiBy[tcid] || [];
      const key = weightedPick(pool.map(r => [r.epkey, r.prob]));
      if (!key) continue;
      const rng = (T.tsEpBy[pinzhi] || {})[key];
      if (!rng) continue;
      eps[key] = randInt(rng.min, rng.max);
    }
    const plist = T.pifuByBw[buwei] || [];
    const cand = [];
    for (const p of plist) {
      if (p.limit > 0) {
        const qz = String(parseInt(p.id) - 1);
        const have = (A.czpf || {})[qz] || 0;
        if (have < p.limit) continue;
      }
      cand.push([String(p.id), p.prob]);
    }
    let mrhh = String(weightedPick(cand) || '');
    if (!mrhh && plist.length) mrhh = String(plist[0].id);
    return { equipId, buwei, pinzhi, level, eps, mrhh };
  }

  _xuanzhongInto(A, xbid) {
    if (!A.linshi95 || A.linshi95[xbid] == null) return;
    A.linshixz = xbid;
    const T = this._loadTables();
    const info = T.infoById[A.linshi95[xbid].equipId];
    if (!info) return;
    const ch = (A.chuan || {})[String(info.buwei)];
    if (ch) {
      if (A.linshiOld && A.linshiOld.isNew == 1) {
        const cfgold = T.infoById[A.linshiOld.equipId] || {};
        if (Number(cfgold.buwei) === Number(info.buwei)) return;
      }
      A.linshiOld.equipId = ch.equipId;
      A.linshiOld.mrhh = ch.equipId === '' ? '' : ch.mrhh;
      A.linshiOld.hh = ch.hh || '';
      A.linshiOld.level = ch.level || 0;
      A.linshiOld.eps = ch.eps || {};
      A.linshiOld.isNew = 0;
    }
    A.linshi = JSON.parse(JSON.stringify(A.linshi95[xbid]));
  }

  _openBox95(needNum) {
    const sev = this.state.sev;
    if (!sev.actEquip) sev.actEquip = {};
    if (!sev.actEquip.a) sev.actEquip.a = {};
    const A = sev.actEquip.a;
    const actBox = sev.actBox || {};
    if (!(needNum >= 1)) return { type: 0, win: { msg: ['参数错误'] } };
    if ((A.box || 0) < needNum) return { type: 0, win: { msg: ['鼎炉不足'] } };
    A.opAt = Math.floor(Date.now() / 1000);
    A.box -= needNum;
    A.linshi95 = {};
    A.linshi = { equipId: '', mrhh: '', hh: '', level: 0, eps: {}, isNew: 0 };
    A.linshiOld = { equipId: '', mrhh: '', hh: '', level: 0, eps: {}, isNew: 0 };
    A.czpf = A.czpf || {};
    const outChuan = {};
    for (let i = 1; i <= needNum; i++) {
      const xhid = String(i);
      const it = this._rollOne(A, actBox);
      const bw = String(it.buwei);
      if (!A.chuan) A.chuan = {};
      if (!A.chuan[bw]) A.chuan[bw] = { equipId: '', mrhh: '', hh: '', level: 0, eps: {}, hhList: {}, newHh: '' };
      const ch = A.chuan[bw];
      ch.newHh = '';
      if (it.mrhh && ch.hhList[it.mrhh] == null) { ch.hhList[it.mrhh] = 1; ch.newHh = it.mrhh; }
      outChuan[bw] = ch;
      A.linshi95[xhid] = { equipId: it.equipId, mrhh: it.mrhh, hh: '', level: it.level, eps: it.eps, isNew: 1 };
      A.count = (A.count || 0) + 1;
      A.czpf[it.mrhh] = (A.czpf[it.mrhh] || 0) + 1;
    }
    if (needNum === 1) this._xuanzhongInto(A, '1');
    const u = { box: A.box, jjc: A.jjc, linshi: A.linshi, linshiOld: A.linshiOld, linshi95: A.linshi95 };
    if (Object.keys(outChuan).length) u.chuan = A.chuan;
    this._dirty = true;
    console.log('[srv] 开箱 x' + needNum + ' → box=' + A.box + ' count=' + A.count + ' items=' + JSON.stringify(A.linshi95).length + 'B');
    return { type: 1, actEquip: { u: u } };
  }

  // ---------- 托管后端代理 ----------
  setBackendPort(p) { this.backendPort = Number(p) || 0; console.log('[srv] 托管后端端口 = ' + this.backendPort); }

  _proxy(req) {
    return new Promise((resolve) => {
      if (!this.backendPort) return resolve(null);
      const url = String(req.url || '');
      const qi = url.indexOf('?');
      const qs = qi >= 0 ? url.slice(qi) : '';
      const reqPath = '/' + String(req.route || '') + qs;
      const data = Buffer.from(String(req.body || '{}'), 'utf8');
      const rq = http.request({
        host: '127.0.0.1', port: this.backendPort, path: reqPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
      }, (rs) => {
        const chunks = [];
        rs.on('data', (c) => chunks.push(c));
        rs.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      rq.on('error', (e) => { console.log('[srv] 后端代理失败 /' + req.route + ': ' + e.message); resolve(null); });
      rq.setTimeout(60000, () => { try { rq.destroy(); } catch (e) { } resolve(null); });
      rq.end(data);
    });
  }

  flush() {
    try {
      this.state.updatedAt = Math.floor(Date.now() / 1000);
      fs.writeFileSync(this.saveFile, JSON.stringify(this.state));
      this._dirty = false;
    } catch (e) { console.log('[srv] 存档写入失败: ' + e.message); }
  }

  async handle(req) {
    // v3：优先交给托管官方后端（全套真实业务逻辑）
    if (this.backendPort) {
      const r = await this._proxy(req);
      if (r != null && r.length > 0) { this.stats.backend++; return r; }
    }
    const route = String(req.route || '');
    const now = Math.floor(Date.now() / 1000);
    let out = null;
    this.stats.hit++;

    switch (route) {
      case 'player/login': out = this._fixture(route) || { type: 1 }; break;
      case 'player/loginPlayer': out = this._fixture(route) || { type: 1 }; break;
      case 'player/loginUser':
        out = Object.assign({ type: 1 }, JSON.parse(JSON.stringify(this.state.sev)));
        break;
      case 'user/adok':
        this.state.lastActive = now; this._dirty = true;
        out = { time: now, type: 1 };
        break;
      case 'user/setPos': {
        try { const b = JSON.parse(req.body || '{}'); if (typeof b.pos !== 'undefined') { this.state.pos = b.pos; this._dirty = true; } } catch (e) { }
        out = { time: now, type: 1 };
        break;
      }
      case 'equip/openBox95': {
        try { const b = JSON.parse(req.body || '{}'); out = this._openBox95(Number(b.needNum || 1)); }
        catch (e) { console.log('[srv] openBox95 异常: ' + e.stack); out = { type: 0, win: { msg: ['[solo] 开箱异常'] } }; }
        break;
      }
      case 'equip/xuanzhong': {
        try {
          const b = JSON.parse(req.body || '{}');
          const A = ((this.state.sev.actEquip || {}).a) || {};
          this._xuanzhongInto(A, String(b.xbid || '1'));
          this._dirty = true;
          out = { type: 1, actEquip: { u: { linshi: A.linshi, linshiOld: A.linshiOld, linshi95: A.linshi95 } } };
        } catch (e) { out = { type: 0 }; }
        break;
      }
      default: {
        const fx = this._fixture(route);
        if (fx) { out = JSON.parse(JSON.stringify(fx)); this.stats.fixture++; }
        else {
          this.stats.miss.push(route);
          out = { type: 0, win: { msg: ['[solo] 未实现 /' + route] }, time: now };
          console.log('[srv] MISS /' + route + ' | body=' + String(req.body || '').slice(0, 120));
        }
      }
    }
    if (out && typeof out === 'object') {
      if (route === 'player/loginUser' || typeof out.time === 'number') out.time = now;
    }
    const body = JSON.stringify(out);
    console.log('[srv] /' + route + ' => ' + body.length + 'B');
    return body;
  }
}

module.exports = LocalServer;
