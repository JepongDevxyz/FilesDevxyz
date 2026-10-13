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

  it('drops a >100MB file → uses multipart sign-part + complete flow', async () => {
    const dom = bootDom();
    const { window } = dom;
    const file = new window.File(['x'.repeat(10)], 'big.apk', {
      type: 'application/vnd.android.package-archive',
    });
    Object.defineProperty(file, 'size', { value: 250 * 1024 * 1024 });

    dropFile(window, file);
    await settle(300);

    const signPart = window.__fetchCalls.find((c) => c.url === '/api/sign-part');
    assert.ok(signPart, 'expected a call to /api/sign-part');
    const complete = window.__fetchCalls.find((c) => c.url === '/api/complete-multipart');
    assert.ok(complete, 'expected a call to /api/complete-multipart');
    assert.equal(complete.body.parts.length, 25);
    assert.equal(window.__xhrPuts.length, 25);

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
