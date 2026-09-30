const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class EventTarget {
  constructor(tagName, type) {
    this.tagName = tagName.toUpperCase();
    this.type = type || '';
    this.value = '';
    this.listeners = new Map();
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatchEvent(event) {
    event.target = this;
    event.defaultPrevented = false;
    event.propagationStopped = false;
    event.preventDefault = () => { event.defaultPrevented = true; };
    event.stopPropagation = () => { event.propagationStopped = true; };
    for (const handler of this.listeners.get(event.type) || []) handler(event);
    if (!event.defaultPrevented && event.type === 'keydown' && event.key.length === 1) {
      this.value += event.key;
    }
    return !event.defaultPrevented;
  }
}

for (const [name, tag, type] of [
  ['普通文本框', 'input', 'text'],
  ['密码框', 'input', 'password'],
  ['编辑器 textarea', 'textarea', ''],
]) {
  test(`${name}中的小写 p 不被键盘监听器拦截`, () => {
    const field = new EventTarget(tag, type);
    const event = { type: 'keydown', key: 'p', code: 'KeyP' };
    assert.equal(field.dispatchEvent(event), true);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
    assert.equal(field.value, 'p');
  });
}

test('终端获得焦点时小写 p 通过 onData 发送到 WebSocket', () => {
  const appSource = fs.readFileSync('assets/js/app.js', 'utf8');
  assert.match(appSource, /term\.onData\(function \(data\) \{[\s\S]*?ws\.send\(data\)/);
  const sent = [];
  const ws = { readyState: 1, send(data) { sent.push(data); } };
  const WebSocket = { OPEN: 1 };
  const term = { onData(handler) { this.handler = handler; } };
  vm.runInNewContext('term.onData(function (data) { if (ws.readyState === WebSocket.OPEN) ws.send(data); });', { term, ws, WebSocket });
  term.handler('p');
  assert.deepEqual(sent, ['p']);
});
