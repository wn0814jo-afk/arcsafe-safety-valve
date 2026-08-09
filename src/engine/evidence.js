//  EVIDENCE LAYER — Engine stepData → 근거 텍스트
// ════════════════════════════════════════════════════════════════
function buildEvidence(sd) {
  if (!sd) return [];
  const { fluid, cCoeff, pressure, orifice, selection, backpress, accumulation } = sd;
  return [
    {
      id:1, title:"유체 물성 확인",
      formula:"M, T, k, Z 입력값 확인",
      result:`M = ${fluid.M} g/mol | T = ${fluid.T} K | k = ${fluid.k} | Z = ${fluid.Z}`,
      detail:`비열비 k=${fluid.k} 기준 임계압력비 = (2/(k+1))^(k/(k-1)) = ${fluid.criticalPressRatio.toFixed(4)}. 압축계수 Z=${fluid.Z}${fluid.Z===1 ? " (기본값, 이상기체 가정)" : " (사용자 입력값)"} — Case 소유 계산 조건, Asset 속성 아님.`,
      ok:true,
    },
    {
      id:2, title:"Relieving Pressure(절대압) 산정",
      formula:"P1(abs) = Pset × (1 + OP/100) + P(atm)",
      result:`P1abs = ${pressure.P1abs.toFixed(4)} bara`,
      detail:`설정압 Pset=${pressure.Pset} barg, Overpressure OP=${pressure.OP}% (설비대장 값), 대기압=${pressure.atm} bar. Case 입력값이 아니라 Asset(Equipment) 소유 필드에서 산정.`,
      ok: pressure.P1abs > 0,
    },
    {
      id:3, title:"C 계수 계산 (API 520)",
      formula:`C = ${API_CONST.C_BASE} × √( k × (2/(k+1))^((k+1)/(k-1)) )`,
      result:`C = ${cCoeff.C.toFixed(2)}`,
      detail:`k=${cCoeff.k}일 때 API 520 기준 C계수 = ${cCoeff.C.toFixed(2)}. 이 값이 클수록 동일 면적에서 더 많은 유량 방출 가능.`,
      ok:true,
    },
    {
      id:4, title:"필요 오리피스 면적 (SI 단위)",
      formula:"A[mm²] = 13160 × W / (C × Kd_eff × P1abs[kPa] × Kb) × √(T×Z / M)",
      result:`A_required = ${orifice.areaCm2.toFixed(4)} cm²`,
      detail:`W=${orifice.W} kg/h, P1abs=${orifice.P1abs.toFixed(3)} bara, Kd_eff=${orifice.KdEff.toFixed(3)}, Kb=${orifice.Kb}${orifice.isRD ? ` (럽처디스크 보정계수 ×${API_CONST.RD_KD_FACTOR} 적용)` : ""}`,
      ok: orifice.areaCm2 > 0,
    },
    {
      id:5, title:"API 526 표준 오리피스 선정",
      formula:"A_selected ≥ A_required",
      result:`${selection.selected.letter} 오리피스 | ${selection.selected.area} cm² ≥ ${selection.areaCm2.toFixed(4)} cm²${selection.selected.nonStandard ? " ⚠ 비표준" : ""}`,
      detail:`여유율 = ${selection.margin.toFixed(3)}×${selection.selected.nonStandard ? " — 표준 규격 초과. 특수 제작 또는 병렬 설치 검토 필요." : ""}`,
      ok: !selection.selected.nonStandard && selection.selected.area >= selection.areaCm2,
    },
    {
      id:6, title:"Back Pressure 검증",
      formula:`P2/Pset < ${(backpress.allowableRatio*100).toFixed(0)}% (${backpress.valveType==="BELLOWS"?"벨로우즈형(밸런스형)":"스프링식"} 기준 — KOSHA GUIDE D-18-2020 §7.2(4))`,
      result:`P2/Pset = ${(backpress.ratio*100).toFixed(1)}% → ${backpress.ratio < backpress.allowableRatio ? "적합 ✓" : "초과 ✗ — 조치 필요"}`,
      detail:`선택된 밸브 형식: ${backpress.valveType==="BELLOWS"?"벨로우즈형(밸런스형)":"스프링식"}. 배압이 이 한도를 초과하면 밸브가 제대로 재폐되지 않거나 용량이 저하될 수 있음. 근거: ${backpress.source||"KOSHA GUIDE D-18-2020 §7.2(4)"}`,
      ok: backpress.ratio < backpress.allowableRatio,
    },
    {
      id:7, title:"축적압력 허용성 검증 (Overpressure Guardrail)",
      formula:accumulation
        ? `1 + OP/100 ≤ ${(accumulation.allowableRatio*100).toFixed(0)}% (${accumulation.fireScenario?"화재 보호 목적":`비화재, 밸브 ${accumulation.valveCount>=2?"2개 이상":"1개"} 설치`} 기준 — KOSHA GUIDE D-18-2020 §4.4)`
        : "",
      result:accumulation
        ? `실제 축적압력 = ${(accumulation.actualRatio*100).toFixed(0)}% → ${accumulation.ok ? "GO ✓" : "NO-GO ✗ — 조치 필요"}`
        : "",
      detail:accumulation
        ? `sizing(Relieving Pressure) 산정에 쓰인 것과 같은 Overpressure(OP=${accumulation.OP}%)를 여기서는 다른 질문에 사용 — "이 시나리오(밸브개수·화재여부)에서 허용되는 축적압력 상한을 넘는가?"를 검증한다. sizing 결과(오리피스/필요면적)에는 영향 없음. 초과 시 자동 보정하지 않고 NO-GO로 표시. 근거: ${accumulation.source}`
        : "",
      ok: accumulation ? accumulation.ok : true,
    },
  ];
}

// ════════════════════════════════════════════════════════════════
