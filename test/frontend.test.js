// jsdom smoke test for the gofile-style index.html — runs the REAL page script
// with mocked network (fetch + XMLHttpRequest) and asserts the upload flow:
// dropzone -> uploads panel (progress + speed) -> done sheet (link, QR, stats).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = () => readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const QR_SRC = () => readFileSync(new URL('../js/qrcode-generator.js', import.meta.url), 'utf8');

function installMocks(window) {
  const calls = [];
  window.__fetchCalls = calls;

  window.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    if (url === '/api/sign-upload') {
      return {
        ok: true,
        json: async () => ({
          id: 'AbC12345',
          key: 'AbC12345/test-app.apk',
          uploadUrl: 'https://r2.test/put?sig=mock',
          downloadUrl: '/f/AbC12345',
        }),
      };
    }
    if (url === '/api/sign-part') {
      const numParts = Math.ceil(body.size / (10 * 1024 * 1024));
      return {
        ok: true,
        json: async () => ({
          id: 'MpT98765',
          key: 'MpT98765/big.apk',
          uploadId: 'upload-123',
          partUrls: Array.from({ length: numParts }, (_, i) => `https://r2.test/part${i + 1}?sig=mock`),
          partSize: 10 * 1024 * 1024,
          downloadUrl: '/f/MpT98765',
        }),
      };
    }
    if (url === '/api/complete-multipart') {
      return {
        ok: true,
        json: async () => ({ id: 'MpT98765', key: 'MpT98765/big.apk', downloadUrl: '/f/MpT98765' }),
      };
    }
    if (url === '/api/finalize') {
      if (window.__finalizeShouldFail) {
        return { ok: false, status: 500, json: async () => ({ error: 'copy failed' }) };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, id: body.id, downloadUrl: '/f/' + body.id }),
      };
    }
    throw new Error('unexpected fetch: ' + url);
  };

  // Minimal XHR fake: fires progress events, then succeeds with an ETag.
  window.__xhrPuts = [];
  class FakeXHR {
    constructor() {
      this.upload = {};
      this.headers = {};
      this.status = 0;
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k.toLowerCase()] = v; }
    getResponseHeader(k) { return k.toLowerCase() === 'etag' ? '"faketag123"' : null; }
    addEventListener() {}
    send(body) {
      window.__xhrPuts.push({ url: this.url, headers: this.headers, body });
      const total = (body && body.size) || 1;
      const prog = (loaded) => {
        if (typeof this.upload.onprogress === 'function') {
          this.upload.onprogress({ loaded, total, lengthComputable: true });
        }
      };
      prog(Math.floor(total / 2));
      prog(total);
      this.status = 200;
      if (typeof this.onload === 'function') this.onload();
    }
  }
  window.XMLHttpRequest = FakeXHR;
}

function bootDom() {
  const dom = new JSDOM(HTML(), {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    beforeParse(window) {
      installMocks(window);
      window.eval(QR_SRC()); // vendored QR lib, like the <script src> tag
    },
  });
  return dom;
}

function dropFile(window, file) {
  const dz = window.document.getElementById('dropzone');
  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
  dz.dispatchEvent(ev);
}

async function settle(ms = 100) {
  await new Promise((r) => setTimeout(r, ms));
}

