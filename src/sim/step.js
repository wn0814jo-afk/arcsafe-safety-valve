//  SIMULATION (시간 전용 — 계산 없음)
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
