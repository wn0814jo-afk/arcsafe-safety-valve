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

const PDF_CHECKLIST_ITEMS = [
  { key:"capacityOK",     label:"방출용량 충족",    detail:"선정 오리피스 면적이 필요 면적 이상인지 확인" },
  { key:"backPressureOK", label:"배압(背壓) 허용 범위 이내", detail:"배출 배관에 걸리는 반대 압력이 밸브 작동을 방해하지 않는 범위인지 확인" },
  { key:"mawpOK",         label:"설정압이 최고허용운전압력(MAWP) 이내",    detail:"설정압이 설비가 견딜 수 있는 최고압력을 넘지 않는지 확인" },
  { key:"kdOK",           label:"방출계수 Kd 충족",         detail:"밸브가 실제로 얼마나 잘 배출하는지 나타내는 보정값, 최소 권고 기준(0.9 이상) 충족 여부" },
  { key:"marginOK",       label:"여유율 충분",     detail:"필요량보다 여유있게 설계됐는지 — 선정 오리피스 면적의 여유 정도(1.0배 이상)" },
];

function _pdfVerdictSection(checklist, backpress) {
  if (!checklist) return "";
  const allOK = Object.values(checklist).every(Boolean);
  const vtLabel = backpress?.valveType==="BELLOWS" ? "벨로우즈형(밸런스형)" : "스프링식";
  const allowPct = backpress?.allowableRatio!=null ? (backpress.allowableRatio*100).toFixed(0) : "10";
  const items = PDF_CHECKLIST_ITEMS.map(it => it.key === "backPressureOK"
    ? { ...it, detail:`배출 배관에 걸리는 반대 압력이 밸브 작동을 방해하지 않는 범위인지 확인 — ${vtLabel} 기준 설정압력의 ${allowPct}% 이내 (KOSHA D-18 §7.2(4))` }
    : it);
  const rows = items.map(({key,label,detail}) => {
    const ok = checklist[key];
    return `<div class="pdf-row" style="align-items:flex-start;">
      <span class="k" style="font-family:'Pretendard','Malgun Gothic',sans-serif;color:#1a2b3d;">
        <span style="font-weight:700;">${ok ? "✓" : "✗"} ${label}</span><br/>
        <span style="font-weight:400;color:#64748b;font-size:9px;">${detail}</span>
      </span>
      <span class="${ok ? "pdf-badge-ok" : "pdf-badge-fail"}" style="font-family:'Pretendard','Malgun Gothic',sans-serif;white-space:nowrap;">${ok ? "충족" : "미충족"}</span>
    </div>`;
  }).join("");
  const verdictLabel = allOK ? "적정 — API 520/521 기준을 모두 충족합니다" : "부적정 — 기준 미충족 항목이 있어 조치가 필요합니다";
  const verdictColor = allOK ? "#2e7d32" : "#c0392b";
  return `<div class="pdf-section">
    <div class="pdf-section-title">⓪ 최종 판정 — 이 검토의 결론</div>
    <div class="pdf-section-body">
      <div style="font-size:13px;font-weight:900;color:${verdictColor};margin-bottom:8px;">${verdictLabel}</div>
      ${rows}
    </div>
  </div>`;
}

