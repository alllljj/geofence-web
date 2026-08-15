// Cloudflare Workers — 亲情守护设备同步器
//
// 功能：替代本机 sos_watch.py 的云端常驻角色
//   - 每 1 分钟定时连接巴法云 TCP (cmd=3) 拉取设备上报
//   - 解析设备坐标 → 写 position.json + devices/GEOFENCE001/state.json (GitHub API)
//   - 捕获 FENCE_OK/CLEAR_OK → 写 fenceAck 字段
//   - 捕获 SOS → 更新事件 + 触发 geofence-data 仓库 mailer workflow (repository_dispatch)
//
// ⚠️ 重要: 本 Worker 不再 getMsg 拉队列!
//   围栏指令 (FENCE/CLEAR) 由设备端 pullFence() 主动 getMsg 拉取 (设备是队列唯一消费者),
//   若 Worker 也 getMsg 会“取走即删”抢在设备前面, 导致设备永远收不到围栏指令。
//   本 Worker 只用 TCP cmd=3 订阅设备自己发布的上报 (坐标/FENCE_OK/CLEAR_OK/SOS),
//   这不会消费 getMsg 队列, 与设备拉取互不冲突。
//
// 部署：Cloudflare Dashboard → Workers & Pages → Create Worker → 粘贴本代码
// 触发器：Workers → 本 Worker → Triggers → Cron Triggers → Add Cron Trigger → 填 * * * * * (每分钟)
//
// 需要设置的 Secrets (Workers → Settings → Variables and Secrets):
//   GH_TOKEN   GitHub fine-grained PAT (geofence-web Contents R/W + geofence-data Actions:write)
//   GH_WEB_REPO   alllljj/geofence-web
//   GH_DATA_REPO  alllljj/geofence-data
//   DATA_PAT  geofence-data 仓库的 dispatch 用 token (可与 GH_TOKEN 相同, 需 Actions:write)
//   BEMFA_UID 050042db7c93475090e07b207e55d01a
//   BEMFA_TOPIC geofence001
//   SMTP_* 可选: 若想 worker 直接发邮件(需第三方SMTP API), 否则走 GitHub dispatch 由 mailer.yml 发
//
// 依赖：纯 JS + fetch，无第三方库。

// 配置从环境变量读取
const CFG = {
  GH_TOKEN: '',
  GH_WEB_REPO: 'alllljj/geofence-web',
  GH_DATA_REPO: 'alllljj/geofence-data',
  DATA_PAT: '',
  BEMFA_UID: '',
  BEMFA_TOPIC: 'geofence001',
};

// 全局状态（跨触发保留，用于去重）
let lastSosTs = 0;
let lastFenceAckTs = 0;
let lastPosKey = '';

