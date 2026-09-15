#!/usr/bin/env node
// index.html 을 PDF 로 렌더링한다.
//
//   node scripts/build-pdf.js [출력파일]        (기본: resume.pdf)
//
// 페이지 구성 (4장):
//   1. 헤더 + 경력 · 애니펜
//   2. 프로젝트 · UE5 / C++ — PRJ.01, PRJ.02
//   3. PRJ.03 project:EXFIL
//   4. 기술 스택 + 연락처
//
// 가로는 A4(210mm) 고정, 세로는 각 페이지 내용 길이에 맞춘다. 본문을 축소하지
// 않고 100% 크기로 인쇄해 화면에서 가장 잘 읽히도록 한 구성이다.
//
// 필요 도구: playwright (npm i -g playwright) + Chromium.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'resume.pdf'));

const PAGE_WIDTH_MM = 210;
const MARGIN_MM = 10;
const PX_PER_MM = 96 / 25.4;
const CONTENT_WIDTH_PX = Math.round((PAGE_WIDTH_MM - MARGIN_MM * 2) * PX_PER_MM); // 718

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

// 화면과 인쇄 레이아웃을 일치시키는 규칙. 높이를 화면에서 재고 그대로 페이지
// 크기로 쓰기 때문에 @media print 가 아니라 항상 적용한다.
const LAYOUT_CSS = `
  html, body, #dc-root, #dc-root > .sc-host { background: #fff !important; }
  #dc-root > .sc-host > div {
    box-shadow: none !important;
    max-width: none !important;
    background: #fff !important;
    padding: 0 !important;
  }
  /* 좁은 폭에서 섹션 머리말의 기간 배지가 넘치지 않도록 줄바꿈 허용 */
  section > div:first-child { flex-wrap: wrap; row-gap: 8px; }
  /* 페이지 첫 블록 위쪽 여백은 페이지 마진으로 대신한다 */
  .pdf-page > :first-child { padding-top: 0 !important; }
  .pdf-page > section:first-child > div:first-child { padding-top: 0 !important; }
  /* 페이지 마지막 카드의 아래 여백도 페이지 마진으로 대신한다 */
  .pdf-page > section:last-child > article:last-child { padding-bottom: 0 !important; }
  @media print {
    * , *::before, *::after {
      print-color-adjust: exact; -webkit-print-color-adjust: exact;
    }
    .pdf-page { break-inside: avoid; }
    .pdf-page + .pdf-page { break-before: page; }
  }
`;

// 본문을 4개의 페이지 블록으로 재배치한다.
const SPLIT = () => {
  const root = [...document.querySelectorAll('div')].find(el => el.style.maxWidth === '940px');
  const sec = label => root.querySelector(`section[data-screen-label="${label}"]`);
  const projects = sec('프로젝트');
  const articles = [...projects.querySelectorAll(':scope > article')];

  // PRJ.03 을 같은 모양의 별도 섹션(머리말 없이)으로 떼어낸다.
  const exfil = projects.cloneNode(false);
  exfil.appendChild(articles[articles.length - 1]);
  projects.after(exfil);
  // 마지막 프로젝트 카드의 구분선은 페이지 끝이므로 지운다.
  articles[articles.length - 2].style.borderBottom = 'none';

  const groups = [
    [root.querySelector('header'), sec('경력')],
    [projects],
    [exfil],
    [sec('기술 스택'), sec('Links'), root.querySelector('footer')],
  ];

  return groups.map((nodes, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page';
    wrap.id = `pdf-page-${i + 1}`;
    nodes[0].before(wrap);
    nodes.forEach(n => wrap.appendChild(n));
    return wrap.id;
  });
};

const FORCE_LAZY_IMAGES = () => {
  document.querySelectorAll('image-slot[data-src]').forEach(el => {
    el.setAttribute('src', el.getAttribute('data-src'));
    el.removeAttribute('data-src');
  });
};

const AWAIT_ASSETS = async () => {
  await document.fonts.ready;
  const walk = (node, acc) => {
    acc.push(...node.querySelectorAll('img'));
    node.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot, acc); });
    return acc;
  };
  const imgs = walk(document, []);
  await Promise.all(imgs.map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
};

// 인쇄 크기의 약 2배로 비트맵을 줄여 PDF 용량을 낮춘다.
const SHRINK_IMAGES = async () => {
  const walk = (node, acc) => {
    acc.push(...node.querySelectorAll('img'));
    node.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot, acc); });
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
};

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: CONTENT_WIDTH_PX, height: 1400 } });
    await page.goto(url, { waitUntil: 'networkidle' });

    await page.addStyleTag({ content: LAYOUT_CSS });
    await page.evaluate(FORCE_LAZY_IMAGES);
    await page.waitForTimeout(2500);
    await page.evaluate(AWAIT_ASSETS);
    await page.waitForTimeout(1000);

    const ids = await page.evaluate(SPLIT);
    await page.evaluate(SHRINK_IMAGES);
    await page.evaluate(AWAIT_ASSETS);
    await page.waitForTimeout(500);

    // 페이지별 높이를 재고 이름 있는 @page 규칙으로 각 페이지 크기를 지정한다.
    const heights = await page.evaluate(
      list => list.map(id => Math.ceil(document.getElementById(id).getBoundingClientRect().height)),
      ids,
    );

    const pageCss = ids.map((id, i) => {
      const heightMm = (heights[i] / PX_PER_MM + MARGIN_MM * 2 + 1).toFixed(2);
      return `@page page-${i + 1} { size: ${PAGE_WIDTH_MM}mm ${heightMm}mm; margin: ${MARGIN_MM}mm; }\n` +
             `#${id} { page: page-${i + 1}; }`;
    }).join('\n');
    await page.addStyleTag({ content: pageCss });

    await page.pdf({
      path: OUT,
      printBackground: true,
      preferCSSPageSize: true,
      scale: 1,
    });
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
})();
