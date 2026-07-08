//  CASE SNAPSHOT HISTORY
//  case.snapshotHistory[] = source of truth (append-only)
//  case.latestSnap        = UI 편의용 pointer (검증에 사용 금지)
//
//  계약:
//    HISTORY-001: appendSnapshot()은 항상 새 배열을 반환한다.
//                 기존 history 항목은 교체·삭제되지 않는다.
//    HISTORY-002: resolveSnapshot(hash)은 snapshotHistory에서만 조회한다.
//                 latestSnap을 신뢰 기준으로 사용하지 않는다.
//    HISTORY-003: 같은 case 안에서 snapshotHash가 중복되면 안 된다.
//                 (중복 시 Approval이 어떤 버전을 서명했는지 특정할 수 없다.)
// ════════════════════════════════════════════════════════════════

// ── appendSnapshot ─────────────────────────────────────────────
// caseObj를 직접 수정하지 않고 새 caseObj를 반환.
// snap은 이미 Object.freeze()된 Snapshot이어야 한다 (createSnapshot()의 결과).
function appendSnapshot(caseObj, snap) {
  const prevHistory = caseObj.snapshotHistory || [];
  const nextHistory = Object.freeze([...prevHistory, snap]);
  return {
    ...caseObj,
    snapshotHistory: nextHistory,
    latestSnap:      snap,        // pointer only — 표시 편의용
    workflow:        snap.workflow,
  };
}

// ── resolveSnapshot ────────────────────────────────────────────
// snapshotHash로 특정 Snapshot을 조회. latestSnap은 절대 참조하지 않음.
// Approval 검증은 반드시 이 함수를 통해서만 Snapshot을 가져와야 한다.
function resolveSnapshot(caseObj, snapshotHash) {
  if (!caseObj?.snapshotHistory || !snapshotHash) return null;
  return caseObj.snapshotHistory.find(s => s.snapshotHash === snapshotHash) || null;
}

// ── getLatestSnapshot ──────────────────────────────────────────
// latestSnap 포인터 대신 history의 마지막 항목을 기준으로 계산.
// pointer와 history가 어긋나는 경우(향후 버그) 이 함수가 진짜 값을 반환한다.
function getLatestSnapshot(caseObj) {
  const h = caseObj?.snapshotHistory;
  if (!h || h.length === 0) return null;
  return h[h.length - 1];
}

// ── hasDuplicateHash ───────────────────────────────────────────
// HISTORY-003 검증용. 같은 hash가 두 번 이상 나오면 true.
function hasDuplicateHash(caseObj) {
  const h = caseObj?.snapshotHistory || [];
  const hashes = h.map(s => s.snapshotHash);
  return new Set(hashes).size !== hashes.length;
}
