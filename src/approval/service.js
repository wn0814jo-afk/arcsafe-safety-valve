//  APPROVAL SERVICE
//  ApprovalForm(추후 구현)이 호출하는 유일한 진입점.
//  UI는 hash 계산도, 서명 검증도, workflow 판단도 하지 않는다 — 여기서 전부 처리.
//
//  계약:
//    SERVICE-001: idempotencyKey = SHA256(snapshotHash + signer) 기준으로
//                 동일 (snapshot version, signer) 조합의 중복 서명을 차단한다.
//    SERVICE-002: submitApproval()은 서명까지 완료된 ApprovalRecord만
//                 history에 추가한다 — 미서명 record는 존재할 수 없다.
//    SERVICE-003: Snapshot은 이 파일에서 절대 생성/수정하지 않는다 (읽기 전용).
//                 timestamp는 이 함수가 1회만 생성해 approvedAt과 서명 대상
//                 timestamp 양쪽에 동일하게 사용한다 (두 번 호출 시 값이
//                 어긋날 수 있으므로 반드시 단일 지점에서 생성).
// ════════════════════════════════════════════════════════════════

// ── computeIdempotencyKey ───────────────────────────────────────
async function computeIdempotencyKey(snapshotHash, signer) {
  return sha256Hex(`${snapshotHash}\u0000${signer}`);
}

// ── isDuplicateApproval ──────────────────────────────────────────
// SERVICE-001: 같은 (snapshotHash, signer) 조합으로 이미 서명한 기록이 있는지
async function isDuplicateApproval(history, snapshotHash, signer) {
  const key = await computeIdempotencyKey(snapshotHash, signer);
  for (const rec of (history || [])) {
    if (rec.idempotencyKey === key) return true;
  }
  return false;
}

// ── submitApproval ─────────────────────────────────────────────
// input:   { snapshot, decision, comment, signer, role }
// history: 이 case에 쌓인 기존 ApprovalRecord[] (없으면 [])
// 반환:    성공 { ok:true, record, history }
//          실패 { ok:false, contract, reason }
async function submitApproval(input, history) {
  const { snapshot, decision, comment, signer, role } = input;

  if (!snapshot || !snapshot.snapshotHash) {
    return { ok: false, contract: "APPROVAL-001", reason: "snapshot(with snapshotHash) is required" };
  }

  // SERVICE-003: 단일 timestamp — approvedAt과 서명 대상에 동일하게 사용
  const now = new Date().toISOString();

  const dup = await isDuplicateApproval(history, snapshot.snapshotHash, signer);
  if (dup) {
    return {
      ok: false, contract: "SERVICE-001",
      reason: "duplicate approval — this signer already signed this snapshot version",
    };
  }

  let base;
  try {
    base = createApprovalRecord({
      snapshotId:   snapshot.id,
      snapshotHash: snapshot.snapshotHash,
      approver:     signer,
      role,
      comment,
      approvedAt:   now,
    });
  } catch (e) {
    return { ok: false, contract: "APPROVAL-001", reason: e.message };
  }

  const signPayload = {
    snapshotHash:  base.snapshotHash,
    decision,
    comment:       base.comment,
    signer:        base.approver,
    timestamp:     base.approvedAt,   // base와 동일 값 재사용 — 두 번째 Date() 없음
    workflowState: snapshot.workflow,
  };
  const signature      = await signApproval(signPayload);
  const idempotencyKey = await computeIdempotencyKey(base.snapshotHash, base.approver);

  const record = Object.freeze({
    ...base,
    decision,
    workflowState: snapshot.workflow,
    signature,
    idempotencyKey,
  });

  return { ok: true, record, history: addApprovalRecord(history || [], record) };
}
