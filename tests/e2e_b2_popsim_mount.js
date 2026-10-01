#!/usr/bin/env node
/**
 * B-2 PopSimWalkthrough — jsdom 마운트 검증 (실브라우저 아님)
 * 실행 전 1회:  npm i --no-save react@18 react-dom@18 jsdom@24 @babel/standalone
 *  node tests/e2e_b2_popsim_mount.js [path/to/node_modules]
 * dist/index.html 번들을 그대로 jsdom에 올려 PopSimWalkthrough를 실제 클릭으로 검증한다.
 * 한계: jsdom은 레이아웃/CSS 애니메이션을 계산하지 않는다 → 390px 실측/시각 확인은 실브라우저 몫.
 */
const fs = require('fs'), path = require('path');
const NM = process.argv[2] || path.join(process.cwd(), 'node_modules');
const req = (m) => require(require.resolve(m, { paths: [NM, process.cwd()] }));
const React = req('react'), ReactDOMClient = req('react-dom/client'), ReactDOM = req('react-dom');
const act = React.act;
const { JSDOM } = req('jsdom');
const Babel = req('@babel/standalone');

const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.html'), 'utf8');
const m = html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/);
let code = m[1].replace(/const root = ReactDOM\.createRoot[\s\S]*$/, '');
const js = Babel.transform(code, { presets: ['react'] }).code;

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window; global.document = dom.window.document;
global.IS_REACT_ACT_ENVIRONMENT = true;
const errors = []; const origErr = console.error;
console.error = (...a) => { errors.push(a.join(' ')); };

const out = {}; let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ' + (extra || ''))); };

const factory = new Function('React', 'ReactDOM', 'window', 'document', 'localStorage', 'indexedDB',
  js + '\n;return { PopSimWalkthrough, api520Engine, R201_DEFAULTS, POP_SIM_STEPS };');
const B = factory(React, ReactDOM, dom.window, dom.window.document, {}, undefined);

function makeSnap(deviceType, valveType) {
  const inputs = { ...B.R201_DEFAULTS, valveType };
  const result = B.api520Engine(inputs, deviceType, null, null);
  return { deviceType, inputs, result };
}

async function run(label, snap, expectKind) {
  console.log(`\n── ${label}`);
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = ReactDOMClient.createRoot(host);
  await act(async () => { root.render(React.createElement(B.PopSimWalkthrough, { snap })); });
  const q = (s) => host.querySelector(`[data-popsim="${s}"]`);
  const counter = () => q('counter').textContent.replace(/\s+/g, ' ').trim();
  const click = async (s) => { await act(async () => { q(s).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }); };
  const sd = snap.result.stepData;
  ok('초기 1 / 6', counter() === '1 / 6', counter());
  ok('1/6에서 이전 버튼 비활성', q('prev').disabled === true);
  // 자동 진행 없음: 실제 시간 3.5초 대기
  await act(async () => { await new Promise(r => setTimeout(r, 3500)); });
  ok('3.5초 후에도 1 / 6 (자동 전환 없음)', counter() === '1 / 6', counter());
  const seen = [];
  for (let i = 1; i <= 6; i++) {
    const open = q('valve-state').textContent;
    seen.push(open);
    ok(`${i}/6 표시`, counter() === `${i} / 6`, counter());
    const wantOpen = i >= 4;
    const isOpenTxt = /열림|파열판 파열/.test(open);
    ok(`${i}/6 open=${wantOpen} 상태 칩("${open}")`, isOpenTxt === wantOpen);
    const real = q('real') ? q('real').textContent : '';
    if (i === 1 || i === 3 || i === 4) ok(`${i}/6 P1(${snap.inputs.P1}) 표시`, real.includes(String(snap.inputs.P1)), real);
    if (i === 2) ok('2/6 실제값 박스 없음', !q('real'));
    if (i === 5) ok(`5/6 W(${sd.orifice.W}) 표시`, real.replace(/[,\s]/g, '').includes(String(Math.round(sd.orifice.W)).replace(/[,\s]/g, '')) || real.includes(Number(sd.orifice.W).toLocaleString('ko-KR')), real);
    if (i === 6) {
      ok(`6/6 여유율 ${snap.result.margin.toFixed(3)}×`, real.includes(snap.result.margin.toFixed(3) + '×'), real);
      ok('6/6 배압비/허용 배압비 표시', real.includes((sd.backpress.ratio * 100).toFixed(1) + '%') && real.includes((sd.backpress.allowableRatio * 100).toFixed(0) + '%'), real);
    }
    ok(`${i}/6 설명문 비어있지 않음`, q('desc').textContent.length > 20);
    if (i < 6) { await click('next'); }
  }
  ok('6/6에 다음 버튼 없음·다시 보기 버튼 있음', !q('next') && !!q('restart'));
  await click('prev'); ok('이전 → 5 / 6', counter() === '5 / 6', counter());
  await click('next'); ok('다음 → 6 / 6', counter() === '6 / 6', counter());
  await click('restart'); ok('처음부터 다시 보기 → 1 / 6', counter() === '1 / 6', counter());
  await click('next'); await click('next'); await click('prev'); ok('2→3→이전 = 2 / 6', counter() === '2 / 6', counter());
  const svg = host.querySelector('svg[role="img"]');
  ok(`밸브 일러스트 종류(${expectKind})`, svg && svg.getAttribute('aria-label').includes(expectKind));
  await act(async () => { root.unmount(); });
}

(async () => {
  await run('SPRING', makeSnap('safetyValve', 'SPRING'), '스프링식');
  await run('BELLOWS', makeSnap('safetyValve', 'BELLOWS'), '벨로우즈형');
  await run('RUPTURE', makeSnap('ruptureDisk', 'SPRING'), '럽처디스크');
  ok('console.error 0건', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`\nRESULT: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
