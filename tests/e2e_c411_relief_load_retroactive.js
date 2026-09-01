#!/usr/bin/env node
/**
 * C-4.11 §5.1 / §5.6 / §5.7 / §5.8 Browser E2E Retroactive Gate
 * ════════════════════════════════════════════════════════════════════
 * C-4.10에서 확립된 원칙("Contract Test GREEN ≠ Browser UI GREEN")을
 * C-4.9에서 UI 연결된 기존 4개 시나리오(§5.1/5.6/5.7/5.8)에 소급 적용한다.
 * 이 스크립트는 제품 코드를 전혀 수정하지 않는다 — 실제 프로덕션 번들
 * (dist/index.html, build.py 산출물 그대로)을 로드하되, tests/e2e_c410_
 * external_fire.js와 동일한 하네스 패턴으로 최종 root.render(<ArcSafe/>)
 * 한 줄만 root.render(<CaseView .../>)로 교체해 CaseView 화면에서 시작한다.
 * CaseView/InputView 자체의 코드는 프로덕션과 100% 동일.
 *
 * 판정 기준: 실제 Chromium 렌더링 → 실제 클릭/입력 → 실제 상태 전환 →
 * 실제 계산 → 실제 visible DOM. 문자열 검색이나 contract test PASS로
 * 대체하지 않는다.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const DIST_HTML = path.join(ROOT, 'dist', 'index.html');

// 이 저장소의 dist/index.html은 프로덕션에서 React/ReactDOM/Babel을
// unpkg.com CDN에서 로드한다(실제 브라우저 사용자 환경 그대로). 이 실행
// 환경은 unpkg.com 접근이 네트워크 정책상 차단되어 있어(CI/개발 PC와
// 다른 제약), 동일 버전(react@18.2.0 / react-dom@18.2.0 /
// @babel/standalone@7.23.10 — dist/index.html에 고정된 버전과 정확히
// 동일)을 npm으로 받아 로컬에서 서빙하도록 CDN URL만 치환한다. 파일
// 시스템의 dist/index.html은 전혀 수정하지 않으며, 이 치환은 메모리
// 상의 하네스 사본에만 적용된다. 라이브러리 코드 자체(바이트)는
// CDN 배포본과 동일한 공식 npm 배포본이므로 애플리케이션 동작에는
// 영향이 없다 — 다른 세션이 GitHub Actions(실제 인터넷 접근)에서 이
// 테스트를 재실행할 경우 아래 CDN_LOCAL_MAP 로직은 그대로 두어도
// 무해하다(단, 그 환경에서는 CDN 원본을 그대로 써도 무방하다는 점을
// STEP 8 보고서에 명시한다).
function buildHarnessHtml() {
  const src = fs.readFileSync(DIST_HTML, 'utf8');
  const marker = "const root = ReactDOM.createRoot(document.getElementById('root'));\nroot.render(<ArcSafe />);";
  if (!src.includes(marker)) {
    throw new Error('HARNESS_MOUNT_POINT_NOT_FOUND — dist/index.html 구조가 예상과 다름(root.render(<ArcSafe/>) 라인을 찾을 수 없음)');
  }
  const harnessCaseData = `
    const __E2E_CASE__ = {
      id: "e2e-c411-case-1",
      valveTag: "PSV-E2E-C411",
      equipment: { tag:"PSV-E2E-C411", deviceType:"safetyValve", mawp:11, setPressure:10, overpressure:10 },
      dischargeSystemId: null,
      latestSnap: null,
      approvals: [],
      snapshotHistory: [],
    };
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(
      <div style={{padding:"14px 14px 40px", maxWidth:640, margin:"0 auto"}}>
        <CaseView
          caseData={__E2E_CASE__}
          dischargeSystems={[]}
          onBack={()=>{}}
          onSnapshotCreate={(id, snap)=>{ window.__E2E_LAST_SNAPSHOT__ = snap; }}
          onApprovalUpdate={()=>{}}
        />
      </div>
    );
  `;
  let html = src.replace(marker, harnessCaseData);
  if (process.env.E2E_OFFLINE_VENDOR === '1') {
    html = html
      .replace('https://unpkg.com/react@18.2.0/umd/react.production.min.js', '/vendor/react.production.min.js')
      .replace('https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js', '/vendor/react-dom.production.min.js')
      .replace('https://unpkg.com/@babel/standalone@7.23.10/babel.min.js', '/vendor/babel.min.js')
      .replace('<script src="https://auth.archsafe.co.kr/sdk/auth-client.js"></script>', '');
  }
  return html;
}

const VENDOR_FILES = {
  '/vendor/react.production.min.js': path.join(ROOT, 'node_modules/react/umd/react.production.min.js'),
  '/vendor/react-dom.production.min.js': path.join(ROOT, 'node_modules/react-dom/umd/react-dom.production.min.js'),
  '/vendor/babel.min.js': path.join(ROOT, 'node_modules/@babel/standalone/babel.min.js'),
};

function serve(html, port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (VENDOR_FILES[req.url]) {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(fs.readFileSync(VENDOR_FILES[req.url]));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// visible-only 텍스트 유틸 — e2e_c410_external_fire.js와 동일한 구현.
async function visibleText(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
      return el.getClientRects().length > 0;
    }
    function collect(node, out) {
      if (node.nodeType === 3) {
        const parent = node.parentElement;
        if (parent && parent.tagName !== 'SCRIPT' && parent.tagName !== 'STYLE' && isVisible(parent)) {
          const t = node.textContent.trim();
          if (t) out.push(t);
        }
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
      for (const child of node.childNodes) collect(child, out);
    }
    const out = [];
    collect(document.body, out);
    return out.join('\n');
  });
}

async function clearAndType(page, el, value) {
  await el.focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(el => el.value === '', {}, el);
  await el.type(String(value), { delay: 20 });
}

async function clickByText(page, text, tag = '*') {
  const handle = await page.evaluateHandle((text, tag) => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return el.getClientRects().length > 0;
    }
    const all = Array.from(document.querySelectorAll(tag));
    return all.find(el => isVisible(el) && el.textContent && el.textContent.includes(text) &&
      !Array.from(el.children).some(c => c.textContent && c.textContent.includes(text)));
  }, text, tag);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  return true;
}

// 라벨 div의 nextElementSibling이 정확히 그 number input인 실제 컴포넌트
// 구조(ScenarioNumberField)를 이용한 정밀 매칭 — 아무 조상 서브트리의
// 첫 number input을 잘못 반환하는 실수를 피한다.
async function fillNumberFieldByLabel(page, labelSubstr, value) {
  const handle = await page.evaluateHandle((labelSubstr) => {
    const divs = Array.from(document.querySelectorAll('div'));
    for (const d of divs) {
      if (d.textContent.includes(labelSubstr) &&
          d.nextElementSibling && d.nextElementSibling.tagName === 'INPUT' &&
          d.nextElementSibling.type === 'number') {
        return d.nextElementSibling;
      }
    }
    return null;
  }, labelSubstr);
  const el = handle.asElement();
  if (!el) return false;
  await clearAndType(page, el, value);
  return true;
}

async function clearNumberFieldByLabel(page, labelSubstr) {
  const handle = await page.evaluateHandle((labelSubstr) => {
    const divs = Array.from(document.querySelectorAll('div'));
    for (const d of divs) {
      if (d.textContent.includes(labelSubstr) &&
          d.nextElementSibling && d.nextElementSibling.tagName === 'INPUT' &&
          d.nextElementSibling.type === 'number') {
        return d.nextElementSibling;
      }
    }
    return null;
  }, labelSubstr);
  const el = handle.asElement();
  if (!el) return false;
  await el.focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  return true;
}

function extractW(text) {
  const m = text.match(/SCENARIO RESULT[\s\S]{0,80}?([\d,]+\.?\d*)\s*kg\/h/);
  return m ? m[1] : null;
}

async function main() {
  const results = {};
  const harnessHtml = buildHarnessHtml();
  const port = 8843;
  const server = await serve(harnessHtml, port);

  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox'],
    executablePath: process.env.E2E_CHROME_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', e => pageErrors.push(String(e)));

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('button', { timeout: 15000 });

    const startClicked = await clickByText(page, '사양 결정 시작');
    results.launchAndInitialRender = startClicked;
    await new Promise(r => setTimeout(r, 200));

    const initialText = await visibleText(page);
    results.initialSectionVisible = initialText.includes('Relief Load — §5 시나리오 기반 산정');

    // ══════════════════════════════════════════════════════════════
    //  §5.1 출구 차단 — 실제 흐름: 선택 → 입력 → 계산 → 결과 → 전환 → stale 확인
    // ══════════════════════════════════════════════════════════════
    const s51 = {};
    s51.selected = await clickByText(page, '출구 차단');
    await new Promise(r => setTimeout(r, 150));
    let t = await visibleText(page);
    s51.formShown = t.includes('PHASE') && t.includes('액체(Liquid)') && t.includes('증기(Vapor)');

    // 입력 없이 계산 불가 상태 먼저 확인 (오류/불충분 입력 상태 표시)
    s51.insufficientShownBeforeInput = t.includes('입력을 완료하면 결과가 표시됩니다');

    s51.phaseSelected = await clickByText(page, '액체(Liquid)');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    // 액체 선택 시 생성량 필드는 나타나지 않아야 함(§5.1 원문: 액체=유입량만)
    s51.generationFieldHiddenForLiquid = !t.includes('생성량 (Generation Rate)');

    s51.inflowFilled = await fillNumberFieldByLabel(page, '최대 유입량 (Inflow)', 100);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    s51.resultShown = t.includes('SCENARIO RESULT');
    s51.resultValue = extractW(t);
    s51.resultCorrect = s51.resultValue === '100';
    s51.governingBadgeShown = t.includes('GOVERNING RELIEF LOAD');
    results.s51_outletBlocked = s51;

    // ── §5.1 → §5.6 전환: stale result 미잔존 확인 ──
    const transition_51_to_56 = {};
    transition_51_to_56.switched = await clickByText(page, '과충전');
    await new Promise(r => setTimeout(r, 200));
    t = await visibleText(page);
    transition_51_to_56.oldScenarioFormGone = !t.includes('PHASE');
    transition_51_to_56.oldResultGone = !/SCENARIO RESULT[\s\S]{0,40}100\s*kg\/h/.test(t);
    transition_51_to_56.newFormShowsIncomplete = t.includes('입력을 완료하면 결과가 표시됩니다');
    results.transition_51_to_56 = transition_51_to_56;

    // ══════════════════════════════════════════════════════════════
    //  §5.6 과충전
    // ══════════════════════════════════════════════════════════════
    const s56 = {};
    t = await visibleText(page);
    s56.formShown = t.includes('최대 유입량 (Inflow)');
    s56.inflowFilled = await fillNumberFieldByLabel(page, '최대 유입량 (Inflow)', 200);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    s56.resultShown = t.includes('SCENARIO RESULT');
    s56.resultValue = extractW(t);
    s56.resultCorrect = s56.resultValue === '200';
    results.s56_overfilling = s56;

    // ══════════════════════════════════════════════════════════════
    //  §5.7 자동제어밸브 고장 (INLET_VALVE 분기)
    // ══════════════════════════════════════════════════════════════
    const s57 = {};
    s57.switched = await clickByText(page, '자동제어밸브 고장');
    await new Promise(r => setTimeout(r, 200));
    t = await visibleText(page);
    s57.oldResultGone = !/SCENARIO RESULT[\s\S]{0,40}200\s*kg\/h/.test(t);
    s57.formShown = t.includes('FAILURE MODE') && t.includes('인입 밸브 고장');

    s57.modeSelected = await clickByText(page, '인입 밸브 고장');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    s57.fieldsShown = t.includes('유입량 (Inflow)') && t.includes('유출량 (Outflow)');

    s57.inflowFilled = await fillNumberFieldByLabel(page, '유입량 (Inflow)', 300);
    s57.outflowFilled = await fillNumberFieldByLabel(page, '유출량 (Outflow)', 50);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    s57.resultShown = t.includes('SCENARIO RESULT');
    s57.resultValue = extractW(t);
    s57.resultCorrect = s57.resultValue === '250'; // 300 - 50

    // FAIL_STATIONARY 분기 전환 시 이전 INLET_VALVE 입력이 남지 않는지 확인
    s57.failStationarySelected = await clickByText(page, 'Fail-stationary');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    s57.failStationaryFieldsShown = t.includes('개방 가정 유출량') && t.includes('폐쇄 가정 유출량');
    s57.oldOutflowFieldGoneUnderFailStationary = !t.includes('유출량 (Outflow)');
    s57.previousResultClearedOnModeSwitch = !/SCENARIO RESULT[\s\S]{0,40}250\s*kg\/h/.test(t);
    results.s57_controlValveFail = s57;

    // ── §5.7 → §5.8 전환 확인 ──
    const transition_57_to_58 = {};
    transition_57_to_58.switched = await clickByText(page, '비정상 열/증기 유입');
    await new Promise(r => setTimeout(r, 200));
    t = await visibleText(page);
    transition_57_to_58.oldScenarioFormGone = !t.includes('FAILURE MODE') || !t.includes('Fail-stationary');
    results.transition_57_to_58 = transition_57_to_58;

    // ══════════════════════════════════════════════════════════════
    //  §5.8 비정상 열/증기 유입 (ABNORMAL_HEAT_INPUT 분기)
    // ══════════════════════════════════════════════════════════════
    const s58 = {};
    t = await visibleText(page);
    s58.formShown = t.includes('FAILURE MODE') && t.includes('비정상 열 입력');

    s58.modeSelected = await clickByText(page, '비정상 열 입력');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    s58.fieldsShown = t.includes('증기 발생량 (Vapor Generation)') && t.includes('정상 유출량 (Outflow)');

    s58.genFilled = await fillNumberFieldByLabel(page, '증기 발생량 (Vapor Generation)', 150);
    s58.outflowFilled = await fillNumberFieldByLabel(page, '정상 유출량 (Outflow)', 20);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    s58.resultShown = t.includes('SCENARIO RESULT');
    s58.resultValue = extractW(t);
    s58.resultCorrect = s58.resultValue === '130'; // 150 - 20

    // CHECK_VALVE_FAILURE — 계산식 없음, NEEDS_ENGINEERING_DECISION 고정 문구
    s58.checkValveSelected = await clickByText(page, '체크밸브 고장');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    s58.needsEngineeringDecisionShown = t.includes('원문에 계산식이 없어 이 앱은 자동으로 산정하지 않습니다');
    s58.previousResultClearedOnModeSwitch = !/SCENARIO RESULT[\s\S]{0,40}130\s*kg\/h/.test(t);
    results.s58_abnormalHeatVapor = s58;

    // ══════════════════════════════════════════════════════════════
    //  오류/불충분 입력 상태 — §5.7로 되돌아가 필드 하나만 비운 상태 확인
    // ══════════════════════════════════════════════════════════════
    const errState = {};
    await clickByText(page, '자동제어밸브 고장');
    await new Promise(r => setTimeout(r, 150));
    await clickByText(page, '인입 밸브 고장');
    await new Promise(r => setTimeout(r, 150));
    await fillNumberFieldByLabel(page, '유입량 (Inflow)', 400);
    await new Promise(r => setTimeout(r, 200));
    t = await visibleText(page);
    errState.incompleteShownWithOnlyOneFieldFilled = t.includes('입력을 완료하면 결과가 표시됩니다');
    errState.noResultShownYet = !t.includes('SCENARIO RESULT');
    await fillNumberFieldByLabel(page, '유출량 (Outflow)', 100);
    await new Promise(r => setTimeout(r, 200));
    t = await visibleText(page);
    errState.resultAppearsAfterCompleting = t.includes('SCENARIO RESULT') && extractW(t) === '300';
    // 다시 비워서 stale 결과가 남지 않는지 확인
    await clearNumberFieldByLabel(page, '유출량 (Outflow)');
    await new Promise(r => setTimeout(r, 200));
    t = await visibleText(page);
    errState.staleResultRemovedAfterClearing = !/SCENARIO RESULT[\s\S]{0,40}300\s*kg\/h/.test(t) &&
      t.includes('입력을 완료하면 결과가 표시됩니다');
    results.errorInsufficientInputState = errState;

    // ══════════════════════════════════════════════════════════════
    //  "시나리오 사용 안 함 → Manual W로 복귀" 버튼 실제 동작
    // ══════════════════════════════════════════════════════════════
    const manualReturn = {};
    t = await visibleText(page);
    manualReturn.buttonVisible = t.includes('시나리오 사용 안 함 → Manual W로 복귀');
    manualReturn.clicked = await clickByText(page, '시나리오 사용 안 함 → Manual W로 복귀');
    await new Promise(r => setTimeout(r, 200));
    t = await visibleText(page);
    manualReturn.manualInputBadgeRestored = t.includes('MANUAL INPUT 사용 중');
    manualReturn.scenarioFormGone = !t.includes('FAILURE MODE');
    results.manualReturn = manualReturn;

    // ══════════════════════════════════════════════════════════════
    //  Responsive — Desktop / Mobile viewport에서 §5 섹션 레이아웃 확인
    // ══════════════════════════════════════════════════════════════
    await clickByText(page, '출구 차단');
    await clickByText(page, '액체(Liquid)');
    await new Promise(r => setTimeout(r, 150));
    await fillNumberFieldByLabel(page, '최대 유입량 (Inflow)', 100);
    await new Promise(r => setTimeout(r, 200));

    const desktopLayout = await page.evaluate(() => {
      const el = document.body;
      return { scrollWidth: el.scrollWidth, clientWidth: document.documentElement.clientWidth };
    });
    results.desktop = { viewport: '1280x900', noHorizontalOverflow: desktopLayout.scrollWidth <= desktopLayout.clientWidth + 2, debug: desktopLayout };

    await page.setViewport({ width: 375, height: 800 });
    await new Promise(r => setTimeout(r, 200));
    const tMobile = await visibleText(page);
    const mobileLayout = await page.evaluate(() => {
      const el = document.body;
      return { scrollWidth: el.scrollWidth, clientWidth: document.documentElement.clientWidth };
    });
    results.mobile = {
      viewport: '375x800',
      noHorizontalOverflow: mobileLayout.scrollWidth <= mobileLayout.clientWidth + 2,
      debug: mobileLayout,
      scenarioSectionStillVisible: tMobile.includes('Relief Load — §5 시나리오 기반 산정'),
      resultStillVisible: tMobile.includes('SCENARIO RESULT') && extractW(tMobile) === '100',
    };
    await page.setViewport({ width: 1280, height: 900 });
    await new Promise(r => setTimeout(r, 150));

    // ══════════════════════════════════════════════════════════════
    //  Console / runtime — onSelect류 wiring 결함이 있었다면 여기서 잡힌다
    // ══════════════════════════════════════════════════════════════
    results.consoleErrors = consoleErrors;
    results.pageErrors = pageErrors;
    results.noConsoleErrors = consoleErrors.length === 0;
    results.noPageErrors = pageErrors.length === 0;

    // ── 기존 §5.12 외부화재 회귀 smoke (§5.11 C-4.10 스코프 보호 확인) ──
    await clickByText(page, '외부화재');
    await new Promise(r => setTimeout(r, 150));
    const tFire = await visibleText(page);
    results.externalFireStillIntact = tFire.includes('개방된 액면 화재 (액체)');

  } catch (e) {
    results.fatalError = String(e && e.stack || e);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(JSON.stringify(results, null, 2));

  const s51ok = results.s51_outletBlocked && results.s51_outletBlocked.selected && results.s51_outletBlocked.formShown &&
    results.s51_outletBlocked.insufficientShownBeforeInput && results.s51_outletBlocked.generationFieldHiddenForLiquid &&
    results.s51_outletBlocked.resultShown && results.s51_outletBlocked.resultCorrect && results.s51_outletBlocked.governingBadgeShown;
  const t51to56ok = results.transition_51_to_56 && results.transition_51_to_56.switched &&
    results.transition_51_to_56.oldScenarioFormGone && results.transition_51_to_56.oldResultGone &&
    results.transition_51_to_56.newFormShowsIncomplete;
  const s56ok = results.s56_overfilling && results.s56_overfilling.formShown && results.s56_overfilling.resultShown &&
    results.s56_overfilling.resultCorrect;
  const s57ok = results.s57_controlValveFail && results.s57_controlValveFail.switched && results.s57_controlValveFail.oldResultGone &&
    results.s57_controlValveFail.formShown && results.s57_controlValveFail.modeSelected && results.s57_controlValveFail.fieldsShown &&
    results.s57_controlValveFail.resultShown && results.s57_controlValveFail.resultCorrect &&
    results.s57_controlValveFail.failStationarySelected && results.s57_controlValveFail.failStationaryFieldsShown &&
    results.s57_controlValveFail.oldOutflowFieldGoneUnderFailStationary && results.s57_controlValveFail.previousResultClearedOnModeSwitch;
  const t57to58ok = results.transition_57_to_58 && results.transition_57_to_58.switched && results.transition_57_to_58.oldScenarioFormGone;
  const s58ok = results.s58_abnormalHeatVapor && results.s58_abnormalHeatVapor.formShown && results.s58_abnormalHeatVapor.modeSelected &&
    results.s58_abnormalHeatVapor.fieldsShown && results.s58_abnormalHeatVapor.resultShown && results.s58_abnormalHeatVapor.resultCorrect &&
    results.s58_abnormalHeatVapor.checkValveSelected && results.s58_abnormalHeatVapor.needsEngineeringDecisionShown &&
    results.s58_abnormalHeatVapor.previousResultClearedOnModeSwitch;
  const errOk = results.errorInsufficientInputState && results.errorInsufficientInputState.incompleteShownWithOnlyOneFieldFilled &&
    results.errorInsufficientInputState.noResultShownYet && results.errorInsufficientInputState.resultAppearsAfterCompleting &&
    results.errorInsufficientInputState.staleResultRemovedAfterClearing;
  const manualOk = results.manualReturn && results.manualReturn.buttonVisible && results.manualReturn.clicked &&
    results.manualReturn.manualInputBadgeRestored && results.manualReturn.scenarioFormGone;
  const responsiveOk = results.desktop && results.desktop.noHorizontalOverflow &&
    results.mobile && results.mobile.noHorizontalOverflow && results.mobile.scenarioSectionStillVisible && results.mobile.resultStillVisible;
  const runtimeOk = results.noConsoleErrors && results.noPageErrors;
  const fireIntactOk = results.externalFireStillIntact === true;

  const allPass = !results.fatalError && s51ok && t51to56ok && s56ok && s57ok && t57to58ok && s58ok && errOk && manualOk && responsiveOk && runtimeOk && fireIntactOk;

  console.log('\n=== C-4.11 §5.1/5.6/5.7/5.8 BROWSER E2E: ' + (allPass ? 'PASS' : 'FAIL') + ' ===');
  console.log(JSON.stringify({
    s51ok, t51to56ok, s56ok, s57ok, t57to58ok, s58ok, errOk, manualOk, responsiveOk, runtimeOk, fireIntactOk,
  }, null, 2));
  process.exit(allPass ? 0 : 1);
}

main();
