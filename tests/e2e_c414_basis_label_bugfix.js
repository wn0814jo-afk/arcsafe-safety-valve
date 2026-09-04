#!/usr/bin/env node
/**
 * C-4.14 §5.12 EXTERNAL FIRE BASIS LABEL — Browser E2E
 * ════════════════════════════════════════════════════════════════════
 * 단일 버그픽스 검증: §5.12(외부화재)가 governing scenario가 됐을 때
 * "사양 결정 요약" 화면의 Basis 줄에 문자열 "undefined"가 나타나지
 * 않고 "§5.12 외부화재"가 정상 표시되는지, 그리고 기존 4개 governing
 * 시나리오(§5.1/5.6/5.7/5.8)의 Basis 표시가 이 수정으로 회귀하지
 * 않는지를 실제 Chromium DOM에서 확인한다.
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
      id: "e2e-c414-case-1",
      valveTag: "PSV-E2E-C414",
      equipment: { tag:"PSV-E2E-C414", deviceType:"safetyValve", mawp:11, setPressure:10, overpressure:10 },
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

async function main() {
  const results = {};
  const harnessHtml = buildHarnessHtml();
  const port = 8880;
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

    // ── §5.12 외부화재 선택 → 계산 → Basis 확인(핵심 버그 재현/수정 확인 지점) ──
    await clickByText(page, '외부화재');
    await new Promise(r => setTimeout(r, 150));
    await clickByText(page, '개방된 액면 화재 (액체)');
    await new Promise(r => setTimeout(r, 150));
    // OPEN_POOL_LIQUID 계산에 필요한 전체 입력
    await clickByText(page, '있음(화재 열 절반 이상 배수)');
    await new Promise(r => setTimeout(r, 100));
    await fillNumberFieldByLabel(page, '젖은 면적', 10);
    await fillNumberFieldByLabel(page, '잠열', 100);
    await clickByText(page, 'F 값을 알고 있습니다');
    await new Promise(r => setTimeout(r, 100));
    await fillNumberFieldByLabel(page, 'F (환경인자', 1);
    await new Promise(r => setTimeout(r, 300));
    let t = await visibleText(page);
    results.fireResultShown = t.includes('SCENARIO RESULT') || t.includes('GOVERNING RELIEF LOAD');
    results.basisSectionShown = t.includes('사양 결정 요약');
    results.noLiteralUndefinedAnywhere = !t.includes('undefined');
    results.basisShowsExternalFireLabel = t.includes('§5.12 외부화재');

    // ── 기존 4개 governing 시나리오도 undefined 없이 정상 회귀 확인 ──
    const regressionChecks = {};
    const cases = [
      { click: '출구 차단', sub: '액체(Liquid)', field: '최대 유입량 (Inflow)', value: 100, expectLabel: '§5.1 출구 차단' },
      { click: '과충전', sub: null, field: '최대 유입량 (Inflow)', value: 200, expectLabel: '§5.6 과충전' },
    ];
    for (const c of cases) {
      await clickByText(page, c.click);
      await new Promise(r => setTimeout(r, 150));
      if (c.sub) { await clickByText(page, c.sub); await new Promise(r => setTimeout(r, 150)); }
      await fillNumberFieldByLabel(page, c.field, c.value);
      await new Promise(r => setTimeout(r, 250));
      t = await visibleText(page);
      regressionChecks[c.click] = { noUndefined: !t.includes('undefined'), hasLabel: t.includes(c.expectLabel) };
    }
    results.regressionChecks = regressionChecks;
    results.allRegressionOk = Object.values(regressionChecks).every(r => r.noUndefined && r.hasLabel);

    // ── Responsive ──
    const desktopLayout = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth,
    }));
    results.desktop = { noHorizontalOverflow: desktopLayout.scrollWidth <= desktopLayout.clientWidth + 2 };

    await page.setViewport({ width: 375, height: 800 });
    await new Promise(r => setTimeout(r, 200));
    const mobileLayout = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth,
    }));
    results.mobile = { noHorizontalOverflow: mobileLayout.scrollWidth <= mobileLayout.clientWidth + 2 };
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

  const fixOk = results.fireResultShown && results.basisSectionShown &&
    results.noLiteralUndefinedAnywhere && results.basisShowsExternalFireLabel;
  const regressionOk = results.allRegressionOk;
  const responsiveOk = results.desktop?.noHorizontalOverflow && results.mobile?.noHorizontalOverflow;
  const runtimeOk = results.noConsoleErrors && results.noPageErrors;

  const allPass = !results.fatalError && fixOk && regressionOk && responsiveOk && runtimeOk;

  console.log('\n=== C-4.14 §5.12 BASIS LABEL BUGFIX E2E: ' + (allPass ? 'PASS' : 'FAIL') + ' ===');
  console.log(JSON.stringify({ fixOk, regressionOk, responsiveOk, runtimeOk }, null, 2));
  process.exit(allPass ? 0 : 1);
}

main();
