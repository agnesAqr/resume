#!/usr/bin/env node
// index.html 에 실제로 쓰인 글자만 담은 웹폰트를 내려받아 fonts/ 에 저장한다.
//
//   node scripts/fetch-fonts.js
//
// PDF 를 만드는 브라우저가 fonts.googleapis.com 에 닿지 못하는 환경(사내 프록시,
// 오프라인, CI)에서는 한글이 시스템 대체 폰트로 바뀌어버린다. 그래서 필요한
// 글자만 추려 받아 두고, scripts/build-pdf.js 가 이 파일들을 직접 물린다.
//
// index.html 의 텍스트가 바뀌면 다시 실행해야 새 글자가 포함된다.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FONT_DIR = path.join(ROOT, 'fonts');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// index.html 의 <link> 가 요청하는 것과 같은 구성
const FAMILIES = [
  { name: 'Noto Sans KR', weights: [400, 500, 700, 900] },
  { name: 'JetBrains Mono', weights: [400, 500, 700] },
];

// 프록시 뒤에서도 fetch 가 HTTPS_PROXY 를 읽도록 한 번 다시 띄운다. (Node >= 22.21)
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== '1') {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.exit(r.status ?? 1);
}

function usedCharacters() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const chars = new Set();
  for (const ch of html) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) continue; // 제어문자
    chars.add(ch);
  }
  return [...chars].sort().join('');
}

function slug(family) {
  return `${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.woff2`;
}

async function get(url, asBuffer) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
}

(async () => {
  const text = usedCharacters();
  fs.mkdirSync(FONT_DIR, { recursive: true });

  const blocks = [];
  for (const { name, weights } of FAMILIES) {
    const url = 'https://fonts.googleapis.com/css2'
      + `?family=${encodeURIComponent(name)}:wght@${weights.join(';')}`
      + `&text=${encodeURIComponent(text)}`;
    const css = await get(url, false);

    // 두 폰트 모두 wght 100–900 가변폰트라 굵기별 응답이 같은 파일이다.
    // 하나만 저장하고 @font-face 에 굵기 범위를 적어준다.
    // 서브셋 응답의 주소는 확장자 없는 /l/font?kit=... 형태다.
    const src = (css.match(/url\((https:[^)]+)\)/) || [])[1];
    if (!src) throw new Error(`${name}: @font-face 주소를 찾지 못했다`);
    const file = slug(name);
    const buf = await get(src, true);
    fs.writeFileSync(path.join(FONT_DIR, file), buf);
    blocks.push(
      `@font-face {\n` +
      `  font-family: '${name}';\n` +
      `  font-style: normal;\n` +
      `  font-weight: ${Math.min(...weights)} ${Math.max(...weights)};\n` +
      `  font-display: block;\n` +
      `  src: url(${file}) format('woff2');\n` +
      `}`,
    );
    console.log(`${file}  ${(buf.length / 1024).toFixed(1)} KB`);
  }

  const header = '/* scripts/fetch-fonts.js 가 생성. 직접 고치지 말 것.\n'
    + '   Noto Sans KR, JetBrains Mono — SIL Open Font License 1.1\n'
    + `   index.html 에 쓰인 글자 ${[...text].length}자만 담은 서브셋. */\n\n`;
  fs.writeFileSync(path.join(FONT_DIR, 'fonts.css'), header + blocks.join('\n\n') + '\n');
  console.log(`fonts/fonts.css (${blocks.length} faces)`);
})();
