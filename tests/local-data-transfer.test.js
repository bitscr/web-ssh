// 导出 / 导入功能的回归测试。
// 直接从 app.js 里切出"导出 + 导入"整段,在 vm 沙箱里跑真实代码,
// 不复制实现,避免测试与实现各写一份。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const APP_SRC = fs.readFileSync('assets/js/app.js', 'utf8');
const START = '// ---------- 导出本地连接信息 ----------';
const END = '// ---------- 连接 ----------';
const LS_KEY = 'webssh.conns.v1';
const LS_PASS_PREFIX = 'webssh.pass.';

function extractLocalDataBlock() {
  const start = APP_SRC.indexOf(START);
  assert.notEqual(start, -1, 'app.js 里找不到导出/导入代码块');
  const end = APP_SRC.indexOf(END, start);
  assert.notEqual(end, -1, '找不到代码块的结束位置');
  return APP_SRC.slice(start, end);
}

// 最小沙箱:只提供这段代码真正用到的东西
function makeSandbox(conns, savedPasses) {
  const rec = {
    alerts: [], downloads: [], revoked: [], timers: [], blobs: [],
    confirms: [], confirmAnswer: true, reads: [], pickers: 0,
    persistCalls: 0, renders: 0, nextFile: null,
  };

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
      rec.blobs.push(this);
    }
    text() { return Promise.resolve(this.parts.join('')); }
  }

  class FileReaderStub {
    readAsText(file) {
      rec.reads.push(file.name);
      if (file.__readError) { if (this.onerror) this.onerror(); return; }
      this.result = file.text;
      if (this.onload) this.onload();
    }
  }

  let uidSeq = 0;

  const document = {
    createElement(tag) {
      if (tag === 'input') {
        const el = {
          tagName: 'INPUT', type: '', accept: '', style: {}, files: null,
          listeners: {},
          addEventListener(t, h) { (el.listeners[t] = el.listeners[t] || []).push(h); },
          remove() { el.removed = true; },
          click() {
            rec.pickers++;
            el.files = rec.nextFile ? [rec.nextFile] : [];
            (el.listeners.change || []).forEach((h) => h({ type: 'change' }));
          },
        };
        return el;
      }
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
    // 以下辅助函数在真实 app.js 里定义在代码块之外,这里按原语义镜像
    getSavedPass: (id) => (LS_PASS_PREFIX + id in store ? store[LS_PASS_PREFIX + id] : ''),
    savePassToLS: (id, pass) => { store[LS_PASS_PREFIX + id] = String(pass); },
    clearSavedPass: (id) => { delete store[LS_PASS_PREFIX + id]; },
    persistConns: () => { rec.persistCalls++; store[LS_KEY] = JSON.stringify(sandbox.state.conns); },
    renderHome: () => { rec.renders++; },
    uid: () => 'c-new' + (++uidSeq),
    alert: (m) => rec.alerts.push(String(m)),
    confirm: (m) => { rec.confirms.push(String(m)); return rec.confirmAnswer; },
    location: { origin: 'http://127.0.0.1:23456' },
    localStorage, document, Blob: BlobStub, FileReader: FileReaderStub,
    URL: {
      createObjectURL(b) { return 'blob:test/' + rec.blobs.indexOf(b); },
      revokeObjectURL(u) { rec.revoked.push(u); },
    },
    setTimeout: (fn, ms) => { rec.timers.push(ms); return 0; },
    // 网络出口全部做成"一旦被调用就记录下来"的探针
    fetch: (...a) => { rec.alerts.push('NETWORK:fetch:' + a[0]); throw new Error('不应发起网络请求'); },
    XMLHttpRequest: function () { rec.alerts.push('NETWORK:xhr'); },
    navigator: { sendBeacon: () => { rec.alerts.push('NETWORK:beacon'); } },
    console, rec, store,
  };
  return sandbox;
}