export default {
  async scheduled(event, env, ctx) {
    // 读取环境变量
    CFG.GH_TOKEN = env.GH_TOKEN || '';
    CFG.GH_WEB_REPO = env.GH_WEB_REPO || 'alllljj/geofence-web';
    CFG.GH_DATA_REPO = env.GH_DATA_REPO || 'alllljj/geofence-data';
    CFG.DATA_PAT = env.DATA_PAT || '';
    CFG.BEMFA_UID = env.BEMFA_UID || '';
    CFG.BEMFA_TOPIC = env.BEMFA_TOPIC || 'geofence001';
    if (!CFG.GH_TOKEN || !CFG.BEMFA_UID) {
      console.log('缺少 GH_TOKEN 或 BEMFA_UID');
      return;
    }
    await sync();
  },

  async fetch(request, env, ctx) {
    // HTTP 入口（网页调用 + 手动触发）
    CFG.GH_TOKEN = env.GH_TOKEN || '';
    CFG.GH_WEB_REPO = env.GH_WEB_REPO || 'alllljj/geofence-web';
    CFG.GH_DATA_REPO = env.GH_DATA_REPO || 'alllljj/geofence-data';
    CFG.DATA_PAT = env.DATA_PAT || '';
    CFG.BEMFA_UID = env.BEMFA_UID || '';
    CFG.BEMFA_TOPIC = env.BEMFA_TOPIC || 'geofence001';
    const url = new URL(request.url);

    // GET /position — 实时读设备坐标 (绕过 Pages CDN 缓存)
    if (url.pathname === '/position') {
      const state = await ghGet(CFG.GH_WEB_REPO, 'devices/' + CFG.BEMFA_TOPIC.trim().toUpperCase() + '/state.json');
      if (!state) return json({ ok: false, err: 'state.json 不存在' }, 404);
      return json({ ok: true, position: state.doc.position || {} });
    }

    // POST /fence — 下发围栏/清除指令到巴法云 (body: {cmd: 'FENCE:...' 或 'CLEAR'})
    if (url.pathname === '/fence' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const cmd = String(body.cmd || '').trim();
      if (!cmd) return json({ ok: false, err: '缺少 cmd' }, 400);
      if (!/^[A-Za-z0-9:.,; -]+$/.test(cmd)) {
        return json({ ok: false, err: 'cmd 含非法字符' }, 400);
      }
      const ok = await bemfaSend(cmd);
      return json({ ok: ok, err: ok ? '' : '巴法云下发失败' }, ok ? 200 : 502);
    }

    // GET /sync — 手动触发同步
    if (url.pathname === '/sync') {
      await sync();
      return new Response('ok', { status: 200 });
    }

    // GET /ack — 主动拉取设备回执并返回最新 fenceAck (网页 waitFenceAck 轮询用, 不等 cron)
    if (url.pathname === '/ack') {
      await sync();
      const state = await ghGet(CFG.GH_WEB_REPO, 'devices/' + CFG.BEMFA_TOPIC.trim().toUpperCase() + '/state.json');
      return json({ ok: true, fenceAck: (state && state.doc && state.doc.fenceAck) || null, ts: Date.now() });
    }

    // POST /fence_done — 设备围栏生效后回调写 fenceAck (WiFi HTTPS 绕过 4G TCP 不稳定问题)
    if (url.pathname === '/fence_done' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const kind = String(body.kind || 'FENCE_OK').trim();
      const DEVID2 = (CFG.BEMFA_TOPIC || 'geofence001').trim().toUpperCase();
      const state = await ghGet(CFG.GH_WEB_REPO, 'devices/' + DEVID2 + '/state.json');
      const doc = (state && state.doc) || {};
      doc.fenceAck = { ts: Math.floor(Date.now() / 1000), ok: true, kind: kind };
      await ghPut(CFG.GH_WEB_REPO, 'devices/' + DEVID2 + '/state.json', doc, state ? state.sha : null, 'fence_ack from device via wifi callback');
      return json({ ok: true, kind: kind });
    }

    // GET /health — 状态检查
    if (url.pathname === '/health') {
      return json({ ok: true, name: 'geofence-sync', ts: Date.now() });
    }

    return new Response('geofence-sync worker', { status: 200 });
  },
};

