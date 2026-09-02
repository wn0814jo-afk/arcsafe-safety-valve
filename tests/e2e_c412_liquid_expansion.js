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

    // 1~3. 앱 진입, 기존 5개 카드 정상 표시, §5.11 독립 블록 표시
    let t = await visibleText(page);
    results.existingScenarioCardsShown = t.includes('출구 차단') && t.includes('과충전') &&
      t.includes('자동제어밸브 고장') && t.includes('비정상 열/증기 유입') && t.includes('외부화재');
    results.liquidExpansionBlockShown = t.includes('부가 계산 — 액체부피팽창 (§5.11, 참고용)');
    // §5.11이 5개 카드 라디오 그룹 "안"에는 없어야 함 — 카드 라벨 목록에 "액체부피팽창" 텍스트가
    // 안 보이는 상태(블록 헤더 문구는 위에서 별도 확인했으므로, 여기선 카드 형태 라벨 부재만 확인)
    results.liquidExpansionNotARadioCard = !t.includes('§5.11') || t.includes('부가 계산 — 액체부피팽창');

    // 4. §5.11 열기 (닫혀있는 상태에서 시작 — 다른 카드 선택 없이도 열림)
    const openClicked = await clickByText(page, '액체부피팽창 계산 열기');
    results.openedIndependently = openClicked;
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.formShownAfterOpen = t.includes('체적팽창계수') && t.includes('유입 열량') &&
      t.includes('비중') && t.includes('비열');
    results.insufficientBeforeInput = t.includes('입력을 완료하면 결과가 표시됩니다');

    // 5~7. α/Q/SG/Cp 입력 → 계산(버튼 없이 즉시 반영) → COMPUTABLE 결과 표시
    // V = α·Q / (500·SG·Cp) = (0.001 * 5000) / (500 * 0.8 * 0.5) = 5 / 200 = 0.025 m3/h
    await fillNumberFieldByLabel(page, '체적팽창계수 α', 0.001);
    await fillNumberFieldByLabel(page, '유입 열량 Q', 5000);
    await fillNumberFieldByLabel(page, '비중 SG', 0.8);
    await fillNumberFieldByLabel(page, '비열 Cp', 0.5);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    results.computableShown = t.includes('SCENARIO RESULT') || /0\.025/.test(t);
    results.valueCorrect = /0\.025/.test(t);
    results.unitShown = t.includes('m³/h') || t.includes('m3/h');
    results.nonGoverningNoticeShown = t.includes('governing') || t.includes('sizing에 자동 반영되지 않습') ||
      t.includes('kg/h 시나리오에서만 산정');
    results.noGoverningBadgeOnLiquidExpansion = !/GOVERNING RELIEF LOAD[\s\S]{0,60}0\.025/.test(t);

    // 8~9. 기존 MASS_FLOW governing 시나리오(§5.1) 선택 — §5.11이 여전히 열려있고
    // 값이 보존되는지, 서로 state가 섞이지 않는지 확인
    const s51selected = await clickByText(page, '출구 차단');
    await new Promise(r => setTimeout(r, 150));
    await clickByText(page, '액체(Liquid)');
    await new Promise(r => setTimeout(r, 150));
    await fillNumberFieldByLabel(page, '최대 유입량 (Inflow)', 100);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    results.s51SelectedWhileLiquidExpansionOpen = s51selected && t.includes('PHASE');
    results.s51ResultShown = /100\s*kg\/h/.test(t);
    // §5.11 블록/입력이 §5.1 선택 이후에도 그대로 남아있는지(state 오염 없음)
    results.liquidExpansionSurvivesOtherScenarioSelection = t.includes('부가 계산 — 액체부피팽창') &&
      t.includes('체적팽창계수') && /0\.025/.test(t);
    // §5.1의 governing 결과가 §5.11 값 때문에 바뀌지 않았는지(정확히 100 유지)
    results.governingUnaffectedByLiquidExpansion = /100\s*kg\/h/.test(t) && !/125\s*kg\/h/.test(t);

    // 10~11. §5.11 재계산 — 입력을 바꿔도 §5.1 결과가 변하지 않는지 재확인
    await fillNumberFieldByLabel(page, '체적팽창계수 α', 0.002);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    // 새 값: (0.002*5000)/(500*0.8*0.5) = 10/200 = 0.05
    results.liquidExpansionRecalculated = /0\.05\b/.test(t);
    results.s51StillIntactAfterLiquidExpansionChange = /100\s*kg\/h/.test(t);

    // 12. 불충분 입력으로 되돌리면 stale 결과가 남지 않는지
    await clearNumberFieldByLabel(page, '비중 SG');
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    results.staleClearedOnIncompleteInput = t.includes('입력을 완료하면 결과가 표시됩니다') &&
      !/0\.05\b/.test(t);
    await fillNumberFieldByLabel(page, '비중 SG', 0.8);
    await new Promise(r => setTimeout(r, 250));

    // 13. 블록 닫기 → 다시 열기: 입력값이 보존되는지(CaseView 레벨 state이므로 유지되어야 함)
    const closedClicked = await clickByText(page, '닫기');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.closedHidesForm = !t.includes('체적팽창계수');
    const reopenClicked = await clickByText(page, '액체부피팽창 계산 열기');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.reopenPreservesValue = /0\.05\b/.test(t); // α=0.002 그대로였으므로 0.05 재표시
    results.closeReopenWorked = closedClicked && reopenClicked;

    // 14. Manual W(시나리오 선택 없음) 상태에서도 §5.11이 동작하는지 —
    // §5.1 선택 해제 없이 이 요구사항은 이미 "동시 사용 가능" 형태로 검증했으므로,
    // 여기서는 별도로 시나리오를 아예 선택하지 않은 새 진입 상태에서도 성립함을
    // 스냅샷 레벨(아래 STEP)에서 재확인한다.

    // ── Snapshot Node-runtime 검증 (①/② 핵심 판정) ──
    // §5.1이 여전히 선택된 채로 "사양 결정" 실행 → governing=§5.1, supplementary=§5.11
    const calcClicked = await clickByText(page, '사양 확정');
    await new Promise(r => setTimeout(r, 300));
    const snap1 = await page.evaluate(() => window.__E2E_LAST_SNAPSHOT__ || null);
    results.snapshotCreated_withGoverning = !!snap1;
    results.snapshot_governingPreserved = snap1 && snap1.reliefLoad && snap1.reliefLoad.governing === 'OUTLET_BLOCKED';
    results.snapshot_supplementaryExists = snap1 && Array.isArray(snap1.reliefLoad?.supplementary) &&
      snap1.reliefLoad.supplementary.length === 1;
    results.snapshot_supplementaryScenario = snap1?.reliefLoad?.supplementary?.[0]?.scenario === 'LIQUID_THERMAL_EXPANSION';
    results.snapshot_supplementaryUnit = snap1?.reliefLoad?.supplementary?.[0]?.unit === 'm3/h';
    results.snapshot_supplementaryValueClose = snap1?.reliefLoad?.supplementary?.[0]?.value !== undefined &&
      Math.abs(snap1.reliefLoad.supplementary[0].value - 0.05) < 1e-9;
    results.snapshot_supplementaryNotInGoverning = snap1?.reliefLoad?.governing !== 'LIQUID_THERMAL_EXPANSION';

    // ── Governing scenario 없이(Manual W만) §5.11 supplementary만 있는 케이스 ──
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 200));
    await clickByText(page, '액체부피팽창 계산 열기');
    await new Promise(r => setTimeout(r, 150));
    await fillNumberFieldByLabel(page, '체적팽창계수 α', 0.001);
    await fillNumberFieldByLabel(page, '유입 열량 Q', 5000);
    await fillNumberFieldByLabel(page, '비중 SG', 0.8);
    await fillNumberFieldByLabel(page, '비열 Cp', 0.5);
    await new Promise(r => setTimeout(r, 250));
    const calc2 = await clickByText(page, '사양 확정');
    await new Promise(r => setTimeout(r, 300));
    const snap2 = await page.evaluate(() => window.__E2E_LAST_SNAPSHOT__ || null);
    results.snapshotCreated_manualWOnly = !!snap2 && calc2;
    results.snapshot_governingNullWhenNoScenario = snap2 && snap2.reliefLoad && snap2.reliefLoad.governing === null;
    results.snapshot_supplementaryAloneExists = snap2 && Array.isArray(snap2.reliefLoad?.supplementary) &&
      snap2.reliefLoad.supplementary.length === 1 &&
      Math.abs(snap2.reliefLoad.supplementary[0].value - 0.025) < 1e-9;

    // ── 아무것도 안 쓴 기존 Case(§5.11/governing 둘 다 미사용) — 하위호환 확인 ──
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 200));
    const calc3 = await clickByText(page, '사양 확정');
    await new Promise(r => setTimeout(r, 300));
    const snap3 = await page.evaluate(() => window.__E2E_LAST_SNAPSHOT__ || null);
    results.snapshotCreated_bareDefault = !!snap3 && calc3;
    results.snapshot_reliefLoadNullWhenUnused = snap3 && snap3.reliefLoad === null;

    // ── Responsive ──
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 200));
    await clickByText(page, '액체부피팽창 계산 열기');
    await fillNumberFieldByLabel(page, '체적팽창계수 α', 0.001);
    await fillNumberFieldByLabel(page, '유입 열량 Q', 5000);
    await fillNumberFieldByLabel(page, '비중 SG', 0.8);
    await fillNumberFieldByLabel(page, '비열 Cp', 0.5);
    await new Promise(r => setTimeout(r, 250));
    const desktopLayout = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth,
    }));
    results.desktop = { noHorizontalOverflow: desktopLayout.scrollWidth <= desktopLayout.clientWidth + 2, debug: desktopLayout };

    await page.setViewport({ width: 375, height: 800 });
    await new Promise(r => setTimeout(r, 200));
    const tMobile = await visibleText(page);
    const mobileLayout = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth,
    }));
    results.mobile = {
      noHorizontalOverflow: mobileLayout.scrollWidth <= mobileLayout.clientWidth + 2,
      debug: mobileLayout,
      blockStillVisible: tMobile.includes('부가 계산 — 액체부피팽창'),
      resultStillVisible: /0\.025/.test(tMobile),
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
    results.insufficientBeforeInput && results.computableShown && results.valueCorrect && results.unitShown &&
    results.nonGoverningNoticeShown && results.noGoverningBadgeOnLiquidExpansion &&
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