function run(conns, savedPasses) {
  const sandbox = makeSandbox(conns, savedPasses);
  vm.createContext(sandbox);
  vm.runInContext(extractLocalDataBlock(), sandbox);
  for (const fn of ['exportLocalData', 'importLocalData', 'parseImportPayload', 'applyImportedConns']) {
    assert.equal(typeof sandbox[fn], 'function', `${fn} 未导出到沙箱`);
  }
  return sandbox;
}

// 走完整路径:点按钮 -> 选文件 -> FileReader -> 解析 -> 确认 -> 落盘
function runImport(conns, savedPasses, payloadText, opts) {
  const s = run(conns, savedPasses);
  if (opts && 'confirmAnswer' in opts) s.rec.confirmAnswer = opts.confirmAnswer;
  s.rec.nextFile = { name: 'backup.json', text: payloadText };
  s.importLocalData();
  return s;
}

function backup(conns) {
  return JSON.stringify({
    app: 'web-ssh', schema: 1, exportedAt: new Date().toISOString(),
    origin: 'http://127.0.0.1:23456', count: conns.length, conns,
  });
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

// ============ 导出 ============

test('[导出] 没有连接时不下载,只提示', () => {
  const s = run([], {});
  s.exportLocalData();
  assert.deepEqual(s.rec.downloads, []);
  assert.equal(s.rec.alerts.length, 1);
  assert.match(s.rec.alerts[0], /还没有保存的连接/);
});

test('[导出] 记录包含每个连接的全部字段', () => {
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
  for (const src of [PWD_CONN, KEY_CONN]) {
    for (const k of Object.keys(src)) {
      assert.ok(k in byId[src.id], `连接 ${src.id} 缺少字段 ${k}`);
      assert.deepEqual(byId[src.id][k], src[k], `连接 ${src.id} 字段 ${k} 值不一致`);
    }
  }
});

test('[导出] 密码从独立 localStorage 键并回记录', () => {
  const s = run([PWD_CONN], { 'webssh.pass.c1': 'pwd-from-ls' });
  s.exportLocalData();
  const payload = JSON.parse(s.rec.blobs[0].parts.join(''));
  assert.equal(payload.conns[0].password, 'pwd-from-ls');
});

test('[导出] 未勾选保存密码时 password 为空字符串而不是 undefined', () => {
  const s = run([PWD_CONN], {});
  s.exportLocalData();
  const payload = JSON.parse(s.rec.blobs[0].parts.join(''));
  assert.equal(payload.conns[0].password, '');
});

test('[导出] 私钥与口令原样导出', () => {
  const s = run([KEY_CONN], {});
  s.exportLocalData();
  const payload = JSON.parse(s.rec.blobs[0].parts.join(''));
  assert.equal(payload.conns[0].privateKey, KEY_CONN.privateKey);
  assert.equal(payload.conns[0].passphrase, KEY_CONN.passphrase);
});

test('[导出] 下载走 blob URL,文件名带时间戳,类型为 JSON', () => {
  const s = run([PWD_CONN], { 'webssh.pass.c1': 'x' });
  s.exportLocalData();
  const d = s.rec.downloads[0];
  assert.match(d.download, /^webssh-conns-\d{8}-\d{6}\.json$/);
  assert.match(d.href, /^blob:/);
  assert.equal(s.rec.blobs[0].type, 'application/json;charset=utf-8');
  assert.deepEqual(s.rec.revoked, [], 'blob URL 不能在下载落地前就被回收');
  assert.equal(s.rec.timers.length, 1);
  assert.ok(s.rec.timers[0] >= 1000, 'revoke 延迟太短,可能打断下载');
});

// ============ 导入 ============

test('[导入] 合法备份写入 localStorage,密码拆回独立键、不进连接记录', () => {
  const s = runImport([], {}, backup([Object.assign({}, PWD_CONN, { password: 'pwd-x' })]));

  assert.equal(s.rec.pickers, 1, '应当弹出文件选择框');
  assert.equal(s.rec.alerts.length, 1, '应当只有一条结果提示,不该有报错');
  assert.match(s.rec.alerts[0], /导入完成:新增 1 条/);
  assert.equal(s.rec.confirms.length, 1);
  assert.match(s.rec.confirms[0], /将导入 1 条连接/);
  assert.equal(s.rec.persistCalls, 1, '应当落盘一次');
  assert.equal(s.rec.renders, 1, '应当重绘首页');

  const stored = JSON.parse(s.store[LS_KEY]);
  assert.equal(stored.length, 1);
  const c = stored[0];
  assert.equal(c.host, '1.2.3.4');
  assert.equal(c.user, 'root');
  assert.equal(c.hasPass, true);
  assert.equal(c.savePass, true);
  assert.ok(!('password' in c), '密码不该留在连接记录里');
  assert.equal(s.store[LS_PASS_PREFIX + c.id], 'pwd-x');
  assert.match(s.rec.alerts.join('\n') + s.rec.confirms.join('\n'), /导入 1 条/);
});

test('[导入] 重复连接被跳过,不重复堆', () => {
  const existing = Object.assign({}, PWD_CONN);
  const s = runImport([existing], { 'webssh.pass.c1': 'old' },
    backup([Object.assign({}, PWD_CONN, { password: 'new' })]));

  assert.deepEqual(s.rec.persistCalls, 0, '全部重复时不该落盘');
  assert.equal(s.rec.confirms.length, 0, '全部重复时不该弹确认框');
  assert.match(s.rec.alerts[0], /都已存在/);
  assert.equal(s.state.conns.length, 1, '不该新增记录');
  assert.equal(s.store['webssh.pass.c1'], 'old', '不该覆盖已有密码');
});

test('[导入] 部分重复时只导入新的', () => {
  const s = runImport([Object.assign({}, PWD_CONN)], { 'webssh.pass.c1': 'old' },
    backup([
      Object.assign({}, PWD_CONN, { password: 'ignored' }),
      Object.assign({}, KEY_CONN, { id: 'c9' }),
    ]));

  assert.match(s.rec.confirms[0], /导入 1 条.*跳过 1 条/);
  const stored = JSON.parse(s.store[LS_KEY]);
  assert.equal(stored.length, 2);
  assert.equal(s.store['webssh.pass.c1'], 'old', '已有连接的密码不该被动过');
});

test('[导入] id 冲突时重新分配,不覆盖已有记录', () => {
  const existing = Object.assign({}, PWD_CONN);           // id = c1
  const incoming = Object.assign({}, KEY_CONN, { id: 'c1', host: '9.9.9.9' });
  const s = runImport([existing], {}, backup([incoming]));

  const stored = JSON.parse(s.store[LS_KEY]);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].id, 'c1');
  assert.equal(stored[0].host, '1.2.3.4', '已有记录必须原样保留');
  assert.notEqual(stored[1].id, 'c1', '冲突的 id 应当换新');
  assert.equal(stored[1].host, '9.9.9.9');
});