async function sync() {
  const msgs = await pullBemfa();
  if (!msgs || !msgs.length) {
    console.log('TCP 订阅无消息');
    return;
  }
  console.log('TCP 订阅拉到', msgs.length, '条');
  const DEVID = (CFG.BEMFA_TOPIC || 'geofence001').trim().toUpperCase();

  let latestCoord = null;   // 最新坐标
  let fenceAck = null;      // FENCE_OK / CLEAR_OK
  let sosHit = null;        // SOS 消息

  for (const raw of msgs) {
    const msg = String(raw.msg || '').trim();
    // 坐标: lat,lon,sats,inFence,dist
    const m = msg.match(/^(-?[\d.]+),(-?[\d.]+),(\d+),(\d+),(-?[\d.]+)$/);
    if (m) {
      latestCoord = {
        lat: parseFloat(m[1]), lon: parseFloat(m[2]),
        sats: parseInt(m[3]), inFence: m[4] === '1', dist: parseFloat(m[5]),
      };
      continue;
    }
    if (msg.startsWith('SOS:')) {
      const sm = msg.match(/^(-?[\d.]+),(-?[\d.]+)/);
      sosHit = {
        lat: sm ? parseFloat(sm[1]) : 0,
        lon: sm ? parseFloat(sm[2]) : 0,
        raw: msg,
      };
      continue;
    }
    if (msg.startsWith('FENCE_OK')) {
      const v = (msg.match(/FENCE_OK:(\d+)/) || [])[1];
      fenceAck = { kind: 'FENCE_OK', verts: v ? parseInt(v) : 0 };
      continue;
    }
    if (msg.startsWith('CLEAR_OK')) {
      fenceAck = { kind: 'CLEAR_OK', verts: 0 };
      continue;
    }
    // 其他(如 ping)忽略
  }

  const now = Math.floor(Date.now() / 1000);
  const ts = new Date().toISOString();

  // 1) 读当前 state.json
  const state = await ghGet(CFG.GH_WEB_REPO, `devices/${DEVID}/state.json`);
  const doc = (state && state.doc) || { sos: false, updated: 0, events: [] };
  const sha = state ? state.sha : null;
  doc.position = doc.position || {};
  doc.events = doc.events || [];

  // 2) 更新坐标
  if (latestCoord) {
    doc.position = {
      ...doc.position,
      ...latestCoord,
      ts: now,
      sos: doc.position.sos || false,
    };
    console.log('坐标更新:', JSON.stringify(latestCoord));
  }

  // 3) fenceAck
  if (fenceAck) {
    doc.fenceAck = { ...fenceAck, ts: now, ok: true };
    console.log('fenceAck:', JSON.stringify(fenceAck));
  }

  // 4) SOS 事件
  if (sosHit) {
    const lastSos = (doc.events || []).filter(e => e.type === 'SOS').map(e => e.ts);
    const lastSosTsMax = lastSos.length ? Math.max(...lastSos) : 0;
    // 去重: 5 分钟内同一次求救不重复记录
    if (now - lastSosTsMax > 300) {
      const mailedTo = await listActiveUsers(DEVID);
      const sosEv = {
        ts: now, type: 'SOS', lat: sosHit.lat, lon: sosHit.lon,
        src: 'worker', devId: DEVID,
      };
      if (mailedTo.length) sosEv.mailedTo = mailedTo;
      doc.events.push(sosEv);
      doc.sos = true;
      doc.position.sos = true;
      console.log('SOS 事件记录 mailedTo=' + mailedTo.length);
      // 触发邮件
      await dispatchMailer(sosHit.lat, sosHit.lon, now, DEVID);
    } else {
      console.log('SOS 去重跳过 (last=' + lastSosTsMax + ')');
    }
  }

  // 5) SAFE 处理：消息里有 SAFE 且当前 sos 为 true → 解除
  if (msgs.some(m => String(m.msg || '').trim().startsWith('SAFE'))) {
    if (doc.sos) {
      doc.events.push({ ts: now, type: 'SAFE', lat: 0, lon: 0, src: 'worker', devId: DEVID });
      doc.sos = false;
      doc.position.sos = false;
      console.log('SAFE 解除');
    }
  }

  doc.events = doc.events.slice(-100);
  doc.updated = now;

  // 6) 写回 state.json
  const putOk = await ghPut(CFG.GH_WEB_REPO, `devices/${DEVID}/state.json`, doc, sha, 'worker sync ' + ts);
  console.log('state.json 写入:', putOk ? 'OK' : 'FAIL');

  // 7) 同步 position.json（管理端读）
  if (latestCoord || true) {
    const pj = await ghGet(CFG.GH_WEB_REPO, 'position.json');
    const pdoc = (pj && pj.doc) || { position: {} };
    pdoc.position = {
      ...doc.position,
      ts: doc.position.ts || now,
    };
    await ghPut(CFG.GH_WEB_REPO, 'position.json', pdoc, pj ? pj.sha : null, 'worker pos ' + ts);
    console.log('position.json 写入 OK');
  }
}

