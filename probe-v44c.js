// probe-v44c.js — clist host/协议矩阵探测
const https = require('https');
const http = require('http');

function get(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': '*/*', 'Referer': 'https://quote.eastmoney.com/', 'Connection': 'close' },
      timeout: 15000
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

const HOSTS = [
  'http://push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
  'http://push2delay.eastmoney.com',
];
const Q = '/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f3,f6,f12,f14,f100';

(async () => {
  for (const h of HOSTS) {
    try {
      const r = await get(h + Q);
      const j = JSON.parse(r.body);
      const n = j && j.data && j.data.diff ? j.data.diff.length : 0;
      console.log(`✓ ${h}  http=${r.code} total=${j && j.data && j.data.total} got=${n}`);
      if (n) { console.log('  样本:', JSON.stringify(j.data.diff[0])); break; }
    } catch (e) {
      console.log(`✗ ${h}  ${e.message}`);
    }
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
