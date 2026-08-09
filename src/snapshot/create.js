//  SNAPSHOT — Object.freeze, 불변
//  3-레이어 + assetRefs + workflowDecision trace
// ════════════════════════════════════════════════════════════════

function _hashResult(inputs, result) {
  const str = JSON.stringify({
    inputs, areaCm2: result.areaCm2, selected: result.selected?.letter
  });
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function _assetHash(equipment, dischargeSystem) {
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

const SNAPSHOT_ENGINE_VERSION = "1.5.0";

// Snapshot이 기록하는 trigger fields — 감사 시 "어떤 규칙으로 판단했는지" 재현용
const WORKFLOW_TRIGGER_FIELDS_SNAPSHOT = [
  "headerPressure","L","D","fittingsK","destination",
  "setPressure","mawp","orifice","deviceType",
];

function createSnapshot({ caseId, valveTag, deviceType, inputs, engineResult,
                          equipment, dischargeSystem, workflowDecision }) {
  if (ENGINE_VERSION !== SNAPSHOT_ENGINE_VERSION) {
    throw new Error(
      `INVALID_STATE: engine version mismatch. ` +
      `engine=${ENGINE_VERSION}, snapshot expects=${SNAPSHOT_ENGINE_VERSION}.`
    );
  }

  const resultHash       = _hashResult(inputs, engineResult);
  const assetFingerprint = _assetHash(equipment, dischargeSystem);
  // evaluatedAt은 Snapshot 생성 시점에서 결정 — Engine이 아닌 증거 패키지의 책임
  const evaluatedAt      = new Date().toISOString();

  // snapshotHash — Approval 서명 대상. Snapshot 핵심 내용의 fingerprint.
  // 승인 후 Snapshot 내용이 바뀌면 이 값과 달라져 서명 검증 실패 감지 가능.
  function _snapHash(id, rHash, aFP, ev, wfState) {
    const str = JSON.stringify({ id, result_hash:rHash, assetFingerprint:aFP,
                                  evaluatedAt:ev, workflow:wfState });
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31,h)+str.charCodeAt(i))|0;
    return (h>>>0).toString(16).padStart(8,'0');
  }

  const snap = {  // eslint-disable-line prefer-const
    id:             `SNAP-${caseId}-${Date.now()}`,
    createdAt:      evaluatedAt,
    caseId,
    valveTag,
    deviceType,
    engine_version: ENGINE_VERSION,
    result_hash:    resultHash,

    // MOC 감지용 — 검토 시점 Asset 식별자 + Revision
    assetRefs: Object.freeze({
      equipmentId:         equipment?.id        || null,
      equipmentTag:        equipment?.tag        || null,
      equipmentRevision:   equipment?.revision   ?? null,
      dischargeSystemId:   dischargeSystem?.id   || null,
      dischargeSystemName: dischargeSystem?.name || null,
      dischargeRevision:   dischargeSystem?.revision ?? null,
      assetFingerprint,
    }),

    // Workflow 결정 trace — 감사 시 재현 가능한 불변 기록
    // Engine이 결정한 값 그대로. UI가 수정 불가.
    workflowDecision: workflowDecision ? Object.freeze({
      state:         workflowDecision.state,
      evaluatedAt,                             // Snapshot 생성 시점 — 증거 패키지 책임
      engineVersion: workflowDecision.engineVersion || ENGINE_VERSION,
      reasons:       Object.freeze([...(workflowDecision.reasons || [])]),
      triggerFields: Object.freeze([...WORKFLOW_TRIGGER_FIELDS_SNAPSHOT]),
    }) : null,

    // 3-레이어 불변 복사본
    equipment:       equipment       ? Object.freeze({ ...equipment })       : null,
    dischargeSystem: dischargeSystem ? Object.freeze({ ...dischargeSystem }) : null,
    inputs:          Object.freeze({ ...inputs }),
    result:          Object.freeze({ ...engineResult }),
    evidence:        Object.freeze(buildEvidence(engineResult.stepData)),
    workflow:        workflowDecision?.state || "INSPECTION",
  };
  // snapshotHash는 id/result_hash/assetFingerprint/evaluatedAt/workflow가 확정된 후 계산
  const snapshotHash = _snapHash(
    snap.id, snap.result_hash, snap.assetRefs.assetFingerprint,
    snap.evaluatedAt, snap.workflow
  );
  // Object.freeze 전에 snapshotHash 주입
  snap.snapshotHash = snapshotHash;
  return Object.freeze(snap);
}

// detectMOC → engine/workflow_engine.js 로 이동
// Snapshot은 데이터 저장만 담당. 상태 판정은 Engine 책임.