// ---------- 工具函数 ----------
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// 下发指令到巴法云 (FENCE/CLEAR 等)
// 双通道策略:
//   1) TCP 发布优先 (cmd=2 到 bemfa.com:8344) — 设备 TCP 订阅秒收, 延迟 <1s
//   2) HTTP sendMessage 兜底 (写 getMsg 队列, 设备 pullFence 轮询可拉到, ~10s)
// 两者都发, 设备端双通道去重 (FENCE_OK 回显里带顶点数, 重复指令幂等), 保证不丢指令。
async function bemfaSend(cmd) {
  let tcpOk = false;
  try {
    tcpOk = await bemfaSendTcp(cmd);
  } catch (e) {
    console.log('bemfaSendTcp 异常:', e.message);
  }
  let httpOk = false;
  const url = 'https://apis.bemfa.com/va/sendMessage?uid=' + CFG.BEMFA_UID +
              '&topic=' + CFG.BEMFA_TOPIC + '&type=3&msg=' + encodeURIComponent(cmd);
  // 重试 3 次, 巴法云偶发网络抖动时也能下发成功
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'geofence-worker' } });
      const j = await r.json();
      if (j && j.code === 0) { httpOk = true; break; }
      console.log('bemfaSend HTTP 第' + i + '次返回非0:', JSON.stringify(j).slice(0, 100));
    } catch (e) {
      console.log('bemfaSend HTTP 第' + i + '次异常:', e.message);
    }
    await new Promise(res => setTimeout(res, 800 * i));
  }
  return tcpOk || httpOk;
}

// TCP 发布 (cmd=2): 设备订阅同 topic 实时秒收
function bemfaSendTcp(cmd) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const socket = connect({ hostname: 'bemfa.com', port: 8344 });
      const t0 = Date.now();
      let buf = '';
      const timer = setInterval(() => {
        if (Date.now() - t0 > 8000) {  // 8 秒超时
          clearInterval(timer);
          try { socket.close(); } catch (e) {}
          done(buf.indexOf('res=0') >= 0);
        }
      }, 500);
      socket.opened.then(() => {
        const line = 'cmd=2&uid=' + CFG.BEMFA_UID + '&topic=' + CFG.BEMFA_TOPIC + '&msg=' + cmd + '\r\n';
        socket.write(line);
        socket.readable.pipeTo(new WritableStream({
          write(chunk) { buf += new TextDecoder().decode(chunk); },
        })).catch(() => {});
      }).catch((e) => {
        console.log('TCP 发布 connect fail:', e.message);
        clearInterval(timer);
        done(false);
      });
      // 收到 res=0 立即确认
      const chk = setInterval(() => {
        if (buf.indexOf('res=0') >= 0) {
          clearInterval(timer); clearInterval(chk);
          try { socket.close(); } catch (e) {}
          done(true);
        }
      }, 200);
    } catch (e) {
      console.log('TCP 发布异常:', e.message);
      done(false);
    }
  });
}

// ---------- 巴法云 TCP 拉取 (cmd=3 订阅, 不消费 getMsg 队列) ----------
// 设备 publish 的消息会广播回显给所有 cmd=3 订阅者, 用这个拉设备上报 (坐标/FENCE_OK/SOS)。
async function pullBemfa() {
  try {
    const resp = await fetch('https://cloudflare-dns.com/dns-query', { method: 'HEAD' });
    void resp;
  } catch (e) {}
  return new Promise((resolve) => {
    let msgs = [];
    let settled = false;
    const done = (arr) => { if (!settled) { settled = true; resolve(arr); } };
    try {
      const socket = connect({ hostname: 'bemfa.com', port: 8344 });
      socket.opened.then(() => {
        socket.write('cmd=3&uid=' + CFG.BEMFA_UID + '&topic=' + CFG.BEMFA_TOPIC + '\r\n');
        let buf = '';
        const started = Date.now();
        const timer = setInterval(() => {
          if (Date.now() - started > 20000) {  // 听 20 秒 (覆盖半个上报周期), 减少 Cloudflare CPU 限制影响
            clearInterval(timer);
            try { socket.close(); } catch (e) {}
            msgs = parseTcpBuf(buf);
            done(msgs);
          }
        }, 1000);
        socket.readable.pipeTo(new WritableStream({
          write(chunk) { buf += new TextDecoder().decode(chunk); },
        })).catch(() => {});
      }).catch((e) => {
        console.log('TCP connect fail:', e.message);
        done([]);
      });
    } catch (e) {
      console.log('TCP pull 异常:', e.message);
      done([]);
    }
  });
}

