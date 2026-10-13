// jsdom smoke test for index.html — runs the REAL page script with mocked
// network (fetch + XMLHttpRequest) and asserts the upload flow end-to-end.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = () => readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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
    beforeParse(window) { installMocks(window); },
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

describe('index.html upload flow', () => {
  it('drops a small file → calls /api/sign-upload, shows progress, renders link + saves to my files', async () => {
    const dom = bootDom();
    const { window } = dom;
    const file = new window.File(['x'.repeat(1000)], 'test-app.apk', {
      type: 'application/vnd.android.package-archive',
    });

    dropFile(window, file);
    await settle();

    // sign endpoint was called with the file details
    const sign = window.__fetchCalls.find((c) => c.url === '/api/sign-upload');
    assert.ok(sign, 'expected a call to /api/sign-upload');
    assert.equal(sign.body.filename, 'test-app.apk');
    assert.equal(sign.body.contentType, 'application/vnd.android.package-archive');
    assert.equal(sign.body.size, 1000);

    // exactly one PUT to the presigned url, with matching content-type header
    assert.equal(window.__xhrPuts.length, 1);
    assert.ok(window.__xhrPuts[0].url.includes('sig=mock'));
    assert.equal(window.__xhrPuts[0].headers['content-type'], 'application/vnd.android.package-archive');

    // progress UI reached 100%
    const fill = window.document.querySelector('.up-fill');
    assert.ok(fill, 'expected a progress fill element');
    assert.equal(fill.style.width, '100%');

    // download link rendered
    const link = window.document.querySelector('.up-link');
    assert.ok(link, 'expected a result link');
    assert.ok(link.href.endsWith('/f/AbC12345'), link.href);

    // saved to localStorage my-files
    const saved = JSON.parse(window.localStorage.getItem('filesdevxyz:files'));
    assert.ok(Array.isArray(saved) && saved.length === 1);
    assert.equal(saved[0].id, 'AbC12345');
    assert.equal(saved[0].name, 'test-app.apk');

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
    assert.equal(signPart.body.size, 250 * 1024 * 1024);

    const complete = window.__fetchCalls.find((c) => c.url === '/api/complete-multipart');
    assert.ok(complete, 'expected a call to /api/complete-multipart');
    assert.equal(complete.body.uploadId, 'upload-123');
    assert.equal(complete.body.parts.length, 25);
    assert.deepEqual(
      complete.body.parts.map((p) => p.PartNumber),
      Array.from({ length: 25 }, (_, i) => i + 1)
    );
    assert.ok(complete.body.parts.every((p) => p.ETag === '"faketag123"'));

    // one PUT per part
    assert.equal(window.__xhrPuts.length, 25);

    const link = window.document.querySelector('.up-link');
    assert.ok(link && link.href.endsWith('/f/MpT98765'), 'expected multipart result link');

    dom.window.close();
  });

  it('renders my-files list from localStorage on load', async () => {
    const dom = bootDom();
    const { window } = dom;
    window.localStorage.setItem(
      'filesdevxyz:files',
      JSON.stringify([{ id: 'XxYy1122', name: 'old.apk', size: 42, url: '/f/XxYy1122', at: 1 }])
    );
    // re-render happens via exposed hook after boot
    window.dispatchEvent(new window.Event('DOMContentLoaded'));
    await settle(50);
    const items = window.document.querySelectorAll('.myfile');
    assert.ok(items.length >= 1, 'expected saved files to render');
    assert.ok(items[0].textContent.includes('old.apk'));
    dom.window.close();
  });
});
