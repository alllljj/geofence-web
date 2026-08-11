// ============================================================
// 电子围栏 · 位置中转 Cloudflare Worker
// 网页 fetch 本 Worker → Worker 连巴法云 TCP cmd=3 拉设备最新坐标
// 部署: Cloudflare Dashboard → Workers & Pages → Create Worker
// ============================================================

const BEMFA_HOST = 'bemfa.com';
const BEMFA_PORT = 8344;
const UID = '050042db7c93475090e07b207e55d01a';   // ⚠️ 改成你的 UID
const TOPIC = 'geofence001';                       // ⚠️ 改成你的主题

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // 1) /position → 拉设备最新坐标
      if (path === '/position' && request.method === 'GET') {
        const pos = await pullPosition();
        return new Response(JSON.stringify(pos), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // 2) /fence → 下发围栏指令 (FENCE:... 或 CLEAR), body: {cmd:"FENCE:lat,lon;..."}
      if (path === '/fence' && request.method === 'POST') {
        const body = await request.json();
        const cmd = body.cmd || '';
        if (!cmd) return new Response(JSON.stringify({ ok: false, err: 'missing cmd' }), { headers: { ...cors, 'Content-Type': 'application/json' } });
        const ok = await sendFence(cmd);
        return new Response(JSON.stringify({ ok }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // 3) /ping → 健康检查
      return new Response(JSON.stringify({ ok: true, t: Date.now() }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, err: String(e) }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  },
};

// 连巴法云 cmd=3 拉设备最新上报, 持续等 32 秒覆盖一个上报周期
async function pullPosition() {
  return new Promise((resolve, reject) => {
    const socket = connect({ hostname: BEMFA_HOST, port: BEMFA_PORT });
    socket.opened.then(() => {
      socket.write('cmd=3&uid=' + UID + '&topic=' + TOPIC + '\r\n');
      let buf = '';
      const started = Date.now();
      const timer = setInterval(() => {
        if (Date.now() - started > 32000) {
          clearInterval(timer);
          try { socket.close(); } catch (e) {}
          resolve(parse(buf));
        }
      }, 1000);
      socket.readable.pipeTo(new WritableStream({
        write(chunk) {
          buf += new TextDecoder().decode(chunk);
        },
      })).catch(() => {});
    }).catch((e) => {
      reject(new Error('connect fail: ' + e));
    });
  });
}

function parse(buf) {
  const pos = { lat: 0, lon: 0, sats: 0, inFence: false, dist: 0, ts: Math.floor(Date.now() / 1000) };
  // 匹配所有 msg=lat,lon,sats,inFence,dist, 取最后一个
  const re = /msg=(-?[\d.]+),(-?[\d.]+),(\d+),(\d+),(-?[\d.]+)/g;
  let m, last = null;
  while ((m = re.exec(buf)) !== null) last = m;
  if (last && (Math.abs(parseFloat(last[1])) > 0.0001 || Math.abs(parseFloat(last[2])) > 0.0001)) {
    pos.lat = parseFloat(last[1]);
    pos.lon = parseFloat(last[2]);
    pos.sats = parseInt(last[3]);
    pos.inFence = last[4] === '1';
    pos.dist = parseFloat(last[5]);
  }
  return { position: pos };
}

// 下发围栏指令 (FENCE:... 或 CLEAR)
async function sendFence(cmd) {
  return new Promise((resolve, reject) => {
    const socket = connect({ hostname: BEMFA_HOST, port: BEMFA_PORT });
    socket.opened.then(() => {
      const msg = 'cmd=2&uid=' + UID + '&topic=' + TOPIC + '&msg=' + cmd + '\r\n';
      socket.write(msg);
      // 等 2 秒收服务器回执
      let buf = '';
      setTimeout(() => {
        try { socket.close(); } catch (e) {}
        resolve(buf.includes('res=0') || buf.includes('res=1'));
      }, 2000);
      socket.readable.pipeTo(new WritableStream({
        write(chunk) { buf += new TextDecoder().decode(chunk); },
      })).catch(() => {});
    }).catch((e) => reject(new Error('connect fail: ' + e)));
  });
}
