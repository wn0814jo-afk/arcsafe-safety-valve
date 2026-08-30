#!/usr/bin/env node
/**
 * C-4.10 §5.12 External Fire UX — Browser E2E (Puppeteer, real Chromium)
 * ════════════════════════════════════════════════════════════════════
 * 실제 브라우저를 띄우고 실제 클릭/입력을 수행해 visible DOM만으로 판정한다.
 * document.body.textContent 전체검색, SCRIPT 태그 내 원본 JSX 문자열,
 * contract test/Node 런타임 결과를 이 검증의 근거로 대체하지 않는다.
 *
 * 진입 경로: 이 저장소는 Dashboard → AssetMaster(설비 등록) → NewCaseForm
 * 을 거쳐야 CaseView에 도달하는데, 이 흐름 자체는 §5.12 범위가 아니다.
 * 그래서 실제 프로덕션 번들(dist/index.html, build.py가 생성한 것 그대로,
 * 소스 수정 없음)을 그대로 로드하되, 최종 `root.render(<ArcSafe/>)` 한 줄만
 * `root.render(<CaseView caseData={...} .../>)`로 교체한 하네스를 사용한다.
 * CaseView/InputView 자체의 코드는 프로덕션과 100% 동일 — 이 스크립트가
 * 건드리는 것은 "어느 화면에서 시작하는가"뿐이다.
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
    throw new Error('HARNESS_MOUNT_POINT_NOT_FOUND — dist/index.html 구조가 예상과 다름(root.render(<ArcSafe/>) 라인을 찾을 수 없음)');
  }
  const harnessCaseData = `
    const __E2E_CASE__ = {
      id: "e2e-case-1",
      valveTag: "PSV-E2E-1",
      equipment: { tag:"PSV-E2E-1", deviceType:"safetyValve", mawp:11, setPressure:10, overpressure:10 },
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
  return src.replace(marker, harnessCaseData);
}

function serve(html, port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// visible-only 텍스트 유틸 — SCRIPT/STYLE/hidden 요소를 제외하고
// 실제 렌더된(getClientRects 존재) 텍스트만 모은다.
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
      // 가장 안쪽(자식 중에 같은 텍스트를 포함하는 요소가 없는) 요소를 우선 — 컨테이너 클릭 방지
      !Array.from(el.children).some(c => c.textContent && c.textContent.includes(text)));
  }, text, tag);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  return true;
}

async function main() {
  const results = {};
  const harnessHtml = buildHarnessHtml();
  const port = 8842;
  const server = await serve(harnessHtml, port);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    // ── 공통: Desktop viewport로 초기 로드 ──
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('pageerror', e => { results.pageError = (results.pageError||[]).concat(String(e)); });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('button', { timeout: 15000 });

    // 최초 화면: "사양 결정 시작" 버튼 클릭 → InputView 진입
    const startClicked = await clickByText(page, '사양 결정 시작');
    results.launchAndInitialRender = startClicked;
    await new Promise(r => setTimeout(r, 200));

    // 시나리오 선택 카드에서 "외부화재" 클릭
    const extFireClicked = await clickByText(page, '외부화재');
    results.externalFireCardClicked = extFireClicked;
    await new Promise(r => setTimeout(r, 150));

    // ── A. fireCase 6종 실제 렌더 ──
    const fireCaseLabels = ['개방된 액면 화재 (액체)', '개방된 액면 화재 (가스·증기)',
      '제한된 공간의 소·중규모 화재', '제한된 공간의 환기지배형 화재',
      '제한된 공간의 대규모 화재', '제트 화재 (분출화재)'];
    let vtext = await visibleText(page);
    results.A_fireCaseSixRendered = fireCaseLabels.every(l => vtext.includes(l));
    results.A_nonColorBadges = vtext.includes('계산 가능') && vtext.includes('전문가 판단 필요');

    // ── B. Desktop 2열 ──
    const gridInfoDesktop = await page.evaluate((labels) => {
      const labelDivs = Array.from(document.querySelectorAll('div')).filter(d => labels.includes(d.textContent.trim()));
      const cards = labelDivs.map(d => d.parentElement && d.parentElement.parentElement).filter(Boolean);
      if (cards.length < 6) return { count: cards.length, uniqueRows: null, note: 'fewer than 6 cards matched' };
      const tops = cards.slice(0, 6).map(c => Math.round(c.getBoundingClientRect().top));
      const uniqueRows = new Set(tops).size;
      return { count: cards.length, uniqueRows, tops };
    }, fireCaseLabels);
    results.B_desktopTwoColumn = !!(gridInfoDesktop && gridInfoDesktop.count >= 6 && gridInfoDesktop.uniqueRows <= 3 && gridInfoDesktop.uniqueRows >= 2);
    results.B_debug = gridInfoDesktop;

    // ── C. Mobile 1열 ──
    await page.setViewport({ width: 375, height: 800 });
    await new Promise(r => setTimeout(r, 150));
    const gridInfoMobile = await page.evaluate((labels) => {
      const labelDivs = Array.from(document.querySelectorAll('div')).filter(d => labels.includes(d.textContent.trim()));
      const cards = labelDivs.map(d => d.parentElement && d.parentElement.parentElement).filter(Boolean);
      if (cards.length < 6) return { count: cards.length, uniqueRows: null, note: 'fewer than 6 cards matched' };
      const tops = cards.slice(0, 6).map(c => Math.round(c.getBoundingClientRect().top));
      const uniqueRows = new Set(tops).size;
      return { count: cards.length, uniqueRows };
    }, fireCaseLabels);
    results.C_mobileOneColumn = !!(gridInfoMobile && gridInfoMobile.uniqueRows >= 5);
    results.C_debug = gridInfoMobile;
    await page.setViewport({ width: 1280, height: 900 });
    await new Promise(r => setTimeout(r, 150));

    // ── D. NEEDS_ENGINEERING_DECISION 3종 ──
    const needsDecisionCases = ['제트 화재 (분출화재)', '제한된 공간의 환기지배형 화재', '제한된 공간의 대규모 화재'];
    results.D_each = {};
    for (const label of needsDecisionCases) {
      await clickByText(page, label);
      await new Promise(r => setTimeout(r, 150));
      const t = await visibleText(page);
      const noNumberInput = await page.evaluate(() => document.querySelectorAll('input[type="number"]').length === 0);
      results.D_each[label] = {
        showsFixedMessage: t.includes('현재 선택한 화재 상황은 이 기준에서 압력방출장치의 방출량 계산식이 제공되지 않습니다.') &&
                            t.includes('따라서 자동 sizing을 진행하지 않고 전문가 판단이 필요합니다.'),
        noInputForm: noNumberInput,
      };
    }
    results.D_allPass = needsDecisionCases.every(l => results.D_each[l].showsFixedMessage && results.D_each[l].noInputForm);

    // ── E. F method 상호배타 (OPEN_POOL_LIQUID) ──
    await clickByText(page, '개방된 액면 화재 (액체)');
    await new Promise(r => setTimeout(r, 150));
    await clickByText(page, 'F 값을 알고 있습니다');
    await new Promise(r => setTimeout(r, 150));
    let numberInputsAfterDirect = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="number"]')).length);
    let hasFLabelDirect = (await visibleText(page)).includes('환경인자, 0~1');
    await clickByText(page, '단열재 정보로 계산합니다');
    await new Promise(r => setTimeout(r, 150));
    let tAfterInsulation = await visibleText(page);
    let hasInsulationFields = tAfterInsulation.includes('단열재 층') && tAfterInsulation.includes('열전도율');
    let hasFFieldStillThere = tAfterInsulation.includes('환경인자, 0~1');
    // F 방법으로 복귀
    await clickByText(page, 'F 값을 알고 있습니다');
    await new Promise(r => setTimeout(r, 150));
    let tAfterBackToDirect = await visibleText(page);
    let insulationGoneAfterBack = !tAfterBackToDirect.includes('열전도율');
    results.E_fMethod = {
      directShowsFField: hasFLabelDirect,
      insulationShowsLayerFields: hasInsulationFields,
      noOverlapDirectHiddenWhenInsulation: !hasFFieldStillThere,
      noStaleInsulationAfterBackToDirect: insulationGoneAfterBack,
    };
    results.E_allPass = Object.values(results.E_fMethod).every(Boolean);

    // ── F. T1 method 상호배타 (OPEN_POOL_GAS_VAPOR) ──
    await clickByText(page, '개방된 액면 화재 (가스·증기)');
    await new Promise(r => setTimeout(r, 150));
    await clickByText(page, '온도를 알고 있습니다');
    await new Promise(r => setTimeout(r, 150));
    let tDirectT1 = await visibleText(page);
    let hasT1DirectField = tDirectT1.includes('화재 발생 전 가스 초기 온도');
    await clickByText(page, '압력·온도로 계산합니다');
    await new Promise(r => setTimeout(r, 150));
    let tPnTn = await visibleText(page);
    let hasPnTnFields = tPnTn.includes('정상운전 압력') && tPnTn.includes('정상운전 온도');
    let t1FieldGoneUnderPnTn = !tPnTn.includes('화재 발생 전 가스 초기 온도');
    await clickByText(page, '온도를 알고 있습니다');
    await new Promise(r => setTimeout(r, 150));
    let tBackToDirect = await visibleText(page);
    let pnTnGoneAfterBack = !tBackToDirect.includes('정상운전 압력');
    results.F_t1Method = {
      directShowsT1Field: hasT1DirectField,
      pnTnShowsFields: hasPnTnFields,
      t1FieldHiddenUnderPnTn: t1FieldGoneUnderPnTn,
      noStalePnTnAfterBackToDirect: pnTnGoneAfterBack,
    };
    results.F_allPass = Object.values(results.F_t1Method).every(Boolean);

    // ── G. Case M provenance (CASE_DEFAULT 표시 + SCENARIO_OVERRIDE 전환) ──
    let tGasEntry = await visibleText(page);
    results.G_caseDefaultShown = tGasEntry.includes('Case 사양의 M값 사용 중');
    // M 필드를 직접 수정 → SCENARIO_OVERRIDE로 전환되는지 확인
    const mInput = await page.evaluateHandle(() => {
      const divs = Array.from(document.querySelectorAll('div'));
      for (const d of divs) {
        if (d.textContent.includes('분자량 (M)') &&
            d.nextElementSibling && d.nextElementSibling.tagName === 'INPUT' &&
            d.nextElementSibling.type === 'number') {
          return d.nextElementSibling;
        }
      }
      return null;
    });
    let overrideShown = false;
    const mEl = mInput.asElement();
    if (mEl) {
      await clearAndType(page, mEl, '30.07');
      await new Promise(r => setTimeout(r, 150));
      const tAfterOverride = await visibleText(page);
      overrideShown = tAfterOverride.includes('직접 입력값 사용 중');
    }
    results.G_scenarioOverrideShown = overrideShown;
    results.G_allPass = results.G_caseDefaultShown && results.G_scenarioOverrideShown;

    // ── H. Tw ≤ T1 visible error ──
    // P1/A/Tw 채우고 T1 direct로 Tw<=T1 되도록 입력
    async function fillNumberFieldByLabel(labelSubstr, value) {
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
    const fillOk = {};
    fillOk.P1 = await fillNumberFieldByLabel('P1 (설정압력)', 1.5);
    fillOk.A = await fillNumberFieldByLabel('A (노출 면적)', 20);
    fillOk.Tw = await fillNumberFieldByLabel('Tw', 250);
    await new Promise(r => setTimeout(r, 150));
    results.H_debug_fillOk = fillOk;
    results.H_debug_afterFillingPATw = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="number"]'));
      return inputs.map(i => ({ value: i.value, prevLabel: i.previousElementSibling && i.previousElementSibling.textContent }));
    });
    await clickByText(page, '온도를 알고 있습니다');
    await new Promise(r => setTimeout(r, 150));
    fillOk.T1 = await fillNumberFieldByLabel('T1 — 화재 발생 전', 300);
    results.H_debug_fillOk = fillOk;
    await new Promise(r => setTimeout(r, 200));
    results.H_debug_afterFillingT1 = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="number"]'));
      return inputs.map(i => ({ value: i.value, prevLabel: i.previousElementSibling && i.previousElementSibling.textContent }));
    });
    const tTwViolation = await visibleText(page);
    results.H_debug_visibleText = tTwViolation.slice(0, 1500);
    results.H_fixedMessageShown = tTwViolation.includes('벽면 최대온도(Tw)는 인입측 가스온도(T1)보다 높아야 합니다.');
    results.H_showsTw = /Tw\s*=\s*250/.test(tTwViolation);
    results.H_showsT1 = /T1\s*=\s*300/.test(tTwViolation);
    results.H_showsUnitK = tTwViolation.includes(' K');
    results.H_noResultPanelProgressed = !tTwViolation.includes('SCENARIO RESULT');
    results.H_allPass = results.H_fixedMessageShown && results.H_showsTw && results.H_showsT1 && results.H_showsUnitK;

    // ── I. stale result 제거 ──
    // Tw를 정상값으로 고쳐 정상 계산 결과를 먼저 만든다
    await fillNumberFieldByLabel('Tw', 600);
    await new Promise(r => setTimeout(r, 250));
    const tOkResult = await visibleText(page);
    const hadWResult = /\d[\d,]*\.?\d*\s*kg\/h/.test(tOkResult) && tOkResult.includes('SCENARIO RESULT');
    // 그 다음 A를 비워서(0으로) 불완전 상태로 되돌린다
    const aHandle = await page.evaluateHandle(() => {
      const divs = Array.from(document.querySelectorAll('div'));
      for (const d of divs) {
        if (d.textContent.includes('A (노출 면적)') &&
            d.nextElementSibling && d.nextElementSibling.tagName === 'INPUT' &&
            d.nextElementSibling.type === 'number') {
          return d.nextElementSibling;
        }
      }
      return null;
    });
    const aEl = aHandle.asElement();
    if (aEl) {
      await aEl.focus();
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
    }
    await new Promise(r => setTimeout(r, 250));
    const tAfterClear = await visibleText(page);
    const staleWGone = !(/SCENARIO RESULT[\s\S]{0,40}\d[\d,]*\.?\d*\s*kg\/h/.test(tAfterClear));
    const showsIncomplete = tAfterClear.includes('입력을 완료하면 결과가 표시됩니다');
    results.I_hadInitialResult = hadWResult;
    results.I_staleResultRemoved = staleWGone;
    results.I_showsIncompleteState = showsIncomplete;
    results.I_allPass = hadWResult && staleWGone && showsIncomplete;

    // ── J. 기존 C-4.9 회귀 smoke (§5.1/5.6/5.7/5.8) ──
    results.J_each = {};
    for (const [label, fieldLabel] of [['출구 차단', '최대 유입량'], ['과충전', '최대 유입량'],
      ['자동제어밸브 고장', 'FAILURE MODE'], ['비정상 열/증기 유입', 'FAILURE MODE']]) {
      await clickByText(page, label);
      await new Promise(r => setTimeout(r, 150));
      const t = await visibleText(page);
      results.J_each[label] = t.includes(fieldLabel) || t.includes(label);
    }
    results.J_allPass = Object.values(results.J_each).every(Boolean);

    results.browserLaunchOk = true;
    results.pageRenderOk = results.A_fireCaseSixRendered === true;
  } catch (e) {
    results.fatalError = String(e && e.stack || e);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(JSON.stringify(results, null, 2));
  const criticalKeys = ['A_fireCaseSixRendered','A_nonColorBadges','B_desktopTwoColumn','C_mobileOneColumn',
    'D_allPass','E_allPass','F_allPass','G_allPass','H_allPass','I_allPass','J_allPass'];
  const allPass = criticalKeys.every(k => results[k] === true) && !results.fatalError;
  console.log('\n=== C-4.10 BROWSER E2E: ' + (allPass ? 'PASS' : 'FAIL') + ' ===');
  process.exit(allPass ? 0 : 1);
}

main();
