//  ENGINE (pure, stateless — UI 접근 금지)
// ════════════════════════════════════════════════════════════════
// ENGINE_VERSION 1.2.0 — API520-SI-001 / API520-PRESSURE-001 수정
//   [BUG FIX] SI 단위 변환 상수(13160) 누락 — US 상수(520) 기반 C를
//   SI 입력(kg/h, bar, K)에 그대로 곱해 areaCm2가 실제값의 약 7600배로
//   산출되던 결함. API 520 공식 예제(fluids lib 검증, W=24270kg/h,
//   T=348K, MW=51, k=1.11, P1=670kPa → 3699.046mm²)로 역산 검증,
//   13160 상수(W kg/h, P1 kPa 기준) 적용 시 오차 0.09% 이내로 확인.
//   [BUG FIX] P1을 설정압력(barg)에서 relieving pressure(절대압)로
//   변환하는 과정이 누락 — Pset*(1+OP/100)+대기압 미적용.
// ENGINE_VERSION 1.3.0 — COMPRESSIBILITY-001
//   Z(압축계수)를 하드코딩(1.0)에서 Calculation Input으로 승격.
//   Asset이 아니라 Case 소유 — 유체·운전조건에 따라 케이스마다 달라짐.
//   기본값 1.00은 UI가 명시적으로 대입하며 Engine은 몰래 채우지 않는다.
//   validateInputs가 Z 누락을 거부하므로 이 필드는 계약 변경이다.
const ENGINE_VERSION = "1.3.0";

const API_CONST = {
  C_BASE:              520,
  SI_AREA_CONST:        13160,   // API 520 SI eq.: A[mm²]=13160·W[kg/h]/(C·Kd·P1[kPa]·Kb)·√(TZ/M)
  ATM_PRESSURE_BAR:     1.01325, // 표준 대기압 (relieving pressure 절대압 환산용)
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
  // OP(overpressure %)는 Equipment(Asset) 소유 필드 — Case가 임의 기본값을
  // 대입하지 않는다. 없으면 계산 자체를 막는다 (PRESSURE-001 계약).
  // Z(압축계수)는 반대로 Calculation Input(Case 소유) — 기본값 1.00은
  // UI가 명시적으로 대입하며, Engine은 몰래 채우지 않는다 (COMPRESSIBILITY-001).
  const fields = ["W","P1","P2","T","M","k","Kd","Kb","mawp","OP","Z"];
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
  if (inp.OP <  0) return { ok: false, field:"OP", reason:"must_be_non_negative" };
  if (inp.Z  <= 0) return { ok: false, field:"Z",  reason:"must_be_positive" };
  return { ok: true };
}

