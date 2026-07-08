//  APPROVAL RECORD
//  Snapshot = 영구 불변 (서명 대상)
//  ApprovalRecord = Snapshot에 대한 별도 증명 (Snapshot을 수정하지 않음)
//
//  계약:
//    APPROVAL-001: snapshotHash 없으면 생성 불가
//    APPROVAL-002: 승인 후 Snapshot 변경 시 검증 실패
//    APPROVAL-003: 재승인은 이전 기록을 덮어쓰지 않고 별도 이력으로 남음
// ════════════════════════════════════════════════════════════════

const APPROVAL_ROLES = ["engineer", "senior_engineer", "safety_manager", "pss_manager"];

// ── validateApprovalInput ─────────────────────────────────────
function validateApprovalInput(input) {
  // APPROVAL-001: snapshotHash 필수
  if (!input.snapshotHash || !input.snapshotHash.trim()) {
    return { ok: false, contract: "APPROVAL-001",
             reason: "snapshotHash is required — cannot approve without a snapshot hash" };
  }
  if (!input.snapshotId || !input.snapshotId.trim()) {
    return { ok: false, contract: "APPROVAL-001",
             reason: "snapshotId is required" };
  }
  if (!input.approver || !input.approver.trim()) {
    return { ok: false, contract: "APPROVAL-001",
             reason: "approver name is required" };
  }
  if (!APPROVAL_ROLES.includes(input.role)) {
    return { ok: false, contract: "APPROVAL-001",
             reason: `role must be one of: ${APPROVAL_ROLES.join(", ")}` };
  }
  return { ok: true };
}

// ── createApprovalRecord ──────────────────────────────────────
// Snapshot을 수정하지 않음 — snapshotHash로 참조만 함
// approvedAt: 선택적 주입. service.js가 서명 대상 timestamp와 동일한 값을
// 넘겨서 "record 저장 시각"과 "서명된 시각"이 어긋나지 않도록 한다.
// 넘기지 않으면(기존 호출 호환) 이 함수가 직접 생성한다.
function createApprovalRecord(input) {
  const valid = validateApprovalInput(input);
  if (!valid.ok) {
    throw new Error(`${valid.contract}: ${valid.reason}`);
  }

  return Object.freeze({
    approvalId:    `APPR-${input.snapshotId}-${Date.now()}`,
    snapshotId:    input.snapshotId,
    snapshotHash:  input.snapshotHash,   // 서명 대상 fingerprint
    approver:      input.approver.trim(),
    role:          input.role,
    approvedAt:    input.approvedAt || new Date().toISOString(),
    comment:       input.comment || "",
    // APPROVAL-003: 재승인은 별도 approvalId로 생성 (덮어쓰기 없음)
    // 호출자는 이 record를 기존 배열에 push — replace 금지
  });
}

// ── verifyApproval ────────────────────────────────────────────
// APPROVAL-002: Snapshot의 현재 snapshotHash와 ApprovalRecord의 snapshotHash 비교
// 일치하지 않으면 승인 이후 Snapshot이 변경된 것
function verifyApproval(approvalRecord, currentSnapshot) {
  if (!approvalRecord || !currentSnapshot) {
    return { valid: false, reason: "approvalRecord or snapshot is null" };
  }
  if (approvalRecord.snapshotId !== currentSnapshot.id) {
    return { valid: false, reason: "snapshotId mismatch — wrong snapshot" };
  }
  if (approvalRecord.snapshotHash !== currentSnapshot.snapshotHash) {
    return {
      valid:  false,
      reason: "APPROVAL-002: snapshotHash mismatch — Snapshot was modified after approval",
      approvedHash: approvalRecord.snapshotHash,
      currentHash:  currentSnapshot.snapshotHash,
    };
  }
  return { valid: true, approver: approvalRecord.approver, approvedAt: approvalRecord.approvedAt };
}

// ── ApprovalHistory ───────────────────────────────────────────
// APPROVAL-003: 재승인은 push — replace 금지
// 단순 배열 헬퍼. 상태 없음.
function addApprovalRecord(history, newRecord) {
  // history는 배열. 새 record를 추가한 새 배열 반환 (mutation 없음).
  return Object.freeze([...history, newRecord]);
}

function getLatestApproval(history) {
  if (!history || history.length === 0) return null;
  return history[history.length - 1];
}
