//  ENGINE (pure, stateless — UI 접근 금지)
// ════════════════════════════════════════════════════════════════
const ENGINE_VERSION = "1.1.0"; // API 520 Gas + Liquid 계산 지원

const API_CONST = {
  C_BASE:              520,
  BACKPRESSURE_SPRING: 0.10,
  BACKPRESSURE_PILOT:  0.30,
  RD_KD_FACTOR:        0.9,
  KD_MIN:              0.9,
  MARGIN_MIN:          1.0,
  SIM_MAWP_FACTOR:     1.12,
  SIM_SPEED_NORMAL:    0.04,
  SIM_SPEED_RELIEF:    0.08,
  HISTORY_SIZE:        90,
};

const API526_ORIFICES = [
  { letter:"D", area:0.71 },{ letter:"E", area:1.27 },
  { letter:"F", area:1.98 },{ letter:"G", area:3.24 },
  { letter:"H", area:5.07 },{ letter:"J", area:8.30 },
  { letter:"K", area:11.05},{ letter:"L", area:15.32},
  { letter:"M", area:20.27},{ letter:"N", area:26.0 },
  { letter:"P", area:42.48},
];

function validateInputs(inp) {
  const fields = ["W","P1","P2","T","M","k","Kd","Kb","mawp"];
  for (const f of fields) {
    const v = Number(inp[f]);
    if (isNaN(v) || !isFinite(v)) return { ok: false, field: f, reason: "not_a_number" };
  }
  if (inp.P1 <= 0) return { ok: false, field:"P1", reason:"must_be_positive" };
  if (inp.T  <= 0) return { ok: false, field:"T",  reason:"must_be_positive" };
  if (inp.M  <= 0) return { ok: false, field:"M",  reason:"must_be_positive" };
  if (inp.k  <= 1) return { ok: false, field:"k",  reason:"must_be_gt_1" };
  if (inp.Kd <= 0) return { ok: false, field:"Kd", reason:"must_be_positive" };
  if (inp.Kb <= 0) return { ok: false, field:"Kb", reason:"must_be_positive" };
  return { ok: true };
}

// Engine — 입력만 받고 출력만 반환. 외부 state 접근 금지.
function api520Engine(inp, deviceType) {
  const valid = validateInputs(inp);
  if (!valid.ok) return { valid: false, error: valid };

  const { W, P1, P2, T, M, k, Kd, Kb, mawp } = Object.fromEntries(
    Object.entries(inp).map(([key, v]) => [key, Number(v)])
  );

  const Z     = 1.0;
  const C     = API_CONST.C_BASE * Math.sqrt(k * Math.pow(2/(k+1), (k+1)/(k-1)));
  const KdEff = deviceType === "ruptureDisk" ? Kd * API_CONST.RD_KD_FACTOR : Kd;
  const A_m2  = (W / (C * KdEff * Kb)) * Math.sqrt((T * Z) / (M * P1 * P1));
  const areaCm2 = A_m2 * 1e4;

  const selected = API526_ORIFICES.find(o => o.area >= areaCm2)
    ?? { letter:"P+", area: areaCm2, nonStandard: true };

  const margin            = selected.area / areaCm2;
  const backPressureRatio = P2 / P1;
  const criticalPressRatio= Math.pow(2/(k+1), k/(k-1));

  const checklist = {
    capacityOK:     selected.area >= areaCm2,
    backPressureOK: backPressureRatio < API_CONST.BACKPRESSURE_SPRING,
    mawpOK:         P1 <= mawp,
    kdOK:           Kd >= API_CONST.KD_MIN,
    marginOK:       margin >= API_CONST.MARGIN_MIN,
  };

  const stepData = {
    fluid:     { M, T, k, criticalPressRatio },
    cCoeff:    { C, k },
    orifice:   { areaCm2, W, P1, KdEff, Kb, isRD: deviceType === "ruptureDisk" },
    selection: { selected, areaCm2, margin },
    backpress: { ratio: backPressureRatio, limitSpring: API_CONST.BACKPRESSURE_SPRING, limitPilot: API_CONST.BACKPRESSURE_PILOT },
  };

  return { valid: true, areaCm2, selected, margin, C, backPressureRatio, checklist, stepData };
}

// ════════════════════════════════════════════════════════════════