// Engine — 입력만 받고 출력만 반환. 외부 state 접근 금지.
function api520Engine(inp, deviceType) {
  const valid = validateInputs(inp);
  if (!valid.ok) return { valid: false, error: valid };

  const { W, P1, P2, T, M, k, Kd, Kb, mawp, OP, Z } = Object.fromEntries(
    Object.entries(inp).map(([key, v]) => [key, Number(v)])
  );

  // ── COMPRESSIBILITY-001: Z는 Asset이 아니라 Calculation Input ──
  // 설비 속성이 아니라 유체·운전조건에 따라 케이스마다 달라지는 계산
  // 조건이므로 Equipment/DischargeSystem이 아닌 Case 입력값으로 취급한다.
  // 기본값 1.0(이상기체 가정)은 UI에서 명시적으로 노출하며, Engine은
  // 몰래 대입하지 않는다 — validateInputs에서 누락 시 계산을 막는다.

  // ── PRESSURE-001: relieving pressure(절대압) 산정 ──────────────
  // P1(입력) = 설정압력(barg, Equipment.setPressure). 이것 자체는
  // relieving pressure가 아니다. API 520 정의대로 overpressure(%)와
  // 대기압을 더해 절대압으로 환산한 뒤에만 sizing 식에 사용한다.
  const Pset  = P1;
  const P1abs = Pset * (1 + OP / 100) + API_CONST.ATM_PRESSURE_BAR; // bara
  const P1_kPa = P1abs * 100;

  const C     = API_CONST.C_BASE * Math.sqrt(k * Math.pow(2/(k+1), (k+1)/(k-1)));
  const KdEff = deviceType === "ruptureDisk" ? Kd * API_CONST.RD_KD_FACTOR : Kd;

  // ── API520-SI-001: SI 단위 필수 변환상수(13160) 적용 ───────────
  // A[mm²] = 13160·W[kg/h] / (C·Kd·P1[kPa]·Kb) · √(T·Z/M)
  const A_mm2   = (API_CONST.SI_AREA_CONST * W / (C * KdEff * P1_kPa * Kb)) * Math.sqrt((T * Z) / M);
  const areaCm2 = A_mm2 / 100;

  const selected = API526_ORIFICES.find(o => o.area >= areaCm2)
    ?? { letter:"P+", area: areaCm2, nonStandard: true };

  const margin            = selected.area / areaCm2;
  // 배압비(Kb 산정 기준)는 API 520 Fig.30/31 관례대로 게이지압 기준 유지 —
  // 절대압 환산과는 별개 개념 (relieving pressure 산정과 혼동 금지).
  const backPressureRatio = P2 / Pset;
  const criticalPressRatio= Math.pow(2/(k+1), k/(k-1));

  const checklist = {
    capacityOK:     selected.area >= areaCm2,
    backPressureOK: backPressureRatio < API_CONST.BACKPRESSURE_SPRING,
    mawpOK:         Pset <= mawp,
    kdOK:           Kd >= API_CONST.KD_MIN,
    marginOK:       margin >= API_CONST.MARGIN_MIN,
  };

  // ── Calculation Trace — 감사/Report Evidence 전용, UI 표시용 아님 ──
  const trace = [
    { step: "COMPRESSIBILITY_Z", value: Z, unit: "",
      formula: Z === 1.0 ? "User Input (default 1.00)" : "User Input", inputs: { Z } },
    { step: "SET_PRESSURE",     value: Pset,   unit: "barg", formula: "Equipment.setPressure" },
    { step: "RELIEVING_PRESSURE", value: P1abs, unit: "bara",
      formula: "P1abs = Pset×(1+OP/100) + Patm", inputs: { Pset, OP, Patm: API_CONST.ATM_PRESSURE_BAR } },
    { step: "C_COEFFICIENT",    value: C,      unit: "",     formula: "C = 520·√(k·(2/(k+1))^((k+1)/(k-1)))", inputs: { k } },
    { step: "MASS_FLUX_AREA",   value: A_mm2,  unit: "mm²",
      formula: "A = 13160·W/(C·Kd·P1[kPa]·Kb)·√(TZ/M)", inputs: { W, KdEff, P1_kPa, Kb, T, Z, M } },
    { step: "REQUIRED_AREA",    value: areaCm2, unit: "cm²", formula: "areaCm2 = A_mm2 / 100" },
    { step: "ORIFICE_SELECTION",value: selected.letter, unit: "", formula: "next API526 orifice ≥ areaCm2", inputs: { areaCm2, selectedArea: selected.area } },
  ];

  const stepData = {
    fluid:     { M, T, k, Z, criticalPressRatio },
    cCoeff:    { C, k },
    pressure:  { Pset, OP, P1abs, atm: API_CONST.ATM_PRESSURE_BAR },
    orifice:   { areaCm2, W, P1abs, KdEff, Kb, isRD: deviceType === "ruptureDisk" },
    selection: { selected, areaCm2, margin },
    backpress: { ratio: backPressureRatio, limitSpring: API_CONST.BACKPRESSURE_SPRING, limitPilot: API_CONST.BACKPRESSURE_PILOT },
  };

  return { valid: true, areaCm2, selected, margin, C, P1abs, backPressureRatio, checklist, stepData, trace };
}

// ════════════════════════════════════════════════════════════════
