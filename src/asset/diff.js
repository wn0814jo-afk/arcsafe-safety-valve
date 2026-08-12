// ════════════════════════════════════════════════════════════════
//  ASSET REVISION DIFF ENGINE
//  "무엇이 달라졌는가"만 반환하는 순수 함수. 의미 해석(영향도/위험도/
//  MOC 필요 여부/워크플로우 변경)은 포함하지 않는다 — 그건 B3(Impact
//  Analysis)의 책임이다.
//
//    Revision A, Revision B
//          ↓
//    diffEquipmentRevision / diffDischargeSystemRevision   (여기까지만)
//          ↓
//    순수 Diff = [{ field, from, to, unit? }, ...]
//
//  계약:
//    ASSET-DIFF-001: 동일한 revision을 비교하면 빈 배열을 반환한다.
//    ASSET-DIFF-002: 입력 순서를 바꾸면 from/to만 반전되고, 대상 필드와
//                    출력 순서는 그대로다 (비교 자체는 대칭적이다).
//    ASSET-DIFF-003: 값이 바뀌지 않은 필드는 결과에 포함되지 않는다.
//    ASSET-DIFF-004: 입력 객체를 변경하지 않는다 (immutability) —
//                    oldRev/newRev 어느 쪽도 mutate하지 않고, 반환값도
//                    Object.freeze로 고정한다.
//    ASSET-DIFF-005: 출력 순서는 결정론적이다 — 스키마에 정의된 필드
//                    순서를 따르며, 어떤 필드가 "먼저 바뀌었는지"나 입력
//                    객체의 key 순서에 의존하지 않는다.
//
//  id / revision / mocId / registeredAt / revisedAt은 diff 대상에서
//  제외한다 — 이들은 revision마다 정의상 항상 달라지는 식별·감사 메타
//  데이터이고, "설비 사양이 무엇이 달라졌는가"에는 노이즈만 더한다.
//  (MOC 근거 자체는 이미 RevisionHistoryPanel의 MOC 배지로 노출됨)
// ════════════════════════════════════════════════════════════════

const EQUIPMENT_DIFF_FIELDS = [
  ["tag",          null],
  ["location",     null],
  ["deviceType",   null],
  ["manufacturer", null],
  ["model",        null],
  ["serialNo",     null],
  ["mawp",         "barg"],
  ["setPressure",  "barg"],
  ["overpressure", "%"],
  ["orifice",      null],
  ["inletSize",    null],
  ["outletSize",   null],
  ["installedAt",  null],
  // INLET-LOSS-001: inletPiping.* — dot-path 필드. DischargeSystem의
  // L/D/fittingsK와 이름이 겹치므로("L" vs "L") 반드시 접두사를 붙여
  // 구분한다 — 감사 로그에서 "무엇의 L이 바뀌었는지" 모호하면 안 된다.
  ["inletPiping.L",         "m"],
  ["inletPiping.D",         "m"],
  ["inletPiping.fittingsK", null],
];

const DISCHARGE_DIFF_FIELDS = [
  ["name",           null],
  ["destination",    null],
  ["L",              "m"],
  ["D",              "m"],
  ["fittingsK",      null],
  ["headerPressure", "barg"],
  ["connectedTags",  null],
];

// ── _valuesEqual ───────────────────────────────────────────────
// 배열(connectedTags)은 순서 포함 값 비교, 그 외는 단순 비교.
// undefined/null/""은 "값 없음"으로 취급해 동일하게 본다 (스키마 기본값 차이로
// 인한 허위 diff 방지).
function _emptyish(v) {
  return v === undefined || v === null || v === "";
}
function _valuesEqual(a, b) {
  if (_emptyish(a) && _emptyish(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a || []) === JSON.stringify(b || []);
  }
  return a === b;
}

// ── _getPath (내부 전용) ──────────────────────────────────────
// "inletPiping.L" 같은 1-depth 점(.) 경로를 읽는다. 중간 객체가
// null/undefined면 undefined를 반환(값 없음 취급) — _emptyish와 호환.
function _getPath(obj, path) {
  if (!obj) return undefined;
  if (path.indexOf(".") === -1) return obj[path];
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

// ── _diffFields (내부 전용) ───────────────────────────────────
function _diffFields(oldRev, newRev, fieldSpec) {
  if (!oldRev || !newRev) return Object.freeze([]);
  const changes = [];
  for (const [field, unit] of fieldSpec) {
    const from = _getPath(oldRev, field);
    const to = _getPath(newRev, field);
    if (!_valuesEqual(from, to)) {
      changes.push(Object.freeze(
        unit ? { field, from, to, unit } : { field, from, to }
      ));
    }
  }
  return Object.freeze(changes);
}

// ── diffEquipmentRevision ────────────────────────────────────
function diffEquipmentRevision(oldRev, newRev) {
  return _diffFields(oldRev, newRev, EQUIPMENT_DIFF_FIELDS);
}

// ── diffDischargeSystemRevision ──────────────────────────────
function diffDischargeSystemRevision(oldRev, newRev) {
  return _diffFields(oldRev, newRev, DISCHARGE_DIFF_FIELDS);
}
