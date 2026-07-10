//  PDF TEMPLATE
//  Presentation Dictionary(raw 값 → 사람이 읽는 라벨) + HTML 문서 조립.
//  Raw Evidence(ReportPackage) → Presentation Dictionary → HTML, 순서 고정.
//
//  계약:
//    PDF-002: buildPDFHtml(reportPackage) — reportPackage 하나만 받는다.
//             snapshot/equipment/caseData 등 다른 인자를 받지 않는다.
//    PDF-004: Asset/Calculation/Workflow/Approval/Integrity 5개 섹션 전부 출력.
//
//  이 파일은 renderer 전용 dictionary를 별도로 둔다 — components/report/*의
//  FLUID_CHOICES/WF_LABEL을 재사용하지 않는다. renderer는 UI 컴포넌트 트리와
//  완전히 독립적이어야(서버/CLI로 옮겨도 동작) 하기 때문에 의도적으로 중복시킨다.
// ════════════════════════════════════════════════════════════════

// ── Presentation Dictionary ────────────────────────────────────
const PDF_FLUID_LABELS = [
  { M:44, k:1.30, label:"CO₂ — 이산화탄소" },
  { M:28, k:1.40, label:"N₂ — 질소" },
  { M:18, k:1.33, label:"Steam — 수증기" },
  { M:29, k:1.40, label:"Air — 공기" },
  { M:16, k:1.31, label:"CH₄ — 메탄" },
];

const PDF_WF_STATE_LABELS = {
  DRAFT:           "초안",
  INSPECTION:      "점검 중",
  REVIEW:          "검토 대기",
  ACTION_REQUIRED: "조치 필요",
  APPROVED:        "승인 완료",
  CLOSED:          "종결",
};

function _pdfFluidLabel(inputs) {
  if (!inputs) return "커스텀";
  const m = PDF_FLUID_LABELS.find(f => f.M === inputs.M && f.k === inputs.k);
  return m ? m.label : "커스텀 유체 (직접 입력값)";
}

function _pdfWfLabel(state) {
  return PDF_WF_STATE_LABELS[state] || state || "—";
}

function _pdfRow(k, v) {
  return `<div class="pdf-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

function _pdfSection(title, bodyHtml) {
  return `<div class="pdf-section">
    <div class="pdf-section-title">${title}</div>
    <div class="pdf-section-body">${bodyHtml}</div>
  </div>`;
}

// ── buildPDFHtml ────────────────────────────────────────────────
// reportPackage 하나만 받는다. 계산/조회 없음 — package 필드를 그대로 문자열로 옮길 뿐.
function buildPDFHtml(reportPackage) {
  const pkg = reportPackage;

  const assetBody =
    _pdfRow("Equipment", `${pkg.asset.equipment.tag || "—"} · Rev.${pkg.asset.equipment.revision ?? "—"}`) +
    _pdfRow("Equipment MOC", pkg.asset.equipment.mocId || "—") +
    _pdfRow("Discharge System", `${pkg.asset.dischargeSystem.name || "—"} · Rev.${pkg.asset.dischargeSystem.revision ?? "—"}`) +
    _pdfRow("Discharge MOC", pkg.asset.dischargeSystem.mocId || "—");

  const calcBody =
    _pdfRow("Fluid", _pdfFluidLabel(pkg.calculation.inputs)) +
    _pdfRow("Engine", `API520 v${pkg.calculation.engineVersion}`) +
    _pdfRow("Compressibility Z", pkg.calculation.inputs?.Z != null ? `${pkg.calculation.inputs.Z}${pkg.calculation.inputs.Z===1 ? " (default)" : ""}` : "—") +
    _pdfRow("Relieving Pressure (abs)", pkg.calculation.result?.P1abs ? `${pkg.calculation.result.P1abs.toFixed(3)} bara` : "—") +
    _pdfRow("Selected Orifice", pkg.calculation.result?.selected?.letter || "—") +
    _pdfRow("Required Area", pkg.calculation.result?.areaCm2 ? `${pkg.calculation.result.areaCm2.toFixed(2)} cm²` : "—") +
    `<div style="margin-top:6px;font-size:9px;font-weight:700;color:#64748b;letter-spacing:0.5px;">BACKPRESSURE BASIS</div>` +
    _pdfRow("Header Pressure", pkg.asset.dischargeSystem.headerPressure != null ? `${pkg.asset.dischargeSystem.headerPressure} barg` : "—") +
    _pdfRow("Pipe Length",     pkg.asset.dischargeSystem.L != null ? `${pkg.asset.dischargeSystem.L} m` : "—") +
    _pdfRow("Diameter",        pkg.asset.dischargeSystem.D != null ? `${Math.round(pkg.asset.dischargeSystem.D*1000)} mm` : "—") +
    _pdfRow("Fittings K",      pkg.asset.dischargeSystem.fittingsK ?? "—");

  const reasons = (pkg.workflow.decision?.reasons || [])
    .map(r => `<div class="pdf-reason-item">· ${r.field} ${r.from}${r.unit||""} → ${r.to}${r.unit||""}</div>`)
    .join("");
  const wfBody =
    _pdfRow("State", _pdfWfLabel(pkg.workflow.state)) +
    _pdfRow("Evaluated At", (pkg.workflow.decision?.evaluatedAt || "—").slice(0,19).replace("T"," ")) +
    reasons;

  const approvalBody = pkg.approvals.length === 0
    ? `<div class="pdf-row"><span class="k">Status</span><span class="pdf-badge-none">서명 없음</span></div>`
    : pkg.approvals.map(a => {
        const badgeClass = a.verified === true ? "pdf-badge-ok"
                          : a.verified === false ? "pdf-badge-fail" : "pdf-badge-none";
        const badgeText  = a.verified === true ? "✓ 서명 유효"
                          : a.verified === false ? "✗ 위변조 의심" : "검증 안 됨";
        return `<div class="pdf-row">
          <span class="k">${a.signer} (${a.role||"—"})</span>
          <span class="${badgeClass}">${badgeText}</span>
        </div>` + _pdfRow("승인일", (a.approvedAt||"").slice(0,10));
      }).join("");

  const integrityBody =
    _pdfRow("Snapshot Hash", pkg.identity.snapshotHash) +
    _pdfRow("Snapshot ID", pkg.identity.snapshotId) +
    _pdfRow("Case ID", pkg.identity.caseId) +
    _pdfRow("Report Package Version", pkg.meta.packageVersion) +
    _pdfRow("Generated At", (pkg.meta.generatedAt||"").slice(0,19).replace("T"," "));

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<title>ArcSafe Audit Report — ${pkg.identity.snapshotId}</title>
<style>${PDF_STYLES}</style>
</head><body>
  <div class="pdf-title">PSV 검토 감사 보고서</div>
  <div class="pdf-subtitle">${pkg.identity.caseId} · ${pkg.identity.snapshotId}</div>

  ${_pdfSection("ASSET", assetBody)}
  ${_pdfSection("CALCULATION BASIS", calcBody)}
  ${_pdfSection("WORKFLOW DECISION", wfBody)}
  ${_pdfSection("APPROVAL", approvalBody)}
  ${_pdfSection("INTEGRITY", integrityBody)}

  <div class="pdf-footer">
    ArcSafe Report Package v${pkg.meta.packageVersion} · Engine v${pkg.meta.engineVersion} ·
    본 문서는 Snapshot ${pkg.identity.snapshotHash}에서 생성되었으며 원본 데이터를 재계산하지 않습니다.
  </div>
</body></html>`;
}