test('[导入] 恢复私钥与口令', () => {
  const s = runImport([], {}, backup([KEY_CONN]));
  const c = JSON.parse(s.store[LS_KEY])[0];
  assert.equal(c.privateKey, KEY_CONN.privateKey);
  assert.equal(c.passphrase, KEY_CONN.passphrase);
  assert.equal(c.authType, 'key');
  assert.equal(c.hasPass, false);
});

test('[导入] 缺省字段被补齐,没有 host 的记录被丢弃', () => {
  const s = runImport([], {}, backup([
    { host: '10.0.0.1' },                                  // 只有 host
    { name: '没有主机', user: 'root' },                     // 应被丢弃
    null,                                                  // 应被丢弃
    { host: '10.0.0.2', port: 'not-a-number', authType: 'weird', user: null },
  ]));

  const stored = JSON.parse(s.store[LS_KEY]);
  assert.equal(stored.length, 2, '应当只留下两条有 host 的记录');
  assert.equal(stored[0].port, 22);
  assert.equal(stored[0].name, '10.0.0.1', 'name 缺省应当用 host');
  assert.equal(stored[0].authType, 'password');
  assert.equal(stored[1].port, 22, '非法端口回落到 22');
  assert.equal(stored[1].authType, 'password', '未知认证方式回落到密码');
  assert.equal(stored[1].user, '');
});

