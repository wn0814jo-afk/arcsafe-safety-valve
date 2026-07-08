//  RENDER PDF
//  ReportPackage → HTML → 브라우저 인쇄(PDF 저장). React 화면을 print()하지 않는다 —
//  항상 buildPDFHtml(reportPackage)이 새로 만든 독립 문서를 인쇄한다.
//
//  계약:
//    PDF-001: 이 파일은 계산/재검증 함수를 호출하지 않는다
//             (computeBackpressure, calculateKb, detectMOC, verifyApprovalRecord 전부 금지).
//    PDF-002: renderPDF(reportPackage) — 단일 인자. snapshot/equipment/caseData 등
//             추가 데이터를 받지 않는다.
//    PDF-003: 유효하지 않은 Package는 절대 렌더링하지 않는다 —
//             validateReportPackage() 실패 시 즉시 중단.
// ════════════════════════════════════════════════════════════════
function renderPDF(reportPackage) {
  const check = validateReportPackage(reportPackage);
  if (!check.ok) {
    return { ok: false, reason: `INVALID_REPORT_PACKAGE: ${check.reason}` };
  }

  const html = buildPDFHtml(reportPackage);

  const win = window.open("", "_blank");
  if (!win) {
    return { ok: false, reason: "팝업이 차단되었습니다 — 브라우저에서 팝업을 허용해주세요" };
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();

  const doPrint = () => { try { win.print(); } catch (e) { /* noop */ } };
  win.onload = doPrint;
  setTimeout(doPrint, 300); // onload 타이밍을 놓치는 브라우저 대비 백업 트리거

  return { ok: true };
}