// ── buildPDFHtml ────────────────────────────────────────────────
// reportPackage 하나만 받는다. 계산/조회 없음 — package 필드를 그대로 문자열로 옮길 뿐.
function buildPDFHtml(reportPackage) {
  const pkg = reportPackage;

  const assetBody =
    _pdfRow("설비 (Tag No.)", `${pkg.asset.equipment.tag || "—"} · 개정 Rev.${pkg.asset.equipment.revision ?? "—"}`) +
    _pdfRow("설비 변경관리번호 (MOC)", pkg.asset.equipment.mocId || "—") +
    _pdfRow("배출계통 (가스 배출 배관)", `${pkg.asset.dischargeSystem.name || "—"} · 개정 Rev.${pkg.asset.dischargeSystem.revision ?? "—"}`) +
    _pdfRow("배출계통 변경관리번호 (MOC)", pkg.asset.dischargeSystem.mocId || "—");

  const calcBody =
    _pdfRow("유체 종류", _pdfFluidLabel(pkg.calculation.inputs)) +
    _pdfRow("밸브 형식", pkg.calculation.inputs?.valveType === "BELLOWS" ? "벨로우즈형(밸런스형)" : "스프링식") +
    _pdfRow("계산 방식 (계산 엔진 버전)", `API 520 방식 v${pkg.calculation.engineVersion}`) +
    _pdfRow("압축계수 Z (이상기체와의 차이 보정값)", pkg.calculation.inputs?.Z != null ? `${pkg.calculation.inputs.Z}${pkg.calculation.inputs.Z===1 ? " (기본값)" : ""}` : "—") +
    _pdfRow("분출압력 (절대압 기준)", pkg.calculation.result?.P1abs ? `${pkg.calculation.result.P1abs.toFixed(3)} bar(절대압)` : "—") +
    _pdfRow("선정 오리피스 (밸브 유량 구멍 규격)", pkg.calculation.result?.selected?.letter || "—") +
    _pdfRow("필요 유량 면적", pkg.calculation.result?.areaCm2 ? `${pkg.calculation.result.areaCm2.toFixed(2)} cm²` : "—") +
    `<div style="margin-top:6px;font-size:9px;font-weight:700;color:#64748b;letter-spacing:0.5px;">배압(背壓) 산정 근거 — 배출 배관이 밸브 작동을 방해하지 않는지 확인하는 값들</div>` +
    _pdfRow("배출 헤더 압력", pkg.asset.dischargeSystem.headerPressure != null ? `${pkg.asset.dischargeSystem.headerPressure} bar(게이지압)` : "—") +
    _pdfRow("배관 길이",     pkg.asset.dischargeSystem.L != null ? `${pkg.asset.dischargeSystem.L} m` : "—") +
    _pdfRow("배관 내경",        pkg.asset.dischargeSystem.D != null ? `${Math.round(pkg.asset.dischargeSystem.D*1000)} mm` : "—") +
    _pdfRow("배관 부속 저항계수 (ΣK)",      pkg.asset.dischargeSystem.fittingsK ?? "—");

  const reasons = (pkg.workflow.decision?.reasons || [])
    .map(r => `<div class="pdf-reason-item">· ${r.field} ${r.from}${r.unit||""} → ${r.to}${r.unit||""}</div>`)
    .join("");
  const wfBody =
    _pdfRow("현재 상태", _pdfWfLabel(pkg.workflow.state)) +
    _pdfRow("판정 일시", (pkg.workflow.decision?.evaluatedAt || "—").slice(0,19).replace("T"," ")) +
    reasons;

  const approvalBody = pkg.approvals.length === 0
    ? `<div class="pdf-row"><span class="k">서명 상태</span><span class="pdf-badge-none">서명 없음</span></div>`
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
    _pdfRow("스냅샷 해시값 (위변조 확인용 고유값)", pkg.identity.snapshotHash) +
    _pdfRow("스냅샷 ID", pkg.identity.snapshotId) +
    _pdfRow("검토 건 번호 (Case ID)", pkg.identity.caseId) +
    _pdfRow("리포트 형식 버전", pkg.meta.packageVersion) +
    _pdfRow("생성 일시", (pkg.meta.generatedAt||"").slice(0,19).replace("T"," "));

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<title>ArcSafe 검토 보고서 — ${pkg.identity.snapshotId}</title>
<style>${PDF_STYLES}</style>
</head><body>
  <div class="pdf-title">PSV 검토 감사 보고서</div>
  <div class="pdf-subtitle">${pkg.identity.caseId} · ${pkg.identity.snapshotId}</div>

  ${_pdfVerdictSection(pkg.calculation.result?.checklist, pkg.calculation.result?.stepData?.backpress)}
  ${_pdfSection("① 설비 정보", assetBody)}
  ${_pdfSection("② 계산 근거", calcBody)}
  ${_pdfSection("③ 검토 진행 상태", wfBody)}
  ${_pdfSection("④ 승인 현황", approvalBody)}
  ${_pdfSection("⑤ 문서 무결성 (변조 확인용)", integrityBody)}

  <div class="pdf-footer">
    ArcSafe 리포트 패키지 v${pkg.meta.packageVersion} · 계산 엔진 v${pkg.meta.engineVersion} ·
    본 문서는 스냅샷 ${pkg.identity.snapshotHash}에서 생성되었으며 원본 데이터를 재계산하지 않습니다.
  </div>
</body></html>`;
}