function parseTcpBuf(buf) {
  const out = [];
  // 巴法云 TCP 回显格式: ...msg=<内容>\r\n  (可能带其他字段)
  const re = /msg=([^\r\n]+)/g;
  let m;
  while ((m = re.exec(buf)) !== null) {
    const v = m[1].trim();
    if (v && v !== 'on' && v !== 'off') out.push({ msg: v });
  }
  return out;
}

// ---------- GitHub API ----------
async function ghGet(repo, path) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}?t=${Date.now()}`;
  try {
    const r = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + CFG.GH_TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'geofence-worker',
      },
    });
    if (r.status === 404) return null;
    if (!r.ok) { console.log('ghGet', repo, path, r.status); return null; }
    const j = await r.json();
    return { doc: JSON.parse(atob(j.content)), sha: j.sha };
  } catch (e) {
    console.log('ghGet 异常:', e.message);
    return null;
  }
}

async function ghPut(repo, path, obj, sha, note) {
  const body = {
    message: note,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(obj)))),
  };
  if (sha) body.sha = sha;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + CFG.GH_TOKEN,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'geofence-worker',
      },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch (e) {
    console.log('ghPut 异常:', e.message);
    return false;
  }
}

// ---------- 获取已激活守护人邮箱列表 ----------
async function listActiveUsers(devId) {
  // geofence-data users/active/*.json (DATA_PAT 需该仓库 Contents read)
  try {
    const r = await fetch('https://api.github.com/repos/' + CFG.GH_DATA_REPO + '/contents/users/active?t=' + Date.now(), {
      headers: {
        'Authorization': 'Bearer ' + (CFG.DATA_PAT || CFG.GH_TOKEN),
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'geofence-worker',
      },
    });
    if (!r.ok) { console.log('listActiveUsers', r.status); return []; }
    const items = await r.json();
    const mails = [];
    for (const it of items) {
      if (!it.name || !it.name.endsWith('.json')) continue;
      const u = await ghGet(CFG.GH_DATA_REPO, 'users/active/' + it.name);
      if (!u || !u.doc || !u.doc.email) continue;
      if (devId && String(u.doc.devId || '').toUpperCase() !== String(devId || '').toUpperCase()) continue;
      mails.push(u.doc.email);
    }
    return mails;
  } catch (e) {
    console.log('listActiveUsers 异常:', e.message);
    return [];
  }
}

// ---------- 触发邮件 (带去重) ----------
async function dispatchMailer(lat, lon, ts, devId) {
  if (!CFG.DATA_PAT) { console.log('无 DATA_PAT，跳过邮件'); return; }
  // 去重: 查 geofence-web/sos_mail_log.json, 已发过则跳过 (与 sos_watch/Actions 共用台账)
  try {
    const logDoc = await ghGet(CFG.GH_WEB_REPO, 'sos_mail_log.json');
    const sent = (logDoc && logDoc.doc && logDoc.doc.sent) || [];
    const dup = sent.some(i => String(i.devId || '').toUpperCase() === String(devId || '').toUpperCase() && parseInt(i.ts || 0) === parseInt(ts || 0));
    if (dup) { console.log('去重: SOS ts=' + ts + ' 已发过信, 跳过 dispatch'); return; }
    console.log('去重: SOS ts=' + ts + ' 未发过, 触发 dispatch');
  } catch (e) {
    console.log('去重查台账异常(继续):', e.message);
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${CFG.GH_DATA_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CFG.DATA_PAT,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'geofence-worker',
      },
      body: JSON.stringify({
        event_type: 'sos-alert',
        client_payload: { lat, lon, ts, devId },
      }),
    });
    console.log('dispatch mailer:', r.status);
  } catch (e) {
    console.log('dispatch 异常:', e.message);
  }
}
