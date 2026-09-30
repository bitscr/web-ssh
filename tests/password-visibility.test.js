'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const passwordVisibility = require('../assets/js/password-visibility.js');

class FakeElement {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName.toUpperCase();
    this.type = attrs.type || '';
    this.className = attrs.className || '';
    this.title = '';
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.parentNode = null;
    this.ownerDocument = null;
    this.dataset = {};
    this.innerHTML = '';
  }

  appendChild(child) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'type') this.type = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'title') this.title = String(value);
  }

  getAttribute(name) {
    if (name === 'type') return this.type;
    if (name === 'class') return this.className;
    if (name === 'title') return this.title;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const matches = (node) => {
      if (selector === 'input[type="password"]') return node.tagName === 'INPUT' && node.type === 'password';
      if (selector === '.password-toggle') return node.className.split(/\s+/).includes('password-toggle');
      return false;
    };
    const visit = (node) => {
      for (const child of node.children) {
        if (matches(child)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super('#document');
    this.ownerDocument = this;
  }

  createElement(tagName) {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  }
}

function fixture() {
  const document = new FakeDocument();
  const root = document.createElement('form');
  const input = document.createElement('input');
  input.type = 'password';
  root.appendChild(input);
  document.appendChild(root);
  return { document, root, input };
}

test('enhances a password input and toggles visibility and accessibility state', () => {
  const { root, input } = fixture();
  passwordVisibility.enhancePasswordFields(root);

  const button = root.querySelector('.password-toggle');
  assert.ok(button, 'a visibility button should be added');
  assert.equal(button.type, 'button', 'button must not submit the form');
  assert.equal(input.type, 'password');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.getAttribute('aria-label'), '显示密码');
  assert.equal(button.title, '显示密码');
  assert.match(button.innerHTML, /password-eye-closed/);

  button.dispatchEvent({ type: 'click', preventDefault() {} });
  assert.equal(input.type, 'text');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), '隐藏密码');
  assert.equal(button.title, '隐藏密码');
  assert.match(button.innerHTML, /password-eye-open/);

  button.dispatchEvent({ type: 'click', preventDefault() {} });
  assert.equal(input.type, 'password');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.match(button.innerHTML, /password-eye-closed/);
});

test('enhancement is idempotent and handles dynamically rendered forms', () => {
  const { document, root } = fixture();
  passwordVisibility.enhancePasswordFields(root);
  passwordVisibility.enhancePasswordFields(root);
  assert.equal(root.querySelectorAll('.password-toggle').length, 1, 'must not bind or render twice');

  const dynamic = document.createElement('div');
  const passphrase = document.createElement('input');
  passphrase.type = 'password';
  dynamic.appendChild(passphrase);
  root.appendChild(dynamic);

  passwordVisibility.enhancePasswordFields(dynamic);
  const dynamicButton = dynamic.querySelector('.password-toggle');
  assert.ok(dynamicButton, 'a dynamically rendered password field should be enhanced');
  dynamicButton.dispatchEvent({ type: 'click', preventDefault() {} });
  assert.equal(passphrase.type, 'text');
});
