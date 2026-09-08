#!/usr/bin/env node
/**
 * C-4.15-A §5.2/§5.10 ENGINEERING DECISION NOTICE — Browser E2E
 * ════════════════════════════════════════════════════════════════════
 * C-4.15-A는 UI-only 정적 안내 추가다(Engine/Snapshot/Report 무변경).
 * Contract/Node 테스트로는 "실제로 화면에 보이는지", "기존 5개 governing
 * 라디오 그룹이 그대로인지", "§5.11/§5.13/governing 계산이 이 추가로
 * 깨지지 않았는지"를 증명할 수 없다 — C-4.10에서 확립된 원칙(Contract
 * GREEN ≠ UI GREEN)에 따라 실제 Chromium으로 검증한다.
 *
 * 확인 항목:
 *  1) Step 2 로드, §5.2/§5.10 안내 둘 다 visible
 *  2) 안내 영역이 클릭 가능한 요소(라디오/버튼)를 갖지 않음(정적 표시)
 *  3) 기존 governing 라디오 그룹이 정확히 5개(§5.1/5.6/5.7/5.8/5.12)로 불변
 *  4) 기존 governing 시나리오(§5.1 출구 차단) 선택+계산 정상
 *  5) §5.11(액체부피팽창)/§5.13(열교환기 고장) supplementary 블록 정상 동작
 *  6) consoleErrors=0 / pageErrors=0, Desktop/Mobile 둘 다 확인
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
      id: "e2e-c415a-case-1",
      valveTag: "PSV-E2E-C415A",
      equipment: { tag:"PSV-E2E-C415A", deviceType:"safetyValve", mawp:11, setPressure:10, overpressure:10 },
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

async function countGoverningScenarioCards(page) {
  // ReliefLoadScenarioSection의 5개 카드는 "§5.1"/"§5.6"/"§5.7"/"§5.8"/"§5.12"
  // 태그를 가진 클릭형 grid 항목이다. §5.2/§5.10은 이 grid에 존재하면 안 된다.
  return page.evaluate(() => {
    const tags = ['§5.1', '§5.6', '§5.7', '§5.8', '§5.12', '§5.2', '§5.10'];
    const found = {};
    for (const tag of tags) {
      const divs = Array.from(document.querySelectorAll('div'));
      found[tag] = divs.filter(d =>
        d.textContent.trim() === tag &&
        d.getClientRects().length > 0
      ).length;
    }
    return found;
  });
}

async function main() {
  const results = {};
  const harnessHtml = buildHarnessHtml();
  const port = 8881;
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

    // ── (Desktop) Step 2 로드 + §5.2/§5.10 안내 visible ──
    let t = await visibleText(page);
    results.desktop = {};
    results.desktop.step2Loaded = t.includes('방출 시나리오');
    results.desktop.notice52Visible = t.includes('§5.2') && t.includes('냉각/환류 중단');
    results.desktop.notice510Visible = t.includes('§5.10') && t.includes('화학반응');
    results.desktop.reviewHeaderVisible = t.includes('추가 검토가 필요한 시나리오');

    // ── 안내 영역이 클릭 가능한 라디오/버튼을 갖지 않는지(정적 표시) ──
    const noticeInteractivity = await page.evaluate(() => {
      const headerDiv = Array.from(document.querySelectorAll('div'))
        .find(d => d.textContent.includes('추가 검토가 필요한 시나리오') &&
          !Array.from(d.children).some(c => c.textContent.includes('추가 검토가 필요한 시나리오')));
      if (!headerDiv) return { found: false };
      const container = headerDiv.closest('div').parentElement;
      const buttons = container ? container.querySelectorAll('button').length : -1;
      const radios = container ? container.querySelectorAll('input[type=radio]').length : -1;
      return { found: true, buttons, radios };
    });
    results.noticeHasNoInteractiveControls =
      noticeInteractivity.found && noticeInteractivity.buttons === 0 && noticeInteractivity.radios === 0;

    // ── governing 5개 카드 그룹 불변 확인(§5.2/§5.10은 카드로 존재하면 안 됨) ──
    const cardCounts = await countGoverningScenarioCards(page);
    results.governingCardCounts = cardCounts;
    results.governingGroupUnchanged =
      cardCounts['§5.1'] === 1 && cardCounts['§5.6'] === 1 && cardCounts['§5.7'] === 1 &&
      cardCounts['§5.8'] === 1 && cardCounts['§5.12'] === 1 &&
      cardCounts['§5.2'] === 0 && cardCounts['§5.10'] === 0;

    // ── 기존 governing 시나리오(§5.1 출구 차단) 선택 + 계산 정상 ──
    await clickByText(page, '출구 차단');
    await new Promise(r => setTimeout(r, 150));
    await clickByText(page, '액체(Liquid)');
    await new Promise(r => setTimeout(r, 150));
    await fillNumberFieldByLabel(page, '최대 유입량 (Inflow)', 100);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    results.governingScenarioStillWorks = (t.includes('SCENARIO RESULT') || t.includes('GOVERNING RELIEF LOAD')) && !t.includes('undefined');

    // ── §5.11 액체부피팽창 supplementary 정상 동작 ──
    await clickByText(page, '액체부피팽창 계산 열기');
    await new Promise(r => setTimeout(r, 150));
    await fillNumberFieldByLabel(page, '열팽창계수', 0.001);
    await fillNumberFieldByLabel(page, '유입 열량', 5000);
    await fillNumberFieldByLabel(page, '비중', 0.8);
    await fillNumberFieldByLabel(page, '비열', 0.5);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    results.liquidExpansionStillWorks = t.includes('m3/h') || t.includes('m³/h') || t.includes('COMPUTABLE');

    // ── §5.13 열교환기 고장 supplementary 정상 동작 ──
    await clickByText(page, '열교환기 고장 계산 열기');
    await new Promise(r => setTimeout(r, 150));
    await clickByText(page, '다관형 (Shell & Tube)');
    await new Promise(r => setTimeout(r, 100));
    await fillNumberFieldByLabel(page, '튜브 단면적', 0.01);
    await new Promise(r => setTimeout(r, 250));
    t = await visibleText(page);
    results.exchangerFailureStillWorks = t.includes('m2') || t.includes('m²') || t.includes('COMPUTABLE');

    // ── Responsive: Desktop ──
    const desktopLayout = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth,
    }));
    results.desktop.noHorizontalOverflow = desktopLayout.scrollWidth <= desktopLayout.clientWidth + 2;

    // ── Mobile: 핵심 visibility만 재확인 ──
    await page.setViewport({ width: 375, height: 800 });
    await new Promise(r => setTimeout(r, 200));
    t = await visibleText(page);
    results.mobile = {};
    results.mobile.notice52Visible = t.includes('§5.2') && t.includes('냉각/환류 중단');
    results.mobile.notice510Visible = t.includes('§5.10') && t.includes('화학반응');
    const mobileLayout = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth,
    }));
    results.mobile.noHorizontalOverflow = mobileLayout.scrollWidth <= mobileLayout.clientWidth + 2;
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

  const noticeOk = results.desktop?.step2Loaded && results.desktop?.notice52Visible &&
    results.desktop?.notice510Visible && results.desktop?.reviewHeaderVisible &&
    results.noticeHasNoInteractiveControls;
  const governingOk = results.governingGroupUnchanged && results.governingScenarioStillWorks;
  const supplementaryOk = results.liquidExpansionStillWorks && results.exchangerFailureStillWorks;
  const responsiveOk = results.desktop?.noHorizontalOverflow && results.mobile?.noHorizontalOverflow &&
    results.mobile?.notice52Visible && results.mobile?.notice510Visible;
  const runtimeOk = results.noConsoleErrors && results.noPageErrors;

  const allPass = !results.fatalError && noticeOk && governingOk && supplementaryOk && responsiveOk && runtimeOk;

  console.log('\n=== C-4.15-A §5.2/§5.10 ENGINEERING DECISION NOTICE E2E: ' + (allPass ? 'PASS' : 'FAIL') + ' ===');
  console.log(JSON.stringify({ noticeOk, governingOk, supplementaryOk, responsiveOk, runtimeOk }, null, 2));
  process.exit(allPass ? 0 : 1);
}

main();
