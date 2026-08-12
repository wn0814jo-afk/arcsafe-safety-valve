//  REPORT PACKAGE — Snapshot → 불변 export 모델
//  PDF/HTML/JSON은 전부 이 결과물을 그대로 출력만 한다. 렌더러가 UI 구조에
//  결합되지 않도록 하는 게 이 파일의 유일한 목적.
//
//  계약:
//    REPORT-PKG-001: 같은 snapshot(+같은 generatedAt) → 항상 같은 package.
//                    (generatedAt은 "패키지를 만든 시각"이라 순수함수가 직접
//                    생성하면 결정론이 깨진다 — 호출자가 주입, 기본값은 폴백일 뿐)
//    REPORT-PKG-002: 결과는 Object.freeze — 이후 어떤 필드도 수정 불가.
//    REPORT-PKG-003: snapshot 하나만 받는다. currentEquipment/currentDischargeSystem/
//                    equipments/dischargeSystems 같은 "현재 Asset" 인자는 받지 않는다.
//                    Asset은 반드시 snapshot에 이미 박제된 값(assetRefs, snapshot.equipment,
//                    snapshot.dischargeSystem)에서만 읽는다.
//    REPORT-PKG-004: approvals는 snapshotHash가 일치하는 것만 포함한다.
//    REPORT-PKG-005: computeBackpressure/calculateKb/detectMOC 등 계산 함수를
//                    이 파일에서 호출하지 않는다 — snapshot.result를 그대로 옮길 뿐.
// ════════════════════════════════════════════════════════════════

// ── buildReportPackage ──────────────────────────────────────────
// snapshot:        createSnapshot()이 만든 frozen Snapshot (필수)
// opts.approvalRecords:          이 case의 ApprovalRecord[] (없으면 [])
// opts.approvalVerificationResults: { [approvalId]: {valid, ...} } —
//                  validator.js(verifyApprovalRecord)가 미리 계산해 넘긴 결과.
//                  이 함수는 절대 재검증하지 않는다.
// opts.generatedAt: 패키지 생성 시각 문자열(ISO). 안 주면 이 함수가 생성 —
//                  결정론 테스트에서는 반드시 명시적으로 넘겨야 한다.
function buildReportPackage(snapshot, opts) {
  if (!snapshot || !snapshot.snapshotHash) {
    return { ok: false, reason: "REPORT-PKG: snapshot(with snapshotHash) is required" };
  }
  // ENGINE-VERSION-LOCK-001: 이 Snapshot이 만들어진 엔진 버전과 지금
  // 돌고 있는 Engine의 버전이 다르면 ReportPackage를 만들지 않는다.
  // (예: 과거 엔진 버전으로 얼어붙은 Snapshot을 새 엔진 코드 위에서
  // 그대로 재출력하면 계산 근거와 화면/PDF 표시가 어긋날 수 있다.)
  // Snapshot 자체는 그 시점 값 그대로 유지되는 게 맞다 — 여기서 재계산하지
  // 않고, "지금 이 버전으로 새 ReportPackage를 만드는 것"만 차단한다.
  if (snapshot.engine_version !== ENGINE_VERSION) {
    return {
      ok: false,
      reason: "INVALID_STATE",
      contract: "ENGINE-VERSION-LOCK-001",
      detail: `snapshot.engine_version(${snapshot.engine_version}) !== ` +
              `현재 ENGINE_VERSION(${ENGINE_VERSION}) — 엔진 버전이 바뀐 뒤 ` +
              `이전 Snapshot으로 새 ReportPackage를 생성할 수 없다.`,
    };
  }
  const { approvalRecords, approvalVerificationResults, generatedAt } = opts || {};
  const genAt = generatedAt || new Date().toISOString();

  const matchedApprovals = (approvalRecords || [])
    .filter(a => a.snapshotHash === snapshot.snapshotHash)
    .map(a => Object.freeze({
      approvalId:  a.approvalId,
      signer:      a.approver,
      role:        a.role,
      approvedAt:  a.approvedAt,
      decision:    a.decision,
      comment:     a.comment,
      signature:   a.signature,
      verified:    (approvalVerificationResults || {})[a.approvalId]?.valid ?? null,
    }));

  const pkg = {
    meta: Object.freeze({
      packageVersion: REPORT_PACKAGE_VERSION,
      generatedAt:    genAt,
      engineVersion:  snapshot.engine_version,
    }),

    identity: Object.freeze({
      caseId:       snapshot.caseId,
      snapshotId:   snapshot.id,
      snapshotHash: snapshot.snapshotHash,
    }),

    asset: Object.freeze({
      equipment: Object.freeze({
        id:       snapshot.assetRefs.equipmentId,
        tag:      snapshot.assetRefs.equipmentTag,
        revision: snapshot.assetRefs.equipmentRevision,
        mocId:    snapshot.equipment?.mocId ?? null,
        // INLET-LOSS-001: PDF/Evidence의 인입배관 형상 표시(pkg.asset.
        // equipment.inletPiping)가 이 필드를 직접 읽는다 — 여기 없으면
        // 실제 데이터가 있어도 "미등록"으로 잘못 표시된다. 재계산 없이
        // snapshot에 이미 박제된 값을 그대로 복사(REPORT-PKG-005와 동일 원칙).
        inletPiping: snapshot.equipment?.inletPiping
          ? { L: snapshot.equipment.inletPiping.L, D: snapshot.equipment.inletPiping.D, fittingsK: snapshot.equipment.inletPiping.fittingsK }
          : null,
      }),
      dischargeSystem: Object.freeze({
        id:       snapshot.assetRefs.dischargeSystemId,
        name:     snapshot.assetRefs.dischargeSystemName,
        revision: snapshot.assetRefs.dischargeRevision,
        mocId:    snapshot.dischargeSystem?.mocId ?? null,
        // Backpressure Basis — 감사자가 "이 Kb가 어떤 배관 형상에서 나왔는지"를
        // 봐야 하므로 snapshot.dischargeSystem(당시 박제된 값)에서 그대로 복사.
        // 재계산 없음 — REPORT-PKG-005.
        L:              snapshot.dischargeSystem?.L ?? null,
        D:              snapshot.dischargeSystem?.D ?? null,
        fittingsK:      snapshot.dischargeSystem?.fittingsK ?? null,
        headerPressure: snapshot.dischargeSystem?.headerPressure ?? null,
        destination:    snapshot.dischargeSystem?.destination ?? null,
      }),
      assetFingerprint: snapshot.assetRefs.assetFingerprint,
    }),

    calculation: Object.freeze({
      engineVersion: snapshot.engine_version,
      inputs:        Object.freeze({ ...snapshot.inputs }),   // 재계산 없이 그대로 복사
      result:        Object.freeze({ ...snapshot.result }),   // 재계산 없이 그대로 복사
    }),

    workflow: Object.freeze({
      state: snapshot.workflow,
      decision: snapshot.workflowDecision ? Object.freeze({
        reasons:       Object.freeze([...(snapshot.workflowDecision.reasons || [])]),
        evaluatedAt:   snapshot.workflowDecision.evaluatedAt,
        engineVersion: snapshot.workflowDecision.engineVersion,
      }) : null,
    }),

    approvals: Object.freeze(matchedApprovals),
  };

  return Object.freeze(pkg);
}
