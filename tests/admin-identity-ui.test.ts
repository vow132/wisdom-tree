import test from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import AdminIdentities from '../frontend/src/AdminIdentities.js';

test('admin identity names remain text and both bound providers retain their own account identifiers', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { configurable: true, writable: true, value: React });
  try {
    const identities = [
      { provider: 'linuxdo', providerUserId: '284915', displayName: '<img src=x onerror=alert(1)>', createdAt: '2026-10-05T00:00:00.000Z' },
      { provider: 'github', providerUserId: '1337000', displayName: '小树 & 朋友', createdAt: '2026-10-05T00:00:00.000Z' },
    ];
    const html = renderToStaticMarkup(createElement(AdminIdentities, { identities }));
    const dom = new JSDOM(html);
    try {
      const items = [...dom.window.document.querySelectorAll('li')];
      assert.equal(items.length, 2);
      assert.deepEqual(items.map(item => item.querySelector('.admin-identity-provider')?.textContent), ['Linux DO', 'GitHub']);
      assert.deepEqual(items.map(item => item.querySelector('strong')?.textContent), identities.map(identity => identity.displayName));
      assert.deepEqual(items.map(item => item.querySelector('code')?.textContent), ['284915', '1337000']);
      assert.equal(dom.window.document.querySelector('img'), null, 'third-party nicknames cannot inject markup');
      assert.equal(dom.window.document.querySelector('button, a, input'), null, 'the admin binding display is read-only');
      const empty = renderToStaticMarkup(createElement(AdminIdentities, { identities: [] }));
      assert.ok(empty.includes('未绑定第三方账号'));
      const missing = renderToStaticMarkup(createElement(AdminIdentities, { identities: [{ ...identities[0], displayName: ' ' }] }));
      assert.ok(missing.includes('未提供昵称'));
      assert.ok(missing.includes('284915'), 'missing nicknames do not hide the provider account ID');
    } finally { dom.window.close(); }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'React', previous); else Reflect.deleteProperty(globalThis, 'React');
  }
});
