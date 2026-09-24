/* Web SSH 前端 — 原生 JS,无构建。 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  var state = {
    view: 'home',          // home | term
    conns: loadConns(),    // [{id,name,host,port,user,authType,hasPass,savePass,keyName,passphrase,command}]
    active: null,          // {spec, token, fingerprint}
    term: null,
    ws: null,
    fit: null
  };

  // ---------- 存储 ----------
  var LS_KEY = 'webssh.conns.v1';
  var LS_PASS_PREFIX = 'webssh.pass.';
  var LS_PASS_SAVE = 'webssh.savePass';

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

  // ---------- 渲染 ----------
  var app = el('app');

  function renderHome() {
    state.view = 'home';
    if (state.term) { try { state.term.dispose(); } catch (e) {} state.term = null; }
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }

    var rows = state.conns.map(function (c) {
      var saved = c.savePass && getSavedPass(c.id);
      return '<div class="conn-card" data-id="' + esc(c.id) + '">' +
        '<div class="actions">' +
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

    app.innerHTML =
      '<div class="topbar"><span class="logo">Web<b>SSH</b></span>' +
      '<span class="spacer"></span>' +
      '<button class="btn primary" id="btn-new">+ 新建连接</button></div>' +
      '<div class="split">' +
      '<div class="sidebar">' +
      '<div class="field"><label>已保存连接(' + state.conns.length + ')</label>' +
      '<div class="conn-list">' + (rows || '<div class="muted">还没有保存的连接。点击右上角新建。</div>') + '</div>' +
      '</div></div>' +
      '<div class="main center muted" style="display:flex;align-items:center;justify-content:center">' +
      '<div><div style="font-size:40px;margin-bottom:12px">🖥</div>' +
      '<div>选择左侧连接,或新建一个 SSH 会话</div>' +
      '<div class="muted mt8" style="font-size:12px">凭据仅保存在本浏览器或内存中,连接即建即消</div></div>' +
      '</div></div>';

    // 事件
    el('btn-new').addEventListener('click', openEditor);
    app.querySelectorAll('.conn-card').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('.actions')) return; // 点按钮不触发连接
        connect(card.dataset.id);
      });
      card.querySelectorAll('.actions .btn').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var act = b.dataset.act;
          if (act === 'edit') openEditor(card.dataset.id);
          if (act === 'del') removeConn(card.dataset.id);
        });
      });
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
      '<div id="auth-key" class="field" style="display:none"><label>私钥(PEM)</label>' +
      '<textarea id="f-key" rows="6" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>' +
      '<div class="field" style="margin-top:8px"><label>私钥口令(可选)</label>' +
      '<input type="password" id="f-passphrase"></div></div>' +
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
      conn.keyName = privateKey.trim().slice(0, 40) + '…';
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

    app.innerHTML =
      '<div class="topbar">' +
      '<button class="btn" id="btn-back">‹ 返回</button>' +
      '<span class="conn-chip" id="chip">' + esc(spec.user) + '@' + esc(spec.host) + ':' + esc(spec.port || 22) + '</span>' +
      '<span class="spacer"></span>' +
      '<span id="status" class="muted" style="font-size:12px">连接中…</span>' +
      '<button class="btn primary" id="btn-recon" style="display:none">重连</button>' +
      '</div>' +
      '<div class="main" style="height:calc(100% - 54px)">' +
      '<div class="term-wrap"><div id="terminal"></div></div>' +
      '<div class="term-statusbar"><span class="dot" id="dot"></span><span id="sbar">正在建立 SSH 会话…</span></div>' +
      '</div>';

    el('btn-back').addEventListener('click', renderHome);

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
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
      theme: {
        background: '#0b0e12', foreground: '#d8dee6',
        cursor: '#4f8cff', selection: 'rgba(79,140,255,.3)',
        black: '#1f2430', red: '#ff6b6b', green: '#3fb950', yellow: '#d29922',
        blue: '#4f8cff', magenta: '#d381ff', cyan: '#39c5cf', white: '#d8dee6'
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

  // ---------- 启动 ----------
  renderHome();
})();