test('[导入] 非 Web SSH 备份被拒绝,不写任何数据', () => {
  const s = runImport([], {}, JSON.stringify({ app: 'other-tool', conns: [PWD_CONN] }));
  assert.equal(s.rec.persistCalls, 0);
  assert.equal(s.store[LS_KEY], undefined, '不该写入 localStorage');
  assert.match(s.rec.alerts[0], /不是 Web SSH 导出的备份/);
});

test('[导入] 非法 JSON 被拒绝', () => {
  const s = runImport([], {}, '{ 这不是 json');
  assert.equal(s.rec.persistCalls, 0);
  assert.match(s.rec.alerts[0], /不是合法的 JSON/);
});

test('[导入] 备份里没有可用记录时拒绝', () => {
  const s = runImport([], {}, backup([{ name: '无主机' }]));
  assert.equal(s.rec.persistCalls, 0);
  assert.match(s.rec.alerts[0], /没有可用的连接记录/);
});

test('[导入] 超过条数上限时拒绝', () => {
  const many = [];
  for (let i = 0; i < 501; i++) many.push({ host: 'h' + i, user: 'root' });
  const s = runImport([], {}, backup(many));
  assert.equal(s.rec.persistCalls, 0);
  assert.match(s.rec.alerts[0], /超过 500 条上限/);
});

test('[导入] 用户在确认框选取消时不写数据', () => {
  const s = runImport([], {}, backup([PWD_CONN]), { confirmAnswer: false });
  assert.equal(s.rec.confirms.length, 1);
  assert.equal(s.rec.persistCalls, 0, '取消后不该落盘');
  assert.equal(s.rec.renders, 0, '取消后不该重绘');
  assert.equal(s.state.conns.length, 0);
  assert.equal(s.store[LS_KEY], undefined);
});

test('[导入] 读取文件失败时报错而不是静默', () => {
  const s = run([], {});
  s.rec.nextFile = { name: 'x.json', text: '', __readError: true };
  s.importLocalData();
  assert.match(s.rec.alerts[0], /读取文件失败/);
  assert.equal(s.rec.persistCalls, 0);
});

// ============ 共同约束 ============

test('[导出+导入] 全程不发起任何网络请求', () => {
  const s = run([PWD_CONN], { 'webssh.pass.c1': 'x' });
  s.exportLocalData();
  s.rec.nextFile = { name: 'b.json', text: backup([PWD_CONN]) };
  s.importLocalData();
  assert.deepEqual(s.rec.alerts.filter((m) => m.indexOf('NETWORK:') === 0), [],
    '导出/导入过程中出现了网络调用');

  // 静态兜底:这段代码里不该出现任何网络 API
  const block = extractLocalDataBlock();
  for (const api of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'new WebSocket', 'navigator.']) {
    assert.equal(block.indexOf(api), -1, `代码块里出现了 ${api}`);
  }
});

test('[导出 -> 导入] 往返后连接记录等价', () => {
  const origin = { 'webssh.pass.c1': 'pwd-roundtrip' };
  const exp = run([PWD_CONN, KEY_CONN], origin);
  exp.exportLocalData();
  const file = exp.rec.blobs[0].parts.join('');

  const imp = runImport([], {}, file);
  const stored = JSON.parse(imp.store[LS_KEY]);
  assert.equal(stored.length, 2);

  const byId = {};
  stored.forEach((c) => { byId[c.id] = c; });
  for (const src of [PWD_CONN, KEY_CONN]) {
    for (const k of Object.keys(src)) {
      if (k === 'password') continue;
      assert.deepEqual(byId[src.id][k], src[k], `往返后字段 ${k} 不一致`);
    }
  }
  assert.equal(imp.store['webssh.pass.c1'], 'pwd-roundtrip', '密码应当回到独立键');
});
