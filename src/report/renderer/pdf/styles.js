//  PDF STYLES
//  renderPDF()가 만드는 인쇄용 HTML에 삽입되는 순수 CSS 문자열.
//  계산/로직 없음 — 스타일 상수만.
// ════════════════════════════════════════════════════════════════
const PDF_STYLES = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Pretendard','Malgun Gothic',sans-serif;
    color: #1a2b3d; font-size: 11px; line-height: 1.5;
    margin: 0; padding: 0;
  }
  .pdf-title { font-size: 18px; font-weight: 900; margin-bottom: 2px; }
  .pdf-subtitle { font-size: 11px; color: #64748b; margin-bottom: 16px; font-family: monospace; }
  .pdf-section {
    border: 1px solid #e2e8f0; border-radius: 6px;
    margin-bottom: 12px; page-break-inside: avoid;
  }
  .pdf-section-title {
    background: #1a3f6f; color: #fff; font-weight: 700;
    font-size: 11px; padding: 6px 10px; letter-spacing: 0.5px;
  }
  .pdf-section-body { padding: 10px 12px; }
  .pdf-row {
    display: flex; justify-content: space-between;
    padding: 3px 0; border-bottom: 1px dotted #e2e8f0; font-size: 11px;
  }
  .pdf-row:last-child { border-bottom: none; }
  .pdf-row .k { color: #64748b; font-family: monospace; }
  .pdf-row .v { font-weight: 700; font-family: monospace; }
  .pdf-badge-ok    { color: #16a34a; font-weight: 700; }
  .pdf-badge-fail  { color: #dc2626; font-weight: 700; }
  .pdf-badge-none  { color: #94a3b8; font-weight: 700; }
  .pdf-footer {
    margin-top: 20px; padding-top: 8px; border-top: 1px solid #e2e8f0;
    font-size: 9px; color: #94a3b8; font-family: monospace;
  }
  .pdf-reason-item { font-size: 10px; color: #64748b; padding: 2px 0; }
  @media print {
    .pdf-no-print { display: none; }
  }
`;
