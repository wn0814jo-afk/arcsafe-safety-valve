//  APPROVAL VALIDATOR
//  Report/승인 화면이 ApprovalRecord의 신뢰성을 확인할 때 호출하는 유일한 진입점.
//  서명 재계산은 crypto.js에, Snapshot 조회는 case/history.js에 위임한다 —
//  이 파일은 그 결과를 조합해 최종 valid/invalid만 판정한다.
//
//  계약:
//    VALIDATOR-001: record.signature가 record 필드로부터 재계산한 값과
//                   일치해야 한다 (위변조 탐지).
//    VALIDATOR-002: record.snapshotHash가 case.snapshotHistory에 실존해야
//                   한다. resolveSnapshot 실패 = 존재한 적 없는 버전에 대한
//                   서명 — 즉 승인 대상 자체가 위조되었다는 뜻.
//    VALIDATOR-003: 전체 승인 이력 안에 동일 idempotencyKey가 2회 이상
//                   나오면 invalid (SERVICE-001을 우회해 만들어진 기록).
// ════════════════════════════════════════════════════════════════

async function verifyApprovalRecord(record, caseObj, allApprovals) {
  if (!record) return { valid: false, reason: "record is null" };

  // VALIDATOR-001: 서명 재계산 (crypto.js에 위임)
  const sigCheck = await verifySignature({
    snapshotHash:  record.snapshotHash,
    decision:      record.decision,
    comment:       record.comment,
    signer:        record.approver,
    timestamp:     record.approvedAt,
    workflowState: record.workflowState,
    signature:     record.signature,
  });
  if (!sigCheck.valid) {
    return { valid: false, contract: "VALIDATOR-001", ...sigCheck };
  }

  // VALIDATOR-002: 서명 대상 Snapshot이 실제로 history에 존재하는지
  // (UI pointer가 아니라 resolveSnapshot으로만 조회 — HISTORY-002 준수)
  const targetSnap = resolveSnapshot(caseObj, record.snapshotHash);
  if (!targetSnap) {
    return {
      valid: false, contract: "VALIDATOR-002",
      reason: "snapshotHash not found in case.snapshotHistory",
    };
  }

  // 기존 APPROVAL-002 검증 재사용 (snapshotId 교차 확인)
  const baseCheck = verifyApproval(record, targetSnap);
  if (!baseCheck.valid) {
    return { valid: false, contract: "APPROVAL-002", ...baseCheck };
  }

  // VALIDATOR-003: idempotency 중복 검사
  const dupCount = (allApprovals || [])
    .filter(r => r.idempotencyKey === record.idempotencyKey).length;
  if (dupCount > 1) {
    return {
      valid: false, contract: "VALIDATOR-003",
      reason: "duplicate idempotencyKey found in approval history",
    };
  }

  return {
    valid: true,
    approver: record.approver,
    approvedAt: record.approvedAt,
    snapshotWorkflow: targetSnap.workflow,
  };
}
