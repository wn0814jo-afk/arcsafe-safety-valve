//  BACKPRESSURE ENGINE (API 521 minimal model, pure, stateless)
//  Kb는 입력값이 아니라 배출 시스템 설계의 결과값이다.
// ════════════════════════════════════════════════════════════════
const BP_CONST = {
  G:              9.80665,   // m/s²
  EXIT_K:         0.5,       // exit loss coefficient
  CHOKED_RATIO:   0.528,     // 임계압력비 근사 (k≈1.3 평균) — 실제는 fluid k로 재계산
  DARCY_F_DEFAULT:0.02,      // 기본 마찰계수 (turbulent, commercial steel 근사)
};

// 배관 형상 입력 — InputView에서 사용자가 결정하는 "물리적 사실"
// (계산값이 아니라 실제 배관 도면 기준 입력)
function validateGeometry(geo) {
  const fields = ["L", "D", "fittingsK", "headerPressure"];
  for (const f of fields) {
    const v = Number(geo?.[f]);
    if (isNaN(v) || !isFinite(v)) return { ok:false, field:f, reason:"not_a_number" };
  }
  if (geo.D <= 0) return { ok:false, field:"D", reason:"must_be_positive" };
  if (geo.L <  0) return { ok:false, field:"L", reason:"must_be_non_negative" };
  if (geo.fittingsK < 0) return { ok:false, field:"fittingsK", reason:"must_be_non_negative" };
  if (geo.headerPressure < 0) return { ok:false, field:"headerPressure", reason:"must_be_non_negative" };
  return { ok:true };
}

// 유체 밀도 근사 (ideal gas, P[bar]→Pa, T[K], M[g/mol])
// rho = P*M / (R*T) — R = 8314 J/(kmol·K)
function gasDensity(P_bar, T_K, M_gmol) {
  const P_Pa = P_bar * 1e5;
  const R = 8314; // J/(kmol·K), M은 g/mol = kg/kmol 이므로 그대로 사용
  return (P_Pa * M_gmol) / (R * T_K); // kg/m³
}

