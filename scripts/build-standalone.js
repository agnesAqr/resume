#!/usr/bin/env node
// index.html 과 모든 이미지·폰트·스크립트를 파일 하나로 합친다.
//
//   node scripts/build-standalone.js [출력파일]   (기본: resume-standalone.html)
//
// PDF 는 애니메이션을 담지 못한다. 이 파일은 더블클릭하면 브라우저에서 열리고
// 움직이는 WebP(GIF) 가 그대로 재생된다. 인터넷 연결도 필요 없다.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'resume-standalone.html'));

const MEDIA_TYPE = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.js': 'text/javascript',
};

function dataUri(relPath) {
  const file = path.join(ROOT, relPath);
  const type = MEDIA_TYPE[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inlined = [];

// 1. 이미지: src / data-src(지연 로딩) / href(파비콘)
html = html.replace(/(\b(?:src|data-src|href)=")(img\/[^"]+)"/g, (_, attr, rel) => {
  if (!fs.existsSync(path.join(ROOT, rel))) return `${attr}${rel}"`;
  inlined.push(rel);
  return `${attr}${dataUri(rel)}"`;
});

// 2. 런타임이 CDN 대신 물어오는 로컬 스크립트 (babel 은 실제로 요청되지 않아 둔다)
html = html.replace(/"(vendor\/(?:react|react-dom)[^"]*)"/g, (_, rel) => {
  inlined.push(rel);
  return `"${dataUri(rel)}"`;
});

// 3. 웹폰트: Google Fonts <link> 를 저장소 서브셋으로 바꿔 오프라인에서도 같은 글꼴로 뜨게 한다.
const fontCssPath = path.join(ROOT, 'fonts', 'fonts.css');
if (fs.existsSync(fontCssPath)) {
  const faces = fs.readFileSync(fontCssPath, 'utf8')
    .replace(/url\(([^)]+\.woff2)\)/g, (_, file) => {
      inlined.push(`fonts/${file}`);
      return `url(${dataUri(path.join('fonts', file))})`;
    });
  html = html.replace(
    /<link href="https:\/\/fonts\.googleapis\.com\/css2[^>]*>/,
    `<style>\n${faces}</style>`,
  );
} else {
  console.warn('fonts/fonts.css 가 없다. node scripts/fetch-fonts.js 를 먼저 실행할 것.');
}

fs.writeFileSync(OUT, html);
console.log(`${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB, 자산 ${inlined.length}개 포함)`);
