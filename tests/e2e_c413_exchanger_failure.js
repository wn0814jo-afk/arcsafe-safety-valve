#!/usr/bin/env node
/**
 * C-4.13 §5.13 EXCHANGER FAILURE — Browser E2E
 * ════════════════════════════════════════════════════════════════════
 * §5.11(C-4.12)과 형제 스프린트다. 핵심 판정:
 *   ① §5.13이 기존 5개 MASS_FLOW 라디오 그룹과 완전히 분리된 독립
 *      블록으로 렌더링되고, §5.11/governing scenario/Manual W와
 *      동시에 사용 가능한가.
 *   ② requiredOrificeArea_m2(§5.11의 value와 다른 필드명)가 정확히
 *      표시되고, "면적≠유량" 경고가 실제로 뜨는가.
 *   ③ COMPUTABLE/NOT_APPLICABLE/NEEDS_ENGINEERING_DECISION/
 *      INSUFFICIENT_INPUT 네 상태가 실제 브라우저에서 모두 정상
 *      렌더링되는가(특히 NOT_APPLICABLE을 오류처럼 안 보이게).
 *   ④ Snapshot.reliefLoad.supplementary[]에 §5.11+§5.13이 동시에
 *      보존되고 governing에는 절대 안 섞이는가(Node runtime 실측).
 * Engine(relief_load.js)은 이 테스트 어디에서도 재구현하지 않는다.
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
      id: "e2e-c413-case-1",
      valveTag: "PSV-E2E-C413",
      equipment: { tag:"PSV-E2E-C413", deviceType:"safetyValve", mawp:11, setPressure:10, overpressure:10 },
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
  const port = 8870;
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

    // 1~4. 앱 진입, 기존 5개 카드 정상 표시, §5.13 독립 블록 표시(라디오 그룹과 분리)
    let t = await visibleText(page);
    results.existingScenarioCardsShown = t.includes('출구 차단') && t.includes('과충전') &&
      t.includes('자동제어밸브 고장') && t.includes('비정상 열/증기 유입') && t.includes('외부화재');
    results.exchangerBlockShown = t.includes('부가 계산 — 열교환기 고장 (§5.13, 참고용)');

    // 5~9. SHELL_AND_TUBE 선택 → tubeCrossSectionArea 입력 → COMPUTABLE → m² → area≠flow 안내
    const opened = await clickByText(page, '열교환기 고장 계산 열기');
    results.openedIndependently = opened;
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.insufficientBeforeInput = t.includes('입력을 완료하면 결과가 표시됩니다');
    const shellSelected = await clickByText(page, '다관형 (Shell & Tube)');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.shellFormShown = shellSelected && t.includes('튜브 단면적');
    await fillNumberFieldByLabel(page, '튜브 단면적', 0.01);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    // requiredOrificeArea_m2 = 0.01 * 2 = 0.02
    results.shellComputableShown = t.includes('SCENARIO RESULT') && /0\.02\b/.test(t);
    results.shellUnitShown = t.includes('m²');
    results.areaNeqFlowNoticeShown = t.includes('유량이 아닙니다') || t.includes('유량으로도 자동 환산되지 않');
    results.noGoverningBadgeOnExchanger = !/GOVERNING RELIEF LOAD[\s\S]{0,60}0\.02/.test(t);

    // 13. PLATE_AND_FRAME branch — requiredOrificeArea_m2 = 0.01 * 1 = 0.01
    await clickByText(page, '판형 (Plate & Frame)');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    // 단면적 입력값은 이전 상태(0.01)가 유지됨 → 이번엔 배수만 다름
    results.plateComputableShown = /0\.01\b/.test(t) && t.includes('SCENARIO RESULT');
    results.staleShellResultGoneAfterTypeSwitch = !/0\.02\b/.test(t.split('SCENARIO RESULT')[1] || '');

    // 14. DOUBLE_PIPE + SCHEDULE_PIPE → NOT_APPLICABLE (오류 스타일 아님)
    await clickByText(page, '이중관형 (Double Pipe)');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.doublePipeHidesAreaField = !t.includes('튜브 단면적');
    results.doublePipeShowsInnerTubeToggle = t.includes('내관 종류');
    await clickByText(page, '스케줄 배관 (Schedule Pipe)');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.notApplicableShown = t.includes('해당 없음') && t.includes('압력방출장치 설치 불요');
    results.notApplicableNotStyledAsInsufficientInput = !t.includes('입력을 완료하면 결과가 표시됩니다');

    // 15. DOUBLE_PIPE + GAUGE_TUBE → NEEDS_ENGINEERING_DECISION
    await clickByText(page, '게이지 튜브 (Gauge Tube)');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.needsEngineeringDecisionShown = t.includes('NEEDS_ENGINEERING_DECISION') || t.includes('엔지니어링') ||
      t.includes('원문');
    results.notApplicableGoneAfterSwitch = !t.includes('압력방출장치 설치 불요');

    // 16. invalid/incomplete input → INSUFFICIENT_INPUT (SHELL_AND_TUBE로 되돌아가 면적을 비워 재현)
    await clickByText(page, '다관형 (Shell & Tube)');
    await new Promise(r => setTimeout(r, 150));
    await clearNumberFieldByLabel(page, '튜브 단면적');
    await new Promise(r => setTimeout(r, 200));
    t = await visibleText(page);
    results.insufficientAfterModeSwitchBack = t.includes('입력을 완료하면 결과가 표시됩니다');

    // 17~18. §5.11 + §5.13 동시 계산 — 서로 독립적으로 존재/계산
    await fillNumberFieldByLabel(page, '튜브 단면적', 0.01);
    await new Promise(r => setTimeout(r, 200));
    await clickByText(page, '액체부피팽창 계산 열기');
    await new Promise(r => setTimeout(r, 150));
    await fillNumberFieldByLabel(page, '체적팽창계수 α', 0.001);
    await fillNumberFieldByLabel(page, '유입 열량 Q', 5000);
    await fillNumberFieldByLabel(page, '비중 SG', 0.8);
    await fillNumberFieldByLabel(page, '비열 Cp', 0.5);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    results.bothBlocksSimultaneouslyOpen = t.includes('부가 계산 — 액체부피팽창') && t.includes('부가 계산 — 열교환기 고장');
    results.le_and_ex_both_computed = /0\.025/.test(t) && /0\.02\b/.test(t);

    // 11~12. 기존 governing 시나리오(§5.1)도 동시에 정상 동작(독립성)
    await clickByText(page, '출구 차단');
    await new Promise(r => setTimeout(r, 150));
    await clickByText(page, '액체(Liquid)');
    await new Promise(r => setTimeout(r, 150));
    await fillNumberFieldByLabel(page, '최대 유입량 (Inflow)', 100);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    results.governingScenarioWorksAlongsideBoth = /100\s*kg\/h/.test(t) &&
      t.includes('부가 계산 — 액체부피팽창') && t.includes('부가 계산 — 열교환기 고장') &&
      /0\.025/.test(t) && /0\.02\b/.test(t);

    // ── Responsive (사양 확정 클릭 전 — 클릭 후에는 report 화면으로 전환되어
    // InputView 자체가 사라지므로 반드시 그 전에 확인해야 함) ──
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
      exchangerBlockStillVisible: tMobile.includes('부가 계산 — 열교환기 고장'),
    };
    await page.setViewport({ width: 1280, height: 900 });

    // ── Snapshot Node-runtime 검증 ──
    const calcClicked = await clickByText(page, '사양 확정');
    await new Promise(r => setTimeout(r, 300));
    const snap = await page.evaluate(() => window.__E2E_LAST_SNAPSHOT__ || null);
    results.snapshotCreated = !!snap && calcClicked;
    results.snapshot_governingPreserved = snap && snap.reliefLoad && snap.reliefLoad.governing === 'OUTLET_BLOCKED';
    results.snapshot_supplementaryHasBoth = snap && Array.isArray(snap.reliefLoad?.supplementary) &&
      snap.reliefLoad.supplementary.length === 2;
    const supList = snap?.reliefLoad?.supplementary || [];
    results.snapshot_hasLE = supList.some(s => s.scenario === 'LIQUID_THERMAL_EXPANSION' && Math.abs(s.value - 0.025) < 1e-9);
    results.snapshot_hasEX = supList.some(s => s.scenario === 'EXCHANGER_FAILURE' && Math.abs(s.requiredOrificeArea_m2 - 0.02) < 1e-9);
    results.snapshot_governingNeverBecomesExchanger = snap?.reliefLoad?.governing !== 'EXCHANGER_FAILURE' &&
      snap?.reliefLoad?.governing !== 'LIQUID_THERMAL_EXPANSION';

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

  const uiOk = results.existingScenarioCardsShown && results.exchangerBlockShown && results.openedIndependently &&
    results.insufficientBeforeInput && results.shellFormShown && results.shellComputableShown &&
    results.shellUnitShown && results.areaNeqFlowNoticeShown && results.noGoverningBadgeOnExchanger &&
    results.plateComputableShown && results.staleShellResultGoneAfterTypeSwitch &&
    results.doublePipeHidesAreaField && results.doublePipeShowsInnerTubeToggle &&
    results.notApplicableShown && results.notApplicableNotStyledAsInsufficientInput &&
    results.needsEngineeringDecisionShown && results.notApplicableGoneAfterSwitch &&
    results.insufficientAfterModeSwitchBack;

  const independenceOk = results.bothBlocksSimultaneouslyOpen && results.le_and_ex_both_computed &&
    results.governingScenarioWorksAlongsideBoth;

  const snapshotOk = results.snapshotCreated && results.snapshot_governingPreserved &&
    results.snapshot_supplementaryHasBoth && results.snapshot_hasLE && results.snapshot_hasEX &&
    results.snapshot_governingNeverBecomesExchanger;

  const responsiveOk = results.desktop?.noHorizontalOverflow && results.mobile?.noHorizontalOverflow &&
    results.mobile?.exchangerBlockStillVisible;
  const runtimeOk = results.noConsoleErrors && results.noPageErrors;

  const allPass = !results.fatalError && uiOk && independenceOk && snapshotOk && responsiveOk && runtimeOk;

  console.log('\n=== C-4.13 §5.13 BROWSER E2E: ' + (allPass ? 'PASS' : 'FAIL') + ' ===');
  console.log(JSON.stringify({ uiOk, independenceOk, snapshotOk, responsiveOk, runtimeOk }, null, 2));
  process.exit(allPass ? 0 : 1);
}

main();
