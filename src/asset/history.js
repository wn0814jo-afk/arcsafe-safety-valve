// ════════════════════════════════════════════════════════════════
//  ASSET REVISION HISTORY
//  equipmentHistory[] / dischargeHistory[] = source of truth (append-only)
//  "latest"는 저장하지 않고 항상 revision 최댓값으로부터 파생시킨다.
//
//  case/history.js(HISTORY-001/002/003)와 동일한 원칙을 Asset Repository에
//  적용한다. Snapshot은 "그 시점의 상태"라 pointer(latestSnap)를 저장하는
//  것이 맞지만, Asset Repository는 history만 저장하고 latest는 계산값으로
//  둔다 — 저장된 pointer와 history가 어긋나는 상태 불일치 자체를 없앤다.
//
//  계약:
//    ASSET-HISTORY-001: appendRevision()은 항상 새 배열을 반환한다.
//                        기존 history 항목은 교체·삭제되지 않는다.
//                        (한 번도 Case에서 참조되지 않은 revision도 보존됨)
//    ASSET-HISTORY-002: resolveRevision(id, revision)은 history에서만 조회한다.
//                        별도로 저장된 "현재 상태" 필드를 신뢰 기준으로 삼지 않는다.
//    ASSET-HISTORY-003: getLatestRevision(id)은 history 중 해당 id의
//                        revision 최댓값을 반환한다 — latest는 저장하지 않고
//                        항상 파생시킨다.
//    ASSET-HISTORY-004: 같은 id 안에서 revision이 중복되면 안 된다.
//                        (중복 시 "최신"이 어느 것인지 특정할 수 없다.)
// ════════════════════════════════════════════════════════════════

// ── _revisionKey (내부 전용) ───────────────────────────────────
// 외부에 노출하는 API는 resolveRevision(history, id, revision)을 그대로 유지하되,
// 내부적으로는 `${id}@${revision}` 형태의 정규화된 키를 사용한다.
// 이 키는 이후 Impact Analysis / Report Package / Audit Evidence / PDF 등에서
// 공통 식별자로 재사용할 수 있도록 지금 통일해 둔다.
function _revisionKey(id, revision) {
  return `${id}@${revision}`;
}

// ── appendRevision ─────────────────────────────────────────────
// history를 직접 수정하지 않고 새 배열을 반환.
// rev는 이미 Object.freeze()된 EquipmentRevision/DischargeSystemRevision
// (createEquipment/reviseEquipment 또는 createDischargeSystem/reviseDischargeSystem의 결과)이어야 한다.
function appendRevision(history, rev) {
  const prev = history || [];
  return Object.freeze([...prev, rev]);
}

// ── resolveRevision ────────────────────────────────────────────
// id + revision 조합으로 특정 revision을 조회. history에서만 조회하며
// "현재 상태"를 별도로 참조하지 않는다. 내부적으로 _revisionKey로 정규화해서 비교한다.
function resolveRevision(history, id, revision) {
  if (!history || !id) return null;
  const key = _revisionKey(id, revision);
  return history.find(r => _revisionKey(r.id, r.revision) === key) || null;
}

// ── getLatestRevision ──────────────────────────────────────────
// 저장된 pointer가 아니라, history 중 해당 id의 revision 최댓값을 계산해서 반환.
function getLatestRevision(history, id) {
  if (!history || !id) return null;
  const list = history.filter(r => r.id === id);
  if (list.length === 0) return null;
  return list.reduce((a, b) => (Number(b.revision) > Number(a.revision) ? b : a));
}

// ── getAllLatestRevisions ────────────────────────────────────────
// history 전체에서 id별 최신 revision만 뽑아 "현재 목록"을 파생시킨다.
// AssetMaster 등 UI가 소비하는 리스트는 이 함수의 결과여야 하며,
// history 배열 자체를 그대로 렌더링해서는 안 된다.
function getAllLatestRevisions(history) {
  if (!history) return [];
  const ids = [...new Set(history.map(r => r.id))];
  return ids
    .map(id => getLatestRevision(history, id))
    .filter(Boolean);
}

// ── getRevisionsFor ───────────────────────────────────────────
// 특정 id의 전체 revision 이력을 revision 오름차순으로 반환 (Revision History View용).
function getRevisionsFor(history, id) {
  if (!history || !id) return [];
  return history
    .filter(r => r.id === id)
    .sort((a, b) => Number(a.revision) - Number(b.revision));
}

// ── hasDuplicateRevision ──────────────────────────────────────
// ASSET-HISTORY-004 검증용. 같은 id+revision 조합이 두 번 이상 나오면 true.
function hasDuplicateRevision(history) {
  const h = history || [];
  const keys = h.map(r => _revisionKey(r.id, r.revision));
  return new Set(keys).size !== keys.length;
}
