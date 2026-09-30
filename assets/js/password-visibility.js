(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PasswordVisibility = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CLOSED_ICON = '<svg class="password-eye password-eye-closed" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A10.8 10.8 0 0 1 12 4c5.5 0 9 5 9 5a16 16 0 0 1-3.1 3.4M6.2 6.2C4.2 7.5 3 9 3 9s3.5 5 9 5c1.4 0 2.6-.3 3.7-.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var OPEN_ICON = '<svg class="password-eye password-eye-open" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 12s3.5-5 9-5 9 5 9 5-3.5 5-9 5-9-5-9-5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

  function setState(input, button, visible) {
    input.type = visible ? 'text' : 'password';
    var label = visible ? '隐藏密码' : '显示密码';
    button.setAttribute('aria-pressed', visible ? 'true' : 'false');
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.title = label;
    button.innerHTML = visible ? OPEN_ICON : CLOSED_ICON;
  }

  function enhanceInput(input) {
    if (!input || input.dataset.passwordVisibilityBound === 'true') return;
    input.dataset.passwordVisibilityBound = 'true';

    var doc = input.ownerDocument;
    var button = doc.createElement('button');
    button.type = 'button';
    button.className = 'password-toggle';

    var parent = input.parentNode;
    if (parent && typeof parent.insertBefore === 'function') {
      var wrapper = doc.createElement('div');
      wrapper.className = 'password-input';
      parent.insertBefore(wrapper, input);
      wrapper.appendChild(input);
      wrapper.appendChild(button);
    } else if (parent) {
      parent.appendChild(button);
    }

    setState(input, button, false);
    button.addEventListener('click', function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      setState(input, button, input.type === 'password');
    });
  }

  function enhancePasswordFields(rootElement) {
    if (!rootElement || typeof rootElement.querySelectorAll !== 'function') return;
    var inputs = rootElement.querySelectorAll('input[type="password"]');
    for (var i = 0; i < inputs.length; i += 1) enhanceInput(inputs[i]);
  }

  return {
    enhancePasswordFields: enhancePasswordFields
  };
}));
