// 导出功能的回归测试。
// 直接从 app.js 里切出"导出本地连接信息"整段,在 vm 沙箱里跑真实代码,
// 不复制实现,避免测试与实现各写一份。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const APP_SRC = fs.readFileSync('assets/js/app.js', 'utf8');
const START = '// ---------- 导出本地连接信息 ----------';
const END = '// ---------- 连接 ----------';

function extractExportBlock() {
  const start = APP_SRC.indexOf(START);
  assert.notEqual(start, -1, 'app.js 里找不到导出功能代码块');
  const end = APP_SRC.indexOf(END, start);
  assert.notEqual(end, -1, '找不到导出代码块的结束位置');
  return APP_SRC.slice(start, end);
}

// 搭一个最小沙箱:只提供导出功能真正用到的东西
function makeSandbox(conns, savedPasses) {
  const rec = { alerts: [], downloads: [], revoked: [], timers: [], blobs: [] };

  const store = Object.assign({}, savedPasses);
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  class BlobStub {
    constructor(parts, opts) {
      this.parts = parts;
      this.type = (opts && opts.type) || '';
      this.size = String(parts.join('')).length;
      rec.blobs.push(this);
    }
    text() { return Promise.resolve(this.parts.join('')); }
  }

  const document = {
    createElement(tag) {
      assert.equal(tag, 'a');
      const el = {
        tagName: 'A', style: {}, href: '', download: '', rel: '',
        click() { rec.downloads.push({ href: el.href, download: el.download }); },
        remove() { el.removed = true; },
      };
      return el;
    },
    body: { appendChild() {}, removeChild() {} },
  };

  const sandbox = {
    state: { conns: conns },
    getSavedPass: (id) => (('webssh.pass.' + id) in store ? store['webssh.pass.' + id] : ''),
    alert: (m) => rec.alerts.push(String(m)),
    location: { origin: 'http://127.0.0.1:23456' },
    localStorage,
    document,
    Blob: BlobStub,
    URL: {
      createObjectURL(b) { return 'blob:test/' + rec.blobs.indexOf(b); },
      revokeObjectURL(u) { rec.revoked.push(u); },
    },
    setTimeout: (fn, ms) => { rec.timers.push(ms); return 0; },
    // 网络出口全部做成"一旦被调用就记录下来"的探针
    fetch: (...a) => { rec.alerts.push('NETWORK:fetch:' + a[0]); throw new Error('导出不应发起网络请求'); },
    XMLHttpRequest: function () { rec.alerts.push('NETWORK:xhr'); },
    navigator: { sendBeacon: () => { rec.alerts.push('NETWORK:beacon'); } },
    console,
    rec,
  };
  return sandbox;
}

function run(conns, savedPasses) {
  const sandbox = makeSandbox(conns, savedPasses);
  vm.createContext(sandbox);
  vm.runInContext(extractExportBlock(), sandbox);
  assert.equal(typeof sandbox.exportLocalData, 'function', 'exportLocalData 未导出到沙箱');
  return sandbox;
}

const PWD_CONN = {
  id: 'c1', name: 'VPS-A', host: '1.2.3.4', port: 22, user: 'root',
  authType: 'password', command: 'cd /srv', savePass: true, hasPass: true,
};
const KEY_CONN = {
  id: 'c2', name: 'VPS-B', host: '5.6.7.8', port: 2222, user: 'ubuntu',
  authType: 'key', command: '', savePass: true, hasPass: false,
  keyName: '-----BEGIN OPENSSH PRIVATE KEY-----...',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nKEYDATA\n-----END OPENSSH PRIVATE KEY-----',
  passphrase: 'pp-secret',
};

test('没有连接时不下载,只提示', () => {
  const s = run([], {});
  s.exportLocalData();
  assert.deepEqual(s.rec.downloads, []);
  assert.equal(s.rec.alerts.length, 1);
  assert.match(s.rec.alerts[0], /还没有保存的连接/);
});

test('导出的记录包含每个连接的全部字段', () => {
  const s = run([PWD_CONN, KEY_CONN], { 'webssh.pass.c1': 'pwd-from-ls' });
  s.exportLocalData();
  assert.equal(s.rec.downloads.length, 1);

  const payload = JSON.parse(s.rec.blobs[0].parts.join(''));
  assert.equal(payload.app, 'web-ssh');
  assert.equal(payload.schema, 1);
  assert.equal(payload.count, 2);
  assert.equal(payload.origin, 'http://127.0.0.1:23456');
  assert.ok(!Number.isNaN(Date.parse(payload.exportedAt)), 'exportedAt 不是合法时间');

  const byId = {};
  payload.conns.forEach((c) => { byId[c.id] = c; });
  // 原有字段一个都不能丢
  for (const src of [PWD_CONN, KEY_CONN]) {
    for (const k of Object.keys(src)) {
      assert.ok(k in byId[src.id], `连接 ${src.id} 缺少字段 ${k}`);
      assert.deepEqual(byId[src.id][k], src[k], `连接 ${src.id} 字段 ${k} 值不一致`);
    }
  }
});

test('密码从独立 localStorage 键并回记录', () => {
  const s = run([PWD_CONN], { 'webssh.pass.c1': 'pwd-from-ls' });
  s.exportLocalData();
  const payload = JSON.parse(s.rec.blobs[0].parts.join(''));
  assert.equal(payload.conns[0].password, 'pwd-from-ls');
});

test('未勾选保存密码时 password 为空字符串而不是 undefined', () => {
  const s = run([PWD_CONN], {});
  s.exportLocalData();
  const payload = JSON.parse(s.rec.blobs[0].parts.join(''));
  assert.equal(payload.conns[0].password, '');
});

test('私钥与口令原样导出', () => {
  const s = run([KEY_CONN], {});
  s.exportLocalData();
  const payload = JSON.parse(s.rec.blobs[0].parts.join(''));
  assert.equal(payload.conns[0].privateKey, KEY_CONN.privateKey);
  assert.equal(payload.conns[0].passphrase, KEY_CONN.passphrase);
});

test('导出不发起任何网络请求', () => {
  const s = run([PWD_CONN, KEY_CONN], { 'webssh.pass.c1': 'x' });
  s.exportLocalData();
  assert.deepEqual(
    s.rec.alerts.filter((m) => m.indexOf('NETWORK:') === 0), [],
    '导出过程中出现了网络调用'
  );
  // 静态兜底:这段代码里不该出现任何网络 API
  const block = extractExportBlock();
  for (const api of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'new WebSocket', 'navigator.']) {
    assert.equal(block.indexOf(api), -1, `导出代码块里出现了 ${api}`);
  }
});

test('下载走 blob URL,文件名带时间戳,类型为 JSON', () => {
  const s = run([PWD_CONN], { 'webssh.pass.c1': 'x' });
  s.exportLocalData();
  const d = s.rec.downloads[0];
  assert.match(d.download, /^webssh-conns-\d{8}-\d{6}\.json$/);
  assert.match(d.href, /^blob:/);
  assert.equal(s.rec.blobs[0].type, 'application/json;charset=utf-8');
  // blob URL 不能在下载还没落地时就被回收
  assert.deepEqual(s.rec.revoked, []);
  assert.equal(s.rec.timers.length, 1);
  assert.ok(s.rec.timers[0] >= 1000, 'revoke 延迟太短,可能打断下载');
});