// ── computeBackpressure ───────────────────────────────────────
// 입력:
//   W           방출량 kg/h
//   P1          설정압 barg (set pressure)
//   T           방출 온도 K
//   M           분자량 g/mol
//   k           비열비
//   geometry: { L, D, fittingsK, headerPressure }
//     L              배관 길이 m
//     D              배관 내경 m
//     fittingsK      fittings K-factor 합산 (elbow, tee, reducer 등)
//     headerPressure flare/header 정상 압력 barg (superimposed backpressure)
//
// 출력: { p_static, p_dynamic, p_total, kb, velocity, choked, status, basis }
function computeBackpressure(inp, geometry) {
  const geoValid = validateGeometry(geometry);
  if (!geoValid.ok) {
    return { valid:false, error: geoValid };
  }

  const W  = Number(inp.W);   // kg/h
  const P1 = Number(inp.P1);  // barg (set pressure)
  const T  = Number(inp.T);   // K
  const M  = Number(inp.M);   // g/mol
  const k  = Number(inp.k);

  if (!P1 || P1 <= 0) {
    return { valid:false, error:{ field:"P1", reason:"must_be_positive" } };
  }

  const { L, D, fittingsK, headerPressure } = geometry;

  // ── 1. 밀도 (방출 조건 기준, P1 절대압 근사) ──
  // UNIT-PRESSURE-002: 대기압 상수는 api520.js API_CONST.ATM_PRESSURE_BAR
  // 단일 출처 — 이 파일에서 값을 별도로 하드코딩하지 않는다. build.py
  // BUILD_ORDER상 api520.js가 이 파일보다 먼저 로드되어 전역에서 참조 가능.
  // 주의: 여기서는 OP(overpressure)를 더하지 않는다 — api520.js의 relieving
  // pressure(P1abs, sizing용)와는 다른 값이다. 배관 유속/밀도 계산은 밸브가
  // 막 열리는 시점(overpressure 이전) 기준 근사이므로 의도적으로 별개.
  const P1_abs = P1 + API_CONST.ATM_PRESSURE_BAR; // barg → bara 근사 (OP 미포함, 의도적)
  const rho = gasDensity(P1_abs, T, M); // kg/m³

  // ── 2. 유속 ──
  const W_kgs = W / 3600;               // kg/h → kg/s (이 파일 유일한 변환 지점)
  const A = Math.PI * (D * D) / 4;      // m²
  const v = A > 0 ? W_kgs / (rho * A) : 0; // m/s

  // ── 3. Choked flow 판정 ──
  // 임계압력비 = (2/(k+1))^(k/(k-1))
  const criticalRatio = Math.pow(2/(k+1), k/(k-1));
  const pressureRatio = headerPressure > 0 ? (headerPressure + API_CONST.ATM_PRESSURE_BAR) / P1_abs : 0;
  const choked = pressureRatio <= criticalRatio;

  // ── 4. 동적 배압 (Darcy-Weisbach + fittings + exit) ──
  const dynHead = rho * v * v / 2; // Pa 단위 동압
  const dP_pipe   = D > 0 ? BP_CONST.DARCY_F_DEFAULT * (L / D) * dynHead : 0;
  const dP_fit    = fittingsK * dynHead;
  const dP_exit   = BP_CONST.EXIT_K * dynHead;
  const p_dynamic_Pa = dP_pipe + dP_fit + dP_exit;
  const p_dynamic_bar = p_dynamic_Pa / 1e5;

  // ── 5. 정적 배압 (header/flare 압력) ──
  const p_static = headerPressure;

  // ── 6. 합산 + Kb ──
  const p_total = p_static + p_dynamic_bar;
  const kb = P1 > 0 ? Math.max(0, 1 - (p_total / P1) * 0.5) : 1.0;
  // 참고: 정밀 Kb 곡선은 API 520 Fig.31 실측 데이터 기반이며
  // 위 식은 P_total/P_set 비율에 대한 1차 근사. 정밀 설계는 제조사 곡선 사용 권장.

  const ratio = p_total / P1;
  let status, basis;
  if (ratio < 0.10) {
    status = "calculated";
    basis = `P_total/P1 = ${(ratio*100).toFixed(1)}% — 배압 영향 미미. 표준 스프링식 적용 가능.`;
  } else if (ratio < 0.30) {
    status = "calculated";
    basis = `P_total/P1 = ${(ratio*100).toFixed(1)}% — 동적+정적 배압 합산 결과. Kb 보정 적용됨 (Pipe ΔP=${(dP_pipe/1e5).toFixed(3)}bar, Fittings ΔP=${(dP_fit/1e5).toFixed(3)}bar, Exit ΔP=${(dP_exit/1e5).toFixed(3)}bar).`;
  } else {
    status = "out_of_range";
    basis = `P_total/P1 = ${(ratio*100).toFixed(1)}% — 스프링식 적용 범위(30%) 초과. 파일럿식 전환 또는 배관 재설계 검토 필요.`;
  }
  if (choked) {
    basis += ` [Choked flow 감지: 임계압력비 ${(criticalRatio*100).toFixed(1)}% 이하 — 음속 유동 구간]`;
  }

  return {
    valid: true,
    p_static:  Math.round(p_static  * 1000) / 1000,
    p_dynamic: Math.round(p_dynamic_bar * 1000) / 1000,
    p_total:   Math.round(p_total   * 1000) / 1000,
    kb:        Math.round(kb * 1000) / 1000,
    velocity:  Math.round(v * 100) / 100,
    choked,
    criticalRatio: Math.round(criticalRatio * 1000) / 1000,
    breakdown: {
      dP_pipe_bar:  Math.round(dP_pipe/1e5 * 1000) / 1000,
      dP_fit_bar:   Math.round(dP_fit/1e5  * 1000) / 1000,
      dP_exit_bar:  Math.round(dP_exit/1e5 * 1000) / 1000,
      rho_kgm3:     Math.round(rho * 100) / 100,
    },
    status,
    basis,
  };
}
