// ════════════════════════════════════════════════════════════════
//  ASSET REVISION IMPACT ANALYSIS ENGINE
//  "이 Asset Revision이 어디에 쓰였는가"만 계산하는 순수 함수.
//  위험도 판단이나 워크플로우 재평가는 하지 않는다 — Snapshot에 이미
//  박제된 workflowDecision을 그대로 읽어 보여줄 뿐, Engine 판정 로직을
//  여기서 다시 돌리지 않는다.
//
//    revisionKey (= `${id}@${revision}`, asset/history.js와 동일 키)
//          ↓
//    analyzeRevisionImpact(revisionKey, allSnapshots)
//          ↓
//    { affectedCases, affectedSnapshots, latestAffected, obsoleteSnapshots }
//
//  allSnapshots는 case.snapshotHistory[]를 모든 Case에 대해 이어붙인
//  평탄화 배열이다 (예: cases.flatMap(c => c.snapshotHistory || [])).
//  각 Snapshot이 이미 assetRefs.equipmentId/equipmentRevision,
//  dischargeSystemId/dischargeRevision을 갖고 있으므로 caseId만으로
//  역인덱스를 구성할 수 있다 — case/history.js에 대한 의존은 없다.
//
//  계약:
//    ASSET-IMPACT-001: 일치하는 Snapshot이 없으면 4개 필드 모두 빈 배열.
//    ASSET-IMPACT-002: affectedCases는 caseId 중복이 없다.
//    ASSET-IMPACT-003: affectedSnapshots의 모든 원소는 실제로 해당
//                       revisionKey를 참조한다 — 같은 Asset의 다른
//                       revision과 섞이지 않는다.
//    ASSET-IMPACT-004: latestAffected와 obsoleteSnapshots는 affectedSnapshots를
//                       정확히 둘로 나눈다 (합집합 = affectedSnapshots,
//                       교집합 = 공집합). "여전히 최신 검토로 쓰이는가"
//                       (latestAffected) vs "이미 새 Snapshot으로 대체됐는가"
//                       (obsoleteSnapshots).
//    ASSET-IMPACT-005: 입력 배열(allSnapshots)을 변경하지 않는다.
// ════════════════════════════════════════════════════════════════

// ── _parseRevisionKey (내부 전용) ────────────────────────────
// asset/history.js의 _revisionKey(id, revision)와 정확히 대칭.
function _parseRevisionKey(revisionKey) {
  if (!revisionKey || typeof revisionKey !== "string") return null;
  const idx = revisionKey.lastIndexOf("@");
  if (idx === -1) return null;
  return { id: revisionKey.slice(0, idx), revision: Number(revisionKey.slice(idx + 1)) };
}

// ── _matchesRevision (내부 전용) ─────────────────────────────
// Snapshot.assetRefs 중 어느 쪽(equipment/discharge)을 볼지는 id 접두어로 판별.
// (asset/schema.js의 createEquipment/createDischargeSystem이 각각
//  `EQ-...`/`DS-...`로 id를 부여하므로 접두어가 곧 kind다.)
function _matchesRevision(snap, id, revision) {
  const refs = snap && snap.assetRefs;
  if (!refs) return false;
  if (id.indexOf("EQ-") === 0) {
    return refs.equipmentId === id && Number(refs.equipmentRevision) === revision;
  }
  if (id.indexOf("DS-") === 0) {
    return refs.dischargeSystemId === id && Number(refs.dischargeRevision) === revision;
  }
  return false;
}

// ── _latestSnapshotByCase (내부 전용) ────────────────────────
// caseId별 마지막 등장 Snapshot = 그 Case의 최신 Snapshot.
// (allSnapshots는 각 case.snapshotHistory의 append 순서를 보존한 채
//  이어붙인 배열이라고 가정 — case 내부에서 뒤에 나올수록 최신.)
function _latestSnapshotByCase(allSnapshots) {
  const map = new Map();
  for (const s of allSnapshots) {
    if (s && s.caseId) map.set(s.caseId, s);
  }
  return map;
}

// ── analyzeRevisionImpact ────────────────────────────────────
function analyzeRevisionImpact(revisionKey, allSnapshots) {
  const empty = Object.freeze({
    affectedCases:     Object.freeze([]),
    affectedSnapshots: Object.freeze([]),
    latestAffected:    Object.freeze([]),
    obsoleteSnapshots: Object.freeze([]),
  });

  const parsed = _parseRevisionKey(revisionKey);
  if (!parsed || !allSnapshots || allSnapshots.length === 0) return empty;

  const { id, revision } = parsed;
  const affectedSnapshots = allSnapshots.filter(s => _matchesRevision(s, id, revision));
  if (affectedSnapshots.length === 0) return empty;

  const affectedCases = [...new Set(affectedSnapshots.map(s => s.caseId))];
  const latestByCase  = _latestSnapshotByCase(allSnapshots);

  const latestAffected    = affectedSnapshots.filter(s => latestByCase.get(s.caseId) === s);
  const obsoleteSnapshots = affectedSnapshots.filter(s => latestByCase.get(s.caseId) !== s);

  return Object.freeze({
    affectedCases:     Object.freeze(affectedCases),
    affectedSnapshots: Object.freeze(affectedSnapshots),
    latestAffected:    Object.freeze(latestAffected),
    obsoleteSnapshots: Object.freeze(obsoleteSnapshots),
  });
}
