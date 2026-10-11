#!/usr/bin/env node
/**
 * C-4.12 REV2 §5.11 LIQUID THERMAL EXPANSION — Browser E2E
 * ════════════════════════════════════════════════════════════════════
 * 핵심 판정 두 가지(Engine/Snapshot 아님, 실제 브라우저에서만 검증 가능한 것):
 *   ① §5.11이 기존 5개 MASS_FLOW exclusive-radio 그룹과 완전히 분리된
 *      독립 블록으로 렌더링되고, 다른 시나리오 선택/Manual W 상태와
 *      무관하게 동작하는가.
 *   ② §5.11 계산 결과가 Snapshot.reliefLoad.supplementary[]에 실제로
 *      도달하고, governing에는 절대 섞이지 않는가(Node runtime 값 검증,
 *      정적 소스 검사 아님 — window.__E2E_LAST_SNAPSHOT__ 실측).
 * Engine(src/engine/relief_load.js)은 이 테스트 어디에서도 재구현하지
 * 않는다 — 오직 실제 브라우저 클릭/입력 → 화면에 반영된 Engine 결과만
 * 확인한다.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const DIST_HTML = path.join(ROOT, 'dist', 'index.html');

function buildHarnessHtml() {
  const src = fs.readFileSync(DIST_HTML, 'utf8');
  const marker = "const root = ReactDOM.createRoot(document.getElementById('root'));\nroot.render(<ArcSafe />);";
  if (!src.includes(marker)) {
    throw new Error('HARNESS_MOUNT_POINT_NOT_FOUND — dist/index.html 구조가 예상과 다름');
  }
  const harnessCaseData = `
    const __E2E_CASE__ = {
      id: "e2e-c412-case-1",
      valveTag: "PSV-E2E-C412",
      equipment: { tag:"PSV-E2E-C412", deviceType:"safetyValve", mawp:11, setPressure:10, overpressure:10 },
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

async function main() {
  const results = {};
  const harnessHtml = buildHarnessHtml();
  const port = 8860;
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
    await new Promise(r => setTimeout(r, 200));

    // ════════════════════════════════════════════════════════════════
    //  C-4.32 Journey D 이후 계약(코드 대조 완료):
    //   · W 산정 근거는 3탭(수동 입력 W / PSV 과압 시나리오 / 열팽창용 안전밸브)으로 배타 렌더링.
    //   · §5.11 블록은 "열팽창용 안전밸브" 탭에서만 렌더, 입력은 β·QF·S, 결과 W = QF·β/S [kg/h].
    //   · 입력 state 는 CaseView 소유 — 탭을 바꿔도 보존, 블록 열림/닫힘만 로컬 state.
    //   · Snapshot: §5.11 이 활성 소스면 reliefLoad.governing 에 기록(supplementary 중복 없음),
    //     비활성이어도 유효 입력이면 supplementary 에 {scenario, W, unit:'kg/h'} 로만 기록.
    //  진입: 하네스는 latestSnap=null 인 CaseView 를 직접 마운트 → InputView 1/7 에서 시작.
    // ════════════════════════════════════════════════════════════════
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const TAB_SCENARIO = 'PSV 과압 시나리오';
    const TAB_LE = '열팽창용 안전밸브(§5.11';
    const TAB_MANUAL = '수동 입력 W';
    const RESULT_RE = (w) => new RegExp('SCENARIO RESULT\\s*' + w + '\\s*kg\\/h');
    async function enterStep2() {          // 1/7 → 2/7(방출 시나리오)
      const ok = await clickByText(page, '다음 →');
      await sleep(200);
      return ok;
    }
    async function goTab(label) {
      const ok = await clickByText(page, label);
      await sleep(200);
      return ok;
    }
    async function fillLE(beta, qf, cp) {  // §5.11 입력(β·QF·S)
      await fillNumberFieldByLabel(page, '열팽창 부피계수', beta);
      await fillNumberFieldByLabel(page, '유입 열량', qf);
      await fillNumberFieldByLabel(page, '비열', cp);
      await sleep(250);
    }
    async function confirmSpec() {         // '사양 확정' 은 7단계 — "다음 →" 로 이동 후 클릭
      for (let i = 0; i < 8 && !(await visibleText(page)).includes('사양 확정'); i++) {
        if (!(await clickByText(page, '다음 →'))) break;
        await sleep(200);
      }
      const ok = await clickByText(page, '사양 확정');
      await sleep(300);
      return ok;
    }
    // CaseView 는 Draft(IndexedDB caseDrafts, PERSISTENCE-001)를 같은 caseId 로 복원하므로,
    // 시나리오 간 상태가 새지 않도록 새 진입 전에 이 origin 의 저장소를 비운다(테스트 위생).
    async function freshStart() {
      const cdp = await page.createCDPSession();
      await cdp.send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${port}`, storageTypes: 'indexeddb,local_storage' });
      await cdp.detach();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 30000 });
      await sleep(200);
      return enterStep2();
    }

    // 1~3. 진입, 기존 5개 카드 정상 표시, §5.11 은 카드가 아니라 별도 W 산정 근거 탭
    results.entryNavigationOk = await enterStep2();
    results.scenarioTabSelected = await goTab(TAB_SCENARIO);
    let t = await visibleText(page);
    results.existingScenarioCardsShown = t.includes('출구 차단') && t.includes('과충전') &&
      t.includes('자동제어밸브 고장') && t.includes('비정상 열/증기 유입') && t.includes('외부화재');
    // §5.11 이 5개 카드 그룹 안에 없어야 함 — 시나리오 탭에는 §5.11 블록/카드가 없고 별도 탭으로만 존재
    results.liquidExpansionNotARadioCard = !t.includes('액체부피팽창 계산 열기') && t.includes(TAB_LE);
    await goTab(TAB_LE);
    t = await visibleText(page);
    results.liquidExpansionBlockShown = t.includes('열팽창용 안전밸브 (§5.11') && t.includes('액체부피팽창 계산 열기');

    // 4. §5.11 열기 (다른 시나리오 카드를 고르지 않아도 열림)
    const openClicked = await clickByText(page, '액체부피팽창 계산 열기');
    results.openedIndependently = openClicked;
    await sleep(150);
    t = await visibleText(page);
    results.formShownAfterOpen = t.includes('열팽창 부피계수') && t.includes('유입 열량') && t.includes('비열');
    results.insufficientBeforeInput = t.includes('입력을 완료하면 결과가 표시됩니다');
    // 재정의(구 nonGoverningNoticeShown 일부): 활성 §5.11 탭의 미완료 상태 배지
    results.incompleteBadgeShownBeforeInput = t.includes('입력 미완료');

    // 5~7. β/QF/S 입력 → 즉시 계산 → W [kg/h]
    // W = QF·β/S = 5000·0.001/0.5 = 10 kg/h
    await fillLE(0.001, 5000, 0.5);
    t = await visibleText(page);
    results.computableShown = t.includes('SCENARIO RESULT');
    results.valueCorrect = RESULT_RE(10).test(t);
    results.unitShown = t.includes('kg/h');
    results.formulaShown = t.includes('W = QF·β / S');
    // 재정의(구 nonGoverningNoticeShown 일부): 활성 §5.11 탭의 "SIZING에 사용 중" 상태 배지
    results.sizingBadgeShownWhenValid = t.includes('SIZING에 사용 중') && !t.includes('입력 미완료');

    // 8~9. 시나리오 탭에서 §5.1 선택 — §5.11 입력은 탭을 오가도 보존, §5.1 결과에 영향 없음
    await goTab(TAB_SCENARIO);
    const s51selected = await clickByText(page, '출구 차단');
    await sleep(150);
    await clickByText(page, '액체(Liquid)');
    await sleep(150);
    await fillNumberFieldByLabel(page, '최대 유입량 (Inflow)', 100);
    await sleep(250);
    t = await visibleText(page);
    results.s51SelectedWhileLiquidExpansionOpen = s51selected && t.includes('PHASE');
    results.s51ResultShown = /100\s*kg\/h/.test(t);
    // §5.1 §5.1 의 governing 결과가 §5.11 값 때문에 바뀌지 않았는지(정확히 100 유지)
    results.governingUnaffectedByLiquidExpansion = /100\s*kg\/h/.test(t) && !/125\s*kg\/h/.test(t);
    // §5.11 탭으로 돌아가 다시 열어 입력값(β·QF·S)과 결과가 그대로인지(state 오염/소실 없음)
    await goTab(TAB_LE);
    await clickByText(page, '액체부피팽창 계산 열기');
    await sleep(200);
    t = await visibleText(page);
    results.liquidExpansionSurvivesOtherScenarioSelection = t.includes('열팽창 부피계수') && RESULT_RE(10).test(t);

    // 10~11. §5.11 재계산 — 입력을 바꿔도 §5.1 결과가 변하지 않는지 재확인
    await fillNumberFieldByLabel(page, '열팽창 부피계수', 0.002);
    await sleep(250);
    t = await visibleText(page);
    // 새 값: 5000·0.002/0.5 = 20 kg/h
    results.liquidExpansionRecalculated = RESULT_RE(20).test(t);
    await goTab(TAB_SCENARIO);
    t = await visibleText(page);
    results.s51StillIntactAfterLiquidExpansionChange = /100\s*kg\/h/.test(t);

    // 12. 불충분 입력으로 되돌리면 stale 결과가 남지 않는지 (S 는 분모 — 비우면 무효)
    await goTab(TAB_LE);
    await clickByText(page, '액체부피팽창 계산 열기');
    await sleep(200);
    await clearNumberFieldByLabel(page, '비열');
    await sleep(250);
    t = await visibleText(page);
    results.staleClearedOnIncompleteInput = t.includes('입력을 완료하면 결과가 표시됩니다') &&
      !RESULT_RE(20).test(t) && t.includes('입력 미완료');
    await fillNumberFieldByLabel(page, '비열', 0.5);
    await sleep(250);

    // 13. 블록 닫기 → 다시 열기: 입력값이 보존되는지(CaseView 레벨 state)
    const closedClicked = await clickByText(page, '닫기');
    await sleep(150);
    t = await visibleText(page);
    results.closedHidesForm = !t.includes('열팽창 부피계수');
    const reopenClicked = await clickByText(page, '액체부피팽창 계산 열기');
    await sleep(150);
    t = await visibleText(page);
    results.reopenPreservesValue = RESULT_RE(20).test(t); // β=0.002 그대로였으므로 20 kg/h 재표시
    results.closeReopenWorked = closedClicked && reopenClicked;

    // ── Snapshot Node-runtime 검증 ──
    // (a) §5.11 비활성(시나리오 탭 + §5.1 선택) + 유효 §5.11 입력 → governing=§5.1, supplementary=§5.11
    await goTab(TAB_SCENARIO);
    const calcClicked = await confirmSpec();
    const snap1 = await page.evaluate(() => window.__E2E_LAST_SNAPSHOT__ || null);
    results.snapshotCreated_withGoverning = !!snap1 && calcClicked;
    results.snapshot_governingPreserved = snap1 && snap1.reliefLoad && snap1.reliefLoad.governing === 'OUTLET_BLOCKED';
    results.snapshot_supplementaryExists = snap1 && Array.isArray(snap1.reliefLoad?.supplementary) &&
      snap1.reliefLoad.supplementary.length === 1;
    results.snapshot_supplementaryScenario = snap1?.reliefLoad?.supplementary?.[0]?.scenario === 'LIQUID_THERMAL_EXPANSION';
    // C-4.32 이후: 단위 kg/h, 값 필드 W (이전: m3/h, value)
    results.snapshot_supplementaryUnit = snap1?.reliefLoad?.supplementary?.[0]?.unit === 'kg/h';
    results.snapshot_supplementaryValueClose = snap1?.reliefLoad?.supplementary?.[0]?.W !== undefined &&
      Math.abs(snap1.reliefLoad.supplementary[0].W - 20) < 1e-9;
    // 재정의(구 nonGoverningNoticeShown 일부): 비활성 §5.11 값은 governing 에 섞이지 않는다
    results.snapshot_supplementaryNotInGoverning = snap1?.reliefLoad?.governing !== 'LIQUID_THERMAL_EXPANSION' &&
      snap1?.reliefLoad?.governing !== 'LIQUID_EXPANSION';

    // (b) Governing scenario 없이(수동 W 탭) §5.11 supplementary 만 있는 케이스
    await freshStart();
    await goTab(TAB_LE);
    await clickByText(page, '액체부피팽창 계산 열기');
    await sleep(150);
    await fillLE(0.001, 5000, 0.5);
    await goTab(TAB_MANUAL);            // §5.11 비활성화(입력 state 는 유지)
    const calc2 = await confirmSpec();
    const snap2 = await page.evaluate(() => window.__E2E_LAST_SNAPSHOT__ || null);
    results.snapshotCreated_manualWOnly = !!snap2 && calc2;
    results.snapshot_governingNullWhenNoScenario = snap2 && snap2.reliefLoad && snap2.reliefLoad.governing === null;
    results.snapshot_supplementaryAloneExists = snap2 && Array.isArray(snap2.reliefLoad?.supplementary) &&
      snap2.reliefLoad.supplementary.length === 1 &&
      Math.abs(snap2.reliefLoad.supplementary[0].W - 10) < 1e-9;

    // (c) 신규(감독 결정): §5.11 을 활성 W 소스로 선택하고 사양 확정 → governing 에 기록, supplementary 중복 없음
    await freshStart();
    await goTab(TAB_LE);
    await clickByText(page, '액체부피팽창 계산 열기');
    await sleep(150);
    await fillLE(0.001, 5000, 0.5);
    const calc4 = await confirmSpec();
    const snap4 = await page.evaluate(() => window.__E2E_LAST_SNAPSHOT__ || null);
    results.snapshotCreated_activeLE = !!snap4 && calc4;
    // governing id 는 Engine 의 scenarioId("LIQUID_EXPANSION") — CaseView 가 selector 결과를 그대로 기록
    results.snapshot_activeLE_governingRecorded = snap4?.reliefLoad?.governing === 'LIQUID_EXPANSION' &&
      snap4?.reliefLoad?.quantity === 'MASS_FLOW' && snap4?.reliefLoad?.unit === 'kg/h';
    results.snapshot_activeLE_noDuplicateSupplementary =
      !(snap4?.reliefLoad?.supplementary || []).some(x => x.scenario === 'LIQUID_THERMAL_EXPANSION');

    // ── 아무것도 안 쓴 기존 Case(§5.11/governing 둘 다 미사용) — 하위호환 확인 ──
    await freshStart();
    const calc3 = await confirmSpec();
    const snap3 = await page.evaluate(() => window.__E2E_LAST_SNAPSHOT__ || null);
    results.snapshotCreated_bareDefault = !!snap3 && calc3;
    results.snapshot_reliefLoadNullWhenUnused = snap3 && snap3.reliefLoad === null;

    // ── Responsive ──
    await freshStart();
    await goTab(TAB_LE);
    await clickByText(page, '액체부피팽창 계산 열기');
    await sleep(150);
    await fillLE(0.001, 5000, 0.5);
    const desktopLayout = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth,
    }));
    results.desktop = { noHorizontalOverflow: desktopLayout.scrollWidth <= desktopLayout.clientWidth + 2, debug: desktopLayout };

    await page.setViewport({ width: 375, height: 800 });
    await sleep(200);
    const tMobile = await visibleText(page);
    const mobileLayout = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth,
    }));
    results.mobile = {
      noHorizontalOverflow: mobileLayout.scrollWidth <= mobileLayout.clientWidth + 2,
      debug: mobileLayout,
      blockStillVisible: tMobile.includes('열팽창용 안전밸브 (§5.11'),
      resultStillVisible: RESULT_RE(10).test(tMobile),
    };
    await page.setViewport({ width: 1280, height: 900 });

    // ── Console / runtime ──
    results.consoleErrors = consoleErrors;
    results.pageErrors = pageErrors;
    results.noConsoleErrors = consoleErrors.length === 0;
    results.noPageErrors = pageErrors.length === 0;

  } catch (e) {
    results.fatalError = String(e && e.stack || e);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(JSON.stringify(results, null, 2));

  const uiIndependenceOk = results.existingScenarioCardsShown && results.liquidExpansionBlockShown &&
    results.liquidExpansionNotARadioCard && results.openedIndependently && results.formShownAfterOpen &&
    results.insufficientBeforeInput && results.incompleteBadgeShownBeforeInput &&
    results.computableShown && results.valueCorrect && results.unitShown && results.formulaShown &&
    results.sizingBadgeShownWhenValid &&
    results.s51SelectedWhileLiquidExpansionOpen && results.s51ResultShown &&
    results.liquidExpansionSurvivesOtherScenarioSelection && results.governingUnaffectedByLiquidExpansion &&
    results.liquidExpansionRecalculated && results.s51StillIntactAfterLiquidExpansionChange &&
    results.staleClearedOnIncompleteInput && results.closeReopenWorked && results.closedHidesForm &&
    results.reopenPreservesValue;

  const snapshotOk = results.snapshotCreated_withGoverning && results.snapshot_governingPreserved &&
    results.snapshot_supplementaryExists && results.snapshot_supplementaryScenario &&
    results.snapshot_supplementaryUnit && results.snapshot_supplementaryValueClose &&
    results.snapshot_supplementaryNotInGoverning &&
    results.snapshotCreated_manualWOnly && results.snapshot_governingNullWhenNoScenario &&
    results.snapshot_supplementaryAloneExists &&
    results.snapshotCreated_activeLE && results.snapshot_activeLE_governingRecorded &&
    results.snapshot_activeLE_noDuplicateSupplementary &&
    results.snapshotCreated_bareDefault && results.snapshot_reliefLoadNullWhenUnused;

  const responsiveOk = results.desktop?.noHorizontalOverflow && results.mobile?.noHorizontalOverflow &&
    results.mobile?.blockStillVisible && results.mobile?.resultStillVisible;
  const runtimeOk = results.noConsoleErrors && results.noPageErrors;

  const allPass = !results.fatalError && uiIndependenceOk && snapshotOk && responsiveOk && runtimeOk;

  console.log('\n=== C-4.12 REV2 §5.11 BROWSER E2E: ' + (allPass ? 'PASS' : 'FAIL') + ' ===');
  console.log(JSON.stringify({ uiIndependenceOk, snapshotOk, responsiveOk, runtimeOk }, null, 2));
  process.exit(allPass ? 0 : 1);
}

main();
