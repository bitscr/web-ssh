/* Web SSH 前端 — 原生 JS,无构建。 */
(function () {
  'use strict';

  // ---------- 存储 ----------
  // 必须在初始化 state 前赋值，否则 loadConns() 首次执行时 LS_KEY 为 undefined。
  var LS_KEY = 'webssh.conns.v1';
  var LS_PASS_PREFIX = 'webssh.pass.';
  var LS_PASS_SAVE = 'webssh.savePass';

  // ---------- 状态 ----------
  var state = {
    view: 'home',          // home | term
    conns: loadConns(),    // [{id,name,host,port,user,authType,hasPass,savePass,keyName,privateKey,passphrase,command}]
    active: null,          // {spec, token, fingerprint}
    term: null,
    ws: null,
    fit: null,
    ftp: null              // {token, cwd, entries} SFTP 文件管理器状态
  };

  function loadConns() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function persistConns() {
    localStorage.setItem(LS_KEY, JSON.stringify(state.conns));
  }
  function savePassToLS(id, pass) {
    // 单独键存密码,配套 savePass 开关;关闭时清除
    localStorage.setItem(LS_PASS_PREFIX + id, pass);
  }
  function getSavedPass(id) {
    return localStorage.getItem(LS_PASS_PREFIX + id) || '';
  }
  function clearSavedPass(id) {
    localStorage.removeItem(LS_PASS_PREFIX + id);
  }

  // ---------- 工具 ----------
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function fmtSize(n) {
    if (n == null) return '-';
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(1) + ' ' + units[i];
  }
  function fmtTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts * 1000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ---------- 渲染 ----------
  var app = el('app');

  function renderHome() {
    state.view = 'home';
    if (state.term) { try { state.term.dispose(); } catch (e) {} state.term = null; }
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
    closeFtp(); // 回到首页时关闭文件管理器

    app.innerHTML =
      '<div class="topbar"><span class="logo">Web<b>SSH</b></span>' +
      '<span class="spacer"></span>' +
      '<button class="btn primary" id="btn-new">+ 新建连接</button></div>' +
      '<div class="split">' +
      '<div class="sidebar">' +
      '<div class="field"><label>已保存连接(' + state.conns.length + ')</label>' +
      '<div class="conn-list" id="conn-list">' + connListHtml() + '</div>' +
      '</div></div>' +
      '<div class="main home-main">' +
      homeFormHtml() +
      '</div>';

    // 事件
    el('btn-new').addEventListener('click', openEditor);
    bindConnList();
    bindHomeForm();
  }

  // 已保存连接列表 HTML
  function connListHtml() {
    if (!state.conns.length) return '<div class="muted">还没有保存的连接。</div>';
    return state.conns.map(function (c) {
      return '<div class="conn-card" data-id="' + esc(c.id) + '">' +
        '<div class="actions">' +
        '<button class="btn sm act-link" data-act="link" title="生成快捷链接">🔗</button>' +
        '<button class="btn sm act-edit" data-act="edit" title="编辑">✎</button>' +
        '<button class="btn sm danger act-del" data-act="del" title="删除">✕</button>' +
        '</div>' +
        '<div class="row1"><span class="name">' + esc(c.name || c.host) + '</span>' +
        (c.authType === 'key' ? '<span class="badge">密钥</span>' : '<span class="badge">密码</span>') +
        (c.command ? '<span class="badge">命令</span>' : '') +
        '</div>' +
        '<div class="host">' + esc(c.user) + '@' + esc(c.host) + ':' + esc(c.port || 22) + '</div>' +
        '</div>';
    }).join('');
  }

  // 主区平铺表单(透明背景,输入框不遮)
  function homeFormHtml() {
    return '<div class="home-form">' +
      '<div class="home-form-head"><h2>🚀 快速连接</h2>' +
      '<div class="muted" style="font-size:12px">填写连接信息,点击"连接"自动保存并新开标签页</div></div>' +
      '<div class="err-banner" id="home-err" style="display:none"></div>' +
      '<div class="home-form-grid">' +
      '<div class="field"><label>主机地址</label>' +
      '<input type="text" id="h-host" placeholder="example.com 或 1.2.3.4" autocomplete="off"></div>' +
      '<div class="field"><label>用户名</label>' +
      '<input type="text" id="h-user" value="root" autocomplete="off"></div>' +
      '<div class="field"><label>端口</label>' +
      '<input type="number" id="h-port" min="1" max="65535" value="22"></div>' +
      '</div>' +
      '<div class="field"><label>密码</label>' +
      '<input type="password" id="h-pass" autocomplete="new-password" placeholder="SSH 密码或私钥口令">' +
      '<div class="hint">凭据仅存于本浏览器 localStorage</div></div>' +
      '<div class="field"><label>认证方式</label>' +
      '<select id="h-auth"><option value="password">密码</option><option value="key">私钥</option></select></div>' +
      '<div id="h-keywrap" class="field" style="display:none"><label>私钥(PEM/OPENSSH)</label>' +
      '<input type="file" id="h-keyfile" accept=".pem,.key,.ppk,.id_rsa,.id_ed25519">' +
      '<textarea id="h-key" rows="5" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style="margin-top:6px"></textarea>' +
      '<div class="field" style="margin-top:6px"><label>私钥口令(可选)</label>' +
      '<input type="password" id="h-passphrase" autocomplete="new-password"></div></div>' +
      '<div class="field"><label>初始命令(可选)</label>' +
      '<input type="text" id="h-cmd" placeholder="例如:cd /var/www && ls" autocomplete="off"></div>' +
      '<label class="checkline"><input type="checkbox" id="h-savepass" checked> 记住密码</label>' +
      '<div class="home-form-actions">' +
      '<button class="btn primary btn-lg" id="h-connect">连接并在新标签页打开 ⤴</button>' +
      '</div></div>';
  }

  function bindHomeForm() {
    el('h-auth').addEventListener('change', function () {
      var key = el('h-auth').value === 'key';
      el('h-keywrap').style.display = key ? '' : 'none';
    });
    var kf = el('h-keyfile');
    if (kf) kf.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () { el('h-key').value = reader.result; };
      reader.readAsText(file);
    });
    el('h-connect').addEventListener('click', quickConnect);
    // 回车提交
    ['h-host', 'h-user', 'h-port', 'h-pass', 'h-cmd', 'h-passphrase'].forEach(function (id) {
      el(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') quickConnect(); });
    });
  }

  // 主区快速连接:保存(成功连上后)→ 新标签页打开 → 表单文字保留
  function quickConnect() {
    var errBox = el('home-err');
    errBox.style.display = 'none';
    var host = el('h-host').value.trim();
    var user = el('h-user').value.trim() || 'root';
    var port = parseInt(el('h-port').value, 10) || 22;
    var authType = el('h-auth').value;
    var password = el('h-pass').value;
    var privateKey = el('h-key').value;
    var passphrase = el('h-passphrase').value;
    var command = el('h-cmd').value.trim();
    var savePass = el('h-savepass').checked;

    if (!host) { showErr(errBox, '主机地址不能为空'); return; }
    if (authType === 'password' && !password) { showErr(errBox, '密码不能为空'); return; }
    if (authType === 'key' && !privateKey.trim()) { showErr(errBox, '私钥不能为空'); return; }

    // 先建会话验证凭据(成功才保存)
    var spec = {
      name: host, host: host, port: port, user: user,
      authType: authType, command: command
    };
    if (authType === 'key') {
      spec.privateKey = privateKey; spec.passphrase = passphrase || '';
    } else {
      spec.password = password;
    }

    fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec)
    }).then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.j.error || '连接失败');

        // 保存连接到左侧列表
        var conn = {
          id: uid(), name: host, host: host, port: port, user: user,
          authType: authType, command: command,
          savePass: savePass
        };
        if (authType === 'password') {
          conn.hasPass = !!password;
          if (savePass && password) savePassToLS(conn.id, password);
          if (!savePass) clearSavedPass(conn.id);
        } else {
          conn.hasPass = false;
          conn.privateKey = privateKey; // 内存态
          conn.passphrase = passphrase;
        }
        state.conns.push(conn);
        persistConns();

        // 刷新左侧列表,表单文字保留
        var list = el('conn-list');
        if (list) { list.innerHTML = connListHtml(); bindConnList(); }

        // 新标签页打开终端(带 spec,但凭据已含)
        var proto = location.protocol === 'https:' ? 'wss' : 'ws';
        var url = location.origin + location.pathname + '#conn=' + encodeURIComponent(JSON.stringify({
          host: host, port: port, user: user, authType: authType,
          password: password, privateKey: privateKey, passphrase: passphrase, command: command
        }));
        var w = window.open(url, '_blank');
        if (!w) { alert('浏览器阻止了新窗口打开,请允许弹窗'); return; }
      })
      .catch(function (err) {
        showErr(errBox, '连接失败: ' + err.message);
      });
  }

  function openEditor(id) {
    var existing = id ? state.conns.find(function (c) { return c.id === id; }) : null;
    var f = existing || { host: '', port: 22, user: 'root', authType: 'password', savePass: true, command: '' };
    var savedPass = existing && existing.savePass ? getSavedPass(existing.id) : '';

    var html =
      '<div class="screen open" id="editor-screen"><div class="card">' +
      '<h3>' + (existing ? '编辑连接' : '新建连接') + '</h3>' +
      '<div class="err-banner" id="editor-err" style="display:none"></div>' +
      '<div class="field"><label>名称(可留空,默认用主机名)</label>' +
      '<input type="text" id="f-name" placeholder="例如:我的 VPS" value="' + esc(f.name || '') + '"></div>' +
      '<div class="field"><label>主机地址</label>' +
      '<input type="text" id="f-host" placeholder="example.com 或 1.2.3.4" value="' + esc(f.host) + '"></div>' +
      '<div class="field" style="display:flex;gap:10px"><div style="flex:1"><label>用户名</label>' +
      '<input type="text" id="f-user" value="' + esc(f.user || 'root') + '"></div>' +
      '<div style="width:110px"><label>端口</label><input type="number" id="f-port" min="1" max="65535" value="' + esc(f.port || 22) + '"></div></div>' +
      '<div class="field"><label>认证方式</label>' +
      '<select id="f-auth"><option value="password"' + (f.authType !== 'key' ? ' selected' : '') + '>密码</option>' +
      '<option value="key"' + (f.authType === 'key' ? ' selected' : '') + '>私钥</option></select></div>' +
      '<div id="auth-pass" class="field"><label>密码</label>' +
      '<input type="password" id="f-pass" autocomplete="new-password" value="' + esc(savedPass) + '">' +
      '<div class="hint">密码仅存于本浏览器 localStorage,点击连接时才会发送到本服务</div></div>' +
      '<div id="auth-key" class="field" style="display:' + (f.authType === 'key' ? '' : 'none') + '"><label>私钥(PEM/OPENSSH)</label>' +
      '<div class="hint">粘贴私钥内容,或选择本机私钥文件自动填入</div>' +
      '<input type="file" id="f-keyfile" accept=".pem,.key,.ppk,.id_rsa,.id_ed25519" style="margin-bottom:6px">' +
      '<textarea id="f-key" rows="6" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----">' + esc(f.privateKey || '') + '</textarea>' +
      '<div class="field" style="margin-top:8px;display:flex;gap:8px"><div style="flex:1"><label>私钥口令(可选)</label>' +
      '<input type="password" id="f-passphrase" value="' + esc(f.passphrase || '') + '"></div>' +
      '<div style="width:130px;align-self:flex-end"><label>&nbsp;</label>' +
      '<button type="button" class="btn sm" id="f-key-clear" style="width:100%">清空</button></div></div></div>' +
      '<div class="field"><label>登录后自动执行命令(可选)</label>' +
      '<input type="text" id="f-cmd" placeholder="例如:cd /var/www && ls" value="' + esc(f.command || '') + '"></div>' +
      '<label class="checkline"><input type="checkbox" id="f-savepass"' + (f.savePass ? ' checked' : '') + '> 保存凭据到本浏览器</label>' +
      '<div class="footer">' +
      '<button class="btn" id="f-cancel">取消</button>' +
      '<button class="btn primary" id="f-conn">' + (existing ? '保存' : '连接') + '</button>' +
      '</div></div></div>';

    // 插入屏幕层
    var old = el('editor-screen'); if (old) old.remove();
    var div = document.createElement('div');
    div.innerHTML = html;
    app.appendChild(div.firstChild);

    el('f-auth').addEventListener('change', function () {
      var key = el('f-auth').value === 'key';
      el('auth-pass').style.display = key ? 'none' : '';
      el('auth-key').style.display = key ? '' : 'none';
    });
    el('f-cancel').addEventListener('click', function () { el('editor-screen').remove(); });
    el('f-conn').addEventListener('click', function () { submitEditor(existing); });

    // 选择本地私钥文件 → 自动读入 textarea
    var kf = el('f-keyfile');
    if (kf) {
      kf.addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () { el('f-key').value = reader.result; };
        reader.readAsText(file);
      });
    }
    // 清空私钥与口令
    var kc = el('f-key-clear');
    if (kc) {
      kc.addEventListener('click', function () {
        el('f-key').value = '';
        el('f-passphrase').value = '';
      });
    }
  }

  function submitEditor(existing) {
    var errBox = el('editor-err');
    errBox.style.display = 'none';
    var host = el('f-host').value.trim();
    var user = el('f-user').value.trim();
    var port = parseInt(el('f-port').value, 10) || 22;
    var authType = el('f-auth').value;
    var password = el('f-pass').value;
    var privateKey = el('f-key').value;
    var passphrase = el('f-passphrase').value;
    var command = el('f-cmd').value.trim();
    var name = el('f-name').value.trim() || host;
    var savePass = el('f-savepass').checked;

    if (!host) { showErr(errBox, '主机地址不能为空'); return; }
    if (!user) { showErr(errBox, '用户名不能为空'); return; }
    if (authType === 'password' && !password) { showErr(errBox, '密码不能为空'); return; }
    if (authType === 'key' && !privateKey.trim()) { showErr(errBox, '私钥不能为空'); return; }

    var conn = {
      id: existing ? existing.id : uid(),
      name: name, host: host, port: port, user: user,
      authType: authType,
      command: command,
      savePass: savePass
    };
    if (authType === 'password') {
      conn.hasPass = !!password;
      if (savePass && password) savePassToLS(conn.id, password);
      if (!savePass) clearSavedPass(conn.id);
      // password 不进 conns 记录(不落 localStorage),会话时再取
    } else {
      conn.hasPass = false;
      conn.keyName = privateKey.trim().slice(0, 40) + '...';
      conn.privateKey = privateKey;           // 内存态,不持久化
      conn.passphrase = passphrase;
    }

    if (existing) {
      var i = state.conns.findIndex(function (c) { return c.id === existing.id; });
      if (i >= 0) state.conns[i] = conn; else state.conns.push(conn);
    } else {
      state.conns.push(conn);
    }
    persistConns();
    el('editor-screen').remove();

    // 保存后立即连接(新建时);编辑时留在列表
    if (!existing) { connect(conn.id); }
    else { renderHome(); }
  }

  function showErr(box, msg) { box.textContent = msg; box.style.display = 'block'; }

  function removeConn(id) {
    if (!confirm('删除该连接?')) return;
    clearSavedPass(id);
    state.conns = state.conns.filter(function (c) { return c.id !== id; });
    persistConns();
    renderHome();
  }

  function bindConnList() {
    app.querySelectorAll('.conn-card').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('.actions')) return; // 点按钮不触发连接
        openConnNewTab(card.dataset.id);
      });
      card.querySelectorAll('.actions .btn').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var act = b.dataset.act;
          if (act === 'link') genLink(card.dataset.id);
          if (act === 'edit') openEditor(card.dataset.id);
          if (act === 'del') removeConn(card.dataset.id);
        });
      });
    });
  }

  // 新标签页打开已保存连接
  function openConnNewTab(id) {
    var conn = state.conns.find(function (c) { return c.id === id; });
    if (!conn) return;
    var spec = { host: conn.host, port: conn.port, user: conn.user, authType: conn.authType, command: conn.command || '' };
    if (conn.authType === 'key') {
      spec.privateKey = conn.privateKey || ''; spec.passphrase = conn.passphrase || '';
    } else {
      spec.password = conn.savePass ? getSavedPass(id) : '';
    }
    var url = location.origin + location.pathname + '#conn=' + encodeURIComponent(JSON.stringify(spec));
    var w = window.open(url, '_blank');
    if (!w) alert('浏览器阻止了新窗口打开,请允许弹窗');
  }

  // ---------- 快捷链接 ----------
  // 生成形如 ?host=&user=&port=&pass=<b64>&cmd= 的链接;打开即自动连接。
  // 密钥方式不支持(与 eooce/webssh 一致):私钥 DLL 后太长且不便共享。
  function genLink(id) {
    var conn = state.conns.find(function (c) { return c.id === id; });
    if (!conn) return;
    if (conn.authType === 'key') {
      alert('密钥方式登录不支持生成快捷链接,请改用密码方式登录');
      return;
    }
    var pass = conn.savePass ? getSavedPass(id) : '';
    if (!pass) {
      pass = prompt('输入 ' + conn.host + ' 的密码(将包含在链接中):');
      if (!pass) return;
    }
    var params = new URLSearchParams();
    params.set('host', conn.host);
    params.set('user', conn.user);
    params.set('port', conn.port || 22);
    params.set('pass', btoa(unescape(encodeURIComponent(pass)))); // UTF-8 安全 btoa
    if (conn.command) params.set('cmd', conn.command);

    var url = location.origin + location.pathname + '?' + params.toString();
    showLinkDialog(url);
  }

  function showLinkDialog(url) {
    var html =
      '<div class="screen open" id="link-screen"><div class="card">' +
      '<h3>🔗 快捷链接</h3>' +
      '<div class="err-banner" id="link-err" style="display:none"></div>' +
      '<div class="field"><label>复制此链接,任何人在浏览器打开即可直接连接:</label>' +
      '<input type="text" id="link-url" readonly value="' + esc(url) + '" style="font-family:monospace;font-size:12px">' +
      '<div class="hint">⚠️ 链接含明文密码(base64 编码),请勿在不可信渠道传播</div></div>' +
      '<div class="footer">' +
      '<button class="btn" id="link-cancel">关闭</button>' +
      '<button class="btn primary" id="link-copy">复制链接</button>' +
      '</div></div></div>';

    var old = el('link-screen'); if (old) old.remove();
    var div = document.createElement('div');
    div.innerHTML = html;
    app.appendChild(div.firstChild);

    el('link-cancel').addEventListener('click', function () { el('link-screen').remove(); });
    el('link-copy').addEventListener('click', function () {
      var input = el('link-url');
      input.select();
      try {
        navigator.clipboard.writeText(url).then(function () {
          var b = el('link-err');
          b.textContent = '已复制!'; b.style.display = 'block'; b.style.background = '#14331c'; b.style.color = '#7ee2a8'; b.style.borderColor = '#2e5a3b';
        }).catch(function () {
          document.execCommand('copy');
        });
      } catch (e) {
        document.execCommand('copy');
      }
    });
  }

  // 启动时解析 URL query 自动连接:?host=&user=&port=&pass=[b64]&cmd=
  function connectFromUrl() {
    var q = new URLSearchParams(location.search);
    var host = q.get('host'), user = q.get('user'), pass = q.get('pass');
    if (!host || !user || !pass) return;
    var port = parseInt(q.get('port'), 10) || 22;
    try {
      pass = decodeURIComponent(escape(atob(pass))); // base64 → UTF-8
    } catch (e) { /* pass 原样 */ }
    var spec = {
      name: q.get('name') || host,
      host: host, port: port, user: user,
      authType: 'password', password: pass,
      command: q.get('cmd') || ''
    };
    // 清掉 URL 里的凭据,避免留在地址栏/历史
    history.replaceState(null, '', location.pathname);
    openTerminal(spec, { id: 'url', authType: 'password', savePass: false });
  }

  // ---------- 连接 ----------
  function connect(id) {
    var conn = state.conns.find(function (c) { return c.id === id; });
    if (!conn) return;

    // 组装连接规范
    var spec = {
      name: conn.name,
      host: conn.host,
      port: conn.port,
      user: conn.user
    };
    if (conn.authType === 'key') {
      spec.authType = 'key';
      spec.privateKey = conn.privateKey;   // 内存
      spec.passphrase = conn.passphrase || '';
    } else {
      spec.authType = 'password';
      spec.password = conn.savePass ? getSavedPass(id) : sessionPwd(id);
      if (!spec.password) { alert('没有该连接的密码(未保存凭据)。请编辑连接并输入密码。'); openEditor(id); return; }
    }

    // 进入连接中界面
    openTerminal(spec, conn);
  }

  // 临时输入的密码(未勾选保存时,每次连接弹窗输入)
  var sessionPwdMap = {};
  function sessionPwd(id) {
    if (sessionPwdMap[id] !== undefined) return sessionPwdMap[id];
    var p = prompt('输入 ' + id + ' 的 SSH 密码:');
    sessionPwdMap[id] = p || '';
    return sessionPwdMap[id];
  }

  function openTerminal(spec, conn) {
    state.view = 'term';
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
    // 桌面宽屏 → 右侧常驻 SFTP 面板;移动端 → 顶栏文件按钮走弹窗
    var desktop = window.innerWidth >= 900;
    // 顶栏:桌面隐藏"文件"按钮(右栏常驻),移动端保留
    var filesBtn = desktop ? '' :
      '<button class="btn" id="btn-files" title="SFTP 文件管理">📁 文件</button>';

    app.innerHTML =
      '<div class="topbar">' +
      '<button class="btn" id="btn-back">‹ 返回</button>' +
      '<span class="conn-chip" id="chip">' + esc(spec.user) + '@' + esc(spec.host) + ':' + esc(spec.port || 22) + '</span>' +
      filesBtn +
      '<span class="spacer"></span>' +
      '<span id="status" class="muted" style="font-size:12px">连接中...</span>' +
      '<button class="btn primary" id="btn-recon" style="display:none">重连</button>' +
      '</div>' +
      '<div class="main" style="height:calc(100% - 54px)">' +
      '<div class="term-col">' +
      '<div class="term-wrap"><div id="terminal"></div></div>' +
      '<div class="term-statusbar"><span class="dot" id="dot"></span><span id="sbar">正在建立 SSH 会话...</span></div>' +
      '</div>' +
      (desktop ? '<div class="sftp-pane" id="sftp-pane"><div class="ftp-embed" id="ftp-embed"></div></div>' : '') +
      '</div>';

    el('btn-back').addEventListener('click', renderHome);
    if (!desktop) {
      el('btn-files').addEventListener('click', function () { openFileManager(spec, false); });
    }
    // 桌面端:SSH 会话建立的同时,右侧面板自动初始化 SFTP
    if (desktop) { openFileManager(spec, true); }

    // 建会话
    fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec)
    }).then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.j.error || '会话创建失败');
        var sess = r.j;
        // 首次连接拿到指纹,回存到 conn(后续自动强校验)
        state.active = { spec: spec, token: sess.token, fingerprint: sess.fingerprint };
        startTerminal(sess);
      })
      .catch(function (err) {
        setStatus('连接失败: ' + err.message, true);
        el('btn-recon').style.display = '';
        el('btn-recon').onclick = function () { openTerminal(spec, conn); };
      });
  }

  function startTerminal(sess) {
    var termEl = el('terminal');
    if (!termEl) return;

    var term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 16,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
      theme: {
        background: '#182431', foreground: '#edf3f8',
        cursor: '#72a7ff', selection: 'rgba(114,167,255,.35)',
        black: '#2a3948', red: '#ff7b7b', green: '#55c96a', yellow: '#e2ad3b',
        blue: '#72a7ff', magenta: '#dd96ff', cyan: '#55d5dd', white: '#edf3f8'
      },
      scrollback: 8000
    });
    var fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(termEl);
    fit.fit();
    term.focus();
    state.term = term;
    state.fit = fit;

    // WS 地址
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var ws = new WebSocket(proto + '://' + location.host + '/ws/term?token=' + encodeURIComponent(sess.token));
    state.ws = ws;

    // 应用层心跳:每 20s 发一个文本帧,防止浏览器后台标签页/节能模式
    // 暂停 Pong(或反向代理吞掉 WS 控制帧)导致服务端误判断线。
    var hbTimer = setInterval(function () {
      if (ws.readyState === WebSocket.OPEN) ws.send('p');
    }, 20000);
    ws.addEventListener('close', function () { clearInterval(hbTimer); });

    ws.onopen = function () {
      setStatus('已连接 ' + sess.host, false);
      var r = term.rows, c = term.cols;
      ws.send('r:' + r + ':' + c);
      // 初始命令
      if (state.active.spec.command) {
        setTimeout(function () { ws.send(state.active.spec.command + '\r'); }, 800);
      }
    };
    ws.onmessage = function (ev) {
      // 服务端心跳是 WebSocket 协议级 ping,这里收到的都是终端输出
      if (typeof ev.data === 'string' || ev.data instanceof Blob) {
        var data = ev.data;
        if (data instanceof Blob) {
          data.arrayBuffer().then(function (ab) { term.write(new Uint8Array(ab)); });
        } else {
          term.write(data);
        }
      }
    };
    ws.onclose = function () {
      setStatus('连接已断开', true);
      el('btn-recon').style.display = '';
      el('btn-recon').onclick = function () { openTerminal(state.active.spec, connFor(state.active.spec)); };
    };
    ws.onerror = function () { setStatus('WebSocket 错误', true); };

    // 输入 → WS
    term.onData(function (data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    // 尺寸同步
    window.addEventListener('resize', fitTerm);
    function fitTerm() {
      try { fit.fit(); } catch (e) {}
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('r:' + term.rows + ':' + term.cols);
      }
    }
    fitTerm();
  }

  function connFor(spec) {
    return state.conns.find(function (c) {
      return c.host === spec.host && c.user === spec.user && c.port === spec.port;
    });
  }

  function setStatus(msg, isErr) {
    var s = el('status'); if (s) s.textContent = msg;
    var dot = el('dot'); if (dot) dot.className = 'dot' + (isErr ? ' err' : '');
    var sbar = el('sbar'); if (sbar) sbar.textContent = msg;
  }

  // ---------- SFTP 文件管理器 ----------
  // embedded=true:渲染进右侧面板(桌面);false:全屏弹窗(移动端)
  function openFileManager(spec, embedded) {
    embedded = embedded || false;
    // 已建立过会话就复用
    if (state.ftp && state.ftp.token) {
      renderFtp();
      return;
    }

    // 渲染容器:桌面右侧面板 / 移动弹窗
    var container;
    if (embedded) {
      container = el('ftp-embed');
      if (!container) return;
      container.innerHTML =
        '<div class="ftp-embed-head"><h3>📁 SFTP</h3>' +
        '<span class="muted" style="font-size:11px">' + (spec.user || '') + '@' + (spec.host || '') + '</span>' +
        '<span class="spacer"></span>' +
        '<button class="btn sm" id="ftp-refresh">⟳</button></div>' +
        '<div class="err-banner" id="ftp-err" style="display:none"></div>' +
        '<div class="ftp-toolbar">' +
        '<button class="btn sm" id="ftp-up">⬆</button>' +
        '<button class="btn sm" id="ftp-newdir">+ 目录</button>' +
        '<button class="btn sm primary" id="ftp-upload">⬆ 上传</button>' +
        '<span class="spacer"></span>' +
        '<input type="file" id="ftp-fileinput" style="display:none" multiple>' +
        '</div>' +
        '<div class="ftp-pathrow"><span class="muted">路径</span>' +
        '<input type="text" id="ftp-path" class="ftp-path-input" spellcheck="false" autocomplete="off" placeholder="/">' +
        '</div>' +
        '<div class="ftp-body" id="ftp-body"><div class="muted" style="padding:16px">连接中...</div></div>';
    } else {
      var html =
        '<div class="screen open" id="ftp-screen"><div class="card ftp-card">' +
        '<div class="ftp-head"><h3>📁 SFTP 文件管理</h3>' +
        '<span class="muted" style="font-size:12px">' + (spec.user || '') + '@' + (spec.host || '') + '</span>' +
        '<span class="spacer"></span>' +
        '<button class="btn sm" id="ftp-close">✕</button></div>' +
        '<div class="err-banner" id="ftp-err" style="display:none"></div>' +
        '<div class="ftp-toolbar">' +
        '<button class="btn sm" id="ftp-up">⬆ 上级</button>' +
        '<button class="btn sm" id="ftp-refresh">⟳ 刷新</button>' +
        '<button class="btn sm" id="ftp-newdir">+ 新建目录</button>' +
        '<button class="btn sm primary" id="ftp-upload">⬆ 上传</button>' +
        '<span class="spacer"></span>' +
        '<input type="file" id="ftp-fileinput" style="display:none" multiple>' +
        '</div>' +
        '<div class="ftp-pathrow"><span class="muted">路径</span>' +
        '<input type="text" id="ftp-path" class="ftp-path-input" spellcheck="false" autocomplete="off" placeholder="/">' +
        '</div>' +
        '<div class="ftp-body" id="ftp-body"><div class="muted" style="padding:20px">连接中...</div></div>' +
        '</div></div>';
      var old = el('ftp-screen'); if (old) old.remove();
      var div = document.createElement('div');
      div.innerHTML = html;
      app.appendChild(div.firstChild);
    }

    // 事件绑定(两模式共用选择器)
    var refreshBtn = el('ftp-refresh'), upBtn = el('ftp-up'), newdirBtn = el('ftp-newdir'),
      uploadBtn = el('ftp-upload'), fileInput = el('ftp-fileinput'), closeBtn = el('ftp-close'),
      pathInput = el('ftp-path');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { ftpList(state.ftp && state.ftp.cwd); });
    if (upBtn) upBtn.addEventListener('click', function () {
      var p = (state.ftp && state.ftp.cwd) || '/';
      var up = p.replace(/\/+$/, '');
      var idx = up.lastIndexOf('/');
      ftpList(idx > 0 ? up.slice(0, idx) : '/');
    });
    if (newdirBtn) newdirBtn.addEventListener('click', function () {
      var name = prompt('新目录名:');
      if (!name) return;
      var target = ((state.ftp && state.ftp.cwd) || '/') + '/' + name;
      ftpApi('POST', '/api/sftp/mkdir', { path: target, token: state.ftp.token })
        .then(function () { ftpList(state.ftp.cwd); })
        .catch(function (err) { showFtpErr(err.message); });
    });
    if (uploadBtn) uploadBtn.addEventListener('click', function () { fileInput.click(); });
    if (fileInput) fileInput.addEventListener('change', function (e) {
      var files = e.target.files;
      if (!files || !files.length) return;
      ftpUploadFiles(files);
      e.target.value = '';
    });
    if (closeBtn) closeBtn.addEventListener('click', closeFtp);
    // 路径输入框:回车直达
    if (pathInput) pathInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var v = pathInput.value.trim();
      if (!v) return;
      ftpList(v);
    });

    // 建立 SFTP 会话(复用当前连接凭据)
    if (!state.ftp || !state.ftp.token) {
      fetch('/api/sftp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec)
      }).then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
        .then(function (r) {
          if (!r.ok) throw new Error(r.j.error || 'SFTP 连接失败');
          state.ftp = { token: r.j.token, cwd: '/', entries: [], embedded: embedded };
          ftpList('/');
        })
        .catch(function (err) { showFtpErr(err.message); });
    }
  }

  function closeFtp() {
    var scr = el('ftp-screen'); if (scr) scr.remove();
    // 嵌入式面板:清空容器内容
    var emb = el('ftp-embed'); if (emb) emb.innerHTML = '';
    state.ftp = null;
    state.ftpEmbed = false;
  }

  function renderFtp() {
    var body = el('ftp-body');
    if (!body) return;
    var ftp = state.ftp || { cwd: '/', entries: [] };
    var pathInput = el('ftp-path');
    if (pathInput) pathInput.value = ftp.cwd || '/';
    if (!ftp.entries || !ftp.entries.length) {
      body.innerHTML = '<div class="muted" style="padding:16px">空目录</div>';
      return;
    }
    var rows = ftp.entries.map(function (e) {
      var icon = e.isDir ? '📁' : '📄';
      return '<div class="ftp-row' + (e.isDir ? ' dir' : '') + '" data-path="' + esc(e.path) + '" data-dir="' + e.isDir + '">' +
        '<span class="ftp-icon">' + icon + '</span>' +
        '<span class="ftp-name">' + esc(e.name) + '</span>' +
        '<span class="ftp-size">' + (e.isDir ? '-' : fmtSize(e.size)) + '</span>' +
        '<span class="ftp-time">' + fmtTime(e.modTime) + '</span>' +
        '<span class="ftp-actions">' +
        (e.isDir ? '' : '<button class="btn sm" data-act="download">⬇</button>') +
        '<button class="btn sm" data-act="rename">✎</button>' +
        '<button class="btn sm danger" data-act="del">✕</button>' +
        '</span></div>';
    }).join('');
    body.innerHTML = '<div class="ftp-headrow"><span class="h-icon"></span><span class="h-name">名称</span><span class="h-size">大小</span><span class="h-time">修改时间</span><span class="h-actions">操作</span></div>' + rows;

    body.querySelectorAll('.ftp-row').forEach(function (row) {
      var path = row.dataset.path, isDir = row.dataset.dir === 'true';
      row.addEventListener('click', function (e) {
        if (e.target.closest('.ftp-actions')) return;
        if (isDir) ftpList(path);
      });
      row.querySelectorAll('.ftp-actions .btn').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var act = b.dataset.act;
          if (act === 'download') ftpDownload(path);
          if (act === 'rename') ftpRename(path);
          if (act === 'del') ftpDelete(path);
        });
      });
    });
  }

  function ftpList(dir) {
    var ftp = state.ftp; if (!ftp) return;
    var body = el('ftp-body');
    if (body) body.innerHTML = '<div class="muted" style="padding:16px">加载中...</div>';
    ftpApi('GET', '/api/sftp/list?token=' + encodeURIComponent(ftp.token) + '&path=' + encodeURIComponent(dir || ''))
      .then(function (j) {
        ftp.cwd = j.path || dir || '/';
        ftp.entries = j.entries || [];
        if (el('ftp-body')) renderFtp();
      })
      .catch(function (err) { showFtpErr(err.message); });
  }

  function ftpApi(method, url, body) {
    var opts = { method: method };
    if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (res) {
      return res.json().then(function (j) {
        if (!res.ok) throw new Error(j.error || '请求失败');
        return j;
      });
    });
  }

  function ftpDownload(path) {
    var ftp = state.ftp; if (!ftp) return;
    // 新标签页打开下载,不覆盖当前页面
    var url = '/api/sftp/download?token=' + encodeURIComponent(ftp.token) + '&path=' + encodeURIComponent(path);
    window.open(url, '_blank');
  }

  function ftpDelete(path) {
    if (!confirm('删除 ' + path + ' ?')) return;
    ftpApi('POST', '/api/sftp/delete', { path: path, token: state.ftp.token })
      .then(function () { ftpList(state.ftp.cwd); })
      .catch(function (err) { showFtpErr(err.message); });
  }

  function ftpRename(path) {
    var newName = prompt('新名称(可含路径):', path.split('/').pop());
    if (!newName) return;
    var dir = path.slice(0, path.lastIndexOf('/') + 1);
    ftpApi('POST', '/api/sftp/rename', { old: path, new: dir + newName, token: state.ftp.token })
      .then(function () { ftpList(state.ftp.cwd); })
      .catch(function (err) { showFtpErr(err.message); });
  }

  function ftpUploadFiles(files) {
    var ftp = state.ftp; if (!ftp) return;
    var dir = ftp.cwd || '/';
    Array.prototype.forEach.call(files, function (file) {
      var fd = new FormData();
      fd.append('file', file);
      fd.append('dir', dir);
      fd.append('token', ftp.token);
      fetch('/api/sftp/upload', { method: 'POST', body: fd })
        .then(function (res) { return res.json(); })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || '上传失败');
          ftpList(ftp.cwd);
        })
        .catch(function (err) { showFtpErr(err.message); });
    });
  }

  function showFtpErr(msg) {
    var b = el('ftp-err');
    if (b) { b.textContent = msg; b.style.display = 'block'; setTimeout(function () { b.style.display = 'none'; }, 5000); }
    else alert(msg);
  }

  // ---------- 启动 ----------
  // 优先级:#conn=(新标签页传参) > ?host=(快捷链接) > 首页
  var hashConn = null;
  var m = location.hash.match(/#conn=([^&]+)/);
  if (m) {
    try { hashConn = JSON.parse(decodeURIComponent(m[1])); } catch (e) { hashConn = null; }
  }
  if (hashConn && hashConn.host && hashConn.user && (hashConn.password || hashConn.privateKey)) {
    var hspec = {
      name: hashConn.name || hashConn.host,
      host: hashConn.host, port: hashConn.port || 22, user: hashConn.user,
      authType: hashConn.authType || 'password', command: hashConn.command || ''
    };
    if (hspec.authType === 'key') { hspec.privateKey = hashConn.privateKey || ''; hspec.passphrase = hashConn.passphrase || ''; }
    else { hspec.password = hashConn.password || ''; }
    history.replaceState(null, '', location.pathname); // 清哈希
    openTerminal(hspec, { id: 'hash', authType: hspec.authType, savePass: false });
  } else if (new URLSearchParams(location.search).get('host')) {
    connectFromUrl(); // 快捷链接直达
  } else {
    renderHome();
  }
})();