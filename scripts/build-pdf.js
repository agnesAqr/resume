#!/usr/bin/env node
// index.html 을 인쇄용으로 렌더링해 PDF 로 저장한다.
//
//   node scripts/build-pdf.js [출력파일]        (기본: resume.pdf)
//
// 필요 도구: playwright (npm i -g playwright) + Chromium.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'resume.pdf'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    // 전역 설치본 사용 (npm i -g playwright)
    const { execSync } = require('child_process');
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const PRINT_CSS = `
  @media print {
    @page { size: A4; margin: 10mm 0; }
    html, body, #dc-root, #dc-root > .sc-host { background: #fff !important; }
    #dc-root > .sc-host > div {
      box-shadow: none !important;
      max-width: none !important;
      background: #fff !important;
      padding: 0 6px !important;
    }
    h1, h2, h3 { break-after: avoid; }
    image-slot, figure, table { break-inside: avoid; }
    section > div:first-child { break-after: avoid; }
  }
`;

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
    await page.goto(url, { waitUntil: 'networkidle' });

    // 지연 로딩 슬롯을 모두 강제로 붙인다.
    await page.evaluate(() => {
      document.querySelectorAll('image-slot[data-src]').forEach(el => {
        el.setAttribute('src', el.getAttribute('data-src'));
        el.removeAttribute('data-src');
      });
    });
    await page.waitForTimeout(2500);

    await page.evaluate(async () => {
      await document.fonts.ready;
      const walk = (root, acc) => {
        acc.push(...root.querySelectorAll('img'));
        root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot, acc); });
        return acc;
      };
      const imgs = walk(document, []);
      await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })));
    });
    await page.waitForTimeout(1500);

    // 인쇄 크기의 약 2배로 비트맵을 줄여 PDF 용량을 낮춘다.
    await page.evaluate(async () => {
      const walk = (root, acc) => {
        acc.push(...root.querySelectorAll('img'));
        root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot, acc); });
        return acc;
      };
      for (const img of walk(document, [])) {
        if (!img.complete || !img.naturalWidth) continue;
        const rect = img.getBoundingClientRect();
        const target = Math.min(img.naturalWidth, Math.max(320, Math.round(rect.width * 2)));
        if (target >= img.naturalWidth) continue;
        const height = Math.round(img.naturalHeight * (target / img.naturalWidth));
        const canvas = document.createElement('canvas');
        canvas.width = target;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, target, height);
        const data = canvas.toDataURL('image/jpeg', 0.85);
        await new Promise(done => { img.onload = img.onerror = done; img.src = data; });
      }
    });
    await page.waitForTimeout(800);

    await page.addStyleTag({ content: PRINT_CSS });
    await page.pdf({
      path: OUT,
      format: 'A4',
      printBackground: true,
      scale: 0.72,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
    });
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
})();
