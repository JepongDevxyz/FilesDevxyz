// jsdom smoke test for f.html — mocked /api/resolve, asserts the download
// page states: file card, password gate, expired, not found.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = () => readFileSync(new URL('../f.html', import.meta.url), 'utf8');

// scenario: 'ok' | 'protected' | 'expired' | 'missing'
function bootDom(scenario, query = '?id=AbC12345') {
  const dom = new JSDOM(HTML(), {
    url: 'http://localhost/' + query,
    runScripts: 'dangerously',
    beforeParse(window) {
      window.fetch = async (url) => {
        const u = new URL(url, 'http://localhost/');
        const id = u.searchParams.get('id');
        const pw = u.searchParams.get('password');
        if (id !== 'AbC12345') {
          return { ok: false, status: 404, json: async () => ({ error: 'file not found' }) };
        }
        if (scenario === 'expired') {
          return { ok: false, status: 410, json: async () => ({ error: 'this link has expired' }) };
        }
        if (scenario === 'protected' && pw !== 'rightpw') {
          return {
            ok: false, status: 403,
            json: async () => ({ error: pw ? 'wrong password' : 'password required', passwordProtected: true }),
          };
        }
        return {
          ok: true, status: 200,
          json: async () => ({
            url: 'https://r2.test/get?sig=mock',
            filename: 'report.pdf',
            size: 123456,
            expiresAt: null,
            passwordProtected: scenario === 'protected',
          }),
        };
      };
    },
  });
  return dom;
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

describe('f.html download page', () => {
  it('shows the file card with a working download link', async () => {
    const dom = bootDom('ok');
    const { window } = dom;
    await settle();
    assert.equal(window.document.getElementById('fileName').textContent, 'report.pdf');
    const btn = window.document.getElementById('dlBtn');
    assert.equal(btn.getAttribute('href'), 'https://r2.test/get?sig=mock');
    assert.equal(window.document.getElementById('fileCard').hidden, false);
    dom.window.close();
  });

  it('gates password-protected files behind the password form', async () => {
    const dom = bootDom('protected');
    const { window } = dom;
    await settle();
    const card = window.document.getElementById('pwCard');
    assert.equal(card.hidden, false, 'password card should be visible');
    const form = window.document.getElementById('pwForm');

    // wrong password → error shown, still gated
    window.document.getElementById('pwInput').value = 'wrong';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.ok(window.document.getElementById('pwError').textContent.length > 0);
    assert.equal(window.document.getElementById('fileCard').hidden, true);

    // right password → file card appears
    window.document.getElementById('pwInput').value = 'rightpw';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(window.document.getElementById('fileCard').hidden, false);
    assert.equal(window.document.getElementById('fileName').textContent, 'report.pdf');
    dom.window.close();
  });

  it('shows an expired message for 410', async () => {
    const dom = bootDom('expired');
    const { window } = dom;
    await settle();
    const err = window.document.getElementById('errCard');
    assert.equal(err.hidden, false);
    assert.ok(window.document.getElementById('errMsg').textContent.toLowerCase().includes('expir'));
    dom.window.close();
  });

  it('shows a not-found message for unknown ids', async () => {
    const dom = bootDom('ok', '?id=ZZZZ9999');
    const { window } = dom;
    await settle();
    const err = window.document.getElementById('errCard');
    assert.equal(err.hidden, false);
    assert.ok(window.document.getElementById('errMsg').textContent.toLowerCase().includes('not found'));
    dom.window.close();
  });

  it('shows a branded bottom-center toast when Download is clicked', async () => {
    const dom = bootDom('ok');
    const { window } = dom;
    await settle();

    window.document.getElementById('dlBtn').click();
    await settle(50);

    const toast = window.document.getElementById('toast');
    assert.ok(toast, 'expected a #toast element');
    assert.ok(toast.classList.contains('show'), 'toast should be visible after download click');
    assert.match(toast.textContent, /Powered by Jepong Devxyz/);
    assert.match(toast.textContent, /preparing.*download/i);
    dom.window.close();
  });
});
