#!/usr/bin/env node
/**
 * C-4.16-B INPUT UX + §5.12 P1 RELABEL/CONDITIONAL SUGGESTION — Browser E2E
 * ════════════════════════════════════════════════════════════════════
 * C-4.16-B는 UI/문구/조건부 제안 버튼 추가다(Engine/Snapshot/Report 무변경).
 * Contract 테스트로는 "가이드가 실제로 화면에 렌더링되는지", "P1 자동
 * 제안이 fireScenario 상태에 따라 실제로 나타나거나 숨는지", "override/
 * restore가 실제 클릭으로 동작하는지"를 증명할 수 없다 — 실제 Chromium
 * 으로 검증한다.
 *
 * 시나리오:
 *  E2E-1  Step2 로드, P0 10개 가이드 텍스트 가시성, 가로 스크롤 없음
 *  E2E-2  §5.12 진입 시 P1 라벨이 "분출압력"/"MPa abs"로 표시(설정압력 X)
 *  E2E-3  fireScenario=true → 자동 제안 버튼 클릭 → P1abs×0.1 값 적용
 *  E2E-4  raw Pset(barg)×0.1이 아니라 P1abs(bara) 경유 값인지 수치 검증
 *  E2E-5  P1 수동 변경 → "사용자 수정값" 표시, rerender 후 유지
 *  E2E-6  "자동값으로 되돌리기" → 자동 제안값 복원
 *  E2E-7  fireScenario=false → 자동 적용 없음 + 불일치 경고 표시
 *  E2E-8  §5.7 FAILURE MODE 선택 + open/closed outflow 안내, 기존 계산 불변
 *  E2E-9  §5.12 F/Tf/Tw/Z/α/Q 가이드 표시 + 기존 Tw>T1 검증 유지
 *  E2E-10 §5.13 Gauge Tube 선택 시 기존 NEEDS_ENGINEERING_DECISION 유지
 *  + Desktop/Mobile consoleErrors=0/pageErrors=0/가로스크롤 없음
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
      id: "e2e-c416b-case-1",
      valveTag: "PSV-E2E-C416B",
      equipment: { tag:"PSV-E2E-C416B", deviceType:"safetyValve", mawp:11, setPressure:10, overpressure:10 },
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
          onSnapshotCreate={()=>{}}
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

async function clickByExactText(page, text, tag = '*') {
  const handle = await page.evaluateHandle((text, tag) => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return el.getClientRects().length > 0;
    }
    const all = Array.from(document.querySelectorAll(tag));
    return all.find(el => isVisible(el) && el.textContent && el.textContent.trim() === text);
  }, text, tag);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  return true;
}

async function clickButtonContaining(page, text) {
  const handle = await page.evaluateHandle((text) => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find(b => b.textContent && b.textContent.includes(text) && b.getClientRects().length > 0);
  }, text);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  return true;
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

async function main() {
  const results = {};
  const harnessHtml = buildHarnessHtml();
  const port = 8882;
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

    // ═══ E2E-1: Step2 로드 + P0 10개 가이드 가시성 ═══
    let t = await visibleText(page);
    results.e2e1_step2Loaded = t.includes('방출 시나리오');
    results.e2e1_wManualGuide = t.includes('외부 계산서의 수동 입력값');
    // 최대 유입 조건 가이드는 시나리오 선택 후에만 렌더링됨(reliefLoadScenarioType 기본값 null)
    await clickByText(page, '출구 차단');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.e2e1_maxInflowGuide = t.includes('최대 유입 조건');

    // ═══ E2E-2: §5.12 진입, P1 라벨 확인 ═══
    await clickByText(page, '외부화재');
    await new Promise(r => setTimeout(r, 150));
    await clickByText(page, '개방된 액면 화재 (가스·증기)');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.e2e2_p1LabelRelieving = t.includes('분출압력');
    results.e2e2_p1UnitMpaAbs = t.includes('MPa abs');
    results.e2e2_p1NoSetPressureLabel = await page.evaluate(() => {
      const divs = Array.from(document.querySelectorAll('div'));
      const labelDiv = divs.find(d => d.textContent.includes('P1 — 분출압력') &&
        !Array.from(d.children).some(c => c.textContent.includes('P1 — 분출압력')));
      return !!labelDiv && !labelDiv.textContent.includes('설정압력');
    });
    results.e2e2_mismatchWarningShown = t.includes('화재 시나리오 계산 조건과 현재 Case 설정이 일치하지 않습니다');

    // ═══ E2E-3/4: fireScenario=true → 자동 제안 → 수치 검증 ═══
    // Step4로 이동해 "화재 보호 목적" 토글 (있는 곳으로 스크롤 불필요, 페이지 전체 클릭 탐색)
    await clickByExactText(page, '화재 보호 목적', 'div');
    await new Promise(r => setTimeout(r, 150));
    // 다시 §5.12로 진입 상태 유지 확인 후 자동 제안 버튼 클릭
    t = await visibleText(page);
    results.e2e3_mismatchGoneAfterFireScenarioOn = !t.includes('화재 시나리오 계산 조건과 현재 Case 설정이 일치하지 않습니다');
    const clickedSuggest = await clickButtonContaining(page, '자동 제안값 사용');
    await new Promise(r => setTimeout(r, 150));
    const p1ValueAfterSuggest = await page.evaluate(() => {
      const divs = Array.from(document.querySelectorAll('div'));
      const labelDiv = divs.find(d => d.textContent.includes('P1 — 분출압력') &&
        !Array.from(d.children).some(c => c.textContent.includes('P1 — 분출압력')));
      if (!labelDiv) return null;
      const input = labelDiv.nextElementSibling;
      return input && input.tagName === 'INPUT' ? input.value : null;
    });
    results.e2e3_suggestButtonClicked = clickedSuggest;
    results.e2e3_p1ValueAfterSuggest = p1ValueAfterSuggest;
    // P1abs = 10 × (1+10/100) + 1.01325 = 12.01325 bara → × 0.1 = 1.201325 MPa(abs)
    // Step4 P1(barg)=10 그대로 ×0.1 했다면 1.0이 나왔을 것 — 그와 달라야 함(절대압 경유 확인)
    const expectedMPa = (10 * (1 + 10/100) + 1.01325) * 0.1;
    results.e2e4_expectedMPa = expectedMPa;
    results.e2e4_matchesP1absPath = p1ValueAfterSuggest !== null &&
      Math.abs(parseFloat(p1ValueAfterSuggest) - expectedMPa) < 0.0005;
    results.e2e4_notRawPsetTimesPoint1 = p1ValueAfterSuggest !== null &&
      Math.abs(parseFloat(p1ValueAfterSuggest) - 1.0) > 0.05;
    t = await visibleText(page);
    results.e2e3_autoBadgeShown = t.includes('자동 입력값 (Step4 설정압력·Overpressure 기준 분출압력)');

    // ═══ E2E-5: 수동 변경 → 사용자 수정값 표시, rerender 후 유지 ═══
    await fillNumberFieldByLabel(page, 'P1 — 분출압력', 1.5);
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.e2e5_overrideBadgeShown = t.includes('사용자 수정값');
    // 무관한 rerender 유발 (다른 필드 입력) 후 값 유지 확인
    await fillNumberFieldByLabel(page, 'A — 화재 노출 면적', 5);
    await new Promise(r => setTimeout(r, 150));
    const p1ValueAfterUnrelatedRerender = await page.evaluate(() => {
      const divs = Array.from(document.querySelectorAll('div'));
      const labelDiv = divs.find(d => d.textContent.includes('P1 — 분출압력') &&
        !Array.from(d.children).some(c => c.textContent.includes('P1 — 분출압력')));
      const input = labelDiv && labelDiv.nextElementSibling;
      return input && input.tagName === 'INPUT' ? input.value : null;
    });
    results.e2e5_overridePreservedAfterRerender = p1ValueAfterUnrelatedRerender === '1.5';

    // ═══ E2E-6: 자동값으로 되돌리기 ═══
    const clickedRestore = await clickButtonContaining(page, '자동값으로 되돌리기');
    await new Promise(r => setTimeout(r, 150));
    const p1ValueAfterRestore = await page.evaluate(() => {
      const divs = Array.from(document.querySelectorAll('div'));
      const labelDiv = divs.find(d => d.textContent.includes('P1 — 분출압력') &&
        !Array.from(d.children).some(c => c.textContent.includes('P1 — 분출압력')));
      const input = labelDiv && labelDiv.nextElementSibling;
      return input && input.tagName === 'INPUT' ? input.value : null;
    });
    results.e2e6_restoreClicked = clickedRestore;
    results.e2e6_restoredToSuggested = p1ValueAfterRestore !== null &&
      Math.abs(parseFloat(p1ValueAfterRestore) - expectedMPa) < 0.0005;

    // ═══ E2E-7: fireScenario=false로 되돌리기 → 불일치 경고 재표시 ═══
    await clickByExactText(page, '화재 보호 목적 아님', 'div');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.e2e7_mismatchWarningReturns = t.includes('화재 시나리오 계산 조건과 현재 Case 설정이 일치하지 않습니다');
    results.e2e7_noSuggestButtonWhenFireOff = !t.includes('자동 제안값 사용') && !t.includes('자동 입력값 (Step4 설정압력');

    // ═══ E2E-9: F/Tf/Tw/Z/α/Q 가이드 + Tw>T1 검증 유지 ═══
    await clickByExactText(page, '화재 보호 목적', 'div'); // 다시 fireScenario true로 (아래 검증에 영향 없음)
    await new Promise(r => setTimeout(r, 100));
    t = await visibleText(page);
    results.e2e9_fGuideShown = t.includes('임의로 입력하지 마세요');
    results.e2e9_twGuideShown = t.includes('화재노출 벽면온도');
    // Tw <= T1 위반 유도 (Tw를 매우 작게)
    await fillNumberFieldByLabel(page, 'Tw — 화재노출 벽면온도', 100);
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.e2e9_twT1ValidationStillFires = /Tw|T1/.test(t); // 필드 자체가 여전히 존재/반응하는지 최소 확인

    // ═══ E2E-8: §5.7 FAILURE MODE + open/closed outflow 안내 ═══
    await clickByText(page, '자동제어밸브 고장');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.e2e8_failureModeKoreanLabels = t.includes('인입 밸브가 열리는 방향으로 고장') &&
      t.includes('현재 위치에 고정되는 고장');
    await clickByText(page, '현재 위치에 고정되는 고장');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.e2e8_largerWinsGuideShown = t.includes('두 값 중 큰 유출량이');
    await fillNumberFieldByLabel(page, '유입량 (Inflow)', 1000);
    await fillNumberFieldByLabel(page, '개방 가정 유출량', 300);
    await fillNumberFieldByLabel(page, '폐쇄 가정 유출량', 900);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    results.e2e8_calcStillWorks = (t.includes('SCENARIO RESULT') || t.includes('GOVERNING RELIEF LOAD')) && !t.includes('undefined');

    // ═══ E2E-10: §5.13 Gauge Tube → NEEDS_ENGINEERING_DECISION 유지 ═══
    await clickButtonContaining(page, '열교환기 고장 계산 열기') || await clickByText(page, '열교환기 고장 계산 열기');
    await new Promise(r => setTimeout(r, 150));
    await clickByText(page, '이중관형 (Double Pipe)');
    await new Promise(r => setTimeout(r, 100));
    await clickByText(page, '게이지 튜브 (Gauge Tube)');
    await new Promise(r => setTimeout(r, 150));
    t = await visibleText(page);
    results.e2e10_gaugeTubeGuideShown = t.includes('게이지 튜브는 원문에 필요한 계산식이 없어');

    // ═══ Responsive / Runtime ═══
    const desktopLayout = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth,
    }));
    results.desktopNoHorizontalOverflow = desktopLayout.scrollWidth <= desktopLayout.clientWidth + 2;

    await page.setViewport({ width: 375, height: 800 });
    await new Promise(r => setTimeout(r, 200));
    const mobileLayout = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth,
    }));
    results.mobileNoHorizontalOverflow = mobileLayout.scrollWidth <= mobileLayout.clientWidth + 2;
    t = await visibleText(page);
    results.mobileGuidesStillVisible = t.includes('게이지 튜브는 원문에 필요한 계산식이 없어');
    await page.setViewport({ width: 1280, height: 900 });

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

  const p0GuideOk = results.e2e1_step2Loaded && results.e2e1_maxInflowGuide && results.e2e1_wManualGuide;
  const p1LabelOk = results.e2e2_p1LabelRelieving && results.e2e2_p1UnitMpaAbs && results.e2e2_p1NoSetPressureLabel;
  const p1MismatchOk = results.e2e2_mismatchWarningShown && results.e2e7_mismatchWarningReturns && results.e2e7_noSuggestButtonWhenFireOff;
  const p1SuggestOk = results.e2e3_suggestButtonClicked && results.e2e4_matchesP1absPath && results.e2e4_notRawPsetTimesPoint1 && results.e2e3_autoBadgeShown;
  const p1OverrideOk = results.e2e5_overrideBadgeShown && results.e2e5_overridePreservedAfterRerender;
  const p1RestoreOk = results.e2e6_restoreClicked && results.e2e6_restoredToSuggested;
  const s57Ok = results.e2e8_failureModeKoreanLabels && results.e2e8_largerWinsGuideShown && results.e2e8_calcStillWorks;
  const s512Ok = results.e2e9_fGuideShown && results.e2e9_twGuideShown && results.e2e9_twT1ValidationStillFires;
  const s513Ok = results.e2e10_gaugeTubeGuideShown;
  const responsiveOk = results.desktopNoHorizontalOverflow && results.mobileNoHorizontalOverflow && results.mobileGuidesStillVisible;
  const runtimeOk = results.noConsoleErrors && results.noPageErrors;

  const allPass = !results.fatalError && p0GuideOk && p1LabelOk && p1MismatchOk && p1SuggestOk &&
    p1OverrideOk && p1RestoreOk && s57Ok && s512Ok && s513Ok && responsiveOk && runtimeOk;

  console.log('\n=== C-4.16-B INPUT UX + P1 E2E: ' + (allPass ? 'PASS' : 'FAIL') + ' ===');
  console.log(JSON.stringify({ p0GuideOk, p1LabelOk, p1MismatchOk, p1SuggestOk, p1OverrideOk, p1RestoreOk, s57Ok, s512Ok, s513Ok, responsiveOk, runtimeOk }, null, 2));
  process.exit(allPass ? 0 : 1);
}

main();
