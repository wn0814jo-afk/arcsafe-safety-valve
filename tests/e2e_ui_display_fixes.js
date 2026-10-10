#!/usr/bin/env node
/**
 * UI 표시 수정 3건 — jsdom 마운트 검증 (실브라우저 아님, 표시 계층 전용)
 *   1) 슬라이더 값 표시 자릿수 = step 소수 자릿수 (Z 0.96 이 "1.0"으로 보이던 문제)
 *   2) 내부 키 inletPiping 이 사용자 화면에 그대로 노출되던 문제 (체크리스트 안내)
 *   3) Step 8 이 입력 부족인데 빨간 ✗ 로 보이고 PSM 체크 탭(회색 보류)과 다르던 문제
 * 실행 전 1회:  npm i --no-save react@18 react-dom@18 jsdom@24 @babel/standalone@7
 *  node tests/e2e_ui_display_fixes.js [path/to/node_modules]
 * dist/index.html 번들을 그대로 jsdom 에 올린다(e2e_b2_popsim_mount.js 와 같은 방식).
 * Engine/Snapshot/Report 는 호출하지 않는다 — 렌더러에 고정 입력만 넘긴다.
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
console.error = () => {};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ' + (extra || ''))); };

const factory = new Function('React', 'ReactDOM', 'window', 'document', 'localStorage', 'indexedDB',
  js + '\n;return { DecisionSlider, EvidenceCard, ChecklistRenderer, formatDataGaps };');
const B = factory(React, ReactDOM, dom.window, dom.window.document, {}, undefined);

const host = document.getElementById('root');
const root = ReactDOMClient.createRoot(host);
const render = (el) => { act(() => { root.render(el); }); return host.textContent; };
const h = React.createElement;

(async () => {
  // 1) 슬라이더 표시 자릿수
  const slider = (value, step, min = 0, max = 10000) =>
    render(h(B.DecisionSlider, { param: 'X', label: 'L', unit: '', value, min, max, step, onChange() {}, basis: '' }));
  const big = (value, step) => {
    // 큰 값 표시(20px 숫자)만 비교하려고 min/max 라벨과 섞이지 않게 숫자 div 를 직접 읽는다.
    slider(value, step);
    const d = [...host.querySelectorAll('div')].find(e => e.style.fontSize === '20px');
    return d && d.textContent;
  };
  ok('Z 0.96 (step 0.01) → "0.96"', big(0.96, 0.01) === '0.96', big(0.96, 0.01));
  ok('Z 1 (step 0.01) → "1.00"', big(1, 0.01) === '1.00', big(1, 0.01));
  ok('P2 0.35 (step 0.05) → "0.35"', big(0.35, 0.05) === '0.35', big(0.35, 0.05));
  ok('압력 6 (step 0.1) → "6.0" (기존 표시 유지)', big(6, 0.1) === '6.0', big(6, 0.1));
  ok('W 2500 (step 100) → "2500" (기존 표시 유지)', big(2500, 100) === '2500', big(2500, 100));

  // 2) 내부 키 노출
  ok('formatDataGaps: inletPiping → 한글 이름', B.formatDataGaps(['inletPiping']) === '인입배관 정보(길이·내경·ΣK)', B.formatDataGaps(['inletPiping']));
  ok('formatDataGaps: 모르는 키는 그대로, 빈 값은 빈 문자열', B.formatDataGaps(['foo']) === 'foo' && B.formatDataGaps(null) === '');
  const checklist = { capacityOK: true, backPressureOK: true, mawpOK: true, kdOK: true, marginOK: true, accumulationOK: true };
  const clText = render(h(B.ChecklistRenderer, { checklist, backpress: null, accumulation: null, inletLoss: { pressureLossAvailable: false }, dataGaps: ['inletPiping'] }));
  ok('체크리스트 안내에 영문 키 inletPiping 미노출', !clText.includes('inletPiping'), clText);
  ok('체크리스트 안내에 한글 이름 표시', clText.includes('인입배관 정보(길이·내경·ΣK) 데이터가 없어'));

  // 3) Step 8 보류 표시
  const step8 = { id: 8, title: '인입배관 압력손실 검증 (Inlet Pressure Loss)', formula: '', ok: false,
    result: '계산 불가 — 인입배관 형상(길이/내경/fittings) 데이터 없음 → INSUFFICIENT INPUT',
    detail: 'Equipment에 inletPiping(L/D/fittingsK)이 등록되어 있지 않아 …' };
  let t = render(h(B.EvidenceCard, { step: step8, pending: true }));
  ok('Step 8 보류: 빨간 ✗ 없음, "−" 표시', !t.includes('✗') && t.includes('−'), t);
  ok('Step 8 보류: "판정 보류" 문구, 영문 INSUFFICIENT 미노출', t.includes('판정 보류') && !t.includes('INSUFFICIENT'), t);
  act(() => { host.querySelector('div[style*="cursor"]').click(); });
  ok('Step 8 보류(펼침): 영문 키 inletPiping 미노출', !host.textContent.includes('inletPiping'), host.textContent);
  t = render(h(B.EvidenceCard, { step: step8, pending: false }));
  ok('pending 아님(실제 NO-GO): 기존대로 빨간 ✗ 유지', t.includes('✗'), t);
  t = render(h(B.EvidenceCard, { step: { ...step8, id: 7, ok: false, result: 'NO-GO', title: 'x' }, pending: true }));
  ok('Step 8 이 아닌 단계는 pending 이어도 영향 없음(✗ 유지)', t.includes('✗'), t);

  console.log(`\nRESULT: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
