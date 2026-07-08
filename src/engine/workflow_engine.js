//  WORKFLOW ENGINE (pure, stateless)
//  결정 계층:
//    detectMOC()          — Fact    : 무엇이 바뀌었나
//    evaluateSafetyImpact() — Analysis: 안전성에 영향을 주는가
//    computeWorkflowState() — Policy  : 최종 workflow 상태 결정
//
//  계약:
//    detectMOC()가 반환한 diff 객체는 이후 함수에서 재조립 금지.
//    { field, from, to, unit } 그대로 전달.
// ════════════════════════════════════════════════════════════════

// ── _wfAssetHash (내부 전용) ──────────────────────────────────
function _wfAssetHash(equipment, dischargeSystem) {
  const eq = equipment ? {
    tag: equipment.tag, mawp: equipment.mawp,
    setPressure: equipment.setPressure, orifice: equipment.orifice,
    deviceType: equipment.deviceType,
  } : null;
  const ds = dischargeSystem ? {
    name: dischargeSystem.name, L: dischargeSystem.L,
    D: dischargeSystem.D, fittingsK: dischargeSystem.fittingsK,
    headerPressure: dischargeSystem.headerPressure,
    destination: dischargeSystem.destination,
  } : null;
  const str = JSON.stringify({ eq, ds });
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── LAYER 1: detectMOC — Fact ─────────────────────────────────
// 반환값 스키마 (불변 계약):
//   { changed: boolean, diffs: Array<{ field, from, to, unit }> }
// 이 스키마를 변경하면 MOC_SCHEMA_001 contract test가 실패한다.
function detectMOC(snap, currentEquipment, currentDischargeSystem) {
  if (!snap?.assetRefs) return { changed: false, diffs: [] };

  const currentFP = _wfAssetHash(currentEquipment, currentDischargeSystem);
  if (currentFP === snap.assetRefs.assetFingerprint) {
    return { changed: false, diffs: [] };
  }

  const diffs = [];
  const eq  = snap.equipment;
  const ds  = snap.dischargeSystem;
  const ceq = currentEquipment;
  const cds = currentDischargeSystem;

  if (eq && ceq) {
    if (eq.mawp        !== ceq.mawp)        diffs.push({ field:"mawp",        from:eq.mawp,        to:ceq.mawp,        unit:"barg" });
    if (eq.setPressure !== ceq.setPressure) diffs.push({ field:"setPressure", from:eq.setPressure, to:ceq.setPressure, unit:"barg" });
    if (eq.orifice     !== ceq.orifice)     diffs.push({ field:"orifice",     from:eq.orifice,     to:ceq.orifice,     unit:"" });
    if (eq.deviceType  !== ceq.deviceType)  diffs.push({ field:"deviceType",  from:eq.deviceType,  to:ceq.deviceType,  unit:"" });
  }
  if (ds && cds) {
    if (ds.headerPressure !== cds.headerPressure) diffs.push({ field:"headerPressure", from:ds.headerPressure, to:cds.headerPressure, unit:"barg" });
    if (ds.L              !== cds.L)              diffs.push({ field:"L",              from:ds.L,              to:cds.L,              unit:"m" });
    if (ds.D              !== cds.D)              diffs.push({ field:"D",              from:ds.D,              to:cds.D,              unit:"m" });
    if (ds.fittingsK      !== cds.fittingsK)      diffs.push({ field:"fittingsK",      from:ds.fittingsK,      to:cds.fittingsK,      unit:"" });
    if (ds.destination    !== cds.destination)    diffs.push({ field:"destination",    from:ds.destination,    to:cds.destination,    unit:"" });
  }

  return { changed: diffs.length > 0, diffs };
}

// ── LAYER 2: evaluateSafetyImpact — Analysis ─────────────────
// detectMOC()의 diffs를 받아 안전성 영향 여부를 평가.
// diff 객체를 재조립하지 않고 그대로 사용.
// 반환값: { requiresReview: boolean, triggerDiffs: diff[] }
const WORKFLOW_TRIGGER_FIELDS = [
  "headerPressure", "L", "D", "fittingsK", "destination",
  "setPressure", "mawp", "orifice", "deviceType",
];

function evaluateSafetyImpact(diffs) {
  if (!diffs || diffs.length === 0) {
    return { requiresReview: false, triggerDiffs: [] };
  }
  // diff 객체 재조립 금지 — 원본 참조만 전달
  const triggerDiffs = diffs.filter(d => WORKFLOW_TRIGGER_FIELDS.includes(d.field));
  return {
    requiresReview: triggerDiffs.length > 0,
    triggerDiffs,   // detectMOC()가 만든 객체 그대로
  };
}

// ── LAYER 3: computeWorkflowState — Policy ───────────────────
// 최종 workflow 상태 결정. diff 객체를 생성하지 않음.
// detectMOC() → evaluateSafetyImpact() 결과만 사용.
//
// 반환값:
//   {
//     state: string,
//     reasons: diff[],      — detectMOC 원본 참조 (재조립 없음)
//     evaluatedAt: string,  — ISO timestamp
//     engineVersion: string,
//   }
// Engine은 결정만 반환. 시간(evaluatedAt)은 Snapshot 생성 시점에서 추가.
// 반환값에 evaluatedAt 없음 — createSnapshot()이 증거 패키지로 조립.
function computeWorkflowState(previousSnapshot, currentEquipment, currentDischargeSystem) {

  // Policy 1: 최초 검토
  if (!previousSnapshot) {
    return { state:"DRAFT", reasons:[], engineVersion:ENGINE_VERSION };
  }

  // Policy 2: APPROVED / CLOSED — Engine이 바꾸지 않음
  if (["APPROVED","CLOSED"].includes(previousSnapshot.workflow)) {
    return { state:previousSnapshot.workflow, reasons:[], engineVersion:ENGINE_VERSION };
  }

  // Fact: 무엇이 바뀌었나
  const mocResult = detectMOC(previousSnapshot, currentEquipment, currentDischargeSystem);

  if (!mocResult.changed) {
    return { state:previousSnapshot.workflow, reasons:[], engineVersion:ENGINE_VERSION };
  }

  // Analysis: 안전성에 영향을 주는가
  const impact = evaluateSafetyImpact(mocResult.diffs);

  // Policy 3: 계산 영향 변경 → REVIEW_REQUIRED
  if (impact.requiresReview) {
    return {
      state:         "REVIEW_REQUIRED",
      reasons:       impact.triggerDiffs,
      engineVersion: ENGINE_VERSION,
    };
  }

  // Policy 4: 비계산 변경 → INSPECTION (재확인 필요)
  return {
    state:         "INSPECTION",
    reasons:       mocResult.diffs,
    engineVersion: ENGINE_VERSION,
  };
}
