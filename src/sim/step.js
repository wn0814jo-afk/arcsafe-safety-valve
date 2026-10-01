//  SIMULATION (시간 전용 — 계산 없음)
//  B-2: 아래 POP_SIM_* 헬퍼는 "단계 기반 팝핑 원리 설명" 전용 순수 함수.
//  새로운 물리/압력 계산을 하지 않는다 — 단계 번호 ↔ 표시 상태 매핑만 담당.
// ════════════════════════════════════════════════════════════════
function stepSim(prev, setPoint, mawp) {
  let { pressure, direction } = prev;
  const speed = pressure >= setPoint ? API_CONST.SIM_SPEED_RELIEF : API_CONST.SIM_SPEED_NORMAL;
  pressure += direction * speed;
  if (pressure >= mawp * API_CONST.SIM_MAWP_FACTOR) direction = -1;
  if (pressure <= 0.3) direction = 1;
  return {
    ...prev,
    pressure: Math.max(0, pressure),
    direction,
    valveOpen: pressure >= setPoint,
    ratio: Math.min(pressure / (mawp * API_CONST.SIM_MAWP_FACTOR), 1),
  };
}

// ════════════════════════════════════════════════════════════════

// ── B-2 — 안전밸브 팝핑 원리 6단계 설명 시뮬레이션 (순수 상태 헬퍼) ──
// 시간 기반 자동 재생이 아니라, 사용자가 [다음 단계]를 눌러야만 진행한다.
// 압력/방출량의 시계열을 만들지 않는다 — 단계별 "설명용 연출 상태"만 정의.
const POP_SIM_TOTAL = 6;
// 설명용 막대 그림에서 "설정압력" 눈금의 높이 비율(실제 압력 값 아님)
const POP_SIM_SET_LEVEL = 0.85;
// open: ValveIllustration에 전달할 열림 상태(STEP 1~3 닫힘, 4~6 열림)
// flow: 유체 방출 연출(STEP 5~6) / pressure: 설명용 막대 높이 비율(실제 값 아님)
const POP_SIM_STEPS = [
  { n: 1, id: "NORMAL",    title: "정상 상태",     open: false, flow: false, pressure: 0.3 },
  { n: 2, id: "RISING",    title: "압력 상승",     open: false, flow: false, pressure: 0.6 },
  { n: 3, id: "SET_REACH", title: "설정압력 도달", open: false, flow: false, pressure: POP_SIM_SET_LEVEL },
  { n: 4, id: "POPPING",   title: "밸브 팝핑",     open: true,  flow: false, pressure: POP_SIM_SET_LEVEL },
  { n: 5, id: "DISCHARGE", title: "유체 방출",     open: true,  flow: true,  pressure: POP_SIM_SET_LEVEL },
  { n: 6, id: "SUPPRESS",  title: "압력 상승 억제", open: true,  flow: true,  pressure: POP_SIM_SET_LEVEL },
];
function popSimClamp(n) {
  const v = Number.isFinite(n) ? Math.trunc(n) : 1;
  return Math.min(POP_SIM_TOTAL, Math.max(1, v));
}
function popSimNext(n) { return popSimClamp(n + 1); }
function popSimPrev(n) { return popSimClamp(n - 1); }
function popSimRestart() { return 1; }
function popSimStepInfo(n) { return POP_SIM_STEPS[popSimClamp(n) - 1]; }
// 밸브 종류 → ValveIllustration kind. Engine이 지원하는 3종만 매핑한다.
// 판정값(verdict 등)은 사용하지 않는다 — deviceType/valveType만.
function popSimKind(snap) {
  if (snap && snap.deviceType === "ruptureDisk") return "RUPTURE";
  return (snap && snap.inputs && snap.inputs.valveType === "BELLOWS") ? "BELLOWS" : "SPRING";
}