describe('index.html gofile-style upload flow', () => {
  it('dropzone has Select files button that opens the file picker', async () => {
    const dom = bootDom();
    const { window } = dom;
    const btn = window.document.getElementById('selectBtn');
    assert.ok(btn, 'expected #selectBtn');
    assert.match(btn.textContent, /select files/i);

    let pickerOpened = false;
    const input = window.document.getElementById('fileInput');
    const origClick = input.click.bind(input);
    input.click = () => { pickerOpened = true; };
    btn.click();
    assert.ok(pickerOpened, 'Select files should open the file picker');
    input.click = origClick;
    dom.window.close();
  });

  it('drops a small file → uploads panel shows progress + speed, done sheet shows link + QR + stats', async () => {
    const dom = bootDom();
    const { window } = dom;
    const file = new window.File(['x'.repeat(1000)], 'test-app.apk', {
      type: 'application/vnd.android.package-archive',
    });

    dropFile(window, file);
    await settle();

    // uploads panel is visible with one entry
    const panel = window.document.getElementById('uploadsPanel');
    assert.ok(panel, 'expected #uploadsPanel');
    assert.equal(panel.hidden, false, 'panel should be visible during/after upload');
    const entry = window.document.querySelector('.up-entry');
    assert.ok(entry, 'expected an upload entry');
    assert.ok(entry.querySelector('.up-fname').textContent.includes('test-app.apk'));

    // progress reached 100% and badge flipped to COMPLETE
    const fill = entry.querySelector('.up-fill');
    assert.equal(fill.style.width, '100%');
    assert.match(entry.querySelector('.badge').textContent, /complete/i);

    // speed + elapsed rendered
    assert.ok(entry.querySelector('.up-speed').textContent.length > 0, 'expected speed text');
    assert.ok(entry.querySelector('.up-elapsed').textContent.length > 0, 'expected elapsed text');

    // done sheet: share link + QR + stats
    const sheet = window.document.getElementById('doneSheet');
    assert.ok(sheet, 'expected #doneSheet');
    assert.equal(sheet.hidden, false, 'done sheet should be visible after upload');
    const linkInput = window.document.getElementById('sheetLink');
    assert.ok(linkInput.value.endsWith('/f/AbC12345'), linkInput.value);
    const qr = window.document.getElementById('sheetQr');
    assert.ok(qr.innerHTML.includes('<svg'), 'expected a QR code svg');
    assert.ok(window.document.getElementById('statSize').textContent.length > 0, 'expected size stat');

    // copy button → toast
    window.document.getElementById('sheetCopy').click();
    await settle(50);
    const toast = window.document.getElementById('toast');
    assert.ok(toast.classList.contains('show'), 'toast should show after copy');
    assert.match(toast.textContent, /copied/i);
    assert.match(toast.textContent, /Powered by Jepong Devxyz/);

    // close button hides the sheet
    window.document.getElementById('sheetCloseBtn').click();
    await settle(50);
    assert.equal(sheet.hidden, true, 'done sheet should close');

    dom.window.close();
  });

  it('drops a 500MB file → single upload (under the 1GB threshold)', async () => {
    const dom = bootDom();
    const { window } = dom;
    const file = new window.File(['x'.repeat(10)], 'mid.apk', {
      type: 'application/vnd.android.package-archive',
    });
    Object.defineProperty(file, 'size', { value: 500 * 1024 * 1024 });

    dropFile(window, file);
    await settle();

    const sign = window.__fetchCalls.find((c) => c.url === '/api/sign-upload');
    assert.ok(sign, 'expected a call to /api/sign-upload');
    const signPart = window.__fetchCalls.find((c) => c.url === '/api/sign-part');
    assert.ok(!signPart, '500MB must NOT use multipart');
    assert.equal(window.__xhrPuts.length, 1, 'single PUT expected');
    assert.equal(window.document.getElementById('doneSheet').hidden, false);
    dom.window.close();
  });

  it('drops a >1GB file → uses multipart sign-part + complete flow', async () => {
    const dom = bootDom();
    const { window } = dom;
    const file = new window.File(['x'.repeat(10)], 'big.apk', {
      type: 'application/vnd.android.package-archive',
    });
    Object.defineProperty(file, 'size', { value: 1.5 * 1024 ** 3 });

    dropFile(window, file);
    await settle(300);

    const signPart = window.__fetchCalls.find((c) => c.url === '/api/sign-part');
    assert.ok(signPart, 'expected a call to /api/sign-part');
    const complete = window.__fetchCalls.find((c) => c.url === '/api/complete-multipart');
    assert.ok(complete, 'expected a call to /api/complete-multipart');
    assert.equal(complete.body.parts.length, 154);
    assert.equal(window.__xhrPuts.length, 154);

    const sheet = window.document.getElementById('doneSheet');
    assert.equal(sheet.hidden, false, 'done sheet should show for multipart too');
    assert.ok(window.document.getElementById('sheetLink').value.endsWith('/f/MpT98765'));
    dom.window.close();
  });

  it('hamburger menu opens a drawer with working links', async () => {
    const dom = bootDom();
    const { window } = dom;
    const drawer = window.document.getElementById('drawer');
    assert.ok(drawer, 'expected #drawer');

    window.document.getElementById('menuBtn').click();
    await settle(50);
    assert.ok(drawer.classList.contains('open'), 'drawer should open');

    // drawer has real links
    const hrefs = Array.from(drawer.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    assert.ok(hrefs.includes('/privacy.html'), 'drawer should link privacy');
    assert.ok(hrefs.includes('/terms.html'), 'drawer should link terms');

    window.document.getElementById('scrim').click();
    await settle(50);
    assert.ok(!drawer.classList.contains('open'), 'drawer should close');
    dom.window.close();
  });

  it('link-styled buttons (Open file) have no underline and centered text', async () => {
    const dom = bootDom();
    const { window } = dom;
    const file = new window.File(['x'.repeat(1000)], 'a.png', { type: 'image/png' });
    dropFile(window, file);
    await settle();

    const open = window.document.getElementById('sheetOpen');
    assert.ok(open, 'expected #sheetOpen');
    const cs = window.getComputedStyle(open);
    assert.equal(cs.textDecorationLine, 'none', 'link button must not be underlined');
    // inline-flex in the static DOM; a real browser blockifies it to flex as a flex item
    assert.ok(cs.display === 'flex' || cs.display === 'inline-flex', 'link button should be a flex box, got ' + cs.display);
    assert.equal(cs.alignItems, 'center', 'link button text must be vertically centered');
    assert.equal(cs.justifyContent, 'center', 'link button text must be horizontally centered');
    dom.window.close();
  });

  it('finalize is called with the password after upload, before the done sheet', async () => {
    const dom = bootDom();
    const { window } = dom;
    window.document.getElementById('pwInput').value = 'secret123';
    window.document.getElementById('expirySelect').value = '24';
    const file = new window.File(['x'.repeat(1000)], 'secret.apk', {
      type: 'application/vnd.android.package-archive',
    });

    dropFile(window, file);
    await settle();

    const fin = window.__fetchCalls.find((c) => c.url === '/api/finalize');
    assert.ok(fin, 'expected a call to /api/finalize');
    assert.equal(fin.body.id, 'AbC12345');
    assert.equal(fin.body.password, 'secret123');
    assert.equal(fin.body.expiresInHours, 24);
    assert.equal(fin.body.filename, 'secret.apk');

    // done sheet only shows after finalize succeeded
    assert.equal(window.document.getElementById('doneSheet').hidden, false);
    dom.window.close();
  });

  it('failed finalize → upload marked failed, no done sheet', async () => {
    const dom = bootDom();
    const { window } = dom;
    window.__finalizeShouldFail = true;
    const file = new window.File(['x'.repeat(1000)], 'a.png', { type: 'image/png' });

    dropFile(window, file);
    await settle();

    assert.equal(window.document.getElementById('doneSheet').hidden, true);
    const badge = window.document.querySelector('.up-entry .badge');
    assert.match(badge.textContent, /failed/i);
    const toast = window.document.getElementById('toast');
    assert.ok(toast.classList.contains('show'));
    dom.window.close();
  });

  it('expiry select has exactly the 4 required options, default Max 7 days', async () => {
    const dom = bootDom();
    const { window } = dom;
    const sel = window.document.getElementById('expirySelect');
    const opts = Array.from(sel.options).map((o) => [o.value, o.textContent.trim()]);
    assert.deepEqual(opts, [
      ['1', 'After 1 hour'],
      ['12', 'After 12 hours'],
      ['24', 'After 24 hours'],
      ['168', 'Max 7 days'],
    ]);
    assert.equal(sel.value, '168', 'default should be Max 7 days');
    dom.window.close();
  });

  it('renders my-files list from localStorage on load', async () => {
    const dom = bootDom();
    const { window } = dom;
    window.localStorage.setItem(
      'filesdevxyz:files',
      JSON.stringify([{ id: 'XxYy1122', name: 'old.apk', size: 42, url: '/f/XxYy1122', at: 1 }])
    );
    window.dispatchEvent(new window.Event('DOMContentLoaded'));
    await settle(50);
    const items = window.document.querySelectorAll('.myfile');
    assert.ok(items.length >= 1, 'expected saved files to render');
    assert.ok(items[0].textContent.includes('old.apk'));
    dom.window.close();
  });
});
