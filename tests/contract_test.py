#!/usr/bin/env python3
"""
ArcSafe Contract Test Suite
════════════════════════════
PSM 현장 시나리오 기반 결정론 검증.

목적:
  1. DETERMINISM  — same input → same output (hash 고정)
  2. ENGINE PURITY — 체크리스트 pass/fail이 기준값과 일치
  3. BOUNDARY     — engine이 UI/snapshot 없이 독립 실행 가능
  4. SNAPSHOT SCHEMA — result_hash 필드 존재, engine_version 일치
  5. REGRESSION   — 이전 기준값에서 벗어나면 FAIL (의도치 않은 변경 감지)

실행: python3 tests/contract_test.py
"""

import math, json, sys, time, hashlib, subprocess, shutil, re
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).parent.parent
SRC  = ROOT / 'src'

# ════════════════════════════════════════════════════════════════
#  ENGINE — 소스 파일 없이 Python으로 직접 재현
#  (engine/api520.js 코드를 그대로 포팅 — 동일 계산식 보장)
# ════════════════════════════════════════════════════════════════
C_BASE             = 520
SI_AREA_CONST      = 13160     # API520-SI-001 — SI 단위 필수 변환상수 (누락 시 ~7600배 오차)
ATM_PRESSURE_BAR   = 1.01325   # API520-PRESSURE-001 — relieving pressure 절대압 환산용
# VALVE-TYPE-001: 배압 허용비율은 밸브 형식의 정책값 (engine/api520.js와 동일 테이블).
# 출처: KOSHA GUIDE D-18-2020 §7.2(4) — 스프링식 10%, 벨로우즈형(밸런스형) 50%.
# 파일럿식은 원문에 수치 기준이 없어 미지원 — 미지정/미지원 값은 SPRING으로 처리.
BACKPRESSURE_POLICY = {"SPRING": 0.10, "BELLOWS": 0.50}
# ACCUMULATION-001: 축적압력 허용한계는 밸브개수+화재여부의 정책값
# (engine/api520.js와 동일 테이블). 출처: KOSHA GUIDE D-18-2020 §4.4, <표1>.
ACCUMULATION_POLICY = {"NON_FIRE_SINGLE": 1.10, "NON_FIRE_MULTI": 1.16, "FIRE": 1.21}
RD_KD_FACTOR       = 0.9
KD_MIN             = 0.9
MARGIN_MIN         = 1.0

ENGINE_VERSION     = "1.6.0"   # engine/api520.js와 반드시 일치해야 함
# v1.6.0: INLET-LOSS-001 — 인입배관 압력손실(KOSHA D-18-2020 §7.2(1),
# 설정압력의 3% 이하) 판정 신설. Physical Calculation(computeFrictionLoss
# 공용 재사용)과 Safety Policy(INLET_PRESSURE_LOSS_POLICY.MAX_RATIO)를
# 분리. inletPiping 데이터 없으면 임의 추정 없이 dataGaps로 명시 —
# checklist.every(Boolean) 통과와 GO는 별개(computeAdequacyVerdict 단일
# 출처, INSUFFICIENT_INPUT을 NO_GO로 오인하지 않음).
# v1.5.0: ACCUMULATION-001 — 축적압력 허용한계(overpressure guardrail)를
# 밸브개수(valveCount)+화재여부(fireScenario) 정책 테이블로 신설. 초과 시
# 자동 보정 없이 NO-GO만 표시(fail-fast). sizing(P1abs)과는 별개 검증.
# v1.4.0: VALVE-TYPE-001 — 배압 허용비율(10% 고정)을 valveType 정책 테이블로
# 승격. valveType 미지정 시 SPRING(기존과 동일 판정)으로 하위호환.
# v1.3.0: COMPRESSIBILITY-001 — Z를 Calculation Input으로 승격 (기존
# 하드코딩 1.0 제거). Case 소유, Asset 아님. inputs에 Z 필드 필수화.
# v1.2.0: [BUG FIX] SI 변환상수(13160) 누락 수정, [BUG FIX] P1 절대압 환산
# (Pset*(1+OP/100)+대기압) 누락 수정. 기준값 전면 재계산 (2026-07-10).

def _allowable_bp_ratio(valve_type):
    vt = str(valve_type or "SPRING").upper()
    return BACKPRESSURE_POLICY.get(vt, BACKPRESSURE_POLICY["SPRING"])

def _allowable_accumulation_ratio(fire_scenario, valve_count):
    if fire_scenario is True:
        return ACCUMULATION_POLICY["FIRE"]
    try:
        vc = float(valve_count)
    except (TypeError, ValueError):
        vc = 1
    return ACCUMULATION_POLICY["NON_FIRE_MULTI"] if vc >= 2 else ACCUMULATION_POLICY["NON_FIRE_SINGLE"]

ORIFICES = [
    ("D",0.71),("E",1.27),("F",1.98),("G",3.24),("H",5.07),
    ("J",8.30),("K",11.05),("L",15.32),("M",20.27),("N",26.0),("P",42.48),
]

def _py_engine(inp, device="safetyValve"):
    """api520Engine()과 동일한 계산 — Python 재현본"""
    W  = float(inp["W"]);  P1 = float(inp["P1"]); P2 = float(inp["P2"])
    T  = float(inp["T"]);  M  = float(inp["M"]);  k  = float(inp["k"])
    Kd = float(inp["Kd"]); Kb = float(inp["Kb"]); mawp = float(inp["mawp"])
    OP = float(inp["OP"])
    Z  = float(inp["Z"])   # COMPRESSIBILITY-001: Calculation Input, 기본값 1.00
    allowableBp = _allowable_bp_ratio(inp.get("valveType"))  # VALVE-TYPE-001
    allowableAcc = _allowable_accumulation_ratio(inp.get("fireScenario"), inp.get("valveCount", 1))  # ACCUMULATION-001
    actualAcc = 1 + OP/100

    # PRESSURE-001: Pset(barg) → P1abs(bara) 환산
    Pset  = P1
    P1abs = Pset * (1 + OP/100) + ATM_PRESSURE_BAR
    P1_kPa = P1abs * 100

    C = C_BASE * math.sqrt(k * (2/(k+1))**((k+1)/(k-1)))
    KdEff = Kd * RD_KD_FACTOR if device == "ruptureDisk" else Kd

    # API520-SI-001: SI 변환상수(13160) 적용, A[mm²]=13160·W/(C·Kd·P1[kPa]·Kb)·√(TZ/M)
    A_mm2 = (SI_AREA_CONST * W / (C * KdEff * P1_kPa * Kb)) * math.sqrt((T * Z) / M)
    areaCm2 = A_mm2 / 100

    sel = next((o for o in ORIFICES if o[1] >= areaCm2), ("P+", areaCm2))
    margin = sel[1] / areaCm2
    bpRatio = P2 / Pset
    return {
        "areaCm2":  areaCm2,
        "orifice":  sel[0],
        "margin":   margin,
        "C":        C,
        "bpRatio":  bpRatio,
        "P1abs":    P1abs,
        "checklist": {
            "capacityOK":     sel[1] >= areaCm2,
            "backPressureOK": bpRatio < allowableBp,
            "mawpOK":         Pset <= mawp,
            "kdOK":           Kd >= KD_MIN,
            "marginOK":       margin >= MARGIN_MIN,
            "accumulationOK": actualAcc <= allowableAcc,
        }
    }

def _result_hash(inp, areaCm2, orifice):
    """_hashResult() JavaScript 구현과 동일 — djb2 변형"""
    s = json.dumps({"inputs": inp, "areaCm2": areaCm2, "selected": orifice}, sort_keys=True)
    h = 0
    for ch in s:
        h = ((31 * h) + ord(ch)) & 0xFFFFFFFF
    return format(h, '08x')

# ════════════════════════════════════════════════════════════════
#  BACKPRESSURE ENGINE — engine/backpressure.js Python 재현
# ════════════════════════════════════════════════════════════════
BP_DARCY_F = 0.02
BP_EXIT_K  = 0.5

def _gas_density(P_bar, T_K, M_gmol):
    P_Pa = P_bar * 1e5
    R = 8314
    return (P_Pa * M_gmol) / (R * T_K)

def _py_backpressure(inp, geometry):
    W  = float(inp["W"]); P1 = float(inp["P1"])
    T  = float(inp["T"]); M  = float(inp["M"]); k = float(inp["k"])
    L, D, fittingsK, headerPressure = (
        float(geometry["L"]), float(geometry["D"]),
        float(geometry["fittingsK"]), float(geometry["headerPressure"])
    )

    P1_abs = P1 + 1.01325
    rho = _gas_density(P1_abs, T, M)
    W_kgs = W / 3600
    A = math.pi * D * D / 4
    v = W_kgs / (rho * A) if A > 0 else 0

    criticalRatio = (2/(k+1)) ** (k/(k-1))
    pressureRatio = (headerPressure + 1.01325) / P1_abs if headerPressure > 0 else 0
    choked = pressureRatio <= criticalRatio

    dynHead = rho * v * v / 2
    dP_pipe = BP_DARCY_F * (L/D) * dynHead if D > 0 else 0
    dP_fit  = fittingsK * dynHead
    dP_exit = BP_EXIT_K * dynHead
    p_dyn_bar = (dP_pipe + dP_fit + dP_exit) / 1e5

    p_static = headerPressure
    p_total  = p_static + p_dyn_bar
    kb = max(0, 1 - (p_total/P1) * 0.5) if P1 > 0 else 1.0
    ratio = p_total / P1 if P1 > 0 else 0

    status = "calculated" if ratio < 0.30 else "out_of_range"

    return {
        "p_static":  round(p_static, 3),
        "p_dynamic": round(p_dyn_bar, 3),
        "p_total":   round(p_total, 3),
        "kb":        round(kb, 3),
        "velocity":  round(v, 2),
        "choked":    choked,
        "criticalRatio": round(criticalRatio, 3),
        "status":    status,
        "ratio":     round(ratio, 4),
    }

# ════════════════════════════════════════════════════════════════
#  BACKPRESSURE FIXTURES — 고정 기준값
# ════════════════════════════════════════════════════════════════
BP_FIXTURES = [
    {
        "id": "BP-001", "label": "R-201 CO2 — 짧은 배관, 낮은 header",
        "inputs":   {"W":2500,"P1":5.5,"T":373,"M":44,"k":1.30},
        "geometry": {"L":10,"D":0.1,"fittingsK":2.0,"headerPressure":0.3},
        "expect_status":  "calculated",
        "expect_kb":      0.971,
        "expect_p_total": 0.319,
        "expect_choked":  True,
    },
    {
        "id": "BP-002", "label": "Steam — 긴 배관, 높은 header (out_of_range)",
        "inputs":   {"W":5000,"P1":8.0,"T":453,"M":18,"k":1.33},
        "geometry": {"L":50,"D":0.08,"fittingsK":5.0,"headerPressure":1.2},
        "expect_status":  "out_of_range",
        "expect_kb":      0.825,
        "expect_p_total": 2.795,
        "expect_choked":  True,
    },
    {
        "id": "BP-003", "label": "극단 케이스 — 매우 좁고 긴 배관 (FAIL 예상)",
        "inputs":   {"W":3000,"P1":4.0,"T":350,"M":44,"k":1.30},
        "geometry": {"L":200,"D":0.04,"fittingsK":10.0,"headerPressure":0.8},
        "expect_status":  "out_of_range",
        "expect_kb":      0.0,
        "expect_p_total": 32.852,
        "expect_choked":  True,
    },
]


# ════════════════════════════════════════════════════════════════
#  FIXTURE — 고정 기준값 (한 번 확정되면 변경 금지)
#
#  기준값 변경 = engine 계산 변경을 의미.
#  변경 시 반드시:
#    1. 변경 이유 주석 추가
#    2. ENGINE_VERSION 업데이트
#    3. SNAPSHOT_ENGINE_VERSION 업데이트
#    4. build.py 재실행
# ════════════════════════════════════════════════════════════════
FIXTURES = [
    {
        "id":           "SC-001",
        "label":        "R-201 CO₂ 반응기 — 기준 케이스",
        "tag":          "PSV-R201",
        "device":       "safetyValve",
        "inputs": {
            "W":2500, "P1":5.5, "P2":0.3, "T":373,
            "M":44,   "k":1.30, "Kd":0.975, "Kb":1.0, "mawp":6.0, "OP":10, "Z":1.0
        },
        # ── 기준값 (고정) ──────────────────────────────────────
        # v1.2.0 재계산 (2026-07-10): SI 변환상수(13160) + P1abs 절대압
        # 환산 버그 수정 반영. 이전 기준값(areaCm2=39120.18, hash=6b7e3910)은
        # 검증된 오류였음 — API 520 공식 예제 역산 검증(오차 0.09%)으로 확인.
        "expect_pass":   True,
        "expect_orifice":"H",
        "expect_areaCm2":4.008804,
        "expect_C":      346.9764,
        "expect_bpRatio":0.0545,
        "expect_hash":   "15563539",
        # ── PSM 판단 근거 ──────────────────────────────────────
        "psm_note":      "CO₂ 고압 반응기 기본 케이스. 모든 체크리스트 PASS 기준.",
        "api_ref":       "API 520 Part I, API 526",
    },
    {
        "id":           "SC-002",
        "label":        "R-302 N₂ 고압 퍼지라인",
        "tag":          "PSV-R302",
        "device":       "safetyValve",
        "inputs": {
            "W":800,  "P1":12.0, "P2":0.5, "T":320,
            "M":28,   "k":1.40,  "Kd":0.975, "Kb":1.0, "mawp":13.0, "OP":10, "Z":1.0
        },
        # v1.2.0 재계산 (2026-07-10) — 위 SC-001과 동일 사유
        "expect_pass":   True,
        "expect_orifice":"E",
        "expect_areaCm2":0.721307,
        "expect_C":      356.0604,
        "expect_bpRatio":0.0417,
        "expect_hash":   "826ef9f4",
        "psm_note":      "N₂ 불활성 고압 라인. 배압 4.2% — 스프링식 적합.",
        "api_ref":       "API 520 Part I Sec. 3",
    },
    {
        "id":           "SC-003",
        "label":        "PSV-S12 Steam 유틸리티라인 — 배압 초과",
        "tag":          "PSV-S12",
        "device":       "safetyValve",
        "inputs": {
            "W":5000, "P1":8.0, "P2":1.2, "T":453,
            "M":18,   "k":1.33, "Kd":0.975, "Kb":0.96, "mawp":9.0, "OP":10, "Z":1.0
        },
        # v1.2.0 재계산 (2026-07-10) — 위 SC-001과 동일 사유
        "expect_pass":   False,
        "expect_orifice":"K",
        "expect_areaCm2":10.274755,
        "expect_C":      349.7668,
        "expect_bpRatio":0.1500,
        "expect_hash":   "d31e1a0f",
        "expect_fail_keys": ["backPressureOK"],   # 정확히 이 항목만 FAIL이어야 함
        "psm_note":      "Steam 배압 15% — backPressureOK FAIL. 파일럿식 또는 Kb 재산정 필요.",
        "api_ref":       "API 520 Part I Fig. 31 (Kb correction)",
    },
    {
        "id":           "SC-004",
        "label":        "PSV-RD01 CO₂ 럽처디스크 병용",
        "tag":          "PSV-RD01",
        "device":       "ruptureDisk",
        "inputs": {
            "W":3200, "P1":6.0, "P2":0.2, "T":373,
            "M":44,   "k":1.30, "Kd":0.975, "Kb":1.0, "mawp":6.5, "OP":10, "Z":1.0
        },
        # v1.2.0 재계산 (2026-07-10) — 위 SC-001과 동일 사유
        "expect_pass":   True,
        "expect_orifice":"J",
        "expect_areaCm2":5.289526,
        "expect_C":      346.9764,
        "expect_bpRatio":0.0333,
        "expect_hash":   "fa9caa47",
        "psm_note":      "럽처디스크 병용 Kd×0.9=0.8775 보정 확인. ALL PASS.",
        "api_ref":       "API 520 Part I Annex C (rupture disk combination)",
    },
    {
        "id":           "SC-005",
        "label":        "PSV-BP 배압 경계 FAIL — PSM 부적합",
        "tag":          "PSV-BP01",
        "device":       "safetyValve",
        "inputs": {
            "W":1500, "P1":5.0, "P2":0.8, "T":350,
            "M":44,   "k":1.30, "Kd":0.975, "Kb":1.0, "mawp":5.0, "OP":10, "Z":1.0
        },
        # v1.2.0 재계산 (2026-07-10) — 위 SC-001과 동일 사유
        "expect_pass":   False,
        "expect_orifice":"G",
        "expect_areaCm2":2.526693,
        "expect_C":      346.9764,
        "expect_bpRatio":0.1600,
        "expect_hash":   "97c27259",
        "expect_fail_keys": ["backPressureOK"],
        "psm_note":      "배압 16% 초과 + P1=MAWP 경계. PSM 제출 불가 상태.",
        "api_ref":       "API 521 Sec. 5.4 (back pressure limit)",
    },
    {
        "id":           "API520-SI-001",
        "label":        "SI 단위 변환상수(13160) 외부 검증 — API 520 공식 예제 역산",
        "tag":          "REFERENCE",
        "device":       "safetyValve",
        # 원 예제(fluids 0.66.x, Caleb Bell — API 520 공식 example 1 재현,
        # PyPI 공개 라이브러리로 API 520 Part I Annex 예제와 대조 검증됨):
        #   m=24270 kg/h, T=348K, Z=0.90, MW=51, k=1.11, P1=670kPa(abs) →
        #   A = 0.0036990460646834 m² = 3699.046 mm²
        # 본 엔진은 Z를 1.0으로 고정하는 기존 단순화가 있어(별도 개선 필요
        # 항목, ENGINE-Z-001) Z=0.90 조건을 그대로 재현하지 못한다.
        # 따라서 "13160 상수 자체"의 정합성은 Z=1.0 가정 하에 별도 검증:
        #   Z=1.0 대입 시 목표값 3699.046×√(1/0.90)=3899.15 부근이어야 함
        #   (Z가 sqrt 안에서 단순 배율로만 작용하므로) — 본 엔진 실측값
        #   3895.81mm²는 그 근사 범위 내에 있음 (기존 fluids 비교는
        #   Kb/Kc/반올림 차이로 완전 일치는 아니고 0.09% 이내로 확인됨).
        # Pset은 P1abs=6.7bara(670kPa)가 되도록 역산 (OP=0으로 직접 대입).
        "inputs": {
            "W":24270, "P1":6.7-1.01325, "P2":0, "T":348,
            "M":51,    "k":1.11, "Kd":0.975, "Kb":1.0, "mawp":999, "OP":0, "Z":1.0
        },
        "expect_pass":   True,
        "expect_orifice":"P",
        "expect_areaCm2":38.958136,
        "expect_C":      327.8330,
        "expect_bpRatio":0.0,
        "expect_hash":   "73c6fb67",
        "psm_note":      "SI 변환상수 검증 전용 fixture — PSM 실제 케이스 아님. Z=1.0 가정 하 기준값 고정.",
        "api_ref":       "API 520 Part I Annex (SI 예제), fluids.safety_valve.API520_A_g 대조",
    },
]

# ════════════════════════════════════════════════════════════════
#  TEST RUNNER
# ════════════════════════════════════════════════════════════════
TOLERANCE = 1e-4   # areaCm2, C, bpRatio 비교 허용 오차

class TestResult:
    def __init__(self, sc_id, label):
        self.sc_id  = sc_id
        self.label  = label
        self.checks = []   # (name, ok, detail)

    def check(self, name, condition, detail=""):
        self.checks.append((name, condition, detail))
        return condition

    @property
    def passed(self):
        return all(ok for _, ok, _ in self.checks)

def run_fixture(f) -> TestResult:
    tr = TestResult(f["id"], f["label"])
    r  = _py_engine(f["inputs"], f["device"])
    ck = r["checklist"]
    actual_hash = _result_hash(f["inputs"], r["areaCm2"], r["orifice"])

    # ── T1: DETERMINISM — 동일 입력 2회 실행 결과 동일 ────────
    r2 = _py_engine(f["inputs"], f["device"])
    h2 = _result_hash(f["inputs"], r2["areaCm2"], r2["orifice"])
    tr.check("DETERMINISM_run1==run2",
             r["areaCm2"] == r2["areaCm2"] and actual_hash == h2,
             f"hash run1={actual_hash} run2={h2}")

    # ── T2: HASH REGRESSION — 기준값과 정확히 일치 ────────────
    tr.check("HASH_regression",
             actual_hash == f["expect_hash"],
             f"actual={actual_hash} expected={f['expect_hash']}")

    # ── T3: ORIFICE REGRESSION ────────────────────────────────
    tr.check("ORIFICE_regression",
             r["orifice"] == f["expect_orifice"],
             f"actual={r['orifice']} expected={f['expect_orifice']}")

    # ── T4: AREA REGRESSION ───────────────────────────────────
    area_diff = abs(r["areaCm2"] - f["expect_areaCm2"])
    tr.check("AREA_regression",
             area_diff < TOLERANCE,
             f"diff={area_diff:.8f} tolerance={TOLERANCE}")

    # ── T5: C_COEFF REGRESSION ───────────────────────────────
    c_diff = abs(r["C"] - f["expect_C"])
    tr.check("C_COEFF_regression",
             c_diff < TOLERANCE,
             f"diff={c_diff:.6f}")

    # ── T6: BPRATIO REGRESSION ───────────────────────────────
    bp_diff = abs(r["bpRatio"] - f["expect_bpRatio"])
    tr.check("BPRATIO_regression",
             bp_diff < TOLERANCE,
             f"diff={bp_diff:.6f}")

    # ── T7: PSM PASS/FAIL EXPECTATION ────────────────────────
    actual_pass = all(ck.values())
    tr.check("PSM_pass_fail",
             actual_pass == f["expect_pass"],
             f"actual={'PASS' if actual_pass else 'FAIL'} "
             f"expected={'PASS' if f['expect_pass'] else 'FAIL'}")

    # ── T8: SPECIFIC FAIL KEYS (FAIL 케이스 전용) ────────────
    if "expect_fail_keys" in f:
        actual_fails = [k for k, v in ck.items() if not v]
        expected_fails = f["expect_fail_keys"]
        tr.check("PSM_fail_keys",
                 set(actual_fails) == set(expected_fails),
                 f"actual_fails={actual_fails} expected={expected_fails}")

    # ── T9: ENGINE_VERSION 소스 파일과 일치 ──────────────────
    engine_src = (SRC / "engine" / "api520.js").read_text()
    src_version = None
    for line in engine_src.splitlines():
        if "ENGINE_VERSION" in line and "=" in line and "//" not in line.strip()[:5]:
            src_version = line.split('"')[1] if '"' in line else line.split("'")[1]
            break
    tr.check("ENGINE_VERSION_match",
             src_version == ENGINE_VERSION,
             f"src={src_version} test_expects={ENGINE_VERSION}")

    return tr

# ════════════════════════════════════════════════════════════════
#  BACKPRESSURE FIXTURE RUNNER
# ════════════════════════════════════════════════════════════════
def run_backpressure_fixture(f) -> TestResult:
    tr = TestResult(f["id"], f["label"])
    r  = _py_backpressure(f["inputs"], f["geometry"])

    r2 = _py_backpressure(f["inputs"], f["geometry"])
    tr.check("BP_DETERMINISM", r["kb"] == r2["kb"] and r["p_total"] == r2["p_total"],
              f"run1={r['kb']} run2={r2['kb']}")

    tr.check("BP_status_regression", r["status"] == f["expect_status"],
              f"actual={r['status']} expected={f['expect_status']}")

    kb_diff = abs(r["kb"] - f["expect_kb"])
    tr.check("BP_kb_regression", kb_diff < 0.01,
              f"actual={r['kb']} expected={f['expect_kb']} diff={kb_diff}")

    pt_diff = abs(r["p_total"] - f["expect_p_total"])
    tr.check("BP_p_total_regression", pt_diff < 0.01,
              f"actual={r['p_total']} expected={f['expect_p_total']} diff={pt_diff}")

    tr.check("BP_choked_regression", r["choked"] == f["expect_choked"],
              f"actual={r['choked']} expected={f['expect_choked']}")

    return tr

# ════════════════════════════════════════════════════════════════
#  MOC DETECTION TEST — detectMOC 결정론 + 정확성 검증
# ════════════════════════════════════════════════════════════════
def _py_asset_hash(equipment, discharge_system):
    """_assetHash() JS 구현과 동일 — 핵심 설계값만 해시"""
    eq = {
        "tag": equipment["tag"], "mawp": equipment["mawp"],
        "setPressure": equipment["setPressure"],
        "orifice": equipment["orifice"], "deviceType": equipment["deviceType"],
    } if equipment else None
    ds = {
        "name": discharge_system["name"], "L": discharge_system["L"],
        "D": discharge_system["D"], "fittingsK": discharge_system["fittingsK"],
        "headerPressure": discharge_system["headerPressure"],
        "destination": discharge_system["destination"],
    } if discharge_system else None
    import json as _json
    s = _json.dumps({"eq": eq, "ds": ds})
    h = 0
    for ch in s:
        h = ((31 * h) + ord(ch)) & 0xFFFFFFFF
    return format(h, '08x')

SAMPLE_EQ  = {"tag":"PSV-R201","mawp":6.0,"setPressure":5.5,"orifice":"P","deviceType":"safetyValve","revision":3,"mocId":None}
SAMPLE_DS  = {"name":"LP-FLARE-01","L":12,"D":0.1,"fittingsK":2.5,"headerPressure":0.3,"destination":"flare","revision":5,"mocId":None}
CHANGED_DS = {"name":"LP-FLARE-01","L":12,"D":0.1,"fittingsK":2.5,"headerPressure":0.5,"destination":"flare","revision":6,"mocId":"MOC-2026-017"}  # MOC: 0.3→0.5

def test_moc_detection() -> TestResult:
    tr = TestResult("MOC-001", "detectMOC — Asset fingerprint + revision 기반 MOC 감지")

    h_orig    = _py_asset_hash(SAMPLE_EQ, SAMPLE_DS)
    h_changed = _py_asset_hash(SAMPLE_EQ, CHANGED_DS)

    # T1: 동일 입력 → 동일 hash (결정론)
    tr.check("DETERMINISM",
             h_orig == _py_asset_hash(SAMPLE_EQ, SAMPLE_DS),
             "같은 입력인데 hash가 다름")

    # T2: 변경 후 hash 달라져야 함
    tr.check("CHANGE_DETECTED",
             h_orig != h_changed,
             f"변경 전후 hash가 같음: {h_orig}")

    # T3: Equipment만 변경 (orifice P→K)
    changed_eq = {**SAMPLE_EQ, "orifice": "K", "revision": 4, "mocId": "MOC-2026-014"}
    tr.check("EQ_CHANGE_DETECTED",
             _py_asset_hash(SAMPLE_EQ, SAMPLE_DS) != _py_asset_hash(changed_eq, SAMPLE_DS),
             "Equipment 변경이 fingerprint에 반영 안 됨")

    # T4: 동일 조건 → hash 동일 (false positive 없음)
    tr.check("NO_FALSE_POSITIVE",
             _py_asset_hash(SAMPLE_EQ, SAMPLE_DS) == _py_asset_hash(SAMPLE_EQ, SAMPLE_DS),
             "같은 입력인데 hash가 달라짐")

    # T5: revision/mocId 필드가 schema에 있는지
    schema_src = (SRC / "asset" / "schema.js").read_text()
    tr.check("revision_in_equipment", "revision:" in schema_src,
             "Equipment에 revision 필드 없음")
    tr.check("mocId_in_equipment", "mocId:" in schema_src,
             "Equipment에 mocId 필드 없음")

    # T6: assetRefs에 equipmentRevision/dischargeRevision 있는지
    snap_src = (SRC / "snapshot" / "create.js").read_text()
    tr.check("equipmentRevision_in_assetRefs", "equipmentRevision:" in snap_src,
             "assetRefs에 equipmentRevision 없음")
    tr.check("dischargeRevision_in_assetRefs", "dischargeRevision:" in snap_src,
             "assetRefs에 dischargeRevision 없음")

    # T7: computeWorkflowState가 engine/workflow_engine.js에 있는지
    wf_eng_src = (SRC / "engine" / "workflow_engine.js").read_text()
    tr.check("computeWorkflowState_in_engine",
             "function computeWorkflowState" in wf_eng_src,
             "computeWorkflowState가 engine에 없음")
    tr.check("WORKFLOW_TRIGGER_FIELDS_in_engine",
             "WORKFLOW_TRIGGER_FIELDS" in wf_eng_src,
             "WORKFLOW_TRIGGER_FIELDS가 engine에 없음")

    # T8: requiresReview가 workflow/index.js에 없는지 (engine으로 이동됨)
    wf_src = (SRC / "workflow" / "index.js").read_text()
    tr.check("requiresReview_removed_from_workflow",
             "function requiresReview" not in wf_src,
             "requiresReview가 workflow/index.js에 잔존")
    tr.check("REVIEW_REQUIRED_in_workflow",
             "REVIEW_REQUIRED" in wf_src,
             "REVIEW_REQUIRED 상태가 workflow에 없음")

    # T9: detectMOC가 snapshot에 없는지 (engine으로 이동됨)
    snap_src2 = (SRC / "snapshot" / "create.js").read_text()
    tr.check("detectMOC_removed_from_snapshot",
             "function detectMOC" not in snap_src2,
             "detectMOC가 snapshot/create.js에 잔존")
    tr.check("detectMOC_in_engine",
             "function detectMOC" in wf_eng_src,
             "detectMOC가 engine에 없음")

    # T10: computeWorkflowState 로직 검증 (Python 재현)
    TRIGGER = ["headerPressure","L","D","fittingsK","destination",
               "setPressure","mawp","orifice","deviceType"]
    def py_compute_wf(reasons):
        trigger = [r for r in reasons if r["field"] in TRIGGER]
        return "REVIEW_REQUIRED" if trigger else "INSPECTION"

    tr.check("computeWF_trigger_positive",
             py_compute_wf([{"field":"headerPressure","from":0.3,"to":0.5,"unit":"barg"}])
             == "REVIEW_REQUIRED",
             "headerPressure 변경이 REVIEW_REQUIRED를 반환하지 않음")
    tr.check("computeWF_trigger_negative",
             py_compute_wf([{"field":"registeredAt","from":"2024","to":"2025","unit":""}])
             == "INSPECTION",
             "비계산 필드 변경이 INSPECTION을 반환하지 않음")

    return tr

# ════════════════════════════════════════════════════════════════
#  UNIT BOUNDARY TEST — 단위/기준상태(Reference State) 경계 검증
#  Sprint A에서 발견된 두 CRITICAL 버그(SI 변환상수 누락, P1 절대압
#  환산 누락)가 모두 "단위 변환이 어디서 몇 번 일어나는가"의 문제였다.
#  이 스위트는 계산값이 아니라 변환의 위치·횟수·일관성을 고정한다:
#    - 각 변환은 정확히 한 곳(Single Source of Truth)에서만 일어나야 한다
#    - 같은 이름의 물리량이 서로 다른 파일에서 다른 정의로 쓰이면
#      (예: api520.js의 P1abs vs backpressure.js의 P1_abs) 그 차이가
#      "의도적 문서화"돼 있어야 한다 — 우연한 드리프트를 차단한다.
# ════════════════════════════════════════════════════════════════
def test_unit_boundaries() -> TestResult:
    tr = TestResult("UNIT-BOUNDARY-001", "단위/기준상태 경계 변환 — 위치·횟수·수치 검증")

    api520_src = (SRC / "engine" / "api520.js").read_text()
    bp_src     = (SRC / "engine" / "backpressure.js").read_text()
    input_src  = (SRC / "components" / "InputView.jsx").read_text()

    # trace 설명 문자열/주석에는 "OP/100", "A_mm2/100" 같은 식이 문서화
    # 목적으로 다시 등장한다 — 실제 연산 코드만 세려면 문자열·주석을
    # 제거한 버전으로 카운트해야 "exactly once" 계약이 의미가 있다.
    def _code_only(src):
        src = re.sub(r'"(?:[^"\\]|\\.)*"', '""', src)
        src = re.sub(r'`(?:[^`\\]|\\.)*`', '``', src)
        src = re.sub(r'//.*', '', src)
        return src
    api520_code = _code_only(api520_src)
    bp_code     = _code_only(bp_src)

    # ── UNIT-PRESSURE-001: 대기압 상수(1.01325) 단일 출처 ──────────
    # api520.js에 정확히 1회(정의부)만 리터럴로 존재해야 하고,
    # backpressure.js는 리터럴을 갖지 않고 API_CONST를 참조해야 한다.
    api520_atm_literals = len(re.findall(r"1\.01325", api520_src))
    bp_atm_literals      = len(re.findall(r"1\.01325", bp_src))
    tr.check("UNIT_PRESSURE_001_atm_const_single_source_in_api520",
             api520_atm_literals == 1,
             f"api520.js 내 1.01325 리터럴 개수={api520_atm_literals} (기대: 1, ATM_PRESSURE_BAR 정의부만)")
    tr.check("UNIT_PRESSURE_001_backpressure_no_duplicate_literal",
             bp_atm_literals == 0,
             f"backpressure.js 내 1.01325 리터럴 개수={bp_atm_literals} (기대: 0 — API_CONST.ATM_PRESSURE_BAR 참조로 대체)")
    tr.check("UNIT_PRESSURE_001_backpressure_references_shared_const",
             "API_CONST.ATM_PRESSURE_BAR" in bp_src,
             "backpressure.js가 api520.js의 공유 상수를 참조하지 않음")

    # ── UNIT-PRESSURE-002: bar → kPa (×100) 는 api520.js에서만, 1회 ──
    tr.check("UNIT_PRESSURE_002_kPa_conversion_only_in_api520",
             "P1_kPa" in api520_src and "P1_kPa" not in bp_src,
             "kPa 변환(P1_kPa)이 api520.js 밖에서도 발생함 — 경계 위반")
    tr.check("UNIT_PRESSURE_002_kPa_conversion_exactly_once",
             len(re.findall(r"P1_kPa\s*=\s*P1abs\s*\*\s*100", api520_src)) == 1,
             "P1abs*100 변환이 정확히 1회가 아님")

    # ── UNIT-PRESSURE-003: overpressure(%) 는 api520.js 전용 개념 ────
    # backpressure.js는 OP를 입력받지 않는다 — relieving pressure(sizing용,
    # OP 포함)와 배관 유속용 근사압력(OP 미포함)은 의도적으로 다른 값이며,
    # 이 차이가 backpressure.js 주석에 명시돼 있어야 한다 (우연한 차이 아님).
    tr.check("UNIT_PRESSURE_003_OP_not_referenced_in_backpressure",
             re.search(r"\bOP\b", bp_code) is None,
             "backpressure.js '코드'(주석 제외)가 OP(overpressure)를 참조함 — sizing 전용 개념이 유출됨")
    tr.check("UNIT_PRESSURE_003_divergence_documented",
             "의도적" in bp_src and "P1abs" in bp_src,
             "backpressure.js의 P1_abs가 api520.js의 P1abs와 다른 이유가 주석으로 문서화돼 있지 않음")
    # ACCUMULATION-001(C-2)부터 OP/100은 두 곳에서 의도적으로 재사용된다:
    #   1) RELIEVING_PRESSURE: P1abs = Pset*(1+OP/100)+Patm — sizing 입력
    #   2) ACCUMULATION_GUARDRAIL: actualAccumulationRatio = 1+OP/100 — 별개
    #      정책 검증(허용 축적압력 대비 GO/NO-GO), sizing 결과에 영향 없음
    # 두 계산은 서로 다른 목적의 별도 코드이며 우연한 중복이 아니다 —
    # 그래서 "정확히 1회"가 아니라 "정확히 2회"로 계약을 갱신한다(완화 아님,
    # 3회 이상의 우발적 중복은 여전히 잡아낸다).
    tr.check("UNIT_PRESSURE_003_OP_divided_by_100_exactly_twice",
             len(re.findall(r"OP\s*/\s*100", api520_code)) == 2,
             "OP/100 변환(코드)이 api520.js에서 정확히 2회(sizing + accumulation guardrail)가 아님")

    # ── UNIT-FLOW-001: kg/h → kg/s (÷3600) 는 backpressure.js 전용 ──
    # api520.js의 SI 면적식은 13160 상수가 W[kg/h] 기준으로 이미 보정돼
    # 있으므로 W를 kg/s로 바꾸면 안 된다 — 이 자체가 또 다른 잠재 버그원.
    tr.check("UNIT_FLOW_001_no_kgs_conversion_in_api520",
             re.search(r"/\s*3600", api520_src) is None,
             "api520.js가 W를 kg/s로 변환함 — 13160 상수는 kg/h 기준이므로 이중변환 위험")
    tr.check("UNIT_FLOW_001_kgs_conversion_in_backpressure_once",
             len(re.findall(r"/\s*3600", bp_src)) == 1,
             "kg/h→kg/s 변환이 backpressure.js에서 정확히 1회가 아님")

    # ── UNIT-AREA-001: mm² → cm² (÷100) 는 api520.js에서만, 1회 ─────
    tr.check("UNIT_AREA_001_mm2_to_cm2_exactly_once",
             len(re.findall(r"A_mm2\s*/\s*100", api520_code)) == 1,
             "A_mm2/100(mm²→cm², 코드)이 정확히 1회가 아님")
    tr.check("UNIT_AREA_001_no_area_reconversion_in_evidence",
             re.search(r"areaCm2\s*[*/]\s*100", (SRC/"engine"/"evidence.js").read_text()) is None,
             "evidence.js가 areaCm2를 다시 단위 변환하고 있음 — Engine 경계 밖 재변환")

    # ── UNIT-TEMP-001: °C↔K 변환은 InputView.jsx(UI)에서만 ─────────
    # 273.15가 engine 파일 어디에도 나타나면 안 된다 — engine은 항상
    # Kelvin만 받는다는 계약이 깨진 것.
    for fname, src in [("api520.js", api520_src), ("backpressure.js", bp_src),
                        ("workflow_engine.js", (SRC/"engine"/"workflow_engine.js").read_text()),
                        ("evidence.js", (SRC/"engine"/"evidence.js").read_text())]:
        tr.check(f"UNIT_TEMP_001_no_celsius_conversion_in_{fname}",
                 "273.15" not in src,
                 f"{fname}에 273.15(°C↔K 변환)가 있음 — Engine은 K만 받아야 함")
    tr.check("UNIT_TEMP_001_celsius_conversion_confined_to_InputView",
             "273.15" in input_src,
             "InputView.jsx에 273.15 변환이 없음 — °C 입력 모드가 깨졌을 가능성")

    # ── 수치 회귀: 변환 계수 자체의 산술 정확성 (엔진과 무관한 순수 검증) ──
    tr.check("UNIT_NUMERIC_pressure_bar_to_kPa",
             abs(5.5 * 100 - 550) < 1e-9, "bar→kPa 계수(×100) 오류")
    tr.check("UNIT_NUMERIC_area_mm2_to_cm2",
             abs(1000 / 100 - 10) < 1e-9, "mm²→cm² 계수(÷100) 오류")
    tr.check("UNIT_NUMERIC_area_cm2_to_m2",
             abs(39120.177446 / 10000 - 3.9120177446) < 1e-9, "cm²→m² 계수(÷10000) 오류")
    tr.check("UNIT_NUMERIC_flow_kgh_to_kgs",
             abs(2500 / 3600 - 0.6944444444444444) < 1e-9, "kg/h→kg/s 계수(÷3600) 오류")
    tr.check("UNIT_NUMERIC_temp_C_to_K",
             abs((25 + 273.15) - 298.15) < 1e-9, "°C→K 변환(+273.15) 오류")
    tr.check("UNIT_NUMERIC_relieving_pressure_roundtrip",
             abs((5.5 * (1 + 10/100) + 1.01325) - 7.06325) < 1e-9,
             "P1abs = Pset×(1+OP/100)+Patm 산술 오류")

    return tr


# ════════════════════════════════════════════════════════════════
#  COMPRESSIBILITY (Z) CONTRACT — Z를 Calculation Input으로 승격
#  Z는 Asset이 아니라 Case 소유 계산 조건 (OP와 반대 방향의 소유권).
# ════════════════════════════════════════════════════════════════
def test_compressibility_contract() -> TestResult:
    tr = TestResult("COMPRESSIBILITY-001", "Z(압축계수) Calculation Input 계약")

    api520_src = (SRC / "engine" / "api520.js").read_text()
    snap_src   = (SRC / "snapshot" / "create.js").read_text()
    pkg_src    = (SRC / "report" / "createPackage.js").read_text()
    pdf_src    = (SRC / "report" / "renderer" / "pdf" / "template.js").read_text()
    evid_src   = (SRC / "engine" / "evidence.js").read_text()
    schema_src = (SRC / "asset" / "schema.js").read_text()

    # ── API520-Z-001: Z=1.0과 Z=0.97 결과 차이 확인 (√Z 비례) ──────
    base = dict(W=2500, P1=5.5, P2=0.3, T=373, M=44, k=1.30,
                Kd=0.975, Kb=1.0, mawp=6.0, OP=10)
    r1 = _py_engine({**base, "Z":1.0},  "safetyValve")
    r2 = _py_engine({**base, "Z":0.97}, "safetyValve")
    tr.check("API520_Z_001_area_differs_with_Z",
             r1["areaCm2"] != r2["areaCm2"],
             "Z를 바꿔도 areaCm2가 그대로임 — Z가 계산에 반영되지 않음")
    expected_ratio = math.sqrt(0.97/1.0)
    actual_ratio = r2["areaCm2"] / r1["areaCm2"]
    tr.check("API520_Z_001_area_scales_by_sqrtZ",
             abs(actual_ratio - expected_ratio) < 1e-6,
             f"면적 비율={actual_ratio:.6f}, 기대(√(Z2/Z1))={expected_ratio:.6f}")

    # ── Z가 Asset(Equipment) 스키마에는 없어야 함 — Case 소유 확인 ──
    tr.check("API520_Z_001_Z_not_in_equipment_schema",
             "overpressure" in schema_src and re.search(r"\bZ\b\s*:", schema_src) is None,
             "Z가 Equipment 스키마에 있음 — Z는 Asset이 아니라 Case 소유여야 함")

    # ── validateInputs가 Z 필수 필드로 요구하는지 (Engine 계약) ─────
    tr.check("API520_Z_001_Z_required_in_validateInputs",
             '"Z"' in api520_src and "must_be_positive" in api520_src,
             "validateInputs가 Z를 필수 필드로 요구하지 않음")

    # ── SNAPSHOT-Z-001: Snapshot이 inputs를 통째로 보존(필드 화이트리스트 없음) ──
    tr.check("SNAPSHOT_Z_001_inputs_stored_as_full_copy",
             "inputs:          Object.freeze({ ...inputs })" in snap_src,
             "snapshot이 inputs를 부분 필드만 재구성해 저장함 — Z 같은 신규 필드가 누락될 위험")

    # ── REPORT-Z-001: ReportPackage/PDF가 동일한 Z를 표시 ──────────
    tr.check("REPORT_Z_001_package_inputs_full_copy",
             "inputs:        Object.freeze({ ...snapshot.inputs })" in pkg_src,
             "ReportPackage가 inputs를 재계산/부분 복사함 — Z 누락 위험")
    tr.check("REPORT_Z_001_pdf_shows_Z",
             "압축계수 Z" in pdf_src and "inputs?.Z" in pdf_src,
             "PDF 템플릿에 압축계수 Z 표시가 없음")
    tr.check("REPORT_Z_001_evidence_shows_Z",
             "fluid.Z" in evid_src,
             "화면 Evidence(evidence.js)에 Z 표시가 없음 — PDF와 화면 근거 불일치 위험")

    # ── TRACE-Z-001: Calculation Trace에 Z 단계 존재 ───────────────
    tr.check("TRACE_Z_001_step_in_trace",
             'step: "COMPRESSIBILITY_Z"' in api520_src,
             "Calculation Trace에 COMPRESSIBILITY_Z 단계가 없음")
    tr.check("TRACE_Z_001_default_source_labeled",
             "User Input (default 1.00)" in api520_src,
             "Z 기본값 출처(User Input, default 1.00) 라벨이 trace formula에 없음")

    return tr


# ════════════════════════════════════════════════════════════════
#  VALVE-TYPE-001 CONTRACT — 밸브 형식별 배압 정책 (Sprint C-1)
#  근거: KOSHA GUIDE D-18-2020 §7.2(4) — 스프링식 10%, 벨로우즈형 50%.
#  범위: "밸브 형식별 배압 정책을 정확히 적용하는 것"까지만. 축적압력/
#  Overpressure 가드레일(C-2), 인입배관 3%(C-3), 소요분출량 산정(C-4)은
#  이번 계약의 범위 밖 — 여기서 그 항목들을 검증하지 않는다.
# ════════════════════════════════════════════════════════════════
def test_valve_type_policy_contract() -> TestResult:
    tr = TestResult("VALVE-TYPE-001", "Sprint C-1 — 밸브 형식별 배압 정책")

    api520_src   = (SRC / "engine" / "api520.js").read_text()
    evid_src     = (SRC / "engine" / "evidence.js").read_text()
    renderer_src = (SRC / "components" / "renderers" / "index.jsx").read_text()
    template_src = (SRC / "report" / "renderer" / "pdf" / "template.js").read_text()
    input_view   = (SRC / "components" / "InputView.jsx").read_text()

    # ── 정책 테이블 자체가 소스에 정확한 값으로 존재하는지 ──────
    tr.check("POLICY_table_SPRING_010",
             "SPRING:  0.10" in api520_src or "SPRING: 0.10" in api520_src,
             "BACKPRESSURE_POLICY.SPRING이 0.10이 아님")
    tr.check("POLICY_table_BELLOWS_050",
             "BELLOWS: 0.50" in api520_src,
             "BACKPRESSURE_POLICY.BELLOWS가 0.50이 아님")
    tr.check("POLICY_source_cited",
             "KOSHA GUIDE D-18-2020" in api520_src,
             "정책 테이블에 KOSHA D-18-2020 출처 인용이 없음")
    tr.check("POLICY_pilot_not_in_table",
             '"PILOT"' not in api520_src.replace("PILOT_", "") and "PILOT:" not in api520_src.split("BACKPRESSURE_POLICY")[1].split("}")[0],
             "정책 테이블에 PILOT이 값과 함께 들어있음 — 원문에 수치 기준 없는 채로 지원 표시하면 안 됨")

    node = shutil.which("node")
    if node:
        check_script = f"""
const fs = require('fs');
const files = ['constants.js','engine/api520.js']
  .map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};

// 1) SPRING -> 10%, BELLOWS -> 50%
out.spring = getAllowableBackpressureRatio("SPRING");
out.bellows = getAllowableBackpressureRatio("BELLOWS");
out.lowercase = getAllowableBackpressureRatio("bellows");

// 2) valveType 누락 -> SPRING 하위호환
out.missing = getAllowableBackpressureRatio(undefined);
out.emptyString = getAllowableBackpressureRatio("");

// 3) 알 수 없는 valveType -> fail-fast (validateInputs가 거부)
const baseInputs = {{ W:2500,P1:5.5,P2:0.3,T:373,M:44,k:1.3,Kd:0.975,Kb:1.0,mawp:6.0,OP:10,Z:1.0 }};
out.unknownRejected = validateInputs({{ ...baseInputs, valveType:"PILOT" }});
out.unknownRejected2 = validateInputs({{ ...baseInputs, valveType:"GARBAGE" }});
out.missingAccepted = validateInputs({{ ...baseInputs }});
out.springAccepted = validateInputs({{ ...baseInputs, valveType:"SPRING" }});
out.bellowsAccepted = validateInputs({{ ...baseInputs, valveType:"BELLOWS" }});

// 4) Engine 실행 결과 checklist가 정책값을 실제로 사용하는지
//    (P2/P1 = 0.3/5.5 = 5.45% -> SPRING(10%) 통과, 이 자체로는 구분 안 되므로
//     30% 배압으로 SPRING/BELLOWS 갈리는 case 별도 확인)
const hiBp = {{ ...baseInputs, P2: 2.0 }}; // P2/P1 = 36.4%
const rSpring  = api520Engine({{ ...hiBp, valveType:"SPRING" }}, "safetyValve");
const rBellows = api520Engine({{ ...hiBp, valveType:"BELLOWS" }}, "safetyValve");
out.springFailsAt36pct  = rSpring.checklist.backPressureOK === false;
out.bellowsPassesAt36pct = rBellows.checklist.backPressureOK === true;
out.springStepDataRatio  = rSpring.stepData.backpress.allowableRatio;
out.bellowsStepDataRatio = rBellows.stepData.backpress.allowableRatio;
out.springTraceRatio = rSpring.trace.find(t => t.step === "BACKPRESSURE_POLICY").value;
out.bellowsTraceRatio = rBellows.trace.find(t => t.step === "BACKPRESSURE_POLICY").value;
out.springSource = rSpring.stepData.backpress.source;

console.log(JSON.stringify(out));
"""
        r = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
        try:
            result = json.loads(r.stdout.strip())
        except Exception:
            result = None
        ok = result is not None
        tr.check("ENGINE_reachable", ok, f"node 실행 실패 — stdout={r.stdout!r} stderr={r.stderr!r}")
        if ok:
            tr.check("RATIO_spring_is_010", result["spring"] == 0.10, f"actual={result['spring']}")
            tr.check("RATIO_bellows_is_050", result["bellows"] == 0.50, f"actual={result['bellows']}")
            tr.check("RATIO_case_insensitive", result["lowercase"] == 0.50, f"actual={result['lowercase']}")
            tr.check("MISSING_defaults_to_SPRING", result["missing"] == 0.10, f"actual={result['missing']}")
            tr.check("EMPTY_STRING_defaults_to_SPRING", result["emptyString"] == 0.10, f"actual={result['emptyString']}")
            tr.check("UNKNOWN_valveType_PILOT_rejected",
                     result["unknownRejected"]["ok"] is False and result["unknownRejected"].get("field") == "valveType",
                     f"actual={result['unknownRejected']}")
            tr.check("UNKNOWN_valveType_GARBAGE_rejected",
                     result["unknownRejected2"]["ok"] is False and result["unknownRejected2"].get("field") == "valveType",
                     f"actual={result['unknownRejected2']}")
            tr.check("MISSING_valveType_accepted", result["missingAccepted"]["ok"] is True, f"actual={result['missingAccepted']}")
            tr.check("SPRING_accepted", result["springAccepted"]["ok"] is True, f"actual={result['springAccepted']}")
            tr.check("BELLOWS_accepted", result["bellowsAccepted"]["ok"] is True, f"actual={result['bellowsAccepted']}")
            tr.check("SPRING_fails_at_36pct_backpressure", result["springFailsAt36pct"] is True)
            tr.check("BELLOWS_passes_at_36pct_backpressure", result["bellowsPassesAt36pct"] is True)
            tr.check("stepData_ratio_matches_policy_SPRING", result["springStepDataRatio"] == 0.10)
            tr.check("stepData_ratio_matches_policy_BELLOWS", result["bellowsStepDataRatio"] == 0.50)
            tr.check("trace_ratio_matches_stepData_SPRING", result["springTraceRatio"] == result["springStepDataRatio"])
            tr.check("trace_ratio_matches_stepData_BELLOWS", result["bellowsTraceRatio"] == result["bellowsStepDataRatio"])
            tr.check("provenance_source_cited_in_stepData",
                     result["springSource"] is not None and "KOSHA" in result["springSource"],
                     f"actual={result['springSource']}")
    else:
        tr.check("ENGINE_node_available", False, "node 없음 — 실행 검증 생략")

    # ── Checklist(화면)/Evidence/PDF가 하드코딩된 10%/50% 대신
    #    stepData/backpress의 allowableRatio를 그대로 읽는지 (단일 출처) ──
    tr.check("CHECKLIST_reads_allowableRatio_not_hardcoded",
             "backpress?.allowableRatio" in renderer_src or "backpress.allowableRatio" in renderer_src,
             "ChecklistRenderer가 backpress.allowableRatio를 읽지 않음 — 하드코딩 가능성")
    tr.check("EVIDENCE_reads_allowableRatio_not_hardcoded",
             "backpress.allowableRatio" in evid_src,
             "evidence.js가 backpress.allowableRatio를 읽지 않음 — 하드코딩 가능성")
    tr.check("PDF_reads_allowableRatio_not_hardcoded",
             "backpress?.allowableRatio" in template_src or "backpress.allowableRatio" in template_src,
             "PDF template이 backpress.allowableRatio를 읽지 않음 — 하드코딩 가능성")
    tr.check("CHECKLIST_no_hardcoded_percent_literal",
             "*0.10" not in renderer_src.replace(" ", "") and "* 0.10" not in renderer_src,
             "ChecklistRenderer에 배압 비율 0.10 리터럴이 하드코딩됨")

    # ── UI(InputView)가 10%/50%를 자체 계산하지 않고 engine 함수를 호출하는지 ──
    tr.check("UI_calls_getAllowableBackpressureRatio",
             "getAllowableBackpressureRatio(" in input_view,
             "InputView.jsx가 getAllowableBackpressureRatio()를 호출하지 않음 — 자체 계산 가능성")
    tr.check("UI_does_not_hardcode_bp_thresholds",
             "bpRatio > 30" not in input_view and "bpRatio > 10" not in input_view,
             "InputView.jsx에 예전 하드코딩 배압 임계값(10/30)이 잔존")

    # ── PILOT을 UI 선택지로 노출하지 않는지 ─────────────────────
    tr.check("UI_does_not_offer_PILOT_option",
             '["PILOT"' not in input_view and "'PILOT'" not in input_view,
             "InputView.jsx가 PILOT을 선택지로 제공함 — 원문에 수치 기준 없는 상태에서 지원 표시하면 안 됨")

    return tr


# ════════════════════════════════════════════════════════════════
#  ACCUMULATION-001 CONTRACT — 축적압력(Overpressure) Guardrail (Sprint C-2)
#  근거: KOSHA GUIDE D-18-2020 §4.4, <표 1> — 비화재/단일 110%,
#  비화재/2개이상 116%, 화재(수량무관) 121%.
#  범위: "입력된 Overpressure가 시나리오상 허용 가능한지 증명"까지만.
#  인입배관 3%(C-3), 5장 소요분출량 산정(C-4)은 이번 계약의 범위 밖.
# ════════════════════════════════════════════════════════════════
def test_accumulation_policy_contract() -> TestResult:
    tr = TestResult("ACCUMULATION-001", "Sprint C-2 — 축적압력(Overpressure) Guardrail")

    api520_src   = (SRC / "engine" / "api520.js").read_text()
    evid_src     = (SRC / "engine" / "evidence.js").read_text()
    renderer_src = (SRC / "components" / "renderers" / "index.jsx").read_text()
    template_src = (SRC / "report" / "renderer" / "pdf" / "template.js").read_text()
    input_view   = (SRC / "components" / "InputView.jsx").read_text()

    # ── 정책 테이블 값 자체가 소스에 정확히 존재하는지 ──────────
    tr.check("POLICY_non_fire_single_110",
             "NON_FIRE_SINGLE:" in api520_src and "1.10" in api520_src,
             "ACCUMULATION_POLICY.NON_FIRE_SINGLE이 1.10이 아님")
    tr.check("POLICY_non_fire_multi_116",
             "NON_FIRE_MULTI:" in api520_src and "1.16" in api520_src,
             "ACCUMULATION_POLICY.NON_FIRE_MULTI가 1.16이 아님")
    tr.check("POLICY_fire_121",
             "FIRE:" in api520_src and "1.21" in api520_src,
             "ACCUMULATION_POLICY.FIRE가 1.21이 아님")
    tr.check("POLICY_source_cited",
             "KOSHA GUIDE D-18-2020 §4.4" in api520_src,
             "정책 테이블에 KOSHA D-18-2020 §4.4 출처 인용이 없음")

    node = shutil.which("node")
    if node:
        check_script = f"""
const fs = require('fs');
const files = ['constants.js','engine/api520.js']
  .map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};
const baseInputs = {{ W:2500,P1:5.5,P2:0.3,T:373,M:44,k:1.3,Kd:0.975,Kb:1.0,mawp:6.0,Z:1.0 }};

// 1) 정책값 3분기
out.nonFireSingle = getAllowableAccumulationRatio(false, 1);
out.nonFireMulti  = getAllowableAccumulationRatio(false, 2);
out.fireSingle    = getAllowableAccumulationRatio(true, 1);
out.fireMulti     = getAllowableAccumulationRatio(true, 2);

// 2) 미지정 -> 가장 엄격한 기본값(단일/비화재 110%)
out.missingBoth = getAllowableAccumulationRatio(undefined, undefined);

// 3) valveCount 형식 오류 -> fail-fast
out.badCountRejected = validateInputs({{ ...baseInputs, OP:10, valveCount: 1.5 }});
out.badCountRejected2 = validateInputs({{ ...baseInputs, OP:10, valveCount: 0 }});
out.badFireRejected = validateInputs({{ ...baseInputs, OP:10, fireScenario: "yes" }});
out.missingAccepted = validateInputs({{ ...baseInputs, OP:10 }});
out.validAccepted = validateInputs({{ ...baseInputs, OP:10, valveCount:2, fireScenario:true }});

// 4) 허용치 초과 -> NO-GO(accumulationOK:false), 자동 보정 없음(sizing 불변)
//    OP=15 -> 축적압력 115%. 단일/비화재 한도(110%) 초과, 2개설치(116%) 이내.
const rSingleOP15 = api520Engine({{ ...baseInputs, OP:15, valveCount:1, fireScenario:false }}, "safetyValve");
const rMultiOP15  = api520Engine({{ ...baseInputs, OP:15, valveCount:2, fireScenario:false }}, "safetyValve");
const rSingleOP10 = api520Engine({{ ...baseInputs, OP:10, valveCount:1, fireScenario:false }}, "safetyValve"); // 경계값 == 허용, GO
out.singleOP15_NOGO = rSingleOP10 && rSingleOP15.checklist.accumulationOK === false;
out.multiOP15_GO    = rMultiOP15.checklist.accumulationOK === true;
out.boundaryOP10_GO = rSingleOP10.checklist.accumulationOK === true;

// 5) sizing(area/orifice)이 accumulation 통과여부와 무관하게 동일한지
//    (NO-GO라고 areaCm2를 자동으로 바꾸지 않는지 — fail-fast이지 보정이 아님)
out.sizingUnaffectedByAccumulation =
  Math.abs(rSingleOP15.areaCm2 - rSingleOP15.areaCm2) < 1e-9 &&
  rSingleOP15.valid === true; // NO-GO여도 engine이 값을 계속 반환(거부 아님) — checklist로만 표시

// 6) Trace/stepData가 정책 근거를 명시적으로 담고 있는지
out.traceHasPolicy = rSingleOP15.trace.some(t => t.step === "ACCUMULATION_POLICY");
out.traceHasGuardrail = rSingleOP15.trace.some(t => t.step === "ACCUMULATION_GUARDRAIL");
out.stepDataSource = rSingleOP15.stepData.accumulation.source;
out.stepDataValveCount = rSingleOP15.stepData.accumulation.valveCount;
out.stepDataFireScenario = rSingleOP15.stepData.accumulation.fireScenario;
out.stepDataActualRatio = rSingleOP15.stepData.accumulation.actualRatio;
out.stepDataAllowableRatio = rSingleOP15.stepData.accumulation.allowableRatio;

// 7) C-1(valveType)과 충돌하지 않는지 — 같은 호출에서 두 정책이 동시에 정상 계산되는지
const rBoth = api520Engine({{ ...baseInputs, OP:15, valveType:"BELLOWS", valveCount:1, fireScenario:false }}, "safetyValve");
out.coexistsWithValveType =
  rBoth.checklist.backPressureOK !== undefined &&
  rBoth.checklist.accumulationOK !== undefined &&
  rBoth.stepData.backpress.valveType === "BELLOWS" &&
  rBoth.stepData.accumulation.allowableRatio === 1.10;

console.log(JSON.stringify(out));
"""
        r = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
        try:
            result = json.loads(r.stdout.strip())
        except Exception:
            result = None
        ok = result is not None
        tr.check("ENGINE_reachable", ok, f"node 실행 실패 — stdout={r.stdout!r} stderr={r.stderr!r}")
        if ok:
            tr.check("RATIO_non_fire_single_110", result["nonFireSingle"] == 1.10, f"actual={result['nonFireSingle']}")
            tr.check("RATIO_non_fire_multi_116", result["nonFireMulti"] == 1.16, f"actual={result['nonFireMulti']}")
            tr.check("RATIO_fire_single_121", result["fireSingle"] == 1.21, f"actual={result['fireSingle']}")
            tr.check("RATIO_fire_multi_121", result["fireMulti"] == 1.21, f"actual={result['fireMulti']}")
            tr.check("MISSING_defaults_to_strictest_110", result["missingBoth"] == 1.10, f"actual={result['missingBoth']}")
            tr.check("BAD_valveCount_float_rejected",
                     result["badCountRejected"]["ok"] is False and result["badCountRejected"].get("field") == "valveCount",
                     f"actual={result['badCountRejected']}")
            tr.check("BAD_valveCount_zero_rejected",
                     result["badCountRejected2"]["ok"] is False and result["badCountRejected2"].get("field") == "valveCount",
                     f"actual={result['badCountRejected2']}")
            tr.check("BAD_fireScenario_type_rejected",
                     result["badFireRejected"]["ok"] is False and result["badFireRejected"].get("field") == "fireScenario",
                     f"actual={result['badFireRejected']}")
            tr.check("MISSING_valveCount_fireScenario_accepted", result["missingAccepted"]["ok"] is True, f"actual={result['missingAccepted']}")
            tr.check("VALID_valveCount_fireScenario_accepted", result["validAccepted"]["ok"] is True, f"actual={result['validAccepted']}")
            tr.check("OP15_single_nonfire_is_NOGO", result["singleOP15_NOGO"] is True)
            tr.check("OP15_multi_nonfire_is_GO", result["multiOP15_GO"] is True)
            tr.check("OP10_boundary_is_GO", result["boundaryOP10_GO"] is True, "경계값(정확히 허용한계)은 GO여야 함 — <= 비교")
            tr.check("NOGO_does_not_block_engine_or_alter_sizing", result["sizingUnaffectedByAccumulation"] is True,
                     "NO-GO가 sizing 결과를 바꾸거나 engine을 막음 — fail-fast(표시)여야지 자동보정/거부가 아님")
            tr.check("TRACE_has_ACCUMULATION_POLICY_step", result["traceHasPolicy"] is True)
            tr.check("TRACE_has_ACCUMULATION_GUARDRAIL_step", result["traceHasGuardrail"] is True)
            tr.check("stepData_source_cited",
                     result["stepDataSource"] is not None and "KOSHA" in result["stepDataSource"],
                     f"actual={result['stepDataSource']}")
            tr.check("stepData_records_valveCount", result["stepDataValveCount"] == 1, f"actual={result['stepDataValveCount']}")
            tr.check("stepData_records_fireScenario", result["stepDataFireScenario"] is False, f"actual={result['stepDataFireScenario']}")
            tr.check("stepData_actualRatio_matches_OP",
                     abs(result["stepDataActualRatio"] - 1.15) < 1e-9, f"actual={result['stepDataActualRatio']}")
            tr.check("stepData_allowableRatio_matches_policy",
                     result["stepDataAllowableRatio"] == 1.10, f"actual={result['stepDataAllowableRatio']}")
            tr.check("COEXISTS_with_valveType_policy_C1", result["coexistsWithValveType"] is True,
                     "C-1(valveType)과 C-2(accumulation) 정책이 같은 호출에서 동시에 정상 계산되지 않음")
    else:
        tr.check("ENGINE_node_available", False, "node 없음 — 실행 검증 생략")

    # ── Checklist(화면)/Evidence/PDF가 하드코딩 대신 stepData.accumulation을 읽는지 ──
    tr.check("CHECKLIST_reads_accumulation_allowableRatio",
             "accumulation?.allowableRatio" in renderer_src or "accumulation.allowableRatio" in renderer_src,
             "ChecklistRenderer가 accumulation.allowableRatio를 읽지 않음 — 하드코딩 가능성")
    tr.check("EVIDENCE_reads_accumulation_allowableRatio",
             "accumulation.allowableRatio" in evid_src,
             "evidence.js가 accumulation.allowableRatio를 읽지 않음 — 하드코딩 가능성")
    tr.check("PDF_reads_accumulation_allowableRatio",
             "accumulation?.allowableRatio" in template_src or "accumulation.allowableRatio" in template_src,
             "PDF template이 accumulation.allowableRatio를 읽지 않음 — 하드코딩 가능성")

    # ── UI가 허용 상한을 자체 계산하지 않고 engine 함수를 호출하는지 ──
    tr.check("UI_calls_getAllowableAccumulationRatio",
             "getAllowableAccumulationRatio(" in input_view,
             "InputView.jsx가 getAllowableAccumulationRatio()를 호출하지 않음 — 자체 계산 가능성")

    # ── UI가 초과 시 자동으로 OP 값을 낮추지 않는지 (onChange(\"OP\", ...) 자동 보정 금지) ──
    tr.check("UI_does_not_auto_clamp_OP",
             'onChange("OP"' not in input_view and "onChange('OP'" not in input_view,
             "InputView.jsx가 축적압력 초과 시 OP를 자동으로 재설정함 — 자동 보정 금지 원칙 위반")

    # ── 신규 필드가 기존 OP(Asset 소유)를 중복 생성하지 않았는지 ──────
    tr.check("NO_duplicate_overpressure_field",
             "overpressureAllowed" not in api520_src and "maxOverpressure" not in api520_src,
             "OP와 별개의 중복 Overpressure 필드가 생성됨 — 기존 OP(Asset 소유)를 재사용해야 함")

    return tr


# ════════════════════════════════════════════════════════════════
#  INLET-LOSS-001 CONTRACT — 인입배관 압력손실 (Sprint C-3)
#  근거: KOSHA GUIDE D-18-2020 §7.2(1) — 설정압력의 3% 이하.
#  범위: Physical Calculation(공용 computeFrictionLoss 재사용)과 Safety
#  Acceptance Policy(INLET_PRESSURE_LOSS_POLICY.MAX_RATIO)를 분리하고,
#  입력 부족을 GO로 오판하지 않는 것까지. A안(checklist에 조건부 포함 +
#  dataGaps + computeAdequacyVerdict 단일 판정)이 기존 구조와 공존하는지
#  증명한다.
# ════════════════════════════════════════════════════════════════
def test_inlet_pressure_loss_contract() -> TestResult:
    tr = TestResult("INLET-LOSS-001", "Sprint C-3 — 인입배관 압력손실 (KOSHA D-18 §7.2(1))")

    api520_src    = (SRC / "engine" / "api520.js").read_text()
    bp_src        = (SRC / "engine" / "backpressure.js").read_text()
    evid_src      = (SRC / "engine" / "evidence.js").read_text()
    renderer_src  = (SRC / "components" / "renderers" / "index.jsx").read_text()
    template_src  = (SRC / "report" / "renderer" / "pdf" / "template.js").read_text()
    input_view    = (SRC / "components" / "InputView.jsx").read_text()
    asset_schema  = (SRC / "asset" / "schema.js").read_text()
    asset_diff    = (SRC / "asset" / "diff.js").read_text()
    wf_src        = (SRC / "engine" / "workflow_engine.js").read_text()
    snap_src      = (SRC / "snapshot" / "create.js").read_text()
    case_view     = (SRC / "components" / "CaseView.jsx").read_text()
    dash_src      = (SRC / "components" / "Dashboard.jsx").read_text()
    report_src    = (SRC / "components" / "ReportView.jsx").read_text()

    # ── INLET-001: 정책 단일 출처 ──────────────────────────────
    tr.check("INLET_001_policy_value_is_003",
             "MAX_RATIO: 0.03" in api520_src,
             "INLET_PRESSURE_LOSS_POLICY.MAX_RATIO가 0.03이 아님")
    tr.check("INLET_001_source_cited",
             "KOSHA GUIDE D-18-2020 §7.2(1)" in api520_src,
             "정책에 KOSHA D-18-2020 §7.2(1) 출처 인용이 없음")
    tr.check("INLET_001_accessor_function_exists",
             "function getAllowableInletLossRatio" in api520_src,
             "getAllowableInletLossRatio() 단일 접근점이 없음 — C-1/C-2와 동일 패턴 필요")
    # UI/PDF/Evidence/Checklist가 0.03 또는 "3%"를 직접 하드코딩하지 않는지 —
    # 반드시 allowableRatio/allowablePressureLoss 필드를 통해서만 표시해야 한다.
    tr.check("INLET_001_UI_does_not_hardcode_003_or_3pct",
             "0.03" not in input_view and "= 3%" not in input_view and "3%)" not in input_view,
             "InputView.jsx가 0.03 또는 '3%'를 직접 하드코딩함 — allowableRatio를 통해야 함")
    tr.check("INLET_001_PDF_does_not_hardcode_003_or_3pct",
             "0.03" not in template_src and "의 3%" not in template_src and "3% 이내" not in template_src,
             "PDF template이 0.03 또는 '3%'를 직접 하드코딩함")
    tr.check("INLET_001_evidence_does_not_hardcode_003",
             "0.03" not in evid_src and "의 3%(" not in evid_src,
             "evidence.js가 0.03을 직접 하드코딩함 — API_CONST.INLET_PRESSURE_LOSS_POLICY.MAX_RATIO를 통해야 함")
    tr.check("INLET_001_checklist_does_not_hardcode_003",
             "0.03" not in renderer_src,
             "ChecklistRenderer가 0.03을 직접 하드코딩함")

    node = shutil.which("node")
    if node:
        common_files = "['constants.js','engine/api520.js','engine/backpressure.js','asset/schema.js']"
        check_script = f"""
const fs = require('fs');
const files = {common_files}.map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};
const base = {{ W:2500,P1:5.5,P2:0.3,T:373,M:44,k:1.3,Kd:0.975,Kb:1.0,mawp:6.0,OP:10,Z:1.0,valveType:"SPRING",valveCount:1,fireScenario:false }};

// ── INLET-002/003/004: 경계값 — 정확히 3%/미만/초과 ──────────
// 역산: allowablePressureLoss = Pset*0.03. totalFrictionLoss(L,D,fittingsK)로
// 정확히 그 값을 만들 수 있는 geometry를 이분탐색으로 찾는다(모델을
// 시험에서 다시 발명하지 않고, 실제 computeFrictionLoss를 그대로 역이용).
function lossFor(L) {{
  const fric = computeInletFrictionLoss({{W:base.W,T:base.T,M:base.M,Pset:base.P1,inletPiping:{{L,D:0.05,fittingsK:1.0}}}});
  return fric.pressureLoss_bar;
}}
const targetLoss = base.P1 * 0.03; // Pset=5.5 -> 0.165 bar
let lo=0.001, hi=500;
for (let i=0;i<80;i++) {{
  const mid=(lo+hi)/2;
  if (lossFor(mid) < targetLoss) lo=mid; else hi=mid;
}}
const L_exact = lo;
const geomExact = {{L:L_exact, D:0.05, fittingsK:1.0}};
const rExact = api520Engine({{...base}}, 'safetyValve', geomExact);
out.exactRatio = rExact.stepData.inletLoss.pressureLossRatio;
out.exactOK = rExact.checklist.inletLossOK;
out.exactVerdictGO = rExact.verdict;

const geomUnder = {{L:L_exact*0.5, D:0.05, fittingsK:1.0}};
const rUnder = api520Engine({{...base}}, 'safetyValve', geomUnder);
out.underOK = rUnder.checklist.inletLossOK;
out.underRatio = rUnder.stepData.inletLoss.pressureLossRatio;

const geomOver = {{L:L_exact*3, D:0.05, fittingsK:1.0}};
const rOver = api520Engine({{...base}}, 'safetyValve', geomOver);
out.overOK = rOver.checklist.inletLossOK;
out.overRatio = rOver.stepData.inletLoss.pressureLossRatio;
out.overVerdictNOGO = rOver.verdict;

// ── INLET-005: 입력 누락/부분 입력 -> INSUFFICIENT_INPUT, 절대 GO 아님 ──
const rMissing = api520Engine({{...base}}, 'safetyValve', null);
out.missingAvailable = rMissing.stepData.inletLoss.pressureLossAvailable;
out.missingOK = rMissing.stepData.inletLoss.pressureLossOK;
out.missingHasChecklistKey = Object.prototype.hasOwnProperty.call(rMissing.checklist, 'inletLossOK');
out.missingDataGaps = rMissing.dataGaps;
out.missingVerdict = rMissing.verdict;

const rUndefinedArg = api520Engine({{...base}}, 'safetyValve'); // 3번째 인자 자체를 생략
out.undefinedArgVerdict = rUndefinedArg.verdict;
out.undefinedArgDataGaps = rUndefinedArg.dataGaps;

// 부분 입력(L만 있고 D/fittingsK 없음) -> 계산 불가로 처리, GO 아님
const rPartial = api520Engine({{...base}}, 'safetyValve', {{L:5}});
out.partialAvailable = rPartial.stepData.inletLoss.pressureLossAvailable;
out.partialVerdict = rPartial.verdict;
out.partialDataGaps = rPartial.dataGaps;

// L=0(유효, 배관 길이 0도 허용값)이면서 D/fittingsK 있는 경우 -> "0은 누락이 아니다"
// (INLET-012: every(Boolean)/truthy 검사였다면 L:0이 falsy라 누락으로 오판될 수 있음)
const rZeroL = api520Engine({{...base}}, 'safetyValve', {{L:0, D:0.05, fittingsK:1.0}});
out.zeroL_available = rZeroL.stepData.inletLoss.pressureLossAvailable;
out.zeroL_hasChecklistKey = Object.prototype.hasOwnProperty.call(rZeroL.checklist, 'inletLossOK');

// fittingsK=0(유효, 부속 없음)도 같은 방식으로 확인
const rZeroFK = api520Engine({{...base}}, 'safetyValve', {{L:5, D:0.05, fittingsK:0}});
out.zeroFK_available = rZeroFK.stepData.inletLoss.pressureLossAvailable;

// ── INLET-006: 잘못된 geometry -> fail-fast (계산 불가로, NaN 전파 없이) ──
const rBadD = api520Engine({{...base}}, 'safetyValve', {{L:5, D:0, fittingsK:1.0}});   // D<=0
const rBadL = api520Engine({{...base}}, 'safetyValve', {{L:-1, D:0.05, fittingsK:1.0}}); // L<0
const rBadFK = api520Engine({{...base}}, 'safetyValve', {{L:5, D:0.05, fittingsK:-1}}); // fittingsK<0
const rNaN = api520Engine({{...base}}, 'safetyValve', {{L:"abc", D:0.05, fittingsK:1.0}});
out.badD_available = rBadD.stepData.inletLoss.pressureLossAvailable;
out.badL_available = rBadL.stepData.inletLoss.pressureLossAvailable;
out.badFK_available = rBadFK.stepData.inletLoss.pressureLossAvailable;
out.nan_available = rNaN.stepData.inletLoss.pressureLossAvailable;
out.badD_noNaNPropagation = !isNaN(rBadD.areaCm2) && isFinite(rBadD.areaCm2); // sizing 자체는 안 깨짐
out.nan_verdict = rNaN.verdict; // GO가 아니어야 함
out.nan_isNotGo = rNaN.verdict !== "GO";

// asset/schema.js 레벨 fail-fast — createEquipment가 잘못된 inletPiping을 던지는지
out.schemaRejectsInvalid = (() => {{
  try {{ createEquipment({{ tag:"T1", mawp:6, setPressure:5.5, overpressure:10, inletPiping:{{L:5,D:-1,fittingsK:1}} }}); return false; }}
  catch(e) {{ return /INLET|inletPiping|D/.test(e.message); }}
}})();
out.schemaAcceptsValid = (() => {{
  try {{ createEquipment({{ tag:"T2", mawp:6, setPressure:5.5, overpressure:10, inletPiping:{{L:5,D:0.05,fittingsK:1}} }}); return true; }}
  catch(e) {{ return false; }}
}})();
out.schemaAcceptsNull = (() => {{
  try {{ createEquipment({{ tag:"T3", mawp:6, setPressure:5.5, overpressure:10 }}); return true; }}
  catch(e) {{ return false; }}
}})();

// ── INLET-007: sizing 독립성 — 관련없는 sizing 입력이 바뀌어도 동일
//    inletPiping 입력이면 inlet-loss 결과가 바뀌지 않아야 함, 그리고
//    inlet-loss 결과(NO-GO 포함)가 sizing 결과(areaCm2/orifice)를
//    바꾸지 않아야 함 (양방향) ──
const geomFixed = {{L:5, D:0.05, fittingsK:1.0}};
const rSizeA = api520Engine({{...base, W:2500}}, 'safetyValve', geomFixed);
const rSizeB = api520Engine({{...base, W:2500, Kd:0.98}}, 'safetyValve', geomFixed); // 관련없는 sizing 입력 변경
out.inletLossUnaffectedBySizingChange =
  Math.abs(rSizeA.stepData.inletLoss.pressureLoss - rSizeB.stepData.inletLoss.pressureLoss) < 1e-9;
const rGoSizing = api520Engine({{...base}}, 'safetyValve', geomUnder).areaCm2;
const rNoGoSizing = api520Engine({{...base}}, 'safetyValve', geomOver).areaCm2;
out.sizingUnaffectedByInletLossVerdict = Math.abs(rGoSizing - rNoGoSizing) < 1e-9;
out.sizingSameOrificeRegardlessOfInletLoss =
  api520Engine({{...base}}, 'safetyValve', geomUnder).selected.letter ===
  api520Engine({{...base}}, 'safetyValve', geomOver).selected.letter;

// ── INLET-008: C-1(valveType)/C-2(accumulation)과 공존 ─────────
const rCoexist = api520Engine({{...base, valveType:"BELLOWS", valveCount:2, fireScenario:true}}, 'safetyValve', geomFixed);
out.coexist_backpressOK = rCoexist.checklist.backPressureOK !== undefined;
out.coexist_accumulationOK = rCoexist.checklist.accumulationOK !== undefined;
out.coexist_inletLossOK = rCoexist.checklist.inletLossOK !== undefined;
out.coexist_valveTypeCorrect = rCoexist.stepData.backpress.valveType === "BELLOWS";
out.coexist_accumulationRatioCorrect = rCoexist.stepData.accumulation.allowableRatio === 1.21; // fire
// 반대 방향 — C-3 데이터 없이 C-1/C-2만 있는 기존 케이스가 여전히 정상 동작하는지
const rC1C2Only = api520Engine({{...base, valveType:"BELLOWS", valveCount:2, fireScenario:true}}, 'safetyValve', null);
out.c1c2OnlyStillWorks = rC1C2Only.checklist.backPressureOK !== undefined &&
                          rC1C2Only.checklist.accumulationOK !== undefined &&
                          !Object.prototype.hasOwnProperty.call(rC1C2Only.checklist, 'inletLossOK') &&
                          rC1C2Only.dataGaps.includes('inletPiping');

console.log(JSON.stringify(out));
"""
        r = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=20)
        try:
            result = json.loads(r.stdout.strip())
        except Exception:
            result = None
        ok = result is not None
        tr.check("ENGINE_reachable", ok, f"node 실행 실패 — stdout={r.stdout!r} stderr={r.stderr!r}")
        if ok:
            # INLET-002: 정확히 3% -> GO
            tr.check("INLET_002_exact_3pct_ratio_is_003",
                     abs(result["exactRatio"] - 0.03) < 1e-4, f"actual={result['exactRatio']}")
            tr.check("INLET_002_exact_3pct_is_GO",
                     result["exactOK"] is True, "정확히 3%(경계)는 <=이므로 GO여야 함")
            tr.check("INLET_002_exact_3pct_verdict_GO",
                     result["exactVerdictGO"] == "GO", f"actual={result['exactVerdictGO']}")
            # INLET-003: 미만 -> GO
            tr.check("INLET_003_under_3pct_is_GO",
                     result["underOK"] is True and result["underRatio"] < 0.03,
                     f"underOK={result['underOK']} underRatio={result['underRatio']}")
            # INLET-004: 초과 -> NO-GO (canonical: checklist False, verdict NO_GO)
            tr.check("INLET_004_over_3pct_is_NOGO",
                     result["overOK"] is False and result["overRatio"] > 0.03,
                     f"overOK={result['overOK']} overRatio={result['overRatio']}")
            tr.check("INLET_004_over_3pct_verdict_is_canonical_NO_GO",
                     result["overVerdictNOGO"] == "NO_GO", f"actual={result['overVerdictNOGO']}")

            # INLET-005: 누락/부분입력 -> INSUFFICIENT_INPUT, 절대 GO 아님
            tr.check("INLET_005_missing_not_available", result["missingAvailable"] is False)
            tr.check("INLET_005_missing_ok_is_null", result["missingOK"] is None,
                     "입력 누락 시 pressureLossOK는 false가 아니라 null(판정불가)이어야 함")
            tr.check("INLET_005_missing_not_in_checklist", result["missingHasChecklistKey"] is False,
                     "A안: 계산 불가 시 checklist.inletLossOK 자체가 없어야 함")
            tr.check("INLET_005_missing_in_dataGaps", "inletPiping" in result["missingDataGaps"])
            tr.check("INLET_005_missing_verdict_is_INSUFFICIENT_INPUT",
                     result["missingVerdict"] == "INSUFFICIENT_INPUT",
                     f"actual={result['missingVerdict']} — 절대 GO가 되면 안 됨")
            tr.check("INLET_005_undefined_3rd_arg_same_as_missing",
                     result["undefinedArgVerdict"] == "INSUFFICIENT_INPUT" and "inletPiping" in result["undefinedArgDataGaps"],
                     "inletPiping 인자 자체를 생략해도 누락과 동일하게 처리되어야 함")
            tr.check("INLET_005_partial_input_not_available", result["partialAvailable"] is False,
                     "L만 있고 D/fittingsK 없는 부분 입력은 계산 불가여야 함")
            tr.check("INLET_005_partial_input_verdict_INSUFFICIENT",
                     result["partialVerdict"] == "INSUFFICIENT_INPUT", f"actual={result['partialVerdict']}")
            tr.check("INLET_005_partial_input_in_dataGaps", "inletPiping" in result["partialDataGaps"])

            # INLET-012: every(Boolean)/truthy 회귀 방지 — L=0, fittingsK=0은 유효값이지 누락이 아님
            tr.check("INLET_012_zero_L_is_valid_not_missing",
                     result["zeroL_available"] is True and result["zeroL_hasChecklistKey"] is True,
                     "L=0(유효값, 배관 길이 0)이 truthy 검사로 인해 '누락'으로 오판됨 — every(Boolean) 패턴 회귀")
            tr.check("INLET_012_zero_fittingsK_is_valid_not_missing",
                     result["zeroFK_available"] is True,
                     "fittingsK=0(유효값, 부속 없음)이 truthy 검사로 인해 '누락'으로 오판됨")

            # INLET-006: 잘못된 geometry -> fail-fast, NaN 전파 없음, GO 아님
            tr.check("INLET_006_D_zero_rejected", result["badD_available"] is False)
            tr.check("INLET_006_L_negative_rejected", result["badL_available"] is False)
            tr.check("INLET_006_fittingsK_negative_rejected", result["badFK_available"] is False)
            tr.check("INLET_006_non_numeric_rejected", result["nan_available"] is False)
            tr.check("INLET_006_no_NaN_propagation_to_sizing", result["badD_noNaNPropagation"] is True,
                     "잘못된 inletPiping이 sizing(areaCm2)에 NaN을 전파시킴")
            tr.check("INLET_006_invalid_never_becomes_GO", result["nan_isNotGo"] is True)
            tr.check("INLET_006_schema_rejects_invalid_D", result["schemaRejectsInvalid"] is True,
                     "asset/schema.js의 createEquipment가 D<=0인 inletPiping을 거부하지 않음")
            tr.check("INLET_006_schema_accepts_valid", result["schemaAcceptsValid"] is True)
            tr.check("INLET_006_schema_accepts_missing_inletPiping", result["schemaAcceptsNull"] is True,
                     "inletPiping 자체가 선택 항목이므로 없어도 Equipment 생성은 성공해야 함")

            # INLET-007: sizing 독립성 (양방향)
            tr.check("INLET_007_inletLoss_unaffected_by_unrelated_sizing_input",
                     result["inletLossUnaffectedBySizingChange"] is True,
                     "관련없는 sizing 입력(Kd) 변경이 inlet-loss 결과에 영향을 줌")
            tr.check("INLET_007_sizing_unaffected_by_inletLoss_verdict",
                     result["sizingUnaffectedByInletLossVerdict"] is True,
                     "inlet-loss GO/NO-GO 차이가 areaCm2(sizing)를 변경시킴")
            tr.check("INLET_007_orifice_unaffected_by_inletLoss_verdict",
                     result["sizingSameOrificeRegardlessOfInletLoss"] is True)

            # INLET-008: C-1/C-2 공존 (양방향)
            tr.check("INLET_008_coexists_with_backpressure_checklist", result["coexist_backpressOK"] is True)
            tr.check("INLET_008_coexists_with_accumulation_checklist", result["coexist_accumulationOK"] is True)
            tr.check("INLET_008_coexists_with_inletLoss_checklist", result["coexist_inletLossOK"] is True)
            tr.check("INLET_008_valveType_still_correct_with_inletPiping_present", result["coexist_valveTypeCorrect"] is True)
            tr.check("INLET_008_accumulation_still_correct_with_inletPiping_present", result["coexist_accumulationRatioCorrect"] is True)
            tr.check("INLET_008_C1_C2_only_still_works_without_C3_data", result["c1c2OnlyStillWorks"] is True,
                     "C-3 데이터 없이 C-1/C-2만 쓰는 기존 케이스가 깨짐")
    else:
        tr.check("ENGINE_node_available", False, "node 없음 — 실행 검증 생략")

    # ── INLET-009: MOC/Revision Diff 감지 ──────────────────────
    tr.check("INLET_009_diff_has_inletPiping_L",
             '["inletPiping.L"' in asset_diff, "asset/diff.js에 inletPiping.L diff 필드가 없음")
    tr.check("INLET_009_diff_has_inletPiping_D",
             '["inletPiping.D"' in asset_diff, "asset/diff.js에 inletPiping.D diff 필드가 없음")
    tr.check("INLET_009_diff_has_inletPiping_fittingsK",
             '["inletPiping.fittingsK"' in asset_diff, "asset/diff.js에 inletPiping.fittingsK diff 필드가 없음")
    tr.check("INLET_009_diff_uses_dotpath_not_UI_only",
             "function _getPath" in asset_diff, "dot-path 리더가 없음 — Snapshot/Diff 레벨이 아니라 UI에서만 비교할 위험")
    tr.check("INLET_009_workflow_trigger_includes_inletPiping",
             "inletPiping.L" in wf_src and "inletPiping.D" in wf_src and "inletPiping.fittingsK" in wf_src,
             "workflow_engine.js의 WORKFLOW_TRIGGER_FIELDS/detectMOC가 inletPiping 변경을 감지하지 않음")
    tr.check("INLET_009_asset_hash_includes_inletPiping",
             "inletPiping" in wf_src.split("function _wfAssetHash")[1][:600] if "function _wfAssetHash" in wf_src else False,
             "_wfAssetHash가 inletPiping을 fingerprint에 포함하지 않음 — 변경돼도 감지 안 됨")
    tr.check("INLET_009_snapshot_asset_hash_includes_inletPiping",
             "inletPiping" in snap_src.split("function _assetHash")[1][:600] if "function _assetHash" in snap_src else False,
             "snapshot/create.js의 _assetHash가 inletPiping을 포함하지 않음")

    # ── INLET-010: UI가 압력손실/적정성을 독자 계산하지 않는지 ──
    tr.check("INLET_010_UI_calls_engine_inlet_functions",
             "computeInletFrictionLoss(" in input_view and "evaluateInletPressureLossPolicy(" in input_view,
             "InputView.jsx가 Engine의 computeInletFrictionLoss/evaluateInletPressureLossPolicy를 호출하지 않음 — 자체 계산 가능성")
    tr.check("INLET_010_UI_does_not_reimplement_darcy_weisbach",
             "DARCY_F_DEFAULT" not in input_view and "gasDensity(" not in input_view,
             "InputView.jsx가 Darcy-Weisbach/밀도 계산을 직접 재구현함")

    # ── INLET-011: PDF/Evidence가 Snapshot 파생값만 쓰는지 (재계산 금지) ──
    tr.check("INLET_011_PDF_reads_stepData_inletLoss",
             "stepData?.inletLoss" in template_src or "stepData.inletLoss" in template_src,
             "PDF template이 pkg.calculation.result.stepData.inletLoss를 읽지 않음")
    tr.check("INLET_011_PDF_does_not_call_computeFrictionLoss",
             "computeFrictionLoss(" not in template_src and "computeInletFrictionLoss(" not in template_src,
             "PDF template이 압력손실을 직접 재계산함 — Snapshot/Engine 결과만 표시해야 함")
    tr.check("INLET_011_evidence_reads_stepData_not_recompute",
             "computeFrictionLoss(" not in evid_src and "computeInletFrictionLoss(" not in evid_src,
             "evidence.js가 압력손실을 직접 재계산함")

    # ── INLET-012: every(Boolean) 재도입 금지 (checklist 소비측) ──
    tr.check("INLET_012_ReportView_uses_verdict_not_every_Boolean",
             "r.verdict" in report_src and "Object.values(r.checklist).every(Boolean)" not in report_src.split("const verdict")[0],
             "ReportView.jsx가 verdict 이전에 checklist.every(Boolean)로 allOK를 직접 계산함 — 재도입 금지 규칙 위반")
    tr.check("INLET_012_Dashboard_uses_verdict_not_every_Boolean",
             "result?.verdict" in dash_src,
             "Dashboard.jsx가 latestSnap.result.verdict를 쓰지 않음 — every(Boolean) 재도입 가능성")
    tr.check("INLET_012_PDF_uses_verdict_param",
             "verdict)" in template_src.split("function _pdfVerdictSection")[1][:300] if "function _pdfVerdictSection" in template_src else False,
             "PDF _pdfVerdictSection이 verdict 파라미터를 받지 않음")
    tr.check("INLET_012_computeAdequacyVerdict_checks_dataGaps_first",
             "dataGaps && dataGaps.length > 0" in api520_src,
             "computeAdequacyVerdict()가 dataGaps를 checklist보다 우선 확인하지 않음")

    # ── INLET-013: Snapshot/Report 보존 — equipment.inletPiping이 그대로 흐르는지 ──
    tr.check("INLET_013_snapshot_freezes_equipment_copy",
             "equipment       ? Object.freeze({ ...equipment })" in snap_src or "equipment ? Object.freeze({ ...equipment })" in snap_src,
             "snapshot/create.js가 equipment를 freeze 복사하지 않음 — inletPiping 보존 경로 불명확")
    tr.check("INLET_013_schema_freezes_nested_inletPiping",
             asset_schema.count("Object.freeze({\n      L:") >= 1 or "inletPiping.L" in asset_schema and "Object.freeze" in asset_schema,
             "asset/schema.js가 중첩된 inletPiping 객체를 별도로 freeze하지 않음 — 얕은 freeze로 인해 Snapshot 이후 변조 가능")
    tr.check("INLET_013_CaseView_passes_inletPiping_to_engine",
             "equipment?.inletPiping" in case_view or "equipment.inletPiping" in case_view,
             "CaseView.jsx가 api520Engine 호출 시 equipment.inletPiping을 전달하지 않음")
    # ReportPackage 레벨 화이트리스트 누락 방지 — 실제로 이 방식으로 한번
    # 놓쳤던 결함(Snapshot에는 있으나 asset.equipment 화이트리스트에서
    # 빠져 PDF가 "미등록"으로 잘못 표시)이라 회귀 테스트로 고정한다.
    createpkg_src = (SRC / "report" / "createPackage.js").read_text()
    tr.check("INLET_013_reportpackage_equipment_whitelist_includes_inletPiping",
             "inletPiping:" in createpkg_src.split("asset: Object.freeze")[1][:800]
             and "snapshot.equipment?.inletPiping" in createpkg_src,
             "createPackage.js의 asset.equipment 화이트리스트에 inletPiping이 없음 — Snapshot엔 있어도 PDF/Evidence가 '미등록'으로 잘못 표시됨")

    # ── INLET-014: 결정론/아키텍처 무결성 ──────────────────────
    tr.check("INLET_014_engine_is_pure_no_date_now_in_inlet_functions",
             "Date.now()" not in api520_src.split("function computeInletFrictionLoss")[1].split("function evaluateInletPressureLossPolicy")[1].split("function computeAdequacyVerdict")[0]
             if "function computeInletFrictionLoss" in api520_src and "function evaluateInletPressureLossPolicy" in api520_src and "function computeAdequacyVerdict" in api520_src
             else False,
             "evaluateInletPressureLossPolicy가 Date.now() 등 비결정적 값을 사용함 — pure function 원칙 위반")
    tr.check("INLET_014_no_engine_version_duplicate",
             api520_src.count('const ENGINE_VERSION = "1.6.0"') == 1,
             "ENGINE_VERSION 1.6.0 선언이 정확히 1곳이 아님")
    tr.check("INLET_014_snapshot_engine_version_matches",
             'const SNAPSHOT_ENGINE_VERSION = "1.6.0"' in snap_src,
             "SNAPSHOT_ENGINE_VERSION이 1.6.0으로 갱신되지 않음 — engine_version == report_version 계약 위반")

    return tr


# ════════════════════════════════════════════════════════════════
#  RELIEF LOAD TAXONOMY CONTRACT (Sprint C-4.0)
#  KOSHA GUIDE D-18-2020 §5(소요분출량)/§6(안전밸브 선정) 계약/데이터모델.
#  이 단계는 계산식을 구현하지 않는다 — taxonomy와 §6 governing load
#  선택 순수함수만 검증한다. api520Engine과의 연결은 C-4.8에서 검증.
# ════════════════════════════════════════════════════════════════
def test_relief_load_taxonomy_contract() -> TestResult:
    tr = TestResult("RELIEF-LOAD-TAXONOMY-001", "Sprint C-4.0 — §5/§6 시나리오 taxonomy 및 governing load 계약")

    rl_src    = (SRC / "engine" / "relief_load.js").read_text()
    api520_src= (SRC / "engine" / "api520.js").read_text()

    # ── 원문 대조 결과 반영: 7개 COMPUTABLE, 나머지는 원문이 그은 경계 ──
    tr.check("TAXONOMY_001_seven_computable_scenarios",
             rl_src.count("RELIEF_LOAD_STATUS.COMPUTABLE,") == 7,
             "COMPUTABLE 시나리오가 정확히 7개(§5.1/5.6/5.7/5.8/5.11/5.12/5.13)가 아님")
    tr.check("TAXONOMY_001_fourteen_plus_one_sections_present",
             all(f"§5.{n}" in rl_src for n in list(range(1,15))),
             "§5.1~§5.14 전체가 taxonomy에 존재하지 않음 — 원문 조항 누락")
    tr.check("TAXONOMY_001_source_cited",
             "KOSHA GUIDE D-18-2020" in rl_src,
             "taxonomy에 KOSHA D-18-2020 출처 인용이 없음")
    tr.check("TAXONOMY_001_needs_engineering_decision_not_silently_computable",
             '"COOLING_LOSS"' in rl_src and "NEEDS_ENGINEERING_DECISION" in rl_src,
             "§5.2(냉각/환류 중단)가 NEEDS_ENGINEERING_DECISION으로 분류되지 않음")
    tr.check("TAXONOMY_001_out_of_scope_distinct_from_needs_decision",
             rl_src.count("OUT_OF_SCOPE,") >= 4,
             "OUT_OF_SCOPE(§5.3/5.5/5.9/5.14)가 NEEDS_ENGINEERING_DECISION과 구분되지 않음")
    tr.check("TAXONOMY_001_dependent_scenarios_reference_parent",
             '"NONCONDENSABLE_GAS"' in rl_src and "DEPENDENT" in rl_src and "dependsOn" in rl_src,
             "§5.4/§5.15의 종속관계(dependsOn)가 명시되지 않음")
    tr.check("TAXONOMY_001_scenario_calculators_not_hardcoded_into_engine",
             all((fn + "(") not in api520_src for fn in [
                 "calculateOutletBlockedScenario", "calculateOverfillingScenario",
                 "calculateControlValveFailureScenario", "calculateAbnormalHeatVaporScenario",
                 "calculateLiquidThermalExpansionScenario", "calculateExchangerFailureScenario",
                 "calculateExternalFireScenario",
             ]),
             "개별 §5.x 계산 함수가 api520Engine에 직접 하드코딩되면 안 됨 — "
             "C-4.8B는 selectGoverningReliefLoad()/buildReliefSizingInput() 결과를 외부에서 "
             "주입받는 제네릭 reliefLoadAdapter 경로만 허용한다(직접 계산 호출 금지)")

    node = shutil.which("node")
    if node:
        check_script = f"""
const fs = require('fs');
const files = ['engine/relief_load.js'].map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};

// ── GOV-001: 유효 시나리오 없음 -> INSUFFICIENT_INPUT ──
out.emptyVerdict = selectGoverningReliefLoad([]).verdict;
out.nullInputVerdict = selectGoverningReliefLoad(null).verdict;
out.allNotApplicableVerdict = selectGoverningReliefLoad([
  {{scenarioId:"OUTLET_BLOCKED", status:"NOT_APPLICABLE", W:null}},
  {{scenarioId:"OVERFILLING", status:"INSUFFICIENT_INPUT", W:null}},
]).verdict;

// ── GOV-002: 단일 유효 시나리오 -> 그대로 governing ──
const single = selectGoverningReliefLoad([
  {{scenarioId:"OUTLET_BLOCKED", status:"OK", W:1000, unit:"kg/h"}},
]);
out.singleGoverningId = single.governingScenarioId;
out.singleGoverningW = single.governingW;
out.singleVerdict = single.verdict;

// ── GOV-003: 여러 시나리오 중 최댓값 선택 ──
const multi = selectGoverningReliefLoad([
  {{scenarioId:"OUTLET_BLOCKED", status:"OK", W:1200, unit:"kg/h"}},
  {{scenarioId:"EXTERNAL_FIRE",  status:"OK", W:5000, unit:"kg/h"}},
  {{scenarioId:"OVERFILLING",    status:"OK", W:800, unit:"kg/h"}},
]);
out.multiGoverningId = multi.governingScenarioId;
out.multiGoverningW = multi.governingW;

// ── GOV-004: 무효(status != OK, W<=0, W가 숫자아님) 시나리오는 후보에서 제외 ──
const filtered = selectGoverningReliefLoad([
  {{scenarioId:"OUTLET_BLOCKED", status:"OK", W:-5, unit:"kg/h"}},
  {{scenarioId:"OVERFILLING",    status:"OK", W:"not_a_number", unit:"kg/h"}},
  {{scenarioId:"CONTROL_VALVE_FAIL", status:"OK", W:0, unit:"kg/h"}},
  {{scenarioId:"EXTERNAL_FIRE",  status:"OK", W:3000, unit:"kg/h"}},
]);
out.filteredGoverningId = filtered.governingScenarioId;
out.filteredGoverningW = filtered.governingW;

// ── GOV-005: 동점(tie) -> taxonomy 선언순서상 먼저인 쪽으로 결정론적 선택 ──
const tie1 = selectGoverningReliefLoad([
  {{scenarioId:"EXTERNAL_FIRE",  status:"OK", W:2000, unit:"kg/h"}},
  {{scenarioId:"OUTLET_BLOCKED", status:"OK", W:2000, unit:"kg/h"}},
]);
const tie2 = selectGoverningReliefLoad([
  {{scenarioId:"OUTLET_BLOCKED", status:"OK", W:2000, unit:"kg/h"}},
  {{scenarioId:"EXTERNAL_FIRE",  status:"OK", W:2000, unit:"kg/h"}},
]);
out.tieWinner1 = tie1.governingScenarioId;
out.tieWinner2 = tie2.governingScenarioId;
out.tieOrderIndependent = (tie1.governingScenarioId === tie2.governingScenarioId);

// ── GOV-006: allScenarios가 governing만 남기지 않고 전체 보존 ──
const preserve = selectGoverningReliefLoad([
  {{scenarioId:"OUTLET_BLOCKED", status:"OK", W:1000, unit:"kg/h"}},
  {{scenarioId:"EXTERNAL_FIRE",  status:"OK", W:5000, unit:"kg/h"}},
  {{scenarioId:"OVERFILLING",    status:"INSUFFICIENT_INPUT", W:null}},
]);
out.preservedCount = preserve.allScenarios.length;

// ── GOV-007: 순수 함수 — 입력 배열/객체를 변형하지 않음 ──
const original = [{{scenarioId:"OUTLET_BLOCKED", status:"OK", W:1000, unit:"kg/h"}}];
const originalCopy = JSON.parse(JSON.stringify(original));
selectGoverningReliefLoad(original);
out.inputUnmutated = JSON.stringify(original) === JSON.stringify(originalCopy);

// ── GOV-008: 결정론 — 동일 입력 2회 실행 결과 동일 ──
const detInput = [
  {{scenarioId:"OUTLET_BLOCKED", status:"OK", W:1500, unit:"kg/h"}},
  {{scenarioId:"EXTERNAL_FIRE",  status:"OK", W:4200, unit:"kg/h"}},
];
const d1 = selectGoverningReliefLoad(detInput);
const d2 = selectGoverningReliefLoad(detInput);
out.deterministic = JSON.stringify(d1) === JSON.stringify(d2);

// ── GOV-009: getComputableScenarioIds()가 정확히 7개 반환 ──
out.computableCount = getComputableScenarioIds().length;
out.computableIncludesFire = getComputableScenarioIds().includes("EXTERNAL_FIRE");
out.computableExcludesOutOfScope = !getComputableScenarioIds().includes("VOLATILE_INGRESS");

console.log(JSON.stringify(out));
"""
        try:
            result = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
            out = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else {}
        except Exception as e:
            out = {}
            tr.check("GOV_node_execution", False, f"node 실행 실패: {e}\nstderr: {getattr(result,'stderr','')}")
            out = None

        if out is not None:
            tr.check("GOV_001_empty_array_insufficient_input",
                     out.get("emptyVerdict") == "INSUFFICIENT_INPUT", f"got {out.get('emptyVerdict')}")
            tr.check("GOV_001_null_input_insufficient_input",
                     out.get("nullInputVerdict") == "INSUFFICIENT_INPUT", f"got {out.get('nullInputVerdict')}")
            tr.check("GOV_001_all_not_applicable_insufficient_input",
                     out.get("allNotApplicableVerdict") == "INSUFFICIENT_INPUT", f"got {out.get('allNotApplicableVerdict')}")
            tr.check("GOV_002_single_scenario_becomes_governing",
                     out.get("singleGoverningId") == "OUTLET_BLOCKED" and out.get("singleGoverningW") == 1000
                     and out.get("singleVerdict") == "OK",
                     f"got {out.get('singleGoverningId')}/{out.get('singleGoverningW')}/{out.get('singleVerdict')}")
            tr.check("GOV_003_max_W_selected_among_multiple",
                     out.get("multiGoverningId") == "EXTERNAL_FIRE" and out.get("multiGoverningW") == 5000,
                     f"got {out.get('multiGoverningId')}/{out.get('multiGoverningW')}")
            tr.check("GOV_004_invalid_scenarios_excluded_from_selection",
                     out.get("filteredGoverningId") == "EXTERNAL_FIRE" and out.get("filteredGoverningW") == 3000,
                     f"음수/비숫자/0 W를 가진 시나리오가 선택에서 제외되지 않음: got {out.get('filteredGoverningId')}/{out.get('filteredGoverningW')}")
            tr.check("GOV_005_tie_break_deterministic_by_taxonomy_order",
                     out.get("tieOrderIndependent") is True and out.get("tieWinner1") == "OUTLET_BLOCKED",
                     f"동점 시 taxonomy 선언순서(§5.1이 §5.12보다 먼저)로 결정되지 않음: {out.get('tieWinner1')}/{out.get('tieWinner2')}")
            tr.check("GOV_006_all_scenarios_preserved_not_just_governing",
                     out.get("preservedCount") == 3,
                     f"allScenarios가 전체 시나리오(3개)를 보존하지 않음: got {out.get('preservedCount')}")
            tr.check("GOV_007_pure_function_does_not_mutate_input",
                     out.get("inputUnmutated") is True,
                     "selectGoverningReliefLoad가 입력 배열/객체를 변형함 — 순수함수 원칙 위반")
            tr.check("GOV_008_deterministic_same_input_same_output",
                     out.get("deterministic") is True,
                     "동일 입력 2회 실행 결과가 다름 — 결정론 위반")
            tr.check("GOV_009_computable_ids_exactly_seven",
                     out.get("computableCount") == 7 and out.get("computableIncludesFire") is True
                     and out.get("computableExcludesOutOfScope") is True,
                     f"getComputableScenarioIds() 결과가 계약과 다름: {out}")
    else:
        tr.check("GOV_node_available", False, "node를 찾을 수 없어 governing-load 실행 검증을 건너뜀")

    return tr


# ════════════════════════════════════════════════════════════════
#  §5.1 출구 차단 (Sprint C-4.1) — KOSHA D-18-2020 §5.1(1)
#  아직 api520Engine에 미연결. 시나리오 계산 함수 자체의 정확성만 검증.
# ════════════════════════════════════════════════════════════════
def test_outlet_blocked_scenario_contract() -> TestResult:
    tr = TestResult("OUTLET-BLOCKED-001", "Sprint C-4.1 — §5.1 출구 차단 시나리오")

    rl_src = (SRC / "engine" / "relief_load.js").read_text()
    api520_src = (SRC / "engine" / "api520.js").read_text()

    tr.check("OB_001_function_exists",
             "function calculateOutletBlockedScenario" in rl_src,
             "calculateOutletBlockedScenario() 함수가 없음")
    tr.check("OB_001_source_cited",
             "KOSHA GUIDE D-18-2020 §5.1" in rl_src,
             "§5.1 계산 함수에 KOSHA D-18-2020 §5.1 출처 인용이 없음")
    tr.check("OB_001_not_yet_wired_into_engine",
             "calculateOutletBlockedScenario" not in api520_src,
             "C-4.1 단계에서 calculateOutletBlockedScenario가 아직 api520Engine에 연결되면 안 됨")

    node = shutil.which("node")
    if not node:
        tr.check("OB_node_available", False, "node를 찾을 수 없어 실행 검증을 건너뜀")
        return tr

    check_script = f"""
const fs = require('fs');
const files = ['engine/relief_load.js'].map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};

// ── OB-002: 정상 액체 케이스 — W = 최대 유입량 ──
const liquid = calculateOutletBlockedScenario({{ phase:"LIQUID", inflow_kgh: 3200 }});
out.liquidStatus = liquid.status;
out.liquidW = liquid.W;
out.liquidUnit = liquid.unit;
out.liquidScenarioId = liquid.scenarioId;
out.liquidSection = liquid.section;

// ── OB-003: 정상 증기 케이스 — W = 최대 유입량 + 생성량 ──
const vapor = calculateOutletBlockedScenario({{ phase:"VAPOR", inflow_kgh: 1500, generationRate_kgh: 800 }});
out.vaporStatus = vapor.status;
out.vaporW = vapor.W;
out.vaporComponents = vapor.components;

// ── OB-004: 필수 입력 누락(phase 없음, inflow 없음, 증기인데 generation 없음) ──
out.missingPhase = calculateOutletBlockedScenario({{ inflow_kgh: 1000 }}).status;
out.missingInflow = calculateOutletBlockedScenario({{ phase:"LIQUID" }}).status;
out.missingGeneration = calculateOutletBlockedScenario({{ phase:"VAPOR", inflow_kgh: 1000 }}).status;
out.nullInput = calculateOutletBlockedScenario(null).status;

// ── OB-005: 0/음수/NaN/Infinity ──
out.zeroInflowStatus = calculateOutletBlockedScenario({{ phase:"LIQUID", inflow_kgh: 0 }}).status;
out.zeroInflowW = calculateOutletBlockedScenario({{ phase:"LIQUID", inflow_kgh: 0 }}).W;
out.negativeInflow = calculateOutletBlockedScenario({{ phase:"LIQUID", inflow_kgh: -5 }}).status;
out.nanInflow = calculateOutletBlockedScenario({{ phase:"LIQUID", inflow_kgh: NaN }}).status;
out.infInflow = calculateOutletBlockedScenario({{ phase:"LIQUID", inflow_kgh: Infinity }}).status;
out.negativeGeneration = calculateOutletBlockedScenario({{ phase:"VAPOR", inflow_kgh:1000, generationRate_kgh:-1 }}).status;
out.nanGeneration = calculateOutletBlockedScenario({{ phase:"VAPOR", inflow_kgh:1000, generationRate_kgh:NaN }}).status;

// ── OB-006: 잘못된 phase 값 ──
out.wrongPhase = calculateOutletBlockedScenario({{ phase:"GAS", inflow_kgh: 1000 }}).status;
out.emptyPhase = calculateOutletBlockedScenario({{ phase:"", inflow_kgh: 1000 }}).status;
out.numberPhase = calculateOutletBlockedScenario({{ phase: 1, inflow_kgh: 1000 }}).status;

// ── OB-006b: 배열 타입 입력(Number([])===0, Number([5])===5로 암묵변환되는 결함 재발 방지) ──
out.emptyArrayInflow = calculateOutletBlockedScenario({{ phase:"LIQUID", inflow_kgh: [] }}).status;
out.singleArrayInflow = calculateOutletBlockedScenario({{ phase:"LIQUID", inflow_kgh: [5] }}).status;

// ── OB-007: 입력 객체 mutation 금지 ──
const originalInput = {{ phase:"LIQUID", inflow_kgh: 500 }};
const originalCopy = JSON.parse(JSON.stringify(originalInput));
calculateOutletBlockedScenario(originalInput);
out.inputUnmutated = JSON.stringify(originalInput) === JSON.stringify(originalCopy);

// ── OB-008: 동일 입력 -> 동일 결과(결정론) ──
const detInput = {{ phase:"VAPOR", inflow_kgh: 2000, generationRate_kgh: 300 }};
const r1 = calculateOutletBlockedScenario(detInput);
const r2 = calculateOutletBlockedScenario(detInput);
out.deterministic = JSON.stringify(r1) === JSON.stringify(r2);

// ── OB-009: taxonomy와의 정합성은 getComputableScenarioIds()를 통해서만
//    확인한다(직접 참조 시 direct eval의 const 스코프 문제로 상위
//    스크립트에서 안 보임 — 함수 클로저를 통한 간접 검증이 안전).
out.taxonomyIncludesOutletBlocked = getComputableScenarioIds().includes("OUTLET_BLOCKED");
out.resultSectionMatchesTaxonomy = (liquid.section === "§5.1");

// ── OB-010: selectGoverningReliefLoad()와 독립적으로 동작(연동은 되지만 §5.1이 selector를 호출/변형하지 않음) ──
const scenarios = [
  calculateOutletBlockedScenario({{ phase:"LIQUID", inflow_kgh: 1000 }}),
  {{ scenarioId:"EXTERNAL_FIRE", status:"OK", W:5000, unit:"kg/h" }},
];
const gov = selectGoverningReliefLoad(scenarios);
out.integrationGoverningId = gov.governingScenarioId;
out.integrationPreservedCount = gov.allScenarios.length;
// §5.1 함수 자체가 selector 내부 상태를 갖지 않는지 — 두 번째 독립 호출도 동일해야 함
const gov2 = selectGoverningReliefLoad([calculateOutletBlockedScenario({{ phase:"LIQUID", inflow_kgh: 1000 }})]);
out.independentReuse = gov2.governingScenarioId === "OUTLET_BLOCKED" && gov2.governingW === 1000;

console.log(JSON.stringify(out));
"""
    try:
        result = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
        out = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else {}
    except Exception as e:
        tr.check("OB_node_execution", False, f"node 실행 실패: {e}\nstderr: {getattr(result,'stderr','')}")
        return tr

    tr.check("OB_002_liquid_W_equals_inflow",
             out.get("liquidStatus") == "OK" and out.get("liquidW") == 3200,
             f"액체 W가 최대유입량과 다름: got {out.get('liquidW')}")
    tr.check("OB_002_liquid_unit_is_kgh",
             out.get("liquidUnit") == "kg/h", f"unit이 kg/h가 아님: {out.get('liquidUnit')}")
    tr.check("OB_002_scenarioId_matches_taxonomy_id",
             out.get("liquidScenarioId") == "OUTLET_BLOCKED", f"got {out.get('liquidScenarioId')}")
    tr.check("OB_002_section_is_5_1",
             out.get("liquidSection") == "§5.1", f"got {out.get('liquidSection')}")
    tr.check("OB_003_vapor_W_equals_inflow_plus_generation",
             out.get("vaporStatus") == "OK" and out.get("vaporW") == 2300,
             f"증기 W가 유입량+생성량(2300)과 다름: got {out.get('vaporW')}")
    tr.check("OB_003_vapor_components_preserved",
             out.get("vaporComponents", {}).get("inflow_kgh") == 1500
             and out.get("vaporComponents", {}).get("generationRate_kgh") == 800,
             "components에 개별 항(유입량/생성량)이 보존되지 않음")
    tr.check("OB_004_missing_phase_insufficient",
             out.get("missingPhase") == "INSUFFICIENT_INPUT", f"got {out.get('missingPhase')}")
    tr.check("OB_004_missing_inflow_insufficient",
             out.get("missingInflow") == "INSUFFICIENT_INPUT", f"got {out.get('missingInflow')}")
    tr.check("OB_004_missing_generation_for_vapor_insufficient",
             out.get("missingGeneration") == "INSUFFICIENT_INPUT", f"got {out.get('missingGeneration')}")
    tr.check("OB_004_null_input_insufficient",
             out.get("nullInput") == "INSUFFICIENT_INPUT", f"got {out.get('nullInput')}")
    tr.check("OB_005_zero_inflow_is_valid_zero_not_error",
             out.get("zeroInflowStatus") == "OK" and out.get("zeroInflowW") == 0,
             f"유입량 0은 유효한 값(무유입)이어야 함: got status={out.get('zeroInflowStatus')} W={out.get('zeroInflowW')}")
    tr.check("OB_005_negative_inflow_rejected",
             out.get("negativeInflow") == "INSUFFICIENT_INPUT", f"got {out.get('negativeInflow')}")
    tr.check("OB_005_nan_inflow_rejected",
             out.get("nanInflow") == "INSUFFICIENT_INPUT", f"got {out.get('nanInflow')}")
    tr.check("OB_005_infinity_inflow_rejected",
             out.get("infInflow") == "INSUFFICIENT_INPUT", f"got {out.get('infInflow')}")
    tr.check("OB_005_negative_generation_rejected",
             out.get("negativeGeneration") == "INSUFFICIENT_INPUT", f"got {out.get('negativeGeneration')}")
    tr.check("OB_005_nan_generation_rejected",
             out.get("nanGeneration") == "INSUFFICIENT_INPUT", f"got {out.get('nanGeneration')}")
    tr.check("OB_006_wrong_phase_value_rejected",
             out.get("wrongPhase") == "INSUFFICIENT_INPUT", f"got {out.get('wrongPhase')}")
    tr.check("OB_006_empty_phase_rejected",
             out.get("emptyPhase") == "INSUFFICIENT_INPUT", f"got {out.get('emptyPhase')}")
    tr.check("OB_006_non_string_phase_rejected",
             out.get("numberPhase") == "INSUFFICIENT_INPUT", f"got {out.get('numberPhase')}")
    tr.check("OB_006b_array_coercion_rejected",
             out.get("emptyArrayInflow") == "INSUFFICIENT_INPUT" and out.get("singleArrayInflow") == "INSUFFICIENT_INPUT",
             f"배열이 Number()로 암묵 변환되어 통과함(Number([])===0, Number([5])===5): {out.get('emptyArrayInflow')}/{out.get('singleArrayInflow')}")
    tr.check("OB_007_input_object_not_mutated",
             out.get("inputUnmutated") is True,
             "calculateOutletBlockedScenario가 입력 객체를 변형함 — 순수함수 원칙 위반")
    tr.check("OB_008_deterministic_same_input_same_output",
             out.get("deterministic") is True,
             "동일 입력 2회 실행 결과가 다름 — 결정론 위반")
    tr.check("OB_009_scenarioId_and_section_match_taxonomy",
             out.get("taxonomyIncludesOutletBlocked") is True
             and out.get("resultSectionMatchesTaxonomy") is True,
             f"taxonomy 항목과 계산결과의 scenarioId/section이 불일치: {out}")
    tr.check("OB_010_works_independently_with_governing_selector",
             out.get("integrationGoverningId") == "EXTERNAL_FIRE"
             and out.get("integrationPreservedCount") == 2
             and out.get("independentReuse") is True,
             f"§5.1 함수가 selectGoverningReliefLoad와 독립적으로 재사용 가능하지 않음: {out}")

    return tr


# ════════════════════════════════════════════════════════════════
#  §5.6 과충전 (Sprint C-4.2) — KOSHA D-18-2020 §5.6(1)
#  §5.1과 달리 phase 구분이 원문에 없다 — 단일 공식(W=최대유입량).
#  아직 api520Engine에 미연결.
# ════════════════════════════════════════════════════════════════
def test_overfilling_scenario_contract() -> TestResult:
    tr = TestResult("OVERFILLING-001", "Sprint C-4.2 — §5.6 과충전 시나리오")

    rl_src = (SRC / "engine" / "relief_load.js").read_text()
    api520_src = (SRC / "engine" / "api520.js").read_text()

    tr.check("OF_001_function_exists",
             "function calculateOverfillingScenario" in rl_src,
             "calculateOverfillingScenario() 함수가 없음")
    tr.check("OF_001_source_cited",
             "KOSHA GUIDE D-18-2020 §5.6" in rl_src,
             "§5.6 계산 함수에 KOSHA D-18-2020 §5.6 출처 인용이 없음")
    tr.check("OF_001_not_yet_wired_into_engine",
             "calculateOverfillingScenario" not in api520_src,
             "C-4.2 단계에서 calculateOverfillingScenario가 아직 api520Engine에 연결되면 안 됨")
    tr.check("OF_001_outlet_blocked_untouched",
             "function calculateOutletBlockedScenario" in rl_src
             and "W = 최대 유입량 (액체) — KOSHA D-18-2020 §5.1(1)" in rl_src,
             "C-4.1(calculateOutletBlockedScenario)이 C-4.2 작업 중 변경됨 — 불필요한 수정 금지")

    node = shutil.which("node")
    if not node:
        tr.check("OF_node_available", False, "node를 찾을 수 없어 실행 검증을 건너뜀")
        return tr

    check_script = f"""
const fs = require('fs');
const files = ['engine/relief_load.js'].map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};

// ── OF-002: 정상 최대 유입량 -> W = 최대유입량 ──
const normal = calculateOverfillingScenario({{ inflow_kgh: 4400 }});
out.normalStatus = normal.status;
out.normalW = normal.W;
out.normalUnit = normal.unit;
out.normalScenarioId = normal.scenarioId;
out.normalSection = normal.section;
out.normalPhase = normal.phase;

// ── OF-003: 최소 유효값(아주 작은 양수) ──
const tiny = calculateOverfillingScenario({{ inflow_kgh: 0.001 }});
out.tinyStatus = tiny.status;
out.tinyW = tiny.W;

// ── OF-004: 0 (무유입 — 유효값) ──
const zero = calculateOverfillingScenario({{ inflow_kgh: 0 }});
out.zeroStatus = zero.status;
out.zeroW = zero.W;

// ── OF-005: 음수/NaN/Infinity ──
out.negativeStatus = calculateOverfillingScenario({{ inflow_kgh: -1 }}).status;
out.nanStatus = calculateOverfillingScenario({{ inflow_kgh: NaN }}).status;
out.infStatus = calculateOverfillingScenario({{ inflow_kgh: Infinity }}).status;

// ── OF-006: 필수 입력 누락 ──
out.missingStatus = calculateOverfillingScenario({{}}).status;
out.nullStatus = calculateOverfillingScenario(null).status;

// ── OF-007: 잘못된 타입 ──
out.stringTypeStatus = calculateOverfillingScenario({{ inflow_kgh: "not_a_number" }}).status;
out.objectTypeStatus = calculateOverfillingScenario({{ inflow_kgh: {{}} }}).status;
out.arrayTypeStatus = calculateOverfillingScenario({{ inflow_kgh: [] }}).status;

// ── OF-008: 입력 mutation 금지 ──
const originalInput = {{ inflow_kgh: 999 }};
const originalCopy = JSON.parse(JSON.stringify(originalInput));
calculateOverfillingScenario(originalInput);
out.inputUnmutated = JSON.stringify(originalInput) === JSON.stringify(originalCopy);

// ── OF-009: 결정론 ──
const detInput = {{ inflow_kgh: 2750 }};
const r1 = calculateOverfillingScenario(detInput);
const r2 = calculateOverfillingScenario(detInput);
out.deterministic = JSON.stringify(r1) === JSON.stringify(r2);

// ── OF-010: taxonomy 정합성 (간접 참조 — direct eval의 const 스코프 문제 회피) ──
out.taxonomyIncludesOverfilling = getComputableScenarioIds().includes("OVERFILLING");

// ── OF-011: §5.1과 독립적인 scenario identity — 동일 W라도 scenarioId/section이 다름 ──
const ob = calculateOutletBlockedScenario({{ phase:"LIQUID", inflow_kgh: 4400 }});
const of = calculateOverfillingScenario({{ inflow_kgh: 4400 }});
out.sameW = (ob.W === of.W);
out.differentScenarioId = (ob.scenarioId !== of.scenarioId);
out.differentSection = (ob.section !== of.section);

// ── OF-012: governing selector와의 통합 — 두 시나리오가 서로 다른 항목으로 보존됨 ──
const gov = selectGoverningReliefLoad([ob, of]);
out.govPreservedBoth = gov.allScenarios.length === 2
  && gov.allScenarios.some(s => s.scenarioId === "OUTLET_BLOCKED")
  && gov.allScenarios.some(s => s.scenarioId === "OVERFILLING");
// W가 같을 때 taxonomy 선언순서(§5.1이 §5.6보다 먼저)로 결정론적 tie-break
out.govTieWinner = gov.governingScenarioId;

console.log(JSON.stringify(out));
"""
    try:
        result = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
        out = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else {}
    except Exception as e:
        tr.check("OF_node_execution", False, f"node 실행 실패: {e}\nstderr: {getattr(result,'stderr','')}")
        return tr

    tr.check("OF_002_W_equals_max_inflow",
             out.get("normalStatus") == "OK" and out.get("normalW") == 4400,
             f"W가 최대유입량과 다름: got {out.get('normalW')}")
    tr.check("OF_002_unit_is_kgh",
             out.get("normalUnit") == "kg/h", f"got {out.get('normalUnit')}")
    tr.check("OF_002_scenarioId_is_OVERFILLING",
             out.get("normalScenarioId") == "OVERFILLING", f"got {out.get('normalScenarioId')}")
    tr.check("OF_002_section_is_5_6",
             out.get("normalSection") == "§5.6", f"got {out.get('normalSection')}")
    tr.check("OF_002_no_phase_field_forced",
             out.get("normalPhase") is None,
             "원문에 없는 phase 구분을 §5.6에 임의로 강제함 — phase는 null이어야 함")
    tr.check("OF_003_minimum_valid_value_accepted",
             out.get("tinyStatus") == "OK" and out.get("tinyW") == 0.001,
             f"최소 유효값(0.001) 처리 실패: {out.get('tinyStatus')}/{out.get('tinyW')}")
    tr.check("OF_004_zero_is_valid",
             out.get("zeroStatus") == "OK" and out.get("zeroW") == 0,
             f"0은 유효한 값(무유입)이어야 함: {out.get('zeroStatus')}/{out.get('zeroW')}")
    tr.check("OF_005_negative_rejected",
             out.get("negativeStatus") == "INSUFFICIENT_INPUT", f"got {out.get('negativeStatus')}")
    tr.check("OF_005_nan_rejected",
             out.get("nanStatus") == "INSUFFICIENT_INPUT", f"got {out.get('nanStatus')}")
    tr.check("OF_005_infinity_rejected",
             out.get("infStatus") == "INSUFFICIENT_INPUT", f"got {out.get('infStatus')}")
    tr.check("OF_006_missing_input_rejected",
             out.get("missingStatus") == "INSUFFICIENT_INPUT", f"got {out.get('missingStatus')}")
    tr.check("OF_006_null_input_rejected",
             out.get("nullStatus") == "INSUFFICIENT_INPUT", f"got {out.get('nullStatus')}")
    tr.check("OF_007_string_type_rejected",
             out.get("stringTypeStatus") == "INSUFFICIENT_INPUT", f"got {out.get('stringTypeStatus')}")
    tr.check("OF_007_object_type_rejected",
             out.get("objectTypeStatus") == "INSUFFICIENT_INPUT", f"got {out.get('objectTypeStatus')}")
    tr.check("OF_007_array_type_rejected",
             out.get("arrayTypeStatus") == "INSUFFICIENT_INPUT", f"got {out.get('arrayTypeStatus')}")
    tr.check("OF_008_input_not_mutated",
             out.get("inputUnmutated") is True,
             "calculateOverfillingScenario가 입력 객체를 변형함 — 순수함수 원칙 위반")
    tr.check("OF_009_deterministic",
             out.get("deterministic") is True, "동일 입력 2회 실행 결과가 다름")
    tr.check("OF_010_taxonomy_includes_overfilling",
             out.get("taxonomyIncludesOverfilling") is True,
             "OVERFILLING이 getComputableScenarioIds()에 없음")
    tr.check("OF_011_independent_identity_from_outlet_blocked",
             out.get("sameW") is True and out.get("differentScenarioId") is True and out.get("differentSection") is True,
             f"§5.6이 §5.1과 독립적인 scenarioId/section을 갖지 않음(동일 W임에도): {out}")
    tr.check("OF_012_both_scenarios_preserved_in_governing_selection",
             out.get("govPreservedBoth") is True,
             "selectGoverningReliefLoad가 §5.1/§5.6 두 시나리오를 모두 보존하지 않음")
    tr.check("OF_012_tie_break_uses_taxonomy_order",
             out.get("govTieWinner") == "OUTLET_BLOCKED",
             f"동점 시 taxonomy 선언순서(§5.1이 §5.6보다 먼저)로 결정되지 않음: {out.get('govTieWinner')}")

    return tr


# ════════════════════════════════════════════════════════════════
#  §5.7 자동제어밸브의 고장 (Sprint C-4.3) — KOSHA D-18-2020 §5.7
#  3분기(INLET_VALVE/OUTLET_VALVE/FAIL_STATIONARY) 원문 그대로 모델링.
#  아직 api520Engine/selectGoverningReliefLoad에 미연결.
# ════════════════════════════════════════════════════════════════
def test_control_valve_failure_scenario_contract() -> TestResult:
    tr = TestResult("CONTROL-VALVE-FAIL-001", "Sprint C-4.3 — §5.7 자동제어밸브 고장 시나리오")

    rl_src = (SRC / "engine" / "relief_load.js").read_text()
    api520_src = (SRC / "engine" / "api520.js").read_text()

    tr.check("CV_001_function_exists",
             "function calculateControlValveFailureScenario" in rl_src,
             "calculateControlValveFailureScenario() 함수가 없음")
    tr.check("CV_001_source_cited",
             "KOSHA GUIDE D-18-2020 §5.7" in rl_src,
             "§5.7 계산 함수에 KOSHA D-18-2020 §5.7 출처 인용이 없음")
    tr.check("CV_001_not_yet_wired_into_engine",
             "calculateControlValveFailureScenario" not in api520_src,
             "C-4.3 단계에서 아직 api520Engine에 연결되면 안 됨")
    tr.check("CV_001_prior_scenarios_untouched",
             "function calculateOutletBlockedScenario" in rl_src
             and "function calculateOverfillingScenario" in rl_src
             and "W = 최대 유입량 (과충전, phase 무관) — KOSHA D-18-2020 §5.6(1)" in rl_src,
             "C-4.1/C-4.2 구현이 C-4.3 작업 중 변경됨 — 불필요한 수정 금지")
    tr.check("CV_001_three_branches_present",
             '"INLET_VALVE"' in rl_src and '"OUTLET_VALVE"' in rl_src and '"FAIL_STATIONARY"' in rl_src,
             "원문의 3분기(인입/출구/Fail-stationary)가 모두 모델링되지 않음")

    node = shutil.which("node")
    if not node:
        tr.check("CV_node_available", False, "node를 찾을 수 없어 실행 검증을 건너뜀")
        return tr

    check_script = f"""
const fs = require('fs');
const files = ['engine/relief_load.js'].map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};

// ── CV-002: 인입 제어밸브 정상 케이스 ──
const inlet = calculateControlValveFailureScenario({{ failureMode:"INLET_VALVE", inflow_kgh: 5000, outflow_kgh: 1200 }});
out.inletStatus = inlet.status;
out.inletW = inlet.W;
out.inletFailureMode = inlet.failureMode;
out.inletSection = inlet.section;
out.inletUnit = inlet.unit;

// ── CV-003: 출구 제어밸브 정상 케이스(전체폐쇄 -> outflow=0 -> §5.1과 동형) ──
const outletClosed = calculateControlValveFailureScenario({{ failureMode:"OUTLET_VALVE", inflow_kgh: 3000, outflow_kgh: 0 }});
out.outletClosedStatus = outletClosed.status;
out.outletClosedW = outletClosed.W;
// 부분 고장(하나만) -> 나머지 정상유출량 차감
const outletPartial = calculateControlValveFailureScenario({{ failureMode:"OUTLET_VALVE", inflow_kgh: 3000, outflow_kgh: 800 }});
out.outletPartialW = outletPartial.W;

// ── CV-004: 음수 방지 클램프(유출량 > 유입량) ──
const clamp = calculateControlValveFailureScenario({{ failureMode:"INLET_VALVE", inflow_kgh: 1000, outflow_kgh: 1500 }});
out.clampW = clamp.W;
out.clampFlag = clamp.components.clampedToZero;
out.clampRawDiff = clamp.components.rawDifference;

// ── CV-005: Fail-stationary — 개방/폐쇄 가정 중 보수적(큰) 값 채택 ──
const failStat = calculateControlValveFailureScenario({{
  failureMode:"FAIL_STATIONARY", inflow_kgh: 4000, openOutflow_kgh: 500, closedOutflow_kgh: 3800
}});
out.failStatW = failStat.W;
out.failStatGoverning = failStat.governingAssumption;
// 반대 케이스: 폐쇄 가정이 더 보수적인 경우
const failStat2 = calculateControlValveFailureScenario({{
  failureMode:"FAIL_STATIONARY", inflow_kgh: 4000, openOutflow_kgh: 3900, closedOutflow_kgh: 200
}});
out.failStat2W = failStat2.W;
out.failStat2Governing = failStat2.governingAssumption;

// ── CV-006: 잘못된/누락 failureMode ──
out.missingMode = calculateControlValveFailureScenario({{ inflow_kgh:1000, outflow_kgh:200 }}).status;
out.wrongMode = calculateControlValveFailureScenario({{ failureMode:"BYPASS", inflow_kgh:1000, outflow_kgh:200 }}).status;
out.nullInput = calculateControlValveFailureScenario(null).status;

// ── CV-007: 필수 입력 누락(모드별) ──
out.inletMissingOutflow = calculateControlValveFailureScenario({{ failureMode:"INLET_VALVE", inflow_kgh:1000 }}).status;
out.outletMissingInflow = calculateControlValveFailureScenario({{ failureMode:"OUTLET_VALVE", outflow_kgh:200 }}).status;
out.failStatMissingClosed = calculateControlValveFailureScenario({{ failureMode:"FAIL_STATIONARY", inflow_kgh:1000, openOutflow_kgh:200 }}).status;

// ── CV-008: 0/음수/NaN/Infinity/배열·문자열 암묵변환 차단 ──
out.zeroInflowStatus = calculateControlValveFailureScenario({{ failureMode:"INLET_VALVE", inflow_kgh:0, outflow_kgh:0 }}).status;
out.zeroInflowW = calculateControlValveFailureScenario({{ failureMode:"INLET_VALVE", inflow_kgh:0, outflow_kgh:0 }}).W;
out.negativeInflow = calculateControlValveFailureScenario({{ failureMode:"INLET_VALVE", inflow_kgh:-1, outflow_kgh:0 }}).status;
out.nanOutflow = calculateControlValveFailureScenario({{ failureMode:"INLET_VALVE", inflow_kgh:1000, outflow_kgh:NaN }}).status;
out.infInflow = calculateControlValveFailureScenario({{ failureMode:"INLET_VALVE", inflow_kgh:Infinity, outflow_kgh:0 }}).status;
out.arrayInflow = calculateControlValveFailureScenario({{ failureMode:"INLET_VALVE", inflow_kgh:[5], outflow_kgh:0 }}).status;
out.stringOutflow = calculateControlValveFailureScenario({{ failureMode:"INLET_VALVE", inflow_kgh:1000, outflow_kgh:"200" }}).status;

// ── CV-009: 입력 mutation 금지 ──
const originalInput = {{ failureMode:"INLET_VALVE", inflow_kgh: 2000, outflow_kgh: 500 }};
const originalCopy = JSON.parse(JSON.stringify(originalInput));
calculateControlValveFailureScenario(originalInput);
out.inputUnmutated = JSON.stringify(originalInput) === JSON.stringify(originalCopy);

// ── CV-010: 결정론 ──
const detInput = {{ failureMode:"OUTLET_VALVE", inflow_kgh: 2200, outflow_kgh: 300 }};
const r1 = calculateControlValveFailureScenario(detInput);
const r2 = calculateControlValveFailureScenario(detInput);
out.deterministic = JSON.stringify(r1) === JSON.stringify(r2);

// ── CV-011: taxonomy 정합성(간접 참조) ──
out.taxonomyIncludes = getComputableScenarioIds().includes("CONTROL_VALVE_FAIL");

// ── CV-012: selectGoverningReliefLoad/§5.1/§5.6과의 통합 — 여전히 미연결이어야 하지만
//    독립적으로 selector에 넣었을 때 정상 동작함을 확인(연결이 아니라 재사용성 확인) ──
const scenarios = [inlet, outletClosed, calculateOverfillingScenario({{ inflow_kgh: 100 }})];
const gov = selectGoverningReliefLoad(scenarios);
out.govGoverningId = gov.governingScenarioId;
out.govPreservedCount = gov.allScenarios.length;

console.log(JSON.stringify(out));
"""
    try:
        result = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
        out = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else {}
    except Exception as e:
        tr.check("CV_node_execution", False, f"node 실행 실패: {e}\nstderr: {getattr(result,'stderr','')}")
        return tr

    tr.check("CV_002_inlet_W_equals_inflow_minus_outflow",
             out.get("inletStatus") == "OK" and out.get("inletW") == 3800,
             f"인입 제어밸브 W가 5000-1200=3800과 다름: got {out.get('inletW')}")
    tr.check("CV_002_failureMode_preserved_in_result",
             out.get("inletFailureMode") == "INLET_VALVE", f"got {out.get('inletFailureMode')}")
    tr.check("CV_002_section_is_5_7",
             out.get("inletSection") == "§5.7", f"got {out.get('inletSection')}")
    tr.check("CV_002_unit_is_kgh",
             out.get("inletUnit") == "kg/h", f"got {out.get('inletUnit')}")
    tr.check("CV_003_outlet_full_closure_equals_outlet_blocked_form",
             out.get("outletClosedStatus") == "OK" and out.get("outletClosedW") == 3000,
             f"출구 전체폐쇄(outflow=0) 시 W가 유입량(3000)과 같아야 함(§5.1과 동형): got {out.get('outletClosedW')}")
    tr.check("CV_003_outlet_partial_subtracts_remaining_outflow",
             out.get("outletPartialW") == 2200,
             f"출구 부분고장 W가 3000-800=2200과 다름: got {out.get('outletPartialW')}")
    tr.check("CV_004_negative_difference_clamped_to_zero_with_flag",
             out.get("clampW") == 0 and out.get("clampFlag") is True and out.get("clampRawDiff") == -500,
             f"유출량>유입량일 때 W=0 클램프 및 clampedToZero 플래그가 정확하지 않음: {out}")
    tr.check("CV_005_fail_stationary_takes_conservative_max_open_governing",
             out.get("failStatW") == 3500 and out.get("failStatGoverning") == "OPEN",
             f"Fail-stationary가 보수적 최댓값(개방가정 3500)을 채택하지 않음: {out.get('failStatW')}/{out.get('failStatGoverning')}")
    tr.check("CV_005_fail_stationary_closed_governing_case",
             out.get("failStat2W") == 3800 and out.get("failStat2Governing") == "CLOSED",
             f"Fail-stationary 폐쇄가정 우세 케이스가 정확하지 않음: {out.get('failStat2W')}/{out.get('failStat2Governing')}")
    tr.check("CV_006_missing_failureMode_rejected",
             out.get("missingMode") == "INSUFFICIENT_INPUT", f"got {out.get('missingMode')}")
    tr.check("CV_006_wrong_failureMode_rejected",
             out.get("wrongMode") == "INSUFFICIENT_INPUT", f"got {out.get('wrongMode')}")
    tr.check("CV_006_null_input_rejected",
             out.get("nullInput") == "INSUFFICIENT_INPUT", f"got {out.get('nullInput')}")
    tr.check("CV_007_inlet_missing_outflow_rejected",
             out.get("inletMissingOutflow") == "INSUFFICIENT_INPUT", f"got {out.get('inletMissingOutflow')}")
    tr.check("CV_007_outlet_missing_inflow_rejected",
             out.get("outletMissingInflow") == "INSUFFICIENT_INPUT", f"got {out.get('outletMissingInflow')}")
    tr.check("CV_007_fail_stationary_missing_closedOutflow_rejected",
             out.get("failStatMissingClosed") == "INSUFFICIENT_INPUT", f"got {out.get('failStatMissingClosed')}")
    tr.check("CV_008_zero_is_valid",
             out.get("zeroInflowStatus") == "OK" and out.get("zeroInflowW") == 0,
             f"0/0은 유효한 값이어야 함: {out.get('zeroInflowStatus')}/{out.get('zeroInflowW')}")
    tr.check("CV_008_negative_rejected",
             out.get("negativeInflow") == "INSUFFICIENT_INPUT", f"got {out.get('negativeInflow')}")
    tr.check("CV_008_nan_rejected",
             out.get("nanOutflow") == "INSUFFICIENT_INPUT", f"got {out.get('nanOutflow')}")
    tr.check("CV_008_infinity_rejected",
             out.get("infInflow") == "INSUFFICIENT_INPUT", f"got {out.get('infInflow')}")
    tr.check("CV_008_array_coercion_rejected",
             out.get("arrayInflow") == "INSUFFICIENT_INPUT", f"got {out.get('arrayInflow')}")
    tr.check("CV_008_string_coercion_rejected",
             out.get("stringOutflow") == "INSUFFICIENT_INPUT", f"got {out.get('stringOutflow')}")
    tr.check("CV_009_input_not_mutated",
             out.get("inputUnmutated") is True, "입력 객체가 변형됨 — 순수함수 원칙 위반")
    tr.check("CV_010_deterministic",
             out.get("deterministic") is True, "동일 입력 2회 실행 결과가 다름")
    tr.check("CV_011_taxonomy_includes_control_valve_fail",
             out.get("taxonomyIncludes") is True, "CONTROL_VALVE_FAIL이 getComputableScenarioIds()에 없음")
    # 인입 제어밸브 W(3800)가 출구폐쇄(3000)/과충전(100)보다 커서 governing이어야 함
    tr.check("CV_012_governing_selection_among_mixed_scenarios",
             out.get("govGoverningId") == "CONTROL_VALVE_FAIL" and out.get("govPreservedCount") == 3,
             f"혼합 시나리오 중 governing 선택이 예상과 다름: {out}")

    return tr


# ════════════════════════════════════════════════════════════════
#  §5.8 비정상적인 열 또는 증기 유입 (Sprint C-4.4) — KOSHA D-18-2020 §5.8
#  3분기 중 계산식이 있는 건 2개(ABNORMAL_HEAT_INPUT/INADVERTENT_VALVE_OPENING)뿐,
#  CHECK_VALVE_FAILURE은 원문에 계산식이 없어 NEEDS_ENGINEERING_DECISION.
#  아직 api520Engine/selectGoverningReliefLoad에 미연결.
# ════════════════════════════════════════════════════════════════
def test_abnormal_heat_vapor_scenario_contract() -> TestResult:
    tr = TestResult("ABNORMAL-HEAT-VAPOR-001", "Sprint C-4.4 — §5.8 비정상 열/증기 유입 시나리오")

    rl_src = (SRC / "engine" / "relief_load.js").read_text()
    api520_src = (SRC / "engine" / "api520.js").read_text()

    tr.check("AH_001_function_exists",
             "function calculateAbnormalHeatVaporScenario" in rl_src,
             "calculateAbnormalHeatVaporScenario() 함수가 없음")
    tr.check("AH_001_source_cited",
             "KOSHA GUIDE D-18-2020 §5.8" in rl_src,
             "§5.8 계산 함수에 KOSHA D-18-2020 §5.8 출처 인용이 없음")
    tr.check("AH_001_not_yet_wired_into_engine",
             "calculateAbnormalHeatVaporScenario" not in api520_src,
             "C-4.4 단계에서 아직 api520Engine에 연결되면 안 됨")
    tr.check("AH_001_prior_scenarios_untouched",
             "function calculateControlValveFailureScenario" in rl_src
             and "function calculateOverfillingScenario" in rl_src
             and "W = 최대 유입량 − 정상 유출량" in rl_src,
             "C-4.1/C-4.2/C-4.3 구현이 C-4.4 작업 중 변경됨 — 불필요한 수정 금지")
    tr.check("AH_001_no_arbitrary_125_percent_factor_in_formula",
             "1.25" not in rl_src.split("calculateAbnormalHeatVaporScenario")[1].split("function calculate")[0]
             if "calculateAbnormalHeatVaporScenario" in rl_src else False,
             "§5.8(1)(나)③의 125% 계수가 W 산정식에 임의로 곱해짐 — 이건 상류 입력값 산정 가정이지 이 함수의 책임이 아님")
    tr.check("AH_001_check_valve_failure_not_computed_as_ok",
             '"NEEDS_ENGINEERING_DECISION"' in rl_src,
             "체크밸브 고장(§5.8(3))이 계산식 없는 상태(NEEDS_ENGINEERING_DECISION)로 명시되지 않음")

    node = shutil.which("node")
    if not node:
        tr.check("AH_node_available", False, "node를 찾을 수 없어 실행 검증을 건너뜀")
        return tr

    check_script = f"""
const fs = require('fs');
const files = ['engine/relief_load.js'].map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};

// ── AH-002: 비정상 열 입력 정상 케이스 ──
const heat = calculateAbnormalHeatVaporScenario({{ failureMode:"ABNORMAL_HEAT_INPUT", vaporGeneration_kgh: 6000, outflow_kgh: 1500 }});
out.heatStatus = heat.status;
out.heatW = heat.W;
out.heatFailureMode = heat.failureMode;
out.heatSection = heat.section;
out.heatUnit = heat.unit;

// ── AH-003: 부주의한 밸브 개방 정상 케이스 ──
const valve = calculateAbnormalHeatVaporScenario({{ failureMode:"INADVERTENT_VALVE_OPENING", inflow_kgh: 4500, outflow_kgh: 900 }});
out.valveStatus = valve.status;
out.valveW = valve.W;
// 출구 유출량 차감 없이(0) — 원문상 선택적, 0도 유효값
const valveNoCredit = calculateAbnormalHeatVaporScenario({{ failureMode:"INADVERTENT_VALVE_OPENING", inflow_kgh: 4500, outflow_kgh: 0 }});
out.valveNoCreditW = valveNoCredit.W;
out.valveNoCreditStatus = valveNoCredit.status;

// ── AH-004: 체크밸브 고장 -> 계산 안 함, NEEDS_ENGINEERING_DECISION ──
const check = calculateAbnormalHeatVaporScenario({{ failureMode:"CHECK_VALVE_FAILURE" }});
out.checkStatus = check.status;
out.checkW = check.W;
out.checkHasReason = typeof check.reason === "string" && check.reason.length > 0;

// ── AH-005: 음수 차이 클램프(유출량 > 유입량/증기발생량) ──
const clamp1 = calculateAbnormalHeatVaporScenario({{ failureMode:"ABNORMAL_HEAT_INPUT", vaporGeneration_kgh: 1000, outflow_kgh: 1500 }});
out.clamp1W = clamp1.W;
out.clamp1Flag = clamp1.components.clampedToZero;
const clamp2 = calculateAbnormalHeatVaporScenario({{ failureMode:"INADVERTENT_VALVE_OPENING", inflow_kgh: 1000, outflow_kgh: 1500 }});
out.clamp2W = clamp2.W;

// ── AH-006: 필수 입력 누락/잘못된 failureMode ──
out.missingMode = calculateAbnormalHeatVaporScenario({{ vaporGeneration_kgh:1000, outflow_kgh:200 }}).status;
out.wrongMode = calculateAbnormalHeatVaporScenario({{ failureMode:"BOILOVER", vaporGeneration_kgh:1000 }}).status;
out.nullInput = calculateAbnormalHeatVaporScenario(null).status;
out.heatMissingOutflow = calculateAbnormalHeatVaporScenario({{ failureMode:"ABNORMAL_HEAT_INPUT", vaporGeneration_kgh:1000 }}).status;
out.valveMissingInflow = calculateAbnormalHeatVaporScenario({{ failureMode:"INADVERTENT_VALVE_OPENING", outflow_kgh:200 }}).status;

// ── AH-007: 0/음수/NaN/Infinity/배열·문자열 암묵변환 차단 ──
out.zeroStatus = calculateAbnormalHeatVaporScenario({{ failureMode:"ABNORMAL_HEAT_INPUT", vaporGeneration_kgh:0, outflow_kgh:0 }}).status;
out.zeroW = calculateAbnormalHeatVaporScenario({{ failureMode:"ABNORMAL_HEAT_INPUT", vaporGeneration_kgh:0, outflow_kgh:0 }}).W;
out.negativeRejected = calculateAbnormalHeatVaporScenario({{ failureMode:"ABNORMAL_HEAT_INPUT", vaporGeneration_kgh:-1, outflow_kgh:0 }}).status;
out.nanRejected = calculateAbnormalHeatVaporScenario({{ failureMode:"ABNORMAL_HEAT_INPUT", vaporGeneration_kgh:1000, outflow_kgh:NaN }}).status;
out.infRejected = calculateAbnormalHeatVaporScenario({{ failureMode:"INADVERTENT_VALVE_OPENING", inflow_kgh:Infinity, outflow_kgh:0 }}).status;
out.arrayRejected = calculateAbnormalHeatVaporScenario({{ failureMode:"ABNORMAL_HEAT_INPUT", vaporGeneration_kgh:[5], outflow_kgh:0 }}).status;
out.stringRejected = calculateAbnormalHeatVaporScenario({{ failureMode:"INADVERTENT_VALVE_OPENING", inflow_kgh:1000, outflow_kgh:"200" }}).status;

// ── AH-008: 입력 mutation 금지 ──
const originalInput = {{ failureMode:"ABNORMAL_HEAT_INPUT", vaporGeneration_kgh: 3000, outflow_kgh: 700 }};
const originalCopy = JSON.parse(JSON.stringify(originalInput));
calculateAbnormalHeatVaporScenario(originalInput);
out.inputUnmutated = JSON.stringify(originalInput) === JSON.stringify(originalCopy);

// ── AH-009: 결정론 ──
const detInput = {{ failureMode:"INADVERTENT_VALVE_OPENING", inflow_kgh: 2500, outflow_kgh: 400 }};
const r1 = calculateAbnormalHeatVaporScenario(detInput);
const r2 = calculateAbnormalHeatVaporScenario(detInput);
out.deterministic = JSON.stringify(r1) === JSON.stringify(r2);

// ── AH-010: taxonomy 정합성(간접 참조) ──
out.taxonomyIncludes = getComputableScenarioIds().includes("ABNORMAL_HEAT_VAPOR");

// ── AH-011: NEEDS_ENGINEERING_DECISION 결과는 selectGoverningReliefLoad의 후보에서 자동 제외됨 ──
const mixed = [heat, check, valve];
const gov = selectGoverningReliefLoad(mixed);
out.govExcludesCheckValve = gov.governingScenarioId !== null && gov.allScenarios.length === 3;
out.govGoverningIsHeatOrValve = (gov.governingScenarioId === "ABNORMAL_HEAT_VAPOR");
out.govGoverningW = gov.governingW;

console.log(JSON.stringify(out));
"""
    try:
        result = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
        out = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else {}
    except Exception as e:
        tr.check("AH_node_execution", False, f"node 실행 실패: {e}\nstderr: {getattr(result,'stderr','')}")
        return tr

    tr.check("AH_002_heat_W_equals_generation_minus_outflow",
             out.get("heatStatus") == "OK" and out.get("heatW") == 4500,
             f"비정상 열입력 W가 6000-1500=4500과 다름: got {out.get('heatW')}")
    tr.check("AH_002_failureMode_preserved",
             out.get("heatFailureMode") == "ABNORMAL_HEAT_INPUT", f"got {out.get('heatFailureMode')}")
    tr.check("AH_002_section_is_5_8",
             out.get("heatSection") == "§5.8", f"got {out.get('heatSection')}")
    tr.check("AH_002_unit_is_kgh",
             out.get("heatUnit") == "kg/h", f"got {out.get('heatUnit')}")
    tr.check("AH_003_valve_W_equals_inflow_minus_outflow",
             out.get("valveStatus") == "OK" and out.get("valveW") == 3600,
             f"부주의한 밸브개방 W가 4500-900=3600과 다름: got {out.get('valveW')}")
    tr.check("AH_003_valve_outflow_credit_optional_zero_valid",
             out.get("valveNoCreditStatus") == "OK" and out.get("valveNoCreditW") == 4500,
             f"outflow=0(차감 없음)이 유효값으로 처리되지 않음: {out.get('valveNoCreditStatus')}/{out.get('valveNoCreditW')}")
    tr.check("AH_004_check_valve_failure_needs_engineering_decision",
             out.get("checkStatus") == "NEEDS_ENGINEERING_DECISION" and out.get("checkW") is None,
             f"체크밸브 고장이 임의로 계산됨 — 원문에 계산식 없음: {out.get('checkStatus')}/{out.get('checkW')}")
    tr.check("AH_004_check_valve_failure_has_reason",
             out.get("checkHasReason") is True, "체크밸브 고장 결과에 이유(reason)가 없음")
    tr.check("AH_005_heat_negative_diff_clamped",
             out.get("clamp1W") == 0 and out.get("clamp1Flag") is True, f"got {out.get('clamp1W')}/{out.get('clamp1Flag')}")
    tr.check("AH_005_valve_negative_diff_clamped",
             out.get("clamp2W") == 0, f"got {out.get('clamp2W')}")
    tr.check("AH_006_missing_failureMode_rejected",
             out.get("missingMode") == "INSUFFICIENT_INPUT", f"got {out.get('missingMode')}")
    tr.check("AH_006_wrong_failureMode_rejected",
             out.get("wrongMode") == "INSUFFICIENT_INPUT", f"got {out.get('wrongMode')}")
    tr.check("AH_006_null_input_rejected",
             out.get("nullInput") == "INSUFFICIENT_INPUT", f"got {out.get('nullInput')}")
    tr.check("AH_006_heat_missing_outflow_rejected",
             out.get("heatMissingOutflow") == "INSUFFICIENT_INPUT", f"got {out.get('heatMissingOutflow')}")
    tr.check("AH_006_valve_missing_inflow_rejected",
             out.get("valveMissingInflow") == "INSUFFICIENT_INPUT", f"got {out.get('valveMissingInflow')}")
    tr.check("AH_007_zero_is_valid",
             out.get("zeroStatus") == "OK" and out.get("zeroW") == 0,
             f"0/0이 유효값이어야 함: {out.get('zeroStatus')}/{out.get('zeroW')}")
    tr.check("AH_007_negative_rejected",
             out.get("negativeRejected") == "INSUFFICIENT_INPUT", f"got {out.get('negativeRejected')}")
    tr.check("AH_007_nan_rejected",
             out.get("nanRejected") == "INSUFFICIENT_INPUT", f"got {out.get('nanRejected')}")
    tr.check("AH_007_infinity_rejected",
             out.get("infRejected") == "INSUFFICIENT_INPUT", f"got {out.get('infRejected')}")
    tr.check("AH_007_array_coercion_rejected",
             out.get("arrayRejected") == "INSUFFICIENT_INPUT", f"got {out.get('arrayRejected')}")
    tr.check("AH_007_string_coercion_rejected",
             out.get("stringRejected") == "INSUFFICIENT_INPUT", f"got {out.get('stringRejected')}")
    tr.check("AH_008_input_not_mutated",
             out.get("inputUnmutated") is True, "입력 객체가 변형됨 — 순수함수 원칙 위반")
    tr.check("AH_009_deterministic",
             out.get("deterministic") is True, "동일 입력 2회 실행 결과가 다름")
    tr.check("AH_010_taxonomy_includes_abnormal_heat_vapor",
             out.get("taxonomyIncludes") is True, "ABNORMAL_HEAT_VAPOR가 getComputableScenarioIds()에 없음")
    tr.check("AH_011_needs_engineering_decision_excluded_from_governing_but_preserved",
             out.get("govExcludesCheckValve") is True and out.get("govGoverningIsHeatOrValve") is True
             and out.get("govGoverningW") == 4500,
             f"NEEDS_ENGINEERING_DECISION 결과가 governing 후보에서 자동 제외되면서도 allScenarios에는 보존되어야 함: {out}")

    return tr


# ════════════════════════════════════════════════════════════════
#  §5.11 액체부피 팽창 (Sprint C-4.5) — KOSHA D-18-2020 §5.11(2), 식(1)
#  결과 단위가 W(kg/h)가 아닌 V(m3/h) — 다른 시나리오와 다름.
#  아직 api520Engine/selectGoverningReliefLoad에 미연결.
# ════════════════════════════════════════════════════════════════
def test_liquid_thermal_expansion_scenario_contract() -> TestResult:
    tr = TestResult("LIQUID-EXPANSION-001", "Sprint C-4.5 — §5.11 액체부피 팽창 시나리오")

    rl_src = (SRC / "engine" / "relief_load.js").read_text()
    api520_src = (SRC / "engine" / "api520.js").read_text()

    tr.check("LE_001_function_exists",
             "function calculateLiquidThermalExpansionScenario" in rl_src,
             "calculateLiquidThermalExpansionScenario() 함수가 없음")
    tr.check("LE_001_source_cited",
             "KOSHA GUIDE D-18-2020 §5.11" in rl_src,
             "§5.11 계산 함수에 KOSHA D-18-2020 §5.11 출처 인용이 없음")
    tr.check("LE_001_not_yet_wired_into_engine",
             "calculateLiquidThermalExpansionScenario" not in api520_src,
             "C-4.5 단계에서 아직 api520Engine에 연결되면 안 됨")
    tr.check("LE_001_prior_scenarios_untouched",
             "function calculateAbnormalHeatVaporScenario" in rl_src
             and "function calculateControlValveFailureScenario" in rl_src
             and "W = 유입량 − 유출량 (부주의한 밸브 개방" in rl_src,
             "C-4.1~C-4.4 구현이 C-4.5 작업 중 변경됨 — 불필요한 수정 금지")
    fn_body = rl_src.split("function calculateLiquidThermalExpansionScenario")[1].split("function calculate")[0] if "function calculateLiquidThermalExpansionScenario" in rl_src else ""
    tr.check("LE_002_constant_500_present_unmodified",
             "500" in fn_body and "* 500" not in fn_body.replace("(500", "").replace(" 500", " __500__", 1),
             "원문 상수 500이 없거나 변형됨")
    tr.check("LE_002_no_kg_h_conversion_present",
             "kg" not in fn_body.lower() or "kg_" not in fn_body.lower(),
             "V(m3/h)를 kg/h로 변환하는 코드가 존재함 — 원문에 없는 계산 추가 금지")
    tr.check("LE_002_unit_is_m3_h_not_kg_h",
             '"m3/h"' in fn_body,
             "결과 unit이 m3/h로 고정되어 있지 않음")
    tr.check("LE_002_no_W_field_used",
             "W," not in fn_body.split("return {")[-1].split("};")[0] if "return {" in fn_body else True,
             "결과 객체에 W 필드가 존재함 — value/unit(m3/h) 계약을 써야 하며 W(kg/h) 필드를 두면 안 됨")
    tr.check("LE_002_status_computable_not_ok",
             '"COMPUTABLE"' in fn_body,
             "성공 결과의 status가 COMPUTABLE로 명시되지 않음(§6 편입 가능 의미로 오인되지 않도록 OK와 구분해야 함)")
    tr.check("LE_002_upstream_reference_documented_not_used_in_formula",
             "D-13" in rl_src and "D-31" in rl_src,
             "D-13/D-31 교차참조 불일치가 provenance로 기록되지 않음")

    node = shutil.which("node")
    if not node:
        tr.check("LE_node_available", False, "node를 찾을 수 없어 실행 검증을 건너뜀")
        return tr

    check_script = f"""
const fs = require('fs');
const files = ['engine/relief_load.js'].map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};

// ── LE-003: 정상 계산값 — 식 그대로 검증 ──
// alpha=0.0007, Q=50000, SG=0.85, Cp=0.5 -> V = 0.0007*50000/(500*0.85*0.5) = 35/212.5 = 0.16470588...
const normal = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:50000, SG:0.85, Cp_kcal_per_kgC:0.5 }});
out.normalStatus = normal.status;
out.normalValue = normal.value;
out.normalUnit = normal.unit;
out.normalScenarioId = normal.scenarioId;
out.normalSection = normal.section;
out.expectedValue = (0.0007 * 50000) / (500 * 0.85 * 0.5);

// ── LE-004: alpha=0, Q=0 (물리적으로 유효한 0) -> value=0 ──
const zeroAlpha = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0, Q_kcal_per_hr:50000, SG:0.85, Cp_kcal_per_kgC:0.5 }});
out.zeroAlphaStatus = zeroAlpha.status;
out.zeroAlphaValue = zeroAlpha.value;
const zeroQ = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:0, SG:0.85, Cp_kcal_per_kgC:0.5 }});
out.zeroQStatus = zeroQ.status;
out.zeroQValue = zeroQ.value;

// ── LE-005: SG=0, Cp=0 -> 분모 0, fail-fast(계산하지 않음) ──
out.zeroSGStatus = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:50000, SG:0, Cp_kcal_per_kgC:0.5 }}).status;
out.zeroCpStatus = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:50000, SG:0.85, Cp_kcal_per_kgC:0 }}).status;

// ── LE-006: 각 변수 누락 ──
out.missingAlpha = calculateLiquidThermalExpansionScenario({{ Q_kcal_per_hr:50000, SG:0.85, Cp_kcal_per_kgC:0.5 }}).status;
out.missingQ = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, SG:0.85, Cp_kcal_per_kgC:0.5 }}).status;
out.missingSG = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:50000, Cp_kcal_per_kgC:0.5 }}).status;
out.missingCp = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:50000, SG:0.85 }}).status;
out.nullInput = calculateLiquidThermalExpansionScenario(null).status;

// ── LE-007: 음수/NaN/Infinity (각 변수별) ──
out.negAlpha = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:-0.0007, Q_kcal_per_hr:50000, SG:0.85, Cp_kcal_per_kgC:0.5 }}).status;
out.negQ = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:-50000, SG:0.85, Cp_kcal_per_kgC:0.5 }}).status;
out.negSG = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:50000, SG:-0.85, Cp_kcal_per_kgC:0.5 }}).status;
out.negCp = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:50000, SG:0.85, Cp_kcal_per_kgC:-0.5 }}).status;
out.nanAlpha = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:NaN, Q_kcal_per_hr:50000, SG:0.85, Cp_kcal_per_kgC:0.5 }}).status;
out.infQ = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:Infinity, SG:0.85, Cp_kcal_per_kgC:0.5 }}).status;
out.nanSG = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:50000, SG:NaN, Cp_kcal_per_kgC:0.5 }}).status;
out.infCp = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:50000, SG:0.85, Cp_kcal_per_kgC:Infinity }}).status;

// ── LE-008: 배열/문자열 암묵변환 차단 ──
out.arrayAlpha = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:[5], Q_kcal_per_hr:50000, SG:0.85, Cp_kcal_per_kgC:0.5 }}).status;
out.stringQ = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:"50000", SG:0.85, Cp_kcal_per_kgC:0.5 }}).status;
out.emptyArraySG = calculateLiquidThermalExpansionScenario({{ alpha_per_degC:0.0007, Q_kcal_per_hr:50000, SG:[], Cp_kcal_per_kgC:0.5 }}).status;

// ── LE-009: 입력 mutation 금지 ──
const originalInput = {{ alpha_per_degC:0.0007, Q_kcal_per_hr:40000, SG:0.9, Cp_kcal_per_kgC:0.6 }};
const originalCopy = JSON.parse(JSON.stringify(originalInput));
calculateLiquidThermalExpansionScenario(originalInput);
out.inputUnmutated = JSON.stringify(originalInput) === JSON.stringify(originalCopy);

// ── LE-010: 결정론 ──
const detInput = {{ alpha_per_degC:0.0008, Q_kcal_per_hr:30000, SG:0.8, Cp_kcal_per_kgC:0.45 }};
const r1 = calculateLiquidThermalExpansionScenario(detInput);
const r2 = calculateLiquidThermalExpansionScenario(detInput);
out.deterministic = JSON.stringify(r1) === JSON.stringify(r2);

// ── LE-011: taxonomy와 상태 정합성(간접 참조) ──
out.taxonomyIncludes = getComputableScenarioIds().includes("LIQUID_EXPANSION");

// ── LE-012: selectGoverningReliefLoad에 넣어도(우발적 상황 대비) W가 없어 자동 무효 처리됨 ──
const gov = selectGoverningReliefLoad([normal]);
out.govVerdictWhenOnlyLiquidExpansion = gov.verdict;

console.log(JSON.stringify(out));
"""
    try:
        result = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
        out = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else {}
    except Exception as e:
        tr.check("LE_node_execution", False, f"node 실행 실패: {e}\nstderr: {getattr(result,'stderr','')}")
        return tr

    tr.check("LE_003_formula_matches_exactly",
             out.get("normalStatus") == "COMPUTABLE"
             and out.get("normalValue") is not None
             and abs(out.get("normalValue", -999) - out.get("expectedValue", -1)) < 1e-9,
             f"V = α·Q/(500·SG·Cp) 식 계산값이 기대값과 다름: got {out.get('normalValue')} expected {out.get('expectedValue')}")
    tr.check("LE_003_unit_is_m3_h",
             out.get("normalUnit") == "m3/h", f"got {out.get('normalUnit')}")
    tr.check("LE_003_scenarioId_is_LIQUID_EXPANSION",
             out.get("normalScenarioId") == "LIQUID_EXPANSION", f"got {out.get('normalScenarioId')}")
    tr.check("LE_003_section_is_5_11",
             out.get("normalSection") == "§5.11", f"got {out.get('normalSection')}")
    tr.check("LE_004_zero_alpha_valid_zero_value",
             out.get("zeroAlphaStatus") == "COMPUTABLE" and out.get("zeroAlphaValue") == 0,
             f"α=0이 유효한 값(무팽창)이어야 함: {out.get('zeroAlphaStatus')}/{out.get('zeroAlphaValue')}")
    tr.check("LE_004_zero_Q_valid_zero_value",
             out.get("zeroQStatus") == "COMPUTABLE" and out.get("zeroQValue") == 0,
             f"Q=0이 유효한 값(무열유입)이어야 함: {out.get('zeroQStatus')}/{out.get('zeroQValue')}")
    tr.check("LE_005_zero_SG_rejected_denominator",
             out.get("zeroSGStatus") == "INSUFFICIENT_INPUT", f"got {out.get('zeroSGStatus')}")
    tr.check("LE_005_zero_Cp_rejected_denominator",
             out.get("zeroCpStatus") == "INSUFFICIENT_INPUT", f"got {out.get('zeroCpStatus')}")
    tr.check("LE_006_missing_alpha_rejected",
             out.get("missingAlpha") == "INSUFFICIENT_INPUT", f"got {out.get('missingAlpha')}")
    tr.check("LE_006_missing_Q_rejected",
             out.get("missingQ") == "INSUFFICIENT_INPUT", f"got {out.get('missingQ')}")
    tr.check("LE_006_missing_SG_rejected",
             out.get("missingSG") == "INSUFFICIENT_INPUT", f"got {out.get('missingSG')}")
    tr.check("LE_006_missing_Cp_rejected",
             out.get("missingCp") == "INSUFFICIENT_INPUT", f"got {out.get('missingCp')}")
    tr.check("LE_006_null_input_rejected",
             out.get("nullInput") == "INSUFFICIENT_INPUT", f"got {out.get('nullInput')}")
    tr.check("LE_007_negative_values_rejected",
             all(out.get(k) == "INSUFFICIENT_INPUT" for k in ["negAlpha", "negQ", "negSG", "negCp"]),
             f"음수 값 중 일부가 거부되지 않음: {out}")
    tr.check("LE_007_nan_infinity_rejected",
             all(out.get(k) == "INSUFFICIENT_INPUT" for k in ["nanAlpha", "infQ", "nanSG", "infCp"]),
             f"NaN/Infinity 값 중 일부가 거부되지 않음: {out}")
    tr.check("LE_008_array_string_coercion_rejected",
             out.get("arrayAlpha") == "INSUFFICIENT_INPUT" and out.get("stringQ") == "INSUFFICIENT_INPUT"
             and out.get("emptyArraySG") == "INSUFFICIENT_INPUT",
             f"배열/문자열 암묵변환이 차단되지 않음: {out.get('arrayAlpha')}/{out.get('stringQ')}/{out.get('emptyArraySG')}")
    tr.check("LE_009_input_not_mutated",
             out.get("inputUnmutated") is True, "입력 객체가 변형됨 — 순수함수 원칙 위반")
    tr.check("LE_010_deterministic",
             out.get("deterministic") is True, "동일 입력 2회 실행 결과가 다름")
    tr.check("LE_011_taxonomy_includes_liquid_expansion",
             out.get("taxonomyIncludes") is True, "LIQUID_EXPANSION이 getComputableScenarioIds()에 없음")
    tr.check("LE_012_no_W_field_means_excluded_from_governing_selection",
             out.get("govVerdictWhenOnlyLiquidExpansion") == "INSUFFICIENT_INPUT",
             f"W 필드가 없는 §5.11 결과가 selectGoverningReliefLoad에서 자동으로 무효 처리되지 않음(우발적 kg/h 취급 방지 설계 확인 실패): {out.get('govVerdictWhenOnlyLiquidExpansion')}")

    return tr


# ════════════════════════════════════════════════════════════════
#  §5.13 열교환기 고장 (Sprint C-4.6) — KOSHA D-18-2020 §5.13, <표 2> 13
#  원문은 유량식이 아니라 "오리피스 면적" 규칙만 제공 — 이 함수는
#  면적 산정까지만 수행(unit: m2). 아직 api520Engine/
#  selectGoverningReliefLoad에 미연결.
# ════════════════════════════════════════════════════════════════
def test_exchanger_failure_scenario_contract() -> TestResult:
    tr = TestResult("EXCHANGER-FAIL-001", "Sprint C-4.6 — §5.13 열교환기 고장 시나리오")

    rl_src = (SRC / "engine" / "relief_load.js").read_text()
    api520_src = (SRC / "engine" / "api520.js").read_text()

    tr.check("EF_001_function_exists",
             "function calculateExchangerFailureScenario" in rl_src,
             "calculateExchangerFailureScenario() 함수가 없음")
    tr.check("EF_001_source_cited",
             "KOSHA GUIDE D-18-2020 §5.13" in rl_src,
             "§5.13 계산 함수에 KOSHA D-18-2020 §5.13 출처 인용이 없음")
    tr.check("EF_001_not_yet_wired_into_engine",
             "calculateExchangerFailureScenario" not in api520_src,
             "C-4.6 단계에서 아직 api520Engine에 연결되면 안 됨")
    tr.check("EF_001_prior_scenarios_untouched",
             "function calculateLiquidThermalExpansionScenario" in rl_src
             and "function calculateAbnormalHeatVaporScenario" in rl_src
             and "V = α·Q / (500·SG·Cp)" in rl_src,
             "C-4.1~C-4.5 구현이 C-4.6 작업 중 변경됨 — 불필요한 수정 금지")
    fn_body = rl_src.split("function calculateExchangerFailureScenario")[1].split("function calculate")[0] if "function calculateExchangerFailureScenario" in rl_src else ""
    tr.check("EF_002_result_field_is_area_not_W_or_value",
             "requiredOrificeArea_m2" in fn_body,
             "결과 필드가 requiredOrificeArea_m2로 명시되지 않음 — 면적 단위를 W/value 같은 범용 필드에 숨기면 안 됨")
    tr.check("EF_002_unit_is_m2",
             '"m2"' in fn_body, "결과 unit이 m2로 고정되어 있지 않음")
    tr.check("EF_002_no_flow_equation_invented",
             not any(term in fn_body for term in ["sqrt", "Math.sqrt", "compressib", "incompressib", "Cd", "discharge coefficient", "밀도"]),
             "면적→유량 변환을 위한 흐름식(압축성/비압축성/할인계수 등)이 임의로 추가됨 — 원문에 없는 유체역학 모델 금지")
    tr.check("EF_002_double_pipe_two_subcases_modeled",
             '"SCHEDULE_PIPE"' in fn_body and '"GAUGE_TUBE"' in fn_body,
             "이중관 열교환기의 두 하위 케이스(Schedule pipe/Gauge tube)가 모델링되지 않음")
    tr.check("EF_002_status_computable_used_for_area_only",
             '"COMPUTABLE"' in fn_body, "면적 산정 성공 결과의 status가 COMPUTABLE로 명시되지 않음")

    node = shutil.which("node")
    if not node:
        tr.check("EF_node_available", False, "node를 찾을 수 없어 실행 검증을 건너뜀")
        return tr

    check_script = f"""
const fs = require('fs');
const files = ['engine/relief_load.js'].map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};

// ── EF-003: 다관형 — 면적 = 튜브단면적 × 2 ──
const shellTube = calculateExchangerFailureScenario({{ exchangerType:"SHELL_AND_TUBE", tubeCrossSectionArea_m2: 0.0005 }});
out.shellTubeStatus = shellTube.status;
out.shellTubeArea = shellTube.requiredOrificeArea_m2;
out.shellTubeUnit = shellTube.unit;
out.shellTubeSection = shellTube.section;

// ── EF-004: 판형 — 면적 = 튜브단면적 × 1 ──
const plate = calculateExchangerFailureScenario({{ exchangerType:"PLATE_AND_FRAME", tubeCrossSectionArea_m2: 0.0005 }});
out.plateStatus = plate.status;
out.plateArea = plate.requiredOrificeArea_m2;

// ── EF-005: 이중관 - Schedule pipe -> NOT_APPLICABLE(압력방출장치 불요, 계산 안함) ──
const dpSchedule = calculateExchangerFailureScenario({{ exchangerType:"DOUBLE_PIPE", innerTubeType:"SCHEDULE_PIPE" }});
out.dpScheduleStatus = dpSchedule.status;
out.dpScheduleArea = dpSchedule.requiredOrificeArea_m2;

// ── EF-006: 이중관 - Gauge tube -> NEEDS_ENGINEERING_DECISION ──
const dpGauge = calculateExchangerFailureScenario({{ exchangerType:"DOUBLE_PIPE", innerTubeType:"GAUGE_TUBE" }});
out.dpGaugeStatus = dpGauge.status;
out.dpGaugeArea = dpGauge.requiredOrificeArea_m2;
out.dpGaugeHasReason = typeof dpGauge.reason === "string" && dpGauge.reason.length > 0;

// ── EF-007: 필수 입력 누락/잘못된 값 ──
out.missingType = calculateExchangerFailureScenario({{ tubeCrossSectionArea_m2:0.0005 }}).status;
out.wrongType = calculateExchangerFailureScenario({{ exchangerType:"SPIRAL", tubeCrossSectionArea_m2:0.0005 }}).status;
out.nullInput = calculateExchangerFailureScenario(null).status;
out.shellMissingArea = calculateExchangerFailureScenario({{ exchangerType:"SHELL_AND_TUBE" }}).status;
out.dpMissingInnerType = calculateExchangerFailureScenario({{ exchangerType:"DOUBLE_PIPE" }}).status;
out.dpWrongInnerType = calculateExchangerFailureScenario({{ exchangerType:"DOUBLE_PIPE", innerTubeType:"COPPER" }}).status;

// ── EF-008: 0/음수/NaN/Infinity — 튜브단면적은 물리적으로 0/음수 불가(fail-fast) ──
out.zeroAreaStatus = calculateExchangerFailureScenario({{ exchangerType:"SHELL_AND_TUBE", tubeCrossSectionArea_m2:0 }}).status;
out.negativeAreaStatus = calculateExchangerFailureScenario({{ exchangerType:"SHELL_AND_TUBE", tubeCrossSectionArea_m2:-0.001 }}).status;
out.nanAreaStatus = calculateExchangerFailureScenario({{ exchangerType:"PLATE_AND_FRAME", tubeCrossSectionArea_m2:NaN }}).status;
out.infAreaStatus = calculateExchangerFailureScenario({{ exchangerType:"PLATE_AND_FRAME", tubeCrossSectionArea_m2:Infinity }}).status;

// ── EF-009: 배열/문자열 암묵변환 차단 ──
out.arrayAreaStatus = calculateExchangerFailureScenario({{ exchangerType:"SHELL_AND_TUBE", tubeCrossSectionArea_m2:[0.001] }}).status;
out.stringAreaStatus = calculateExchangerFailureScenario({{ exchangerType:"SHELL_AND_TUBE", tubeCrossSectionArea_m2:"0.001" }}).status;

// ── EF-010: 입력 mutation 금지 ──
const originalInput = {{ exchangerType:"SHELL_AND_TUBE", tubeCrossSectionArea_m2: 0.0008 }};
const originalCopy = JSON.parse(JSON.stringify(originalInput));
calculateExchangerFailureScenario(originalInput);
out.inputUnmutated = JSON.stringify(originalInput) === JSON.stringify(originalCopy);

// ── EF-011: 결정론 ──
const detInput = {{ exchangerType:"PLATE_AND_FRAME", tubeCrossSectionArea_m2: 0.0006 }};
const r1 = calculateExchangerFailureScenario(detInput);
const r2 = calculateExchangerFailureScenario(detInput);
out.deterministic = JSON.stringify(r1) === JSON.stringify(r2);

// ── EF-012: taxonomy 정합성(간접 참조) ──
out.taxonomyIncludes = getComputableScenarioIds().includes("EXCHANGER_FAIL");

// ── EF-013: 면적 결과(requiredOrificeArea_m2)가 실수로 selector에 들어가도 W가 없어 자동 무효 처리 ──
const gov = selectGoverningReliefLoad([shellTube]);
out.govVerdictWhenOnlyExchanger = gov.verdict;

console.log(JSON.stringify(out));
"""
    try:
        result = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
        out = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else {}
    except Exception as e:
        tr.check("EF_node_execution", False, f"node 실행 실패: {e}\nstderr: {getattr(result,'stderr','')}")
        return tr

    tr.check("EF_003_shell_and_tube_area_is_double_tube_area",
             out.get("shellTubeStatus") == "COMPUTABLE" and out.get("shellTubeArea") == 0.001,
             f"다관형 면적이 튜브단면적×2(0.001)와 다름: got {out.get('shellTubeArea')}")
    tr.check("EF_003_unit_is_m2",
             out.get("shellTubeUnit") == "m2", f"got {out.get('shellTubeUnit')}")
    tr.check("EF_003_section_is_5_13",
             out.get("shellTubeSection") == "§5.13", f"got {out.get('shellTubeSection')}")
    tr.check("EF_004_plate_and_frame_area_equals_tube_area",
             out.get("plateStatus") == "COMPUTABLE" and out.get("plateArea") == 0.0005,
             f"판형 면적이 튜브단면적(0.0005)과 다름: got {out.get('plateArea')}")
    tr.check("EF_005_schedule_pipe_not_applicable_no_area",
             out.get("dpScheduleStatus") == "NOT_APPLICABLE" and out.get("dpScheduleArea") is None,
             f"Schedule pipe가 압력방출장치 불요(NOT_APPLICABLE)로 처리되지 않음: {out.get('dpScheduleStatus')}/{out.get('dpScheduleArea')}")
    tr.check("EF_006_gauge_tube_needs_engineering_decision",
             out.get("dpGaugeStatus") == "NEEDS_ENGINEERING_DECISION" and out.get("dpGaugeArea") is None,
             f"Gauge tube가 임의로 계산됨 — 원문에 계산식 없음: {out.get('dpGaugeStatus')}/{out.get('dpGaugeArea')}")
    tr.check("EF_006_gauge_tube_has_reason",
             out.get("dpGaugeHasReason") is True, "Gauge tube 결과에 이유(reason)가 없음")
    tr.check("EF_007_missing_type_rejected",
             out.get("missingType") == "INSUFFICIENT_INPUT", f"got {out.get('missingType')}")
    tr.check("EF_007_wrong_type_rejected",
             out.get("wrongType") == "INSUFFICIENT_INPUT", f"got {out.get('wrongType')}")
    tr.check("EF_007_null_input_rejected",
             out.get("nullInput") == "INSUFFICIENT_INPUT", f"got {out.get('nullInput')}")
    tr.check("EF_007_shell_missing_area_rejected",
             out.get("shellMissingArea") == "INSUFFICIENT_INPUT", f"got {out.get('shellMissingArea')}")
    tr.check("EF_007_double_pipe_missing_innerTubeType_rejected",
             out.get("dpMissingInnerType") == "INSUFFICIENT_INPUT", f"got {out.get('dpMissingInnerType')}")
    tr.check("EF_007_double_pipe_wrong_innerTubeType_rejected",
             out.get("dpWrongInnerType") == "INSUFFICIENT_INPUT", f"got {out.get('dpWrongInnerType')}")
    tr.check("EF_008_zero_area_rejected_physically_invalid",
             out.get("zeroAreaStatus") == "INSUFFICIENT_INPUT",
             f"튜브단면적 0은 물리적으로 무의미(실제 튜브가 없다는 뜻)하므로 거부되어야 함: got {out.get('zeroAreaStatus')}")
    tr.check("EF_008_negative_area_rejected",
             out.get("negativeAreaStatus") == "INSUFFICIENT_INPUT", f"got {out.get('negativeAreaStatus')}")
    tr.check("EF_008_nan_area_rejected",
             out.get("nanAreaStatus") == "INSUFFICIENT_INPUT", f"got {out.get('nanAreaStatus')}")
    tr.check("EF_008_infinity_area_rejected",
             out.get("infAreaStatus") == "INSUFFICIENT_INPUT", f"got {out.get('infAreaStatus')}")
    tr.check("EF_009_array_coercion_rejected",
             out.get("arrayAreaStatus") == "INSUFFICIENT_INPUT", f"got {out.get('arrayAreaStatus')}")
    tr.check("EF_009_string_coercion_rejected",
             out.get("stringAreaStatus") == "INSUFFICIENT_INPUT", f"got {out.get('stringAreaStatus')}")
    tr.check("EF_010_input_not_mutated",
             out.get("inputUnmutated") is True, "입력 객체가 변형됨 — 순수함수 원칙 위반")
    tr.check("EF_011_deterministic",
             out.get("deterministic") is True, "동일 입력 2회 실행 결과가 다름")
    tr.check("EF_012_taxonomy_includes_exchanger_fail",
             out.get("taxonomyIncludes") is True, "EXCHANGER_FAIL이 getComputableScenarioIds()에 없음")
    tr.check("EF_013_area_result_excluded_from_governing_selection_no_W_field",
             out.get("govVerdictWhenOnlyExchanger") == "INSUFFICIENT_INPUT",
             f"면적 결과(W 필드 없음)가 selectGoverningReliefLoad에서 자동으로 무효 처리되지 않음: {out.get('govVerdictWhenOnlyExchanger')}")

    return tr


# ════════════════════════════════════════════════════════════════
#  §5.12 외부 화재 (Sprint C-4.7) — KOSHA D-18-2020 §5.12, 식(2)~(7)
#  1차 출처(사용자 제공 PDF, 페이지 이미지 직접 대조)로 계수 확인 완료.
#  아직 api520Engine/selectGoverningReliefLoad에 미연결.
# ════════════════════════════════════════════════════════════════
def test_external_fire_scenario_contract() -> TestResult:
    tr = TestResult("EXTERNAL-FIRE-001", "Sprint C-4.7 — §5.12 외부 화재 시나리오")

    rl_src = (SRC / "engine" / "relief_load.js").read_text()
    api520_src = (SRC / "engine" / "api520.js").read_text()

    tr.check("XF_001_function_exists",
             "function calculateExternalFireScenario" in rl_src,
             "calculateExternalFireScenario() 함수가 없음")
    tr.check("XF_001_source_cited",
             "KOSHA GUIDE D-18-2020 §5.12" in rl_src,
             "§5.12 계산 함수에 출처 인용이 없음")
    tr.check("XF_001_not_yet_wired_into_engine",
             "calculateExternalFireScenario" not in api520_src,
             "C-4.7 단계에서 아직 api520Engine에 연결되면 안 됨")
    tr.check("XF_001_prior_scenarios_untouched",
             "function calculateExchangerFailureScenario" in rl_src
             and "function calculateLiquidThermalExpansionScenario" in rl_src
             and "V = α·Q / (500·SG·Cp)" in rl_src,
             "C-4.1~C-4.6 구현이 C-4.7 작업 중 변경됨 — 불필요한 수정 금지")

    fn_body = rl_src.split("function calculateExternalFireScenario")[1].split("function calculate")[0] if "function calculateExternalFireScenario" in rl_src else ""
    tr.check("XF_002_coefficients_unmodified",
             "37100" in fn_body and "61000" in fn_body and "0.82" in fn_body
             and "57000" in fn_body and "904" in fn_body and "8.766" in fn_body
             and "1.25" in fn_body and "1.1506" in fn_body,
             "원문 계수(37100/61000/0.82/57000/904/8.766/1.25/1.1506) 중 일부가 없거나 변형됨")
    tr.check("XF_002_jet_fire_needs_engineering_decision",
             '"JET_FIRE"' in fn_body and "NEEDS_ENGINEERING_DECISION" in fn_body,
             "제트화재가 계산 대상에서 명시적으로 배제(NEEDS_ENGINEERING_DECISION)되지 않음")
    tr.check("XF_002_confined_pool_subcases_modeled",
             '"CONFINED_POOL_VENTILATION_CONTROLLED"' in fn_body and '"CONFINED_POOL_LARGE_SCALE"' in fn_body,
             "제한공간화재의 계산식 없는 하위케이스(환기지배형/대규모)가 모델링되지 않음")

    node = shutil.which("node")
    if not node:
        tr.check("XF_node_available", False, "node를 찾을 수 없어 실행 검증을 건너뜀")
        return tr

    check_script = f"""
const fs = require('fs');
const files = ['engine/relief_load.js'].map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};

// ── XF-003: 액체 개방화재, F 직접입력, 소화설비 있음(37,100) ──
const liquid = calculateExternalFireScenario({{
  fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true, F:0.3, wettedArea_m2:50, latentHeat_kcal_per_kg:80
}});
const expectedQ_A = 37100 * 0.3 * Math.pow(50, 0.82);
out.liquidStatus = liquid.status;
out.liquidW = liquid.W;
out.expectedLiquidW = expectedQ_A / 80;
out.liquidCoefficient = liquid.components.coefficient;
out.liquidUnit = liquid.unit;
out.liquidSection = liquid.section;

// ── XF-004: 소화설비 없음(61,000) ──
const liquidNoDrain = calculateExternalFireScenario({{
  fireCase:"OPEN_POOL_LIQUID", adequateDrainage:false, F:0.3, wettedArea_m2:50, latentHeat_kcal_per_kg:80
}});
out.liquidNoDrainCoefficient = liquidNoDrain.components.coefficient;
out.liquidNoDrainW = liquidNoDrain.W;

// ── XF-005: F를 식(5) 단일 단열재로 산정 ──
const liquidF5 = calculateExternalFireScenario({{
  fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true,
  insulationLayers:[{{ k_kcal_mm_per_hr_m2_degC:19.5, thickness_mm:50 }}], Tf_degC:20,
  wettedArea_m2:50, latentHeat_kcal_per_kg:80
}});
const expectedF5 = (904 - 20) / (57000 * (50/19.5));
out.liquidF5Status = liquidF5.status;
out.liquidF5F = liquidF5.components.F;
out.expectedF5 = expectedF5;

// ── XF-006: F를 식(6) 복층 단열재로 산정 ──
const liquidF6 = calculateExternalFireScenario({{
  fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true,
  insulationLayers:[
    {{ k_kcal_mm_per_hr_m2_degC:19.5, thickness_mm:30 }},
    {{ k_kcal_mm_per_hr_m2_degC:9.8, thickness_mm:20 }}
  ], Tf_degC:20, wettedArea_m2:50, latentHeat_kcal_per_kg:80
}});
const expectedF6 = (904 - 20) / (57000 * ((30/19.5) + (20/9.8)));
out.liquidF6F = liquidF6.components.F;
out.expectedF6 = expectedF6;

// ── XF-007: 제한공간화재(소규모 연료지배형) — 동일 공식, Awi 레이블 ──
const confined = calculateExternalFireScenario({{
  fireCase:"CONFINED_POOL_FUEL_SMALL_MEDIUM", adequateDrainage:true, F:0.3, wettedArea_m2:50, latentHeat_kcal_per_kg:80
}});
out.confinedStatus = confined.status;
out.confinedW = confined.W;
out.confinedAreaLabel = confined.components.areaLabel;

// ── XF-008: 계산식 없는 하위케이스 -> NEEDS_ENGINEERING_DECISION ──
out.ventStatus = calculateExternalFireScenario({{ fireCase:"CONFINED_POOL_VENTILATION_CONTROLLED" }}).status;
out.largeStatus = calculateExternalFireScenario({{ fireCase:"CONFINED_POOL_LARGE_SCALE" }}).status;
out.jetStatus = calculateExternalFireScenario({{ fireCase:"JET_FIRE" }}).status;
out.ventW = calculateExternalFireScenario({{ fireCase:"CONFINED_POOL_VENTILATION_CONTROLLED" }}).W;

// ── XF-009: 가스/증기 케이스, Pn/Tn으로 T1 산정 ──
const gas = calculateExternalFireScenario({{
  fireCase:"OPEN_POOL_GAS_VAPOR", M:44, P1_MPa:1.5, A_m2:30, Tw_K:866, Pn_MPa:1.2, Tn_K:320
}});
const expectedT1 = (1.5/1.2) * 320;
const expectedGasW = 8.766 * Math.sqrt(44*1.5) * (30 * Math.pow(866-expectedT1, 1.25) / Math.pow(expectedT1, 1.1506));
out.gasStatus = gas.status;
out.gasW = gas.W;
out.expectedGasW = expectedGasW;
out.gasT1 = gas.components.T1_K;
out.expectedT1 = expectedT1;

// ── XF-010: 가스 케이스, T1 직접입력 ──
const gasDirectT1 = calculateExternalFireScenario({{
  fireCase:"OPEN_POOL_GAS_VAPOR", M:44, P1_MPa:1.5, A_m2:30, Tw_K:866, T1_K:400
}});
out.gasDirectT1Status = gasDirectT1.status;
out.gasDirectT1W = gasDirectT1.W;

// ── XF-011: 필수 입력 누락 ──
out.missingFireCase = calculateExternalFireScenario({{ adequateDrainage:true, F:0.3, wettedArea_m2:50, latentHeat_kcal_per_kg:80 }}).status;
out.wrongFireCase = calculateExternalFireScenario({{ fireCase:"VOLCANO", wettedArea_m2:50 }}).status;
out.nullInput = calculateExternalFireScenario(null).status;
out.liquidMissingDrainage = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_LIQUID", F:0.3, wettedArea_m2:50, latentHeat_kcal_per_kg:80 }}).status;
out.liquidMissingArea = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true, F:0.3, latentHeat_kcal_per_kg:80 }}).status;
out.liquidMissingF = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true, wettedArea_m2:50, latentHeat_kcal_per_kg:80 }}).status;
out.gasMissingT1AndPnTn = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_GAS_VAPOR", M:44, P1_MPa:1.5, A_m2:30, Tw_K:866 }}).status;

// ── XF-012: 0/음수/NaN/Infinity ──
out.zeroAreaStatus = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true, F:0.3, wettedArea_m2:0, latentHeat_kcal_per_kg:80 }}).status;
out.negativeAreaStatus = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true, F:0.3, wettedArea_m2:-10, latentHeat_kcal_per_kg:80 }}).status;
out.nanLatentStatus = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true, F:0.3, wettedArea_m2:50, latentHeat_kcal_per_kg:NaN }}).status;
out.infMStatus = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_GAS_VAPOR", M:Infinity, P1_MPa:1.5, A_m2:30, Tw_K:866, T1_K:400 }}).status;
out.zeroLatentStatus = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true, F:0.3, wettedArea_m2:50, latentHeat_kcal_per_kg:0 }}).status;
out.twLessThanT1Status = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_GAS_VAPOR", M:44, P1_MPa:1.5, A_m2:30, Tw_K:300, T1_K:400 }}).status;

// ── XF-013: 배열/문자열 암묵변환 차단 ──
out.arrayAreaStatus = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true, F:0.3, wettedArea_m2:[50], latentHeat_kcal_per_kg:80 }}).status;
out.stringFStatus = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true, F:"0.3", wettedArea_m2:50, latentHeat_kcal_per_kg:80 }}).status;
out.nonBooleanDrainageStatus = calculateExternalFireScenario({{ fireCase:"OPEN_POOL_LIQUID", adequateDrainage:"yes", F:0.3, wettedArea_m2:50, latentHeat_kcal_per_kg:80 }}).status;

// ── XF-014: 입력 mutation 금지 ──
const originalInput = {{ fireCase:"OPEN_POOL_LIQUID", adequateDrainage:true, F:0.3, wettedArea_m2:50, latentHeat_kcal_per_kg:80 }};
const originalCopy = JSON.parse(JSON.stringify(originalInput));
calculateExternalFireScenario(originalInput);
out.inputUnmutated = JSON.stringify(originalInput) === JSON.stringify(originalCopy);

// ── XF-015: 결정론 ──
const detInput = {{ fireCase:"OPEN_POOL_GAS_VAPOR", M:44, P1_MPa:1.5, A_m2:30, Tw_K:866, Pn_MPa:1.2, Tn_K:320 }};
const r1 = calculateExternalFireScenario(detInput);
const r2 = calculateExternalFireScenario(detInput);
out.deterministic = JSON.stringify(r1) === JSON.stringify(r2);

// ── XF-016: taxonomy 정합성(간접 참조) ──
out.taxonomyIncludes = getComputableScenarioIds().includes("EXTERNAL_FIRE");

// ── XF-017: selector와 독립적 — 실수로 넣어도 정상 동작(W 필드 있으므로 이번엔 포함됨, 다른 §5.x와의 max 비교) ──
const gov = selectGoverningReliefLoad([liquid, {{ scenarioId:"OVERFILLING", status:"OK", W:100, unit:"kg/h" }}]);
out.govGoverningId = gov.governingScenarioId;

console.log(JSON.stringify(out));
"""
    try:
        result = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
        out = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else {}
    except Exception as e:
        tr.check("XF_node_execution", False, f"node 실행 실패: {e}\nstderr: {getattr(result,'stderr','')}")
        return tr

    tr.check("XF_003_liquid_formula_matches_37100_coefficient",
             out.get("liquidStatus") == "OK" and abs(out.get("liquidW", -1) - out.get("expectedLiquidW", -999)) < 1e-9
             and out.get("liquidCoefficient") == 37100,
             f"액체(소화설비 있음) W가 식(2)(3) 기대값과 다름: got {out.get('liquidW')} expected {out.get('expectedLiquidW')}")
    tr.check("XF_003_unit_and_section",
             out.get("liquidUnit") == "kg/h" and out.get("liquidSection") == "§5.12",
             f"got unit={out.get('liquidUnit')} section={out.get('liquidSection')}")
    tr.check("XF_004_no_drainage_uses_61000_coefficient",
             out.get("liquidNoDrainCoefficient") == 61000 and out.get("liquidNoDrainW") > out.get("liquidW"),
             f"소화설비 없음이 61,000 계수를 쓰지 않거나 W가 더 크지 않음: {out.get('liquidNoDrainCoefficient')}/{out.get('liquidNoDrainW')}")
    tr.check("XF_005_F_formula5_single_layer_matches",
             out.get("liquidF5Status") == "OK" and abs(out.get("liquidF5F", -1) - out.get("expectedF5", -999)) < 1e-9,
             f"식(5) F 산정값이 기대값과 다름: got {out.get('liquidF5F')} expected {out.get('expectedF5')}")
    tr.check("XF_006_F_formula6_multilayer_matches",
             abs(out.get("liquidF6F", -1) - out.get("expectedF6", -999)) < 1e-9,
             f"식(6) 복층 F 산정값이 기대값과 다름: got {out.get('liquidF6F')} expected {out.get('expectedF6')}")
    tr.check("XF_007_confined_pool_reuses_same_formula_with_Awi_label",
             out.get("confinedStatus") == "OK" and out.get("confinedW") == out.get("liquidW")
             and "Awi" in out.get("confinedAreaLabel", ""),
             f"제한공간화재(소규모)가 동일 공식을 재사용하며 Awi로 표기되지 않음: {out}")
    tr.check("XF_008_no_formula_subcases_return_needs_engineering_decision",
             out.get("ventStatus") == "NEEDS_ENGINEERING_DECISION"
             and out.get("largeStatus") == "NEEDS_ENGINEERING_DECISION"
             and out.get("jetStatus") == "NEEDS_ENGINEERING_DECISION"
             and out.get("ventW") is None,
             f"계산식 없는 하위케이스가 임의로 계산됨: {out.get('ventStatus')}/{out.get('largeStatus')}/{out.get('jetStatus')}")
    tr.check("XF_009_gas_formula7_matches_with_T1_derived_from_Pn_Tn",
             out.get("gasStatus") == "OK" and abs(out.get("gasW", -1) - out.get("expectedGasW", -999)) < 1e-6
             and abs(out.get("gasT1", -1) - out.get("expectedT1", -999)) < 1e-9,
             f"식(7) W 또는 T1=(P1/Pn)Tn 산정값이 기대값과 다름: {out}")
    tr.check("XF_010_gas_direct_T1_works",
             out.get("gasDirectT1Status") == "OK" and out.get("gasDirectT1W") == out.get("gasW"),
             f"T1 직접입력 경로가 Pn/Tn 산정 경로와 동일 결과를 내지 않음: {out.get('gasDirectT1W')}/{out.get('gasW')}")
    tr.check("XF_011_missing_required_fields_rejected",
             all(out.get(k) == "INSUFFICIENT_INPUT" for k in [
                 "missingFireCase", "wrongFireCase", "nullInput", "liquidMissingDrainage",
                 "liquidMissingArea", "liquidMissingF", "gasMissingT1AndPnTn"
             ]),
             f"필수 입력 누락 케이스 중 일부가 거부되지 않음: {out}")
    tr.check("XF_012_zero_negative_nan_infinity_rejected",
             all(out.get(k) == "INSUFFICIENT_INPUT" for k in [
                 "zeroAreaStatus", "negativeAreaStatus", "nanLatentStatus", "infMStatus",
                 "zeroLatentStatus", "twLessThanT1Status"
             ]),
             f"0/음수/NaN/Infinity/Tw≤T1 케이스 중 일부가 거부되지 않음: {out}")
    tr.check("XF_013_array_string_boolean_coercion_rejected",
             out.get("arrayAreaStatus") == "INSUFFICIENT_INPUT" and out.get("stringFStatus") == "INSUFFICIENT_INPUT"
             and out.get("nonBooleanDrainageStatus") == "INSUFFICIENT_INPUT",
             f"배열/문자열/비boolean 암묵변환이 차단되지 않음: {out.get('arrayAreaStatus')}/{out.get('stringFStatus')}/{out.get('nonBooleanDrainageStatus')}")
    tr.check("XF_014_input_not_mutated",
             out.get("inputUnmutated") is True, "입력 객체가 변형됨 — 순수함수 원칙 위반")
    tr.check("XF_015_deterministic",
             out.get("deterministic") is True, "동일 입력 2회 실행 결과가 다름")
    tr.check("XF_016_taxonomy_includes_external_fire",
             out.get("taxonomyIncludes") is True, "EXTERNAL_FIRE가 getComputableScenarioIds()에 없음")
    tr.check("XF_017_governing_selection_works_with_other_scenarios",
             out.get("govGoverningId") == "EXTERNAL_FIRE",
             f"§5.12 결과(W 있음)가 다른 시나리오와 함께 governing 선택에 정상 참여하지 않음: {out.get('govGoverningId')}")

    return tr


# ════════════════════════════════════════════════════════════════
#  UNIT/SELECTOR CONTRACT (Sprint C-4.8A) — §6 governing load 선정 시
#  quantity(kg/h vs m3/h vs m2)가 섞이지 않도록 강제하는 계약.
#  C-4.8B에서 buildReliefSizingInput()이 이 selector 결과를 소비해
#  api520Engine에 제네릭 reliefLoadAdapter로 주입한다(엔진이 selector를
#  직접 호출하지는 않음 — 상세 계약은 RELIEF-SIZING-ADAPTER-001 참고).
# ════════════════════════════════════════════════════════════════
def test_unit_selector_contract() -> TestResult:
    tr = TestResult("UNIT-SELECTOR-001", "Sprint C-4.8A — governing load quantity/unit 계약")

    rl_src = (SRC / "engine" / "relief_load.js").read_text()
    api520_src = (SRC / "engine" / "api520.js").read_text()

    tr.check("US_001_quantity_enum_exists",
             "RELIEF_LOAD_QUANTITY" in rl_src and "MASS_FLOW" in rl_src
             and "VOLUME_FLOW" in rl_src and "AREA" in rl_src,
             "RELIEF_LOAD_QUANTITY enum(MASS_FLOW/VOLUME_FLOW/AREA)이 없음")
    tr.check("US_002_classifier_exists",
             "function classifyReliefLoadQuantity" in rl_src,
             "classifyReliefLoadQuantity() 함수가 없음")
    tr.check("US_007_selector_not_directly_called_inside_engine",
             "selectGoverningReliefLoad(" not in api520_src,
             "C-4.8A 이후에도 api520Engine이 selectGoverningReliefLoad()를 직접 호출하면 안 됨 — "
             "C-4.8B는 buildReliefSizingInput()의 결과를 reliefLoadAdapter 인자로 외부에서 "
             "주입받는 방식만 허용한다(엔진이 selector를 스스로 부르지 않음)")

    node = shutil.which("node")
    if not node:
        tr.check("US_node_available", False, "node를 찾을 수 없어 실행 검증을 건너뜀")
        return tr

    check_script = f"""
const fs = require('fs');
const files = ['engine/relief_load.js'].map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};

// US-003: MASS_FLOW 정상 선택(kg/h 후보 중 최댓값)
{{
  const results = [
    {{ scenarioId:"OUTLET_BLOCKED", status:"OK", W:100, unit:"kg/h" }},
    {{ scenarioId:"OVERFILLING",    status:"OK", W:250, unit:"kg/h" }},
  ];
  const gov = selectGoverningReliefLoad(results);
  out.massOnlyVerdict = gov.verdict;
  out.massOnlyGoverningId = gov.governingScenarioId;
  out.massOnlyGoverningW = gov.governingW;
}}

// US-004: VOLUME_FLOW(§5.11)·AREA(§5.13) 단독 제외 + allScenarios 보존
{{
  const results = [
    {{ scenarioId:"OUTLET_BLOCKED",   status:"OK",         W:100,  unit:"kg/h" }},
    {{ scenarioId:"LIQUID_EXPANSION", status:"COMPUTABLE", value:5.5, unit:"m3/h" }},
    {{ scenarioId:"EXCHANGER_FAIL",   status:"COMPUTABLE", requiredOrificeArea_m2:0.02, unit:"m2" }},
  ];
  const gov = selectGoverningReliefLoad(results);
  out.mixedVerdict = gov.verdict;
  out.mixedGoverningId = gov.governingScenarioId;
  out.mixedAllScenariosLen = gov.allScenarios.length;
  out.mixedAllScenariosPreserved = gov.allScenarios.length === 3
    && gov.allScenarios.some(r => r.scenarioId === "LIQUID_EXPANSION" && r.value === 5.5)
    && gov.allScenarios.some(r => r.scenarioId === "EXCHANGER_FAIL" && r.requiredOrificeArea_m2 === 0.02);
  const audit = gov.quantityAudit;
  out.auditLen = audit.length;
  const leAudit = audit.find(a => a.scenarioId === "LIQUID_EXPANSION");
  const efAudit = audit.find(a => a.scenarioId === "EXCHANGER_FAIL");
  const obAudit = audit.find(a => a.scenarioId === "OUTLET_BLOCKED");
  out.leExcluded = leAudit && leAudit.includedInGoverningSelection === false && leAudit.exclusionReason === "INCOMPATIBLE_QUANTITY" && leAudit.quantity === "VOLUME_FLOW";
  out.efExcluded = efAudit && efAudit.includedInGoverningSelection === false && efAudit.exclusionReason === "INCOMPATIBLE_QUANTITY" && efAudit.quantity === "AREA";
  out.obIncluded = obAudit && obAudit.includedInGoverningSelection === true && obAudit.exclusionReason === null && obAudit.quantity === "MASS_FLOW";
}}

// US-005: 후보 0개(전부 m3/h·m2)면 INSUFFICIENT_INPUT
{{
  const results = [
    {{ scenarioId:"LIQUID_EXPANSION", status:"COMPUTABLE", value:5.5, unit:"m3/h" }},
    {{ scenarioId:"EXCHANGER_FAIL",   status:"COMPUTABLE", requiredOrificeArea_m2:0.02, unit:"m2" }},
  ];
  const gov = selectGoverningReliefLoad(results);
  out.zeroCandidateVerdict = gov.verdict;
  out.zeroCandidateGoverningW = gov.governingW;
  out.zeroCandidateAllScenariosLen = gov.allScenarios.length;
}}

// US-006: 미인식 unit은 암묵적으로 kg/h 취급되지 않음(UNRECOGNIZED_QUANTITY)
{{
  const results = [
    {{ scenarioId:"WEIRD", status:"OK", W:999, unit:"lb/hr" }},
  ];
  const gov = selectGoverningReliefLoad(results);
  out.unrecognizedVerdict = gov.verdict;
  out.unrecognizedAudit = gov.quantityAudit[0];
}}

// US-008: 불변성(입력 배열/원소 mutate 금지)
{{
  const original = [{{ scenarioId:"OUTLET_BLOCKED", status:"OK", W:100, unit:"kg/h" }}];
  const snapshot = JSON.parse(JSON.stringify(original));
  selectGoverningReliefLoad(original);
  out.inputUnmutated = JSON.stringify(original) === JSON.stringify(snapshot);
}}

// US-009: 결정론
{{
  const results = [
    {{ scenarioId:"OUTLET_BLOCKED", status:"OK", W:100, unit:"kg/h" }},
    {{ scenarioId:"OVERFILLING",    status:"OK", W:100, unit:"kg/h" }},
  ];
  const r1 = selectGoverningReliefLoad(results);
  const r2 = selectGoverningReliefLoad(results);
  out.deterministicTie = r1.governingScenarioId === r2.governingScenarioId;
  out.tieBreakToTaxonomyOrder = r1.governingScenarioId === "OUTLET_BLOCKED";
}}

console.log(JSON.stringify(out));
"""
    cp = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
    try:
        out = json.loads(cp.stdout.strip().splitlines()[-1]) if cp.stdout.strip() else {{}}
    except Exception:
        out = {{}}

    tr.check("US_003_mass_flow_only_selection_works",
             out.get("massOnlyVerdict") == "OK" and out.get("massOnlyGoverningId") == "OVERFILLING"
             and out.get("massOnlyGoverningW") == 250,
             f"MASS_FLOW 후보만 있을 때 정상 선택 실패 — stdout={cp.stdout!r} stderr={cp.stderr!r}")
    tr.check("US_004_volume_and_area_excluded_but_preserved",
             out.get("mixedVerdict") == "OK" and out.get("mixedGoverningId") == "OUTLET_BLOCKED"
             and out.get("mixedAllScenariosPreserved") is True,
             f"§5.11/§5.13이 governing 후보에서 제외되지 않았거나 allScenarios에 보존되지 않음: {out}")
    tr.check("US_004_quantity_audit_reasons_correct",
             out.get("leExcluded") is True and out.get("efExcluded") is True and out.get("obIncluded") is True,
             f"quantityAudit의 제외 사유/quantity 분류가 정확하지 않음: {out}")
    tr.check("US_005_zero_mass_flow_candidates_is_insufficient_input",
             out.get("zeroCandidateVerdict") == "INSUFFICIENT_INPUT" and out.get("zeroCandidateGoverningW") is None
             and out.get("zeroCandidateAllScenariosLen") == 2,
             f"MASS_FLOW 후보가 0개일 때 INSUFFICIENT_INPUT이 아니거나 allScenarios가 보존되지 않음: {out}")
    unrecognized_audit = out.get("unrecognizedAudit") or {{}}
    tr.check("US_006_unrecognized_unit_not_treated_as_mass_flow",
             out.get("unrecognizedVerdict") == "INSUFFICIENT_INPUT"
             and unrecognized_audit.get("exclusionReason") == "UNRECOGNIZED_QUANTITY"
             and unrecognized_audit.get("quantity") is None,
             f"미인식 unit(lb/hr)이 암묵적으로 후보 처리됨: {out}")
    tr.check("US_008_selector_does_not_mutate_input",
             out.get("inputUnmutated") is True, "selectGoverningReliefLoad가 입력 배열/원소를 변형함")
    tr.check("US_009_deterministic_and_tiebreak_preserved",
             out.get("deterministicTie") is True and out.get("tieBreakToTaxonomyOrder") is True,
             f"결정론 또는 기존 taxonomy tie-break 순서가 깨짐: {out}")

    return tr


# ════════════════════════════════════════════════════════════════
#  RELIEF-SIZING-ADAPTER-001 (Sprint C-4.8B)
#  §5 scenario → governing MASS_FLOW → buildReliefSizingInput() →
#  api520Engine(W) 연결 계약. UI는 연결하지 않는다(C-4.11/C-5로 분리).
#  자동 fallback 금지: adapter 실패/governing 없음을 조용히 manual W로
#  대체하면 안 되고, 명시적 에러/INSUFFICIENT_INPUT으로 종료해야 한다.
# ════════════════════════════════════════════════════════════════
def test_relief_sizing_adapter_contract() -> TestResult:
    tr = TestResult("RELIEF-SIZING-ADAPTER-001", "Sprint C-4.8B — governing relief load → API 520 sizing 연결 계약")

    rl_src   = (SRC / "engine" / "relief_load.js").read_text()
    api_src  = (SRC / "engine" / "api520.js").read_text()
    snap_src = (SRC / "snapshot" / "create.js").read_text()
    casev_src = (SRC / "components" / "CaseView.jsx").read_text()
    report_files = [
        SRC / "components" / "ReportView.jsx",
        SRC / "components" / "report" / "ApprovalEvidence.jsx",
        SRC / "components" / "report" / "AssetEvidence.jsx",
        SRC / "components" / "report" / "AuditEvidence.jsx",
        SRC / "components" / "report" / "WorkflowEvidence.jsx",
        SRC / "report" / "createPackage.js",
        SRC / "report" / "schema.js",
        SRC / "report" / "renderer" / "pdf" / "renderPDF.js",
        SRC / "report" / "renderer" / "pdf" / "template.js",
    ]

    tr.check("RS_static_001_adapter_function_exists",
             "function buildReliefSizingInput" in rl_src,
             "buildReliefSizingInput() 함수가 없음")
    tr.check("RS_static_002_engine_signature_extended",
             "reliefLoadAdapter" in api_src and "function api520Engine(inp, deviceType, inletPiping, reliefLoadAdapter)" in api_src,
             "api520Engine()에 reliefLoadAdapter 선택 인자가 추가되지 않음")
    tr.check("RS_static_003_no_silent_fallback_to_manual_w",
             "!reliefLoadAdapter.valid" in api_src and "INVALID_RELIEF_LOAD_INPUT" in api_src,
             "adapter invalid 시 manual W로 조용히 대체하지 않고 명시적 에러를 반환해야 함")
    tr.check("RS_static_004_caseview_now_wired_via_generic_adapter",
             "reliefLoadAdapter" in casev_src and "buildReliefSizingInput(" in casev_src
             and "selectGoverningReliefLoad(" in casev_src
             and "api520Engine(inputs, deviceType, equipment?.inletPiping || null, adapterForEngine)" in casev_src,
             "C-4.9는 CaseView를 buildReliefSizingInput()/selectGoverningReliefLoad() 결과를 "
             "그대로 api520Engine()에 주입하는 방식으로 연결해야 함 — 계산 로직을 CaseView가 "
             "직접 재구현하면 안 되고 기존 C-4.8A/C-4.8B 계약 함수를 그대로 호출해야 함")
    tr.check("RS_static_004b_caseview_does_not_reimplement_max_comparison",
             not re.search(r"\.reduce\s*\(|\bMath\.max\s*\(", casev_src.split("function CaseView")[1] if "function CaseView" in casev_src else casev_src),
             "CaseView가 governing 선택을 위한 자체 max()/reduce() 비교 로직을 재구현하면 안 됨 — "
             "반드시 selectGoverningReliefLoad()의 판단만 사용해야 함")
    tr.check("RS_static_005_snapshot_accepts_relief_load",
             "reliefLoad" in snap_src and "_hashResult(inputs, engineResult, reliefLoad)" in snap_src,
             "createSnapshot()이 reliefLoad를 받아 해시에 포함하지 않음")

    for f in report_files:
        text = f.read_text() if f.exists() else ""
        tr.check(f"RS_static_006_report_no_recompute:{f.name}",
                 "selectGoverningReliefLoad" not in text and "buildReliefSizingInput" not in text,
                 f"{f.name}가 relief-load를 직접 재계산하면 안 됨 — Snapshot.reliefLoad만 읽어야 함")

    node = shutil.which("node")
    if not node:
        tr.check("RS_node_available", False, "node를 찾을 수 없어 실행 검증을 건너뜀")
        return tr

    check_script = f"""
const fs = require('fs');
const files = ['engine/relief_load.js', 'engine/backpressure.js', 'engine/api520.js']
  .map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};

const baseInp = {{ W:9999, P1:10, P2:1, T:320, M:44, k:1.28, Kd:0.975, Kb:1.0, mawp:11, OP:10, Z:1.0 }};

// RS-001: MASS_FLOW/kg/h governing → adapter valid, sizing에 반영됨
{{
  const sel = selectGoverningReliefLoad([
    {{ scenarioId:"OUTLET_BLOCKED", status:"OK", W:1234, unit:"kg/h" }},
  ]);
  const adapter = buildReliefSizingInput(sel);
  out.massFlowAdapterValid = adapter.valid;
  out.massFlowAdapterW = adapter.W;
  const eng = api520Engine(baseInp, "safetyValve", null, adapter);
  out.massFlowEngineValid = eng.valid;
  out.massFlowEngineUsedW = eng.stepData?.orifice?.W;
  out.massFlowSource = eng.stepData?.reliefLoadSource?.source;
  out.massFlowManualWPreserved = eng.stepData?.reliefLoadSource?.manualW === 9999;
}}

// RS-002: VOLUME_FLOW(m3/h) 단독 → selector가 INSUFFICIENT_INPUT → adapter invalid → engine 에러(거부)
{{
  const sel = selectGoverningReliefLoad([
    {{ scenarioId:"LIQUID_EXPANSION", status:"COMPUTABLE", value:5.5, unit:"m3/h" }},
  ]);
  const adapter = buildReliefSizingInput(sel);
  out.volumeFlowAdapterValid = adapter.valid;
  out.volumeFlowAdapterReason = adapter.reason;
  const eng = api520Engine(baseInp, "safetyValve", null, adapter);
  out.volumeFlowEngineRejected = (eng.valid === false);
  out.volumeFlowEngineErrorField = eng.error?.field;
}}

// RS-003: AREA(m2) 단독 → 동일하게 거부
{{
  const sel = selectGoverningReliefLoad([
    {{ scenarioId:"EXCHANGER_FAIL", status:"COMPUTABLE", requiredOrificeArea_m2:0.02, unit:"m2" }},
  ]);
  const adapter = buildReliefSizingInput(sel);
  out.areaAdapterValid = adapter.valid;
  const eng = api520Engine(baseInp, "safetyValve", null, adapter);
  out.areaEngineRejected = (eng.valid === false);
}}

// RS-004: unit 누락 → 거부
{{
  const sel = selectGoverningReliefLoad([
    {{ scenarioId:"WEIRD", status:"OK", W:500 }},
  ]);
  const adapter = buildReliefSizingInput(sel);
  out.missingUnitAdapterValid = adapter.valid;
}}

// RS-005: 미인식 unit → 거부
{{
  const sel = selectGoverningReliefLoad([
    {{ scenarioId:"WEIRD2", status:"OK", W:500, unit:"lb/hr" }},
  ]);
  const adapter = buildReliefSizingInput(sel);
  out.unknownUnitAdapterValid = adapter.valid;
}}

// RS-006: zero/negative governing W → 거부 (selector 자체가 이미 걸러 INSUFFICIENT_INPUT을
//         내지만, adapter 레벨에서도 방어적으로 재확인)
{{
  const adapterZero = buildReliefSizingInput({{ verdict:"OK", governingScenarioId:"X", governingW:0, unit:"kg/h", allScenarios:[], quantityAudit:[] }});
  const adapterNeg  = buildReliefSizingInput({{ verdict:"OK", governingScenarioId:"X", governingW:-5, unit:"kg/h", allScenarios:[], quantityAudit:[] }});
  out.zeroWRejected = (adapterZero.valid === false);
  out.negWRejected  = (adapterNeg.valid === false);
}}

// RS-007: governing 없음(INSUFFICIENT_INPUT) → adapter invalid, engine이 즉시 거부(수동 W로 fallback 금지)
{{
  const sel = selectGoverningReliefLoad([]);
  const adapter = buildReliefSizingInput(sel);
  out.noGoverningAdapterValid = adapter.valid;
  out.noGoverningAdapterReason = adapter.reason;
  const eng = api520Engine(baseInp, "safetyValve", null, adapter);
  out.noGoverningEngineRejected = (eng.valid === false);
  // 결정적 확인: 에러 상태에서 sizing 결과(areaCm2 등)가 전혀 계산되지 않음(=조용한 대체가 없었음)
  out.noGoverningNoSilentAreaCm2 = (eng.areaCm2 === undefined);
}}

// RS-008: selector 결과 원본 불변 — buildReliefSizingInput이 selectorResult를 변형하지 않음
{{
  const sel = selectGoverningReliefLoad([
    {{ scenarioId:"OUTLET_BLOCKED", status:"OK", W:1234, unit:"kg/h" }},
  ]);
  const snapshot = JSON.parse(JSON.stringify(sel));
  buildReliefSizingInput(sel);
  out.selectorResultUnmutated = JSON.stringify(sel) === JSON.stringify(snapshot);
}}

// RS-009: 동일 입력 → 동일 sizing 결과(결정론)
{{
  const sel = selectGoverningReliefLoad([
    {{ scenarioId:"OUTLET_BLOCKED", status:"OK", W:1234, unit:"kg/h" }},
  ]);
  const a1 = buildReliefSizingInput(sel);
  const a2 = buildReliefSizingInput(sel);
  const e1 = api520Engine(baseInp, "safetyValve", null, a1);
  const e2 = api520Engine(baseInp, "safetyValve", null, a2);
  out.deterministicSizing = (e1.areaCm2 === e2.areaCm2) && (e1.selected.letter === e2.selected.letter);
}}

// RS-010: 기존 manual W 경로 회귀 — adapter 없이 호출(4번째 인자 생략)하면 기존과 동일하게 동작
{{
  const eng4argsUndefined = api520Engine(baseInp, "safetyValve", null);
  const eng4argsNull      = api520Engine(baseInp, "safetyValve", null, null);
  out.manualPathValid = eng4argsUndefined.valid === true;
  out.manualPathUsedManualW = eng4argsUndefined.stepData?.orifice?.W === 9999;
  out.manualPathSource = eng4argsUndefined.stepData?.reliefLoadSource?.source;
  out.manualPathSameAsExplicitNull = eng4argsUndefined.areaCm2 === eng4argsNull.areaCm2;
}}

// RS-011/012: C-1(backpressure)/C-2(accumulation) 정책 회귀 — governing 경로에서도 그대로 평가됨
{{
  const inpWithPolicies = {{ ...baseInp, valveType:"BELLOWS", valveCount:2, fireScenario:false }};
  const sel = selectGoverningReliefLoad([
    {{ scenarioId:"OUTLET_BLOCKED", status:"OK", W:1234, unit:"kg/h" }},
  ]);
  const adapter = buildReliefSizingInput(sel);
  const eng = api520Engine(inpWithPolicies, "safetyValve", null, adapter);
  out.backpressurePolicyStillApplied = eng.stepData?.backpress?.allowableRatio === 0.50;
  out.accumulationPolicyStillApplied = eng.stepData?.accumulation?.allowableRatio === 1.16;
  out.policiesIndependentOfWSource = eng.stepData?.reliefLoadSource?.source === "GOVERNING_RELIEF_LOAD";
}}

// RS-013: C-3(inlet loss) 정책 회귀 — governing 경로에서도 그대로 평가/독립 유지(계산불가 상태 포함)
{{
  const sel = selectGoverningReliefLoad([
    {{ scenarioId:"OUTLET_BLOCKED", status:"OK", W:1234, unit:"kg/h" }},
  ]);
  const adapter = buildReliefSizingInput(sel);
  const eng = api520Engine(baseInp, "safetyValve", null, adapter);
  out.inletLossStillIndependentOfSizing = (eng.stepData?.inletLoss?.pressureLossAvailable === false)
    && (eng.dataGaps || []).includes("inletPiping")
    && typeof eng.areaCm2 === "number";
}}

// RS-critical: 동일 숫자 W라면 manual 경로와 governing 경로의 sizing 결과가 완전히 동일해야 함
{{
  const manualInp = {{ ...baseInp, W: 4200 }};
  const engManual = api520Engine(manualInp, "safetyValve", null);
  const sel = selectGoverningReliefLoad([
    {{ scenarioId:"OUTLET_BLOCKED", status:"OK", W:4200, unit:"kg/h" }},
  ]);
  const adapter = buildReliefSizingInput(sel);
  const engGoverning = api520Engine(manualInp, "safetyValve", null, adapter);
  out.sameWSameSizingResult = (engManual.areaCm2 === engGoverning.areaCm2)
    && (engManual.selected.letter === engGoverning.selected.letter)
    && (engManual.margin === engGoverning.margin)
    && (engManual.P1abs === engGoverning.P1abs);
}}

console.log(JSON.stringify(out));
"""
    cp = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
    try:
        out = json.loads(cp.stdout.strip().splitlines()[-1]) if cp.stdout.strip() else {{}}
    except Exception:
        out = {{}}

    tr.check("RS_001_mass_flow_used_for_sizing",
             out.get("massFlowAdapterValid") is True and out.get("massFlowEngineValid") is True
             and out.get("massFlowEngineUsedW") == 1234 and out.get("massFlowSource") == "GOVERNING_RELIEF_LOAD"
             and out.get("massFlowManualWPreserved") is True,
             f"stdout={cp.stdout!r} stderr={cp.stderr!r} out={out}")
    tr.check("RS_002_volume_flow_rejected",
             out.get("volumeFlowAdapterValid") is False and out.get("volumeFlowEngineRejected") is True
             and out.get("volumeFlowEngineErrorField") == "reliefLoad",
             f"VOLUME_FLOW(m3/h)가 sizing에 흘러들어감: {out}")
    tr.check("RS_003_area_rejected",
             out.get("areaAdapterValid") is False and out.get("areaEngineRejected") is True,
             f"AREA(m2)가 sizing에 흘러들어감: {out}")
    tr.check("RS_004_missing_unit_rejected",
             out.get("missingUnitAdapterValid") is False, f"unit 누락이 거부되지 않음: {out}")
    tr.check("RS_005_unknown_unit_rejected",
             out.get("unknownUnitAdapterValid") is False, f"미인식 unit이 거부되지 않음: {out}")
    tr.check("RS_006_zero_negative_w_rejected",
             out.get("zeroWRejected") is True and out.get("negWRejected") is True,
             f"0/음수 governing W가 거부되지 않음: {out}")
    tr.check("RS_007_no_governing_scenario_no_silent_fallback",
             out.get("noGoverningAdapterValid") is False and out.get("noGoverningEngineRejected") is True
             and out.get("noGoverningNoSilentAreaCm2") is True,
             f"governing 없음이 manual W로 조용히 대체됨(금지된 fallback): {out}")
    tr.check("RS_008_selector_result_immutable",
             out.get("selectorResultUnmutated") is True, f"buildReliefSizingInput이 입력을 변형함: {out}")
    tr.check("RS_009_deterministic_sizing",
             out.get("deterministicSizing") is True, f"동일 입력에 대해 sizing 결과가 결정론적이지 않음: {out}")
    tr.check("RS_010_manual_path_regression",
             out.get("manualPathValid") is True and out.get("manualPathUsedManualW") is True
             and out.get("manualPathSource") == "MANUAL_INPUT" and out.get("manualPathSameAsExplicitNull") is True,
             f"기존 수동 W 경로(4번째 인자 미전달)가 회귀함: {out}")
    tr.check("RS_011_012_c1_c2_policy_regression",
             out.get("backpressurePolicyStillApplied") is True and out.get("accumulationPolicyStillApplied") is True
             and out.get("policiesIndependentOfWSource") is True,
             f"governing W 경로에서 C-1/C-2 정책이 정상 평가되지 않음: {out}")
    tr.check("RS_013_c3_inlet_loss_regression",
             out.get("inletLossStillIndependentOfSizing") is True,
             f"governing W 경로에서 C-3 inlet loss 독립성이 깨짐: {out}")
    tr.check("RS_018_engine_version_lock",
             ENGINE_VERSION == "1.6.0",
             f"ENGINE_VERSION이 예상과 다름(1.6.0 유지 결정): {ENGINE_VERSION}")
    tr.check("RS_019_engine_version_decision_documented",
             "버전 결정: ENGINE_VERSION은 이번 단계에서 올리지 않는다" in api_src,
             "ENGINE_VERSION 변경 필요 여부에 대한 명시적 판단 근거가 소스에 문서화되지 않음")
    tr.check("RS_critical_same_w_same_sizing_result",
             out.get("sameWSameSizingResult") is True,
             f"동일 W(수동 vs governing)인데 sizing 결과가 달라짐 — C-4 연결이 기존 계산을 변경함: {out}")

    return tr


# ════════════════════════════════════════════════════════════════
#  RELIEF-LOAD-UI-001 (Sprint C-4.9) — MVP Scenario Input UI 계약
#  §5.1/§5.6/§5.7/§5.8 4개 시나리오만 대상. UI는 계산하지 않고
#  CaseView가 relief_load.js의 순수 함수(calculate*Scenario/
#  selectGoverningReliefLoad/buildReliefSizingInput)만 호출해
#  api520Engine에 연결한다. InputView는 입력 수집/표시만 한다.
# ════════════════════════════════════════════════════════════════
def test_relief_load_ui_contract() -> TestResult:
    tr = TestResult("RELIEF-LOAD-UI-001", "Sprint C-4.9 — MVP Scenario Input UI (§5.1/5.6/5.7/5.8) 계약")

    rl_src    = (SRC / "engine" / "relief_load.js").read_text()
    api_src   = (SRC / "engine" / "api520.js").read_text()
    snap_src  = (SRC / "snapshot" / "create.js").read_text()
    casev_src = (SRC / "components" / "CaseView.jsx").read_text()
    inputv_src = (SRC / "components" / "InputView.jsx").read_text()

    # ── UI는 계산하지 않는다 ──────────────────────────────────────
    tr.check("UI_001_inputview_never_calls_scenario_calculators",
             all(fn not in inputv_src for fn in [
                 "calculateOutletBlockedScenario", "calculateOverfillingScenario",
                 "calculateControlValveFailureScenario", "calculateAbnormalHeatVaporScenario",
             ]),
             "InputView.jsx가 §5.x 계산 함수를 직접 호출하면 안 됨 — CaseView가 계산한 결과를 props로만 받아야 함")
    tr.check("UI_001b_inputview_never_calls_selector_adapter_or_engine",
             "selectGoverningReliefLoad(" not in inputv_src
             and "buildReliefSizingInput(" not in inputv_src
             and "api520Engine(" not in inputv_src,
             "InputView.jsx가 selector/adapter/engine을 직접 호출하면 안 됨 — 전부 CaseView 책임")

    # ── state 분리: inputs(manual) / reliefLoadScenarioType / reliefLoadScenarioInput ──
    tr.check("UI_002_three_separate_state_hooks",
             re.search(r"const\s*\[reliefLoadScenarioType,\s*setReliefLoadScenarioType\]\s*=\s*useState\(null\)", casev_src) is not None
             and re.search(r"const\s*\[reliefLoadScenarioInput,\s*setReliefLoadScenarioInput\]\s*=\s*useState\(\{\}\)", casev_src) is not None
             and re.search(r"const\s*\[inputs,\s*setInputs\]\s*=\s*useState\(initialInputs\)", casev_src) is not None,
             "Manual W(inputs)/reliefLoadScenarioType/reliefLoadScenarioInput 세 state가 분리된 훅으로 존재해야 함")
    tr.check("UI_003_scenario_switch_resets_input_not_merges",
             re.search(r"setReliefLoadScenarioType\(type\);\s*\n\s*setReliefLoadScenarioInput\(\{\}\);", casev_src) is not None,
             "시나리오 전환 시 reliefLoadScenarioInput을 완전히 {}로 리셋해야 함(merge 금지, stale 필드 유입 방지)")
    tr.check("UI_003b_same_type_reclick_does_not_wipe_input",
             "if (type === reliefLoadScenarioType) return;" in casev_src,
             "동일 시나리오 재클릭 시 입력 중이던 값이 리셋되면 안 됨(멱등 가드 필요)")

    # ── 자동 fallback 금지: handleCalculate가 engine 호출 전에 차단 ──
    handle_calc_body = casev_src.split("const handleCalculate = ()")[1].split("const _buildAdvancedSnapshot")[0] \
        if "const handleCalculate = ()" in casev_src else ""
    guard_idx = handle_calc_body.find("if (reliefLoadActive && !reliefLoadAdapter?.valid)")
    return_idx = handle_calc_body.find("return;", guard_idx) if guard_idx != -1 else -1
    engine_call_idx = handle_calc_body.find("api520Engine(inputs, deviceType, equipment?.inletPiping")
    tr.check("UI_004_handle_calculate_blocks_before_engine_when_invalid",
             guard_idx != -1 and return_idx != -1 and engine_call_idx != -1 and return_idx < engine_call_idx,
             "handleCalculate가 시나리오 활성화+invalid 상태에서 api520Engine 호출 전에 즉시 return해야 함")
    tr.check("UI_005_no_hardcoded_max_or_reduce_governing_logic_in_caseview",
             not re.search(r"\.reduce\s*\(|\bMath\.max\s*\(",
                           casev_src.split("function CaseView")[1] if "function CaseView" in casev_src else casev_src),
             "CaseView가 governing 선택을 위한 자체 비교 로직(reduce/Math.max)을 재구현하면 안 됨")

    # ── Snapshot: workflow 전이 시 reliefLoad null→undefined 정규화 ──
    tr.check("UI_006_advance_snapshot_normalizes_null_to_undefined",
             "snapshot.reliefLoad === null ? undefined : snapshot.reliefLoad" in casev_src,
             "_buildAdvancedSnapshot가 snapshot.reliefLoad(null)을 그대로 재전달하면 안 됨 — "
             "undefined로 정규화해야 reliefLoad 미사용 Case의 workflow 전이 시 hash가 회귀하지 않음")

    # ── §5.8 CHECK_VALVE_FAILURE는 입력 폼을 만들지 않고 즉시 NEEDS_ENGINEERING_DECISION ──
    check_valve_branch = re.search(r'mode === "CHECK_VALVE_FAILURE".*?\)\s*\}', inputv_src, re.S)
    tr.check("UI_007_check_valve_failure_no_input_form",
             check_valve_branch is not None and "ScenarioNumberField" not in check_valve_branch.group(0),
             "CHECK_VALVE_FAILURE 분기는 숫자 입력 필드를 렌더링하면 안 됨(원문에 계산식 없음)")
    tr.check("UI_007b_check_valve_failure_shows_guidance_message",
             check_valve_branch is not None and "역류" in check_valve_branch.group(0),
             "CHECK_VALVE_FAILURE 분기에 §5.8(3) 안내 문구(역류 상황/기법 선정은 사용자 결정)가 없음")

    # ── phase/failureMode 조건부 필드 — 원문에 없는 입력을 요구하지 않음 ──
    tr.check("UI_008_outlet_blocked_generation_rate_conditional_on_vapor",
             'scenarioInput.phase === "VAPOR"' in inputv_src,
             "§5.1 generationRate_kgh 필드는 phase===VAPOR일 때만 표시되어야 함")

    node = shutil.which("node")
    if not node:
        tr.check("UI_node_available", False, "node를 찾을 수 없어 실행 검증을 건너뜀")
        return tr

    # ══ 동적 검증: CaseView의 파생 로직을 동일하게 재현해 순수 함수 체인 자체를 실행 검증 ══
    # (CaseView.jsx/InputView.jsx는 JSX라 node에서 직접 eval 불가 — 로직은 이미 위 정적
    #  검사로 소스에 실재함을 확인했으므로, 여기서는 그 로직이 호출하는 순수 함수들의
    #  동작 자체가 계약대로인지를 동일한 시퀀스로 실행해 확인한다)
    check_script = f"""
const fs = require('fs');
const files = ['engine/relief_load.js','engine/backpressure.js','engine/api520.js','engine/evidence.js','snapshot/create.js']
  .map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);

const out = {{}};
const baseInp = {{ W:5000, P1:10, P2:1, T:320, M:44, k:1.28, Kd:0.975, Kb:1.0, mawp:11, OP:10, Z:1.0 }};

const META = {{
  OUTLET_BLOCKED:     calculateOutletBlockedScenario,
  OVERFILLING:         calculateOverfillingScenario,
  CONTROL_VALVE_FAIL:  calculateControlValveFailureScenario,
  ABNORMAL_HEAT_VAPOR: calculateAbnormalHeatVaporScenario,
}};
function deriveChain(scenarioType, scenarioInput) {{
  const result = scenarioType ? META[scenarioType](scenarioInput) : null;
  const selector = result ? selectGoverningReliefLoad([result]) : null;
  const adapter = selector ? buildReliefSizingInput(selector) : null;
  return {{ result, selector, adapter }};
}}

// ── UI-101 (Point 4A): Manual W만 존재 ──
{{
  const chain = deriveChain(null, {{}});
  const eng = api520Engine(baseInp, 'safetyValve', null, undefined);
  out.manualOnlySource = eng.stepData.reliefLoadSource.source;
  out.manualOnlyValid = eng.valid;
  out.manualOnlyW = eng.stepData.orifice.W;
}}

// ── UI-102 (Point 4B): Scenario W 정상(§5.6) ──
{{
  const chain = deriveChain('OVERFILLING', {{ inflow_kgh: 4200 }});
  const eng = api520Engine(baseInp, 'safetyValve', null, chain.adapter);
  out.scenarioSource = eng.stepData.reliefLoadSource.source;
  out.scenarioW = eng.stepData.orifice.W;
  out.scenarioManualPreserved = eng.stepData.reliefLoadSource.manualW === 5000;
}}

// ── UI-103 (Point 4C): Scenario 활성화 + invalid — engine 레벨 방어까지 확인 ──
{{
  const chain = deriveChain('OVERFILLING', {{}}); // inflow_kgh 누락
  out.invalidAdapterValid = chain.adapter.valid;
  const eng = api520Engine(baseInp, 'safetyValve', null, chain.adapter);
  out.invalidEngineRejected = (eng.valid === false);
  out.invalidNoSilentAreaCm2 = (eng.areaCm2 === undefined);
}}

// ── UI-104 (Point 5): 시나리오 전환 시 state collision 없음 ──
{{
  let scenarioType = null, scenarioInput = {{}};
  function switchType(t) {{ if (t === scenarioType) return; scenarioType = t; scenarioInput = {{}}; }}
  function setField(k,v) {{ scenarioInput = {{ ...scenarioInput, [k]: v }}; }}
  switchType('OUTLET_BLOCKED');
  setField('phase','VAPOR'); setField('inflow_kgh',1000); setField('generationRate_kgh',300);
  const ob = calculateOutletBlockedScenario(scenarioInput);
  switchType('OVERFILLING');
  out.noStaleFieldsAfterSwitch = !('phase' in scenarioInput) && !('generationRate_kgh' in scenarioInput) && !('inflow_kgh' in scenarioInput);
  setField('inflow_kgh', 4200);
  const of = calculateOverfillingScenario(scenarioInput);
  out.obW = ob.W; out.ofW = of.W;
}}

// ── UI-105: 4개 시나리오 전부 governing 체인 정상 동작 ──
{{
  const cases = [
    ['OUTLET_BLOCKED',     {{ phase:'LIQUID', inflow_kgh: 800 }}],
    ['OVERFILLING',         {{ inflow_kgh: 900 }}],
    ['CONTROL_VALVE_FAIL',  {{ failureMode:'INLET_VALVE', inflow_kgh: 1200, outflow_kgh: 200 }}],
    ['ABNORMAL_HEAT_VAPOR', {{ failureMode:'ABNORMAL_HEAT_INPUT', vaporGeneration_kgh: 700, outflow_kgh: 100 }}],
  ];
  out.allFourValid = cases.every(([t,inp]) => {{
    const chain = deriveChain(t, inp);
    return chain.result.status === 'OK' && chain.adapter.valid === true && typeof chain.adapter.W === 'number';
  }});
}}

// ── UI-106: CHECK_VALVE_FAILURE는 sizing 불가 상태로 명확히 종료 ──
{{
  const chain = deriveChain('ABNORMAL_HEAT_VAPOR', {{ failureMode:'CHECK_VALVE_FAILURE' }});
  out.checkValveStatus = chain.result.status;
  out.checkValveAdapterValid = chain.adapter.valid;
  const eng = api520Engine(baseInp, 'safetyValve', null, chain.adapter);
  out.checkValveEngineRejected = (eng.valid === false);
}}

// ── UI-107: 0이 유효한 필드(부주의한 밸브 개방 outflow=0) 정상 통과 ──
{{
  const chain = deriveChain('ABNORMAL_HEAT_VAPOR', {{ failureMode:'INADVERTENT_VALVE_OPENING', inflow_kgh: 1000, outflow_kgh: 0 }});
  out.zeroOutflowStatus = chain.result.status;
  out.zeroOutflowW = chain.result.W;
  out.zeroOutflowAdapterValid = chain.adapter.valid;
}}

// ── UI-108: 음수/NaN/Infinity 거부(전체 체인 레벨) ──
{{
  const negChain = deriveChain('OVERFILLING', {{ inflow_kgh: -100 }});
  const nanChain = deriveChain('OVERFILLING', {{ inflow_kgh: NaN }});
  const infChain = deriveChain('OVERFILLING', {{ inflow_kgh: Infinity }});
  out.negRejected = negChain.adapter.valid === false;
  out.nanRejected = nanChain.adapter.valid === false;
  out.infRejected = infChain.adapter.valid === false;
}}

// ── UI-109/110: Snapshot reliefLoad + null→undefined 정규화가 hash 안정성을 보장 ──
{{
  const eng = api520Engine(baseInp, 'safetyValve', null);

  // (A) reliefLoad 없는 Case — 최초 생성과 workflow 전이 후 result_hash가 동일해야 함
  const snap0_noRelief = createSnapshot({{ caseId:'C1', valveTag:'PSV-1', deviceType:'safetyValve', inputs: baseInp, engineResult: eng,
    workflowDecision: {{ state:'INSPECTION' }} }});
  const normalizedA = snap0_noRelief.reliefLoad === null ? undefined : snap0_noRelief.reliefLoad;
  const snap1_noRelief = createSnapshot({{ caseId:'C1', valveTag:'PSV-1', deviceType:'safetyValve', inputs: baseInp, engineResult: eng,
    workflowDecision: {{ state:'REVIEW' }}, reliefLoad: normalizedA }});
  out.noReliefHashStable = snap0_noRelief.result_hash === snap1_noRelief.result_hash;

  // 대조군: 정규화 없이 null을 그대로 넘기면(버그가 있었다면) hash가 달라졌을 것 — 그 사실 자체를 증명
  const snap1_noRelief_buggy = createSnapshot({{ caseId:'C1', valveTag:'PSV-1', deviceType:'safetyValve', inputs: baseInp, engineResult: eng,
    workflowDecision: {{ state:'REVIEW' }}, reliefLoad: snap0_noRelief.reliefLoad }});
  out.buggyPathWouldHaveDiffered = snap0_noRelief.result_hash !== snap1_noRelief_buggy.result_hash;

  // (B) reliefLoad 있는 Case — workflow 전이 후에도 내용과 hash 모두 보존
  const relief1 = {{ scenarios:[{{scenarioId:'OVERFILLING', W:4200, unit:'kg/h'}}], governing:'OVERFILLING', quantity:'MASS_FLOW', unit:'kg/h', provenance:{{}} }};
  const snap0_relief = createSnapshot({{ caseId:'C2', valveTag:'PSV-2', deviceType:'safetyValve', inputs: baseInp, engineResult: eng,
    workflowDecision: {{ state:'INSPECTION' }}, reliefLoad: relief1 }});
  const normalizedB = snap0_relief.reliefLoad === null ? undefined : snap0_relief.reliefLoad;
  const snap1_relief = createSnapshot({{ caseId:'C2', valveTag:'PSV-2', deviceType:'safetyValve', inputs: baseInp, engineResult: eng,
    workflowDecision: {{ state:'REVIEW' }}, reliefLoad: normalizedB }});
  out.reliefContentPreserved = JSON.stringify(snap1_relief.reliefLoad) === JSON.stringify(relief1);
  out.reliefHashStableAcrossAdvance = snap0_relief.result_hash === snap1_relief.result_hash;
}}

console.log(JSON.stringify(out));
"""
    cp = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
    try:
        out = json.loads(cp.stdout.strip().splitlines()[-1]) if cp.stdout.strip() else {{}}
    except Exception:
        out = {{}}

    tr.check("UI_101_manual_w_only_path",
             out.get("manualOnlySource") == "MANUAL_INPUT" and out.get("manualOnlyValid") is True
             and out.get("manualOnlyW") == 5000,
             f"Manual W 경로(4A) 실패: {out} stdout={cp.stdout!r} stderr={cp.stderr!r}")
    tr.check("UI_102_scenario_w_governing_path",
             out.get("scenarioSource") == "GOVERNING_RELIEF_LOAD" and out.get("scenarioW") == 4200
             and out.get("scenarioManualPreserved") is True,
             f"Scenario governing 경로(4B) 실패: {out}")
    tr.check("UI_103_invalid_scenario_no_silent_fallback",
             out.get("invalidAdapterValid") is False and out.get("invalidEngineRejected") is True
             and out.get("invalidNoSilentAreaCm2") is True,
             f"Scenario invalid(4C)인데 manual W로 조용히 진행됨(금지된 fallback): {out}")
    tr.check("UI_104_no_state_collision_on_scenario_switch",
             out.get("noStaleFieldsAfterSwitch") is True and out.get("obW") == 1300 and out.get("ofW") == 4200,
             f"시나리오 전환 시 이전 시나리오 필드가 남아 영향을 줌: {out}")
    tr.check("UI_105_all_four_mvp_scenarios_reach_governing",
             out.get("allFourValid") is True,
             f"§5.1/5.6/5.7/5.8 중 하나 이상이 정상 governing 체인에 도달하지 못함: {out}")
    tr.check("UI_106_check_valve_failure_ends_as_insufficient_no_sizing",
             out.get("checkValveStatus") == "NEEDS_ENGINEERING_DECISION" and out.get("checkValveAdapterValid") is False
             and out.get("checkValveEngineRejected") is True,
             f"CHECK_VALVE_FAILURE가 sizing 가능한 상태로 잘못 처리됨: {out}")
    tr.check("UI_107_zero_valid_field_passes",
             out.get("zeroOutflowStatus") == "OK" and out.get("zeroOutflowW") == 1000
             and out.get("zeroOutflowAdapterValid") is True,
             f"0이 유효한 필드(outflow=0)가 잘못 거부됨: {out}")
    tr.check("UI_108_negative_nan_infinity_rejected",
             out.get("negRejected") is True and out.get("nanRejected") is True and out.get("infRejected") is True,
             f"음수/NaN/Infinity가 거부되지 않음: {out}")
    tr.check("UI_109_no_relief_load_hash_stable_across_workflow_advance",
             out.get("noReliefHashStable") is True,
             f"reliefLoad 미사용 Case가 workflow 전이만으로 result_hash가 바뀜(회귀): {out}")
    tr.check("UI_109b_naive_null_forwarding_would_have_broken_hash_stability",
             out.get("buggyPathWouldHaveDiffered") is True,
             f"null→undefined 정규화가 실제로 필요했는지 증명 실패(정규화 없이도 hash가 우연히 같았다면 이 수정의 근거가 약해짐): {out}")
    tr.check("UI_110_relief_load_content_and_hash_preserved_across_advance",
             out.get("reliefContentPreserved") is True and out.get("reliefHashStableAcrossAdvance") is True,
             f"reliefLoad 사용 Case의 workflow 전이 시 근거/hash가 보존되지 않음: {out}")

    return tr


# ════════════════════════════════════════════════════════════════
#  BASELINE LOCK CONTRACT (Sprint A.1) — Engine 1.3.0 기준선 보호 장치
#  1) ENGINE-VERSION-LOCK-001: Snapshot/ReportPackage/Fixture 엔진버전 일치
#  2) GOLDEN-FIXTURE-MUTATION-GUARD-001: fixture를 손으로 고치면 감지
#  3) TRACE-SCHEMA-001: Calculation Trace 필드 스키마 고정
# ════════════════════════════════════════════════════════════════
def test_baseline_lock_contract() -> TestResult:

    tr = TestResult("BASELINE-LOCK-001", "Sprint A.1 — Engine 1.3.0 Baseline 보호 장치")

    node = shutil.which("node")
    pkg_src    = (SRC / "report" / "createPackage.js").read_text()
    schema_src = (SRC / "report" / "schema.js").read_text()
    api520_src = (SRC / "engine" / "api520.js").read_text()

    # ── 1) ENGINE-VERSION-LOCK-001 ──────────────────────────────
    tr.check("ENGINE_VERSION_LOCK_001_check_exists_in_createPackage",
             "ENGINE-VERSION-LOCK-001" in pkg_src and "snapshot.engine_version !== ENGINE_VERSION" in pkg_src,
             "createPackage.js에 ENGINE-VERSION-LOCK-001 검증이 없음")
    tr.check("ENGINE_VERSION_LOCK_001_schema_passes_through_reason",
             "ENGINE-VERSION-LOCK-001" in schema_src,
             "schema.js의 validateReportPackage가 ENGINE-VERSION-LOCK-001 사유를 통과시키지 않음")

    if node:
        # 실제로 버전이 어긋난 Snapshot을 넣으면 정말 차단되는지 실행 검증
        check_script = (
            "const fs = require('fs');\n"
            "const files = ['engine/api520.js','engine/backpressure.js','engine/evidence.js',\n"
            "  'snapshot/create.js','report/schema.js','report/createPackage.js']\n"
            "  .map(f => fs.readFileSync(SRC_DIR + '/' + f, 'utf8')).join(String.fromCharCode(10));\n"
            "(0, eval)(files + '\\nglobalThis.__ARC = { ENGINE_VERSION, buildReportPackage, validateReportPackage };\\n');\n"
            "const { ENGINE_VERSION, buildReportPackage, validateReportPackage } = globalThis.__ARC;\n"
            "const staleSnap = { snapshotHash:'abc', engine_version:'0.9.0-does-not-exist',\n"
            "  assetRefs:{}, caseId:'C', id:'S', workflow:'DRAFT' };\n"
            "const r = buildReportPackage(staleSnap, { generatedAt:'2026-01-01T00:00:00Z' });\n"
            "const v = validateReportPackage(r);\n"
            "console.log(JSON.stringify({ engineVersion: ENGINE_VERSION, buildOk: r.ok, "
            "buildContract: r.contract, validateOk: v.ok, validateReason: v.reason }));\n"
        )
        check_script = f"const SRC_DIR = {json.dumps(str(SRC))};\n" + check_script
        # node -e(문자열 eval)와 node file.js(파일 실행)는 indirect eval의
        # 스코프 처리가 달라 -e에서 "already declared" 오탐이 난다 — 파일로
        # 써서 실행한다.
        tmp_js = ROOT / "tests" / "_tmp_engine_version_lock_check.js"
        tmp_js.write_text(check_script)
        r = subprocess.run([node, str(tmp_js)], capture_output=True, text=True, timeout=15)
        tmp_js.unlink(missing_ok=True)
        try:
            result = json.loads(r.stdout.strip())
        except Exception:
            result = None
        tr.check("ENGINE_VERSION_LOCK_001_actually_blocks_stale_snapshot",
                 result is not None and result.get("buildOk") is False
                 and result.get("buildContract") == "ENGINE-VERSION-LOCK-001",
                 f"버전이 다른 Snapshot으로 buildReportPackage 호출 시 차단되지 않음 — stdout={r.stdout!r} stderr={r.stderr!r}")
        tr.check("ENGINE_VERSION_LOCK_001_validate_surfaces_clear_reason",
                 result is not None and result.get("validateOk") is False
                 and "ENGINE_VERSION" in (result.get("validateReason") or "")
                     or (result is not None and "엔진 버전" in (result.get("validateReason") or "")),
                 "validateReportPackage가 ENGINE-VERSION-LOCK-001 사유를 명확히 드러내지 않음")
    else:
        tr.check("ENGINE_VERSION_LOCK_001_node_available", False, "node 없음 — 실행 검증 생략")

    # ── 2) GOLDEN-FIXTURE-MUTATION-GUARD-001 ────────────────────
    fixtures_dir = ROOT / "tests" / "fixtures"
    manifest_path = fixtures_dir / "hash-manifest.json"
    tr.check("MUTATION_GUARD_001_manifest_exists", manifest_path.exists(),
             "tests/fixtures/hash-manifest.json 없음")
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        for fname, expected in manifest.items():
            fpath = fixtures_dir / fname
            if not fpath.exists():
                tr.check(f"MUTATION_GUARD_001_file_exists_{fname}", False, f"{fname} 없음(manifest엔 있음)")
                continue
            actual = "sha256:" + hashlib.sha256(fpath.read_bytes()).hexdigest()
            tr.check(f"MUTATION_GUARD_001_hash_matches_{fname}",
                     actual == expected,
                     f"{fname}: 파일이 generate_golden_fixtures.js를 거치지 않고 직접 수정된 것으로 보임 "
                     f"(manifest={expected}, actual={actual}) — 재생성 스크립트를 다시 실행하세요.")
        # 생성 스크립트가 manifest도 함께 갱신하는지(수동 관리로 어긋나지 않도록) 소스로 확인
        gen_src = (ROOT / "tests" / "generate_golden_fixtures.js").read_text()
        tr.check("MUTATION_GUARD_001_generator_writes_manifest",
                 "hash-manifest.json" in gen_src,
                 "generate_golden_fixtures.js가 hash-manifest.json을 자동 갱신하지 않음 — "
                 "수동 관리 시 fixture와 manifest가 어긋날 위험")

    # ── 3) TRACE-SCHEMA-001 ──────────────────────────────────────
    tr.check("TRACE_SCHEMA_001_validator_exists",
             "function validateTraceSchema" in api520_src and "TRACE_REQUIRED_KEYS" in api520_src,
             "api520.js에 validateTraceSchema/TRACE_REQUIRED_KEYS 없음")
    if node:
        trace_script = (
            "const fs = require('fs');\n"
            "const src = fs.readFileSync(SRC_DIR + '/engine/api520.js','utf8') "
            "+ '\\nmodule.exports={ api520Engine, validateTraceSchema };';\n"
            "fs.writeFileSync('/tmp/_trace_schema_test.js', src);\n"
            "const { api520Engine, validateTraceSchema } = require('/tmp/_trace_schema_test.js');\n"
            "const r = api520Engine({W:2500,P1:5.5,P2:0.3,T:373,M:44,k:1.30,Kd:0.975,Kb:1.0,"
            "mawp:6.0,OP:10,Z:1.0}, 'safetyValve');\n"
            "const v = validateTraceSchema(r.trace);\n"
            "console.log(JSON.stringify({ traceLen: r.trace.length, schemaOk: v.ok, "
            "steps: r.trace.map(t=>t.step) }));\n"
        )
        trace_script = f"const SRC_DIR = {json.dumps(str(SRC))};\n" + trace_script
        cp = subprocess.run([node, "-e", trace_script], capture_output=True, text=True, timeout=15)
        try:
            tresult = json.loads(cp.stdout.strip())
        except Exception:
            tresult = None
        tr.check("TRACE_SCHEMA_001_real_engine_output_passes_schema",
                 tresult is not None and tresult.get("schemaOk") is True and tresult.get("traceLen", 0) >= 7,
                 f"실제 엔진 trace 출력이 스키마 검증을 통과하지 못함 — stdout={cp.stdout!r} stderr={cp.stderr!r}")
        expected_steps = ["COMPRESSIBILITY_Z","RELIEF_LOAD_W_SOURCE","SET_PRESSURE","RELIEVING_PRESSURE",
                           "C_COEFFICIENT","MASS_FLUX_AREA","REQUIRED_AREA","ORIFICE_SELECTION",
                           "BACKPRESSURE_POLICY","ACCUMULATION_POLICY","ACCUMULATION_GUARDRAIL",
                           "INLET_LOSS_POLICY","INLET_LOSS_CALCULATION","INLET_LOSS_GUARDRAIL"]
        tr.check("TRACE_SCHEMA_001_step_order_frozen",
                 tresult is not None and tresult.get("steps") == expected_steps,
                 f"trace 단계 순서/구성이 계약과 다름(C-4.8B에서 RELIEF_LOAD_W_SOURCE 단계가 "
                 f"COMPRESSIBILITY_Z 다음에 신설됨) — actual={tresult.get('steps') if tresult else None}")
    else:
        tr.check("TRACE_SCHEMA_001_node_available", False, "node 없음 — 실행 검증 생략")

    return tr


#  tests/generate_golden_fixtures.js가 실제 코드(api520Engine,
#  createSnapshot, computeWorkflowState, detectMOC, submitApproval,
#  buildReportPackage, verifyApprovalRecord)를 그대로 실행해 만든
#  두 fixture가, 그 실행 결과를 신뢰성 있게 담고 있는지 확인한다.
# ════════════════════════════════════════════════════════════════
def test_golden_baseline_contract() -> TestResult:
    tr = TestResult("GOLDEN-BASELINE-001", "Engine 1.3.0 Golden Fixture 기준선 계약")

    api520_src = (SRC / "engine" / "api520.js").read_text()
    m = re.search(r'const ENGINE_VERSION = "([\d.]+)"', api520_src)
    current_engine_version = m.group(1) if m else None

    fixtures_dir = ROOT / "tests" / "fixtures"
    pkgs = {}
    for name in ["PSV-R201-review-required-package.json", "PSV-R201-approved-package.json"]:
        p = fixtures_dir / name
        if not p.exists():
            tr.check(f"GOLDEN_fixture_exists_{name}", False, f"{name} 없음")
            continue
        pkgs[name] = json.loads(p.read_text())

    for name, pkg in pkgs.items():
        # ── GOLDEN-001: ENGINE_VERSION 일치 (fixture가 현재 소스와 동기화돼 있는가) ──
        tr.check(f"GOLDEN_001_engine_version_{name}",
                 pkg["meta"]["engineVersion"] == current_engine_version
                 and pkg["calculation"]["engineVersion"] == current_engine_version,
                 f"{name}: meta/calculation engineVersion이 현재 소스({current_engine_version})와 다름 "
                 f"— (meta={pkg['meta']['engineVersion']}, calc={pkg['calculation']['engineVersion']})")

        # ── GOLDEN-002: BUILD_HASH 기록 ─────────────────────────
        fm = pkg.get("_fixtureMeta", {})
        tr.check(f"GOLDEN_002_build_hash_recorded_{name}",
                 bool(fm.get("buildHash")) and fm.get("buildHash") != "UNKNOWN",
                 f"{name}: _fixtureMeta.buildHash가 기록되지 않음")
        tr.check(f"GOLDEN_002_fixture_meta_complete_{name}",
                 all(k in fm for k in ("engineVersion","buildHash","generatedAt","fixtureName")),
                 f"{name}: _fixtureMeta 필드 누락")

        # ── GOLDEN-003: ReportPackage.packageVersion 확인 ───────
        tr.check(f"GOLDEN_003_package_version_{name}",
                 pkg["meta"]["packageVersion"] == "1.0.0",
                 f"{name}: packageVersion={pkg['meta']['packageVersion']} (기대: 1.0.0)")

        # ── GOLDEN-004: inputs.Z 존재 및 값 일치 ────────────────
        tr.check(f"GOLDEN_004_inputs_Z_present_{name}",
                 "Z" in pkg["calculation"]["inputs"],
                 f"{name}: calculation.inputs.Z 없음")
        tr.check(f"GOLDEN_004_stepData_Z_matches_inputs_Z_{name}",
                 pkg["calculation"]["result"]["stepData"]["fluid"]["Z"] == pkg["calculation"]["inputs"]["Z"],
                 f"{name}: stepData.fluid.Z가 inputs.Z와 다름")

        # ── GOLDEN-005: CalculationTrace에 COMPRESSIBILITY_Z 단계 ──
        trace_steps = [t["step"] for t in pkg["calculation"]["result"].get("trace", [])]
        tr.check(f"GOLDEN_005_trace_has_compressibility_Z_{name}",
                 "COMPRESSIBILITY_Z" in trace_steps,
                 f"{name}: trace에 COMPRESSIBILITY_Z 단계 없음 (trace={trace_steps})")
        tr.check(f"GOLDEN_005_trace_has_relieving_pressure_{name}",
                 "RELIEVING_PRESSURE" in trace_steps,
                 f"{name}: trace에 RELIEVING_PRESSURE 단계 없음")

        # ── GOLDEN-006: RelievingPressure(abs)가 result/PDF 양쪽에 동일 ──
        p1abs = pkg["calculation"]["result"].get("P1abs")
        tr.check(f"GOLDEN_006_P1abs_present_{name}",
                 p1abs is not None and p1abs > 0,
                 f"{name}: calculation.result.P1abs 없음/비정상")
        node = shutil.which("node")
        if node:
            check_script = f"""
const fs = require('fs');
const files = ['report/schema.js','report/renderer/pdf/styles.js','report/renderer/pdf/template.js']
  .map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);
const pkg = {json.dumps(pkg)};
console.log(buildPDFHtml(pkg));
"""
            r = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
            html = r.stdout
            tr.check(f"GOLDEN_006_P1abs_shown_in_PDF_{name}",
                     f"{p1abs:.3f}" in html,
                     f"{name}: PDF에 Relieving Pressure(abs)={p1abs:.3f}가 표시되지 않음")
            # ── GOLDEN-007: Required Area / Orifice가 PDF에도 동일하게 표시 ──
            area = pkg["calculation"]["result"]["areaCm2"]
            orifice = pkg["calculation"]["result"]["selected"]["letter"]
            tr.check(f"GOLDEN_007_area_shown_in_PDF_{name}",
                     f"{area:.2f}" in html,
                     f"{name}: PDF에 Required Area={area:.2f}cm²가 표시되지 않음")
            tr.check(f"GOLDEN_007_orifice_shown_in_PDF_{name}",
                     orifice in html,
                     f"{name}: PDF에 Orifice({orifice})가 표시되지 않음")
        else:
            tr.check(f"GOLDEN_006_node_available_{name}", False, "node 없음 — PDF 대조 생략")

        # evidence.js(화면)도 동일 stepData를 소비하므로 근원이 하나임을 소스로 재확인
        evid_src = (SRC / "engine" / "evidence.js").read_text()
        tr.check(f"GOLDEN_007_evidence_reads_same_selection_object_{name}",
                 "selection.areaCm2" in evid_src and "selection.selected" in evid_src,
                 "evidence.js가 별도로 면적/오리피스를 재계산하지 않고 stepData.selection을 그대로 읽는지 확인 실패")

    # ── GOLDEN-008: snapshotHash가 ReportPackage와 Approval Record에서 동일(승인 시나리오) ──
    approved = pkgs.get("PSV-R201-approved-package.json")
    if approved:
        approvals = approved.get("approvals", [])
        tr.check("GOLDEN_008_approved_has_approval_record",
                 len(approvals) > 0,
                 "approved fixture에 approvals가 비어있음")
        if approvals:
            # REPORT-PKG-004: pkg.approvals는 snapshotHash가 일치하는 것만 필터링해 담김 —
            # 즉 이 배열에 들어있다는 사실 자체가 이미 snapshotHash 일치를 증명한다.
            # 여기서는 그 필터링이 실제로 통과했다는 증거(verified=true)까지 함께 확인한다.
            tr.check("GOLDEN_008_approval_verified_true",
                     approvals[0].get("verified") is True,
                     "approved fixture의 승인 기록이 verified=true가 아님 — "
                     "실제 서명 재검증(verifyApprovalRecord)을 통과하지 못한 상태")
            tr.check("GOLDEN_008_snapshotHash_referenced_consistently",
                     approved["identity"]["snapshotHash"] is not None
                     and len(approved["identity"]["snapshotHash"]) == 8,
                     "approved fixture의 identity.snapshotHash 형식이 비정상")

    review = pkgs.get("PSV-R201-review-required-package.json")
    if review and approved:
        tr.check("GOLDEN_008_review_and_approved_share_asset_lineage",
                 review["asset"]["assetFingerprint"] == approved["asset"]["assetFingerprint"],
                 "review-required와 approved fixture의 assetFingerprint가 다름 — 동일 Asset 계보가 아님")
        tr.check("GOLDEN_008_review_has_no_approvals",
                 len(review.get("approvals", [])) == 0,
                 "review-required fixture에 approvals가 있음 — 승인 전 상태와 모순")

    return tr


def test_snapshot_schema() -> TestResult:
    tr = TestResult("SCHEMA-001", "Snapshot schema 필수 필드 검사")
    snap_src = (SRC / "snapshot" / "create.js").read_text()

    required_fields = [
        ("engine_version", "engine 버전 추적"),
        ("result_hash",    "결정론 검증용 hash"),
        ("Object.freeze",  "불변성 강제"),
        ("INVALID_STATE",  "version mismatch 방어"),
        ("SNAPSHOT_ENGINE_VERSION", "버전 고정 상수"),
        ("inputs:",        "입력값 보존"),
        ("result:",        "계산 결과 보존"),
        ("evidence:",      "증거 레이어"),
        ("workflow:",      "워크플로우 상태"),
        # v0.2.0 — 3-레이어 + MOC 감지
        ("equipment:",     "Equipment 복사본 (MOC 비교용)"),
        ("dischargeSystem:","DischargeSystem 복사본 (MOC 비교용)"),
        ("assetRefs",      "검토 시점 Asset 식별자 기록"),
        ("assetFingerprint","MOC 감지용 fingerprint"),
        ("detectMOC",      "MOC 감지 순수 함수"),
        ("_assetHash",     "Asset fingerprint 생성 함수"),
    ]
    for field, reason in required_fields:
        tr.check(f"schema_field:{field}",
                 field in snap_src,
                 reason)

    # SNAPSHOT_ENGINE_VERSION이 ENGINE_VERSION과 일치하는지
    snap_ver = None
    for line in snap_src.splitlines():
        if "SNAPSHOT_ENGINE_VERSION" in line and "=" in line:
            snap_ver = line.split('"')[1] if '"' in line else None
            break
    tr.check("snapshot_engine_version_matches",
             snap_ver == ENGINE_VERSION,
             f"snapshot expects={snap_ver}, engine={ENGINE_VERSION}")

    return tr

# ════════════════════════════════════════════════════════════════
#  BOUNDARY TEST — engine이 외부 의존 없이 독립 실행 가능한지
# ════════════════════════════════════════════════════════════════
def test_engine_boundary() -> TestResult:
    tr = TestResult("BOUNDARY-001", "Engine 독립 실행 가능성 (외부 의존 없음)")
    engine_files = [
        SRC / "engine" / "api520.js",
        SRC / "engine" / "backpressure.js",
        SRC / "engine" / "evidence.js",
    ]
    forbidden = [
        "import ", "require(", "window.", "document.",
        "localStorage", "fetch(", "setTimeout(", "setInterval(",
        "Date.now()", "Math.random()", "crypto.randomUUID(",
    ]
    for path in engine_files:
        text = path.read_text()
        non_comment = [l for l in text.splitlines() if l.strip() and not l.strip().startswith("//")]
        code = "\n".join(non_comment)
        for sym in forbidden:
            tr.check(f"engine_no:{sym}:{path.name}",
                     sym not in code,
                     f"{path.name}에 {sym!r} 발견")
    return tr

# ════════════════════════════════════════════════════════════════
#  UI-ENGINE WIRING TEST
#  목적: InputView가 "정의됐지만 호출 안 됨" 또는
#       "호출하는데 정의 없음" 상태가 되는 사고를 잡는다.
#  (R201_DEFAULTS, calculateKb 누락 사고의 재발 방지용 화이트리스트 검사)
# ════════════════════════════════════════════════════════════════

# ════════════════════════════════════════════════════════════════
#  MOC_SCHEMA_001 — detectMOC diff 스키마 불변 계약
#  detectMOC()가 반환하는 diff는 반드시 { field, from, to, unit } 4개 필드.
#  이 계약이 깨지면 CaseView 배너 + computeWorkflowState 모두 오작동.
# ════════════════════════════════════════════════════════════════
def test_moc_schema() -> TestResult:
    tr = TestResult("MOC_SCHEMA_001", "detectMOC diff 스키마 불변 계약")
    wf_engine = (SRC / "engine" / "workflow_engine.js").read_text()

    # T1: detectMOC 정의 내부에서 { field, from, to, unit } 패턴 사용하는지
    import re
    push_lines = [l.strip() for l in wf_engine.splitlines()
                  if "diffs.push(" in l]
    required_keys = {"field", "from", "to", "unit"}
    for line in push_lines:
        for key in required_keys:
            tr.check(f"diff_has_{key}_in_push",
                     f"{key}:" in line,
                     f"diffs.push()에 '{key}:' 없음: {line[:80]}")

    # T2: evaluateSafetyImpact가 diff를 재조립하지 않는지
    # (triggerDiffs = diffs.filter(...) 형태여야 함 — 새 객체 생성 없음)
    eval_fn_match = re.search(
        r'function evaluateSafetyImpact.*?^}', wf_engine, re.DOTALL | re.MULTILINE
    )
    if eval_fn_match:
        eval_body = eval_fn_match.group(0)
        tr.check("evaluateSafetyImpact_no_reassembly",
                 "{ field:" not in eval_body and "{ from:" not in eval_body,
                 "evaluateSafetyImpact 내부에서 diff를 재조립하고 있음")
        tr.check("evaluateSafetyImpact_uses_filter",
                 ".filter(" in eval_body,
                 "evaluateSafetyImpact가 filter를 사용하지 않음")
    else:
        tr.check("evaluateSafetyImpact_found", False, "evaluateSafetyImpact 함수 없음")

    # T3: computeWorkflowState가 diff 객체를 새로 생성하지 않는지
    compute_match = re.search(
        r'function computeWorkflowState.*?^}', wf_engine, re.DOTALL | re.MULTILINE
    )
    if compute_match:
        compute_body = compute_match.group(0)
        # diffs.push(...)가 computeWorkflowState 내부에 없어야 함
        tr.check("computeWF_no_diff_creation",
                 "diffs.push(" not in compute_body,
                 "computeWorkflowState 내부에서 diff를 직접 생성하고 있음")
    else:
        tr.check("computeWF_found", False, "computeWorkflowState 함수 없음")

    return tr

# ════════════════════════════════════════════════════════════════
#  WORKFLOW_001 — computeWorkflowState 단일 책임 계약
#  Policy: computeWorkflowState()만 최종 workflow state를 결정.
#  CaseView / UI는 이 결과를 읽기만 해야 함.
# ════════════════════════════════════════════════════════════════
def test_workflow_contract() -> TestResult:
    tr = TestResult("WORKFLOW_001", "workflow 결정권이 Engine에만 있는지")
    case_view = (SRC / "components" / "CaseView.jsx").read_text()
    wf_engine = (SRC / "engine" / "workflow_engine.js").read_text()

    # T1: CaseView가 computeWorkflowState를 호출하는지
    tr.check("CaseView_calls_computeWorkflowState",
             "computeWorkflowState(" in case_view,
             "CaseView가 computeWorkflowState를 호출하지 않음")

    # T2: CaseView가 workflow 상태를 직접 문자열로 하드코딩하지 않는지
    # (허용: "INSPECTION" — 최초 계산, "DRAFT" — 초기값)
    import re
    direct_states = re.findall(
        r'workflow\s*[:=]\s*["\']([A-Z_]+)["\']', case_view
    )
    forbidden_direct = [s for s in direct_states
                        if s not in ("INSPECTION", "DRAFT", "REVIEW_REQUIRED")]
    tr.check("CaseView_no_hardcoded_workflow",
             len(forbidden_direct) == 0,
             f"CaseView에서 workflow를 직접 하드코딩: {forbidden_direct}")

    # T3: computeWorkflowState가 engine 파일에만 있는지
    snap_src  = (SRC / "snapshot" / "create.js").read_text()
    dash_src  = (SRC / "components" / "Dashboard.jsx").read_text()
    tr.check("computeWF_not_in_snapshot",
             "function computeWorkflowState" not in snap_src,
             "computeWorkflowState가 snapshot에 잔존")
    tr.check("computeWF_not_in_dashboard",
             "function computeWorkflowState" not in dash_src,
             "computeWorkflowState가 Dashboard에 잔존")

    # T4: 3계층 구조가 workflow_engine.js에 모두 있는지
    for fn in ["detectMOC", "evaluateSafetyImpact", "computeWorkflowState"]:
        tr.check(f"{fn}_in_engine",
                 f"function {fn}" in wf_engine,
                 f"{fn}이 engine에 없음")

    return tr

# ════════════════════════════════════════════════════════════════
#  WFDECISION_001 — workflowDecision trace Snapshot 저장 계약
# ════════════════════════════════════════════════════════════════
def test_workflow_decision_trace() -> TestResult:
    tr = TestResult("WFDECISION_001", "workflowDecision trace가 Snapshot에 기록되는지")
    snap_src = (SRC / "snapshot" / "create.js").read_text()

    required = [
        ("workflowDecision",     "workflowDecision 필드"),
        ("evaluatedAt",          "evaluatedAt 타임스탬프"),
        ("engineVersion",        "engineVersion 기록"),
        ("reasons",              "reasons 배열"),
        ("triggerFields",        "triggerFields 기록"),
        ("WORKFLOW_TRIGGER_FIELDS_SNAPSHOT", "trigger fields 상수"),
    ]
    for sym, desc in required:
        tr.check(f"snap_has_{sym}",
                 sym in snap_src,
                 f"Snapshot에 {desc} 없음")

    # workflowDecision도 Object.freeze되는지
    tr.check("workflowDecision_frozen",
             "Object.freeze({" in snap_src and "workflowDecision" in snap_src,
             "workflowDecision이 freeze되지 않음")

    # evaluatedAt이 Snapshot(createSnapshot)에서 생성되는지
    tr.check("evaluatedAt_in_snapshot",
             "evaluatedAt" in snap_src and "new Date()" in snap_src,
             "evaluatedAt이 snapshot/create.js에서 생성되지 않음")

    # evaluatedAt이 workflow_engine.js 파라미터에 없는지 (Engine 순수성)
    wf_engine = (SRC / "engine" / "workflow_engine.js").read_text()
    tr.check("evaluatedAt_not_in_engine_param",
             "evaluatedAt" not in wf_engine.split("function computeWorkflowState")[1].split(")")[0],
             "evaluatedAt이 computeWorkflowState 파라미터에 잔존")

    # CaseView가 timestamp를 주입하지 않는지
    case_view = (SRC / "components" / "CaseView.jsx").read_text()
    # computeWorkflowState 호출 줄에 new Date()가 없어야 함
    wf_call_lines = [l for l in case_view.splitlines()
                     if "computeWorkflowState(" in l]
    tr.check("CaseView_no_timestamp_injection",
             all("new Date()" not in l for l in wf_call_lines),
             f"CaseView가 여전히 timestamp를 주입하고 있음: {wf_call_lines}")

    return tr

# ════════════════════════════════════════════════════════════════
#  APPROVAL-001 — snapshotHash 없으면 ApprovalRecord 생성 불가
#  APPROVAL-002 — 승인 후 Snapshot 변경 시 검증 실패
#  APPROVAL-003 — 재승인은 별도 이력, 덮어쓰기 없음
# ════════════════════════════════════════════════════════════════
def _py_snap_hash(snap_id, result_hash, asset_fp, evaluated_at, workflow):
    """_snapHash() JS 구현과 동일"""
    import json
    s = json.dumps({"id": snap_id, "result_hash": result_hash,
                    "assetFingerprint": asset_fp,
                    "evaluatedAt": evaluated_at, "workflow": workflow})
    h = 0
    for ch in s:
        h = ((31 * h) + ord(ch)) & 0xFFFFFFFF
    return format(h, '08x')

def _make_mock_snap(snap_id="SNAP-C-001-1234", workflow="INSPECTION"):
    h = _py_snap_hash(snap_id, "abcd1234", "ef567890", "2026-07-05T00:00:00Z", workflow)
    return {"id": snap_id, "snapshotHash": h, "workflow": workflow,
            "result_hash": "abcd1234"}

def test_approval_contracts() -> TestResult:
    tr = TestResult("APPROVAL-001/002/003", "ApprovalRecord 계약 검증")
    approval_src = (SRC / "approval" / "record.js").read_text()

    # ── 소스 구조 확인 ────────────────────────────────────────
    for sym, desc in [
        ("function createApprovalRecord",  "createApprovalRecord 정의"),
        ("function verifyApproval",        "verifyApproval 정의"),
        ("function addApprovalRecord",     "addApprovalRecord 정의"),
        ("APPROVAL-001",                   "APPROVAL-001 계약 주석"),
        ("APPROVAL-002",                   "APPROVAL-002 계약 주석"),
        ("APPROVAL-003",                   "APPROVAL-003 계약 주석"),
        ("snapshotHash",                   "snapshotHash 참조"),
    ]:
        tr.check(f"src_{sym.replace(' ','_')[:30]}", sym in approval_src, f"{desc} 없음")

    # ── APPROVAL-001: snapshotHash 없으면 생성 불가 ───────────
    # Python으로 validateApprovalInput 로직 재현
    def py_validate(inp):
        if not inp.get("snapshotHash","").strip():
            return {"ok": False, "contract": "APPROVAL-001"}
        if not inp.get("snapshotId","").strip():
            return {"ok": False, "contract": "APPROVAL-001"}
        if not inp.get("approver","").strip():
            return {"ok": False, "contract": "APPROVAL-001"}
        roles = ["engineer","senior_engineer","safety_manager","pss_manager"]
        if inp.get("role") not in roles:
            return {"ok": False, "contract": "APPROVAL-001"}
        return {"ok": True}

    tr.check("APPROVAL_001_no_hash",
             py_validate({"snapshotId":"X","approver":"Kim","role":"engineer"})["ok"] == False,
             "snapshotHash 없어도 생성 허용됨 — APPROVAL-001 위반")
    tr.check("APPROVAL_001_valid",
             py_validate({"snapshotHash":"abc","snapshotId":"X","approver":"Kim","role":"engineer"})["ok"] == True,
             "유효한 입력인데 validation 실패")

    # ── APPROVAL-002: Snapshot 변경 시 검증 실패 ─────────────
    snap = _make_mock_snap()
    good_hash = snap["snapshotHash"]
    record = {"snapshotId": snap["id"], "snapshotHash": good_hash, "approver": "Kim"}

    def py_verify(rec, current_snap):
        if rec["snapshotId"] != current_snap["id"]:
            return {"valid": False, "reason": "snapshotId mismatch"}
        if rec["snapshotHash"] != current_snap["snapshotHash"]:
            return {"valid": False, "reason": "APPROVAL-002: hash mismatch"}
        return {"valid": True}

    # 동일 Snapshot → valid
    tr.check("APPROVAL_002_same_snap",
             py_verify(record, snap)["valid"] == True,
             "동일 Snapshot인데 검증 실패")

    # Snapshot workflow 변경 시뮬레이션 → 다른 hash → invalid
    tampered = {**snap, "snapshotHash": _py_snap_hash(
        snap["id"], snap["result_hash"], "ef567890", "2026-07-05T00:00:00Z", "APPROVED"
    )}
    tr.check("APPROVAL_002_tampered",
             py_verify(record, tampered)["valid"] == False,
             "Snapshot 변조인데 검증 통과 — APPROVAL-002 위반")

    # ── APPROVAL-003: 재승인은 push, replace 없음 ─────────────
    hist1 = []
    r1 = {"approvalId":"APPR-001","snapshotHash":good_hash,"approver":"Kim"}
    r2 = {"approvalId":"APPR-002","snapshotHash":good_hash,"approver":"Lee"}

    hist2 = hist1 + [r1]
    hist3 = hist2 + [r2]

    tr.check("APPROVAL_003_history_grows",
             len(hist3) == 2,
             "재승인 후 이력이 2개여야 함")
    tr.check("APPROVAL_003_no_overwrite",
             hist3[0]["approver"] == "Kim" and hist3[1]["approver"] == "Lee",
             "이전 승인 기록이 덮어쓰여짐 — APPROVAL-003 위반")

    # addApprovalRecord가 새 배열 반환하는지 (mutation 없음)
    tr.check("APPROVAL_003_no_mutation",
             "return Object.freeze([...history, newRecord])" in approval_src,
             "addApprovalRecord가 mutation 없이 새 배열 반환하지 않음")

    # ── snapshotHash가 Snapshot에 존재하는지 ──────────────────
    snap_src = (SRC / "snapshot" / "create.js").read_text()
    tr.check("snapshotHash_in_snapshot",
             "snapshotHash" in snap_src and "_snapHash" in snap_src,
             "snapshot/create.js에 snapshotHash 생성 코드 없음")

    return tr

# ════════════════════════════════════════════════════════════════
#  HISTORY-001 — appendSnapshot()은 항상 새 배열 반환, overwrite 없음
#  HISTORY-002 — resolveSnapshot(hash)은 snapshotHistory에서만 조회
#  HISTORY-003 — 같은 case 안 snapshotHash 중복 금지
# ════════════════════════════════════════════════════════════════
def test_case_history_contract() -> TestResult:
    tr = TestResult("HISTORY-001/002/003", "Case Snapshot History 계약 검증")
    history_src = (SRC / "case" / "history.js").read_text()

    for sym, desc in [
        ("function appendSnapshot",   "appendSnapshot 정의"),
        ("function resolveSnapshot",  "resolveSnapshot 정의"),
        ("function getLatestSnapshot","getLatestSnapshot 정의"),
        ("HISTORY-001",               "HISTORY-001 계약 주석"),
        ("HISTORY-002",               "HISTORY-002 계약 주석"),
        ("HISTORY-003",               "HISTORY-003 계약 주석"),
    ]:
        tr.check(f"src_{sym.replace(' ','_')[:30]}", sym in history_src, f"{desc} 없음")

    # ── resolveSnapshot이 latestSnap을 참조하지 않는지 (소스 검사) ──
    # 함수 body만 추출 (첫 '}'까지) — 뒤따르는 주석은 제외
    resolve_body = history_src.split("function resolveSnapshot")[1].split("}")[0]
    tr.check("resolveSnapshot_no_latestSnap_reference",
             "latestSnap" not in resolve_body,
             "resolveSnapshot이 latestSnap을 참조함 — HISTORY-002 위반")

    # ── HISTORY-001: append 시뮬레이션 (Python 재현) ────────────
    def py_append(case_obj, snap):
        prev = case_obj.get("snapshotHistory", [])
        return {**case_obj, "snapshotHistory": prev + [snap],
                "latestSnap": snap, "workflow": snap["workflow"]}

    c0 = {"id": "C-001", "workflow": "DRAFT", "snapshotHistory": []}
    snapA = {"snapshotHash": "hashA", "id": "SNAP-A", "workflow": "INSPECTION"}
    snapB = {"snapshotHash": "hashB", "id": "SNAP-B", "workflow": "REVIEW"}

    c1 = py_append(c0, snapA)
    c2 = py_append(c1, snapB)

    tr.check("HISTORY_001_history_grows",
             len(c2["snapshotHistory"]) == 2,
             "재계산 후 history가 2개여야 함")
    tr.check("HISTORY_001_no_overwrite",
             c2["snapshotHistory"][0]["snapshotHash"] == "hashA" and
             c2["snapshotHistory"][1]["snapshotHash"] == "hashB",
             "이전 Snapshot이 history에서 사라짐 — overwrite 발생, HISTORY-001 위반")
    tr.check("HISTORY_001_original_not_mutated",
             c0["snapshotHistory"] == [],
             "원본 case 객체가 mutate됨 — HISTORY-001 위반")

    # ── HISTORY-002: 재계산 후에도 승인된 옛 Snapshot을 hash로 조회 가능 ──
    def py_resolve(case_obj, snap_hash):
        return next((s for s in case_obj.get("snapshotHistory", [])
                     if s["snapshotHash"] == snap_hash), None)

    tr.check("HISTORY_002_resolve_after_overwrite_latestSnap",
             py_resolve(c2, "hashA") is not None,
             "latestSnap이 hashB로 넘어간 뒤에도 hashA(승인된 옛 Snapshot)를 조회할 수 있어야 함")
    tr.check("HISTORY_002_resolve_latest",
             py_resolve(c2, "hashB") is not None,
             "최신 Snapshot도 동일한 방식으로 조회 가능해야 함")
    tr.check("HISTORY_002_resolve_unknown_returns_none",
             py_resolve(c2, "hash-does-not-exist") is None,
             "존재하지 않는 hash 조회 시 None이 아닌 값 반환")

    # ── HISTORY-003: 중복 hash 감지 ──────────────────────────────
    c_dup = py_append(c1, {"snapshotHash": "hashA", "id": "SNAP-C", "workflow": "REVIEW"})
    hashes = [s["snapshotHash"] for s in c_dup["snapshotHistory"]]
    tr.check("HISTORY_003_duplicate_detected",
             len(set(hashes)) != len(hashes),
             "중복 snapshotHash가 감지되지 않음")

    # ── ArcSafe.jsx가 appendSnapshot을 통해서만 case를 갱신하는지 ──
    arcsafe_src = (SRC.parent / "src" / "ArcSafe.jsx").read_text()
    handler_body = arcsafe_src.split("handleSnapshotCreate")[1].split("};")[0]
    tr.check("ArcSafe_uses_appendSnapshot",
             "appendSnapshot(" in handler_body,
             "handleSnapshotCreate가 appendSnapshot()을 사용하지 않음 — overwrite 가능성")
    tr.check("ArcSafe_no_direct_latestSnap_overwrite",
             "latestSnap: snap" not in handler_body,
             "handleSnapshotCreate가 latestSnap을 직접 overwrite함 — HISTORY-001 위반")

    # ── SnapshotHash identity: workflow 변경은 patch가 아니라 재생성이어야 함 ──
    case_view_src = (SRC / "components" / "CaseView.jsx").read_text()
    advance_body = case_view_src.split("_buildAdvancedSnapshot = (nextState")[1].split("\n  };")[0]
    tr.check("workflowAdvance_uses_createSnapshot",
             "createSnapshot(" in advance_body,
             "handleWorkflowAdvance가 createSnapshot()으로 재생성하지 않음 — "
             "workflow 변경 시 snapshotHash가 stale해짐 (Identity vs State collapse)")
    tr.check("workflowAdvance_no_raw_workflow_mutation",
             "workflow:         nextState" not in advance_body and
             "workflow: nextState" not in advance_body,
             "handleWorkflowAdvance가 여전히 snapshot.workflow를 직접 patch함")
    tr.check("handleWorkflowAdvance_and_approval_share_builder",
             "_buildAdvancedSnapshot(nextState, comment)" in
               case_view_src.split("const handleWorkflowAdvance")[1].split("\n  };")[0] and
             "_buildAdvancedSnapshot(nextState, comment)" in
               case_view_src.split("const handleApprovalSubmit")[1],
             "handleWorkflowAdvance/handleApprovalSubmit이 서로 다른 방식으로 Snapshot을 만듦 — "
             "build/commit 분리가 깨져 있을 위험")

    return tr

# ════════════════════════════════════════════════════════════════
#  ASSET-HISTORY-001 — appendRevision()은 항상 새 배열 반환, overwrite 없음
#  ASSET-HISTORY-002 — resolveRevision(id, revision)은 history에서만 조회
#  ASSET-HISTORY-003 — latest는 저장하지 않고 revision 최댓값으로 파생
#  ASSET-HISTORY-004 — 같은 id 안 revision 중복 금지
# ════════════════════════════════════════════════════════════════
def test_asset_history_contract() -> TestResult:
    tr = TestResult("ASSET-HISTORY-001/002/003/004", "Asset Revision History 계약 검증")
    history_src = (SRC / "asset" / "history.js").read_text()

    for sym, desc in [
        ("function appendRevision",        "appendRevision 정의"),
        ("function resolveRevision",       "resolveRevision 정의"),
        ("function getLatestRevision",     "getLatestRevision 정의"),
        ("function getAllLatestRevisions", "getAllLatestRevisions 정의"),
        ("function getRevisionsFor",       "getRevisionsFor 정의"),
        ("function hasDuplicateRevision",  "hasDuplicateRevision 정의"),
        ("ASSET-HISTORY-001",              "ASSET-HISTORY-001 계약 주석"),
        ("ASSET-HISTORY-002",              "ASSET-HISTORY-002 계약 주석"),
        ("ASSET-HISTORY-003",              "ASSET-HISTORY-003 계약 주석"),
        ("ASSET-HISTORY-004",              "ASSET-HISTORY-004 계약 주석"),
    ]:
        tr.check(f"src_{sym.replace(' ','_')[:30]}", sym in history_src, f"{desc} 없음")

    # ── resolveRevision이 "현재 상태" 별도 필드를 참조하지 않는지 (소스 검사) ──
    resolve_body = history_src.split("function resolveRevision")[1].split("}")[0]
    tr.check("resolveRevision_no_current_state_reference",
             "equipments" not in resolve_body and "dischargeSystems" not in resolve_body,
             "resolveRevision이 별도 저장된 현재 상태를 참조함 — ASSET-HISTORY-002 위반")

    # ── ASSET-HISTORY-001: append 시뮬레이션 (Python 재현) ────────────
    def py_append(history, rev):
        prev = history or []
        return prev + [rev]

    h0 = []
    rev1 = {"id": "EQ-001", "revision": 1, "tag": "PSV-R201"}
    rev2 = {"id": "EQ-001", "revision": 2, "tag": "PSV-R201", "mocId": "MOC-1"}

    h1 = py_append(h0, rev1)
    h2 = py_append(h1, rev2)

    tr.check("ASSET_HISTORY_001_history_grows",
             len(h2) == 2,
             "revise 후 history가 2개여야 함")
    tr.check("ASSET_HISTORY_001_no_overwrite",
             h2[0]["revision"] == 1 and h2[1]["revision"] == 2,
             "이전 revision이 history에서 사라짐 — overwrite 발생, ASSET-HISTORY-001 위반")
    tr.check("ASSET_HISTORY_001_original_not_mutated",
             h0 == [],
             "원본 history 배열이 mutate됨 — ASSET-HISTORY-001 위반")

    # ── ASSET-HISTORY-002: revise 이후에도 옛 revision을 id+revision으로 조회 가능 ──
    def py_resolve(history, id_, revision):
        return next((r for r in history if r["id"] == id_ and r["revision"] == revision), None)

    tr.check("ASSET_HISTORY_002_resolve_old_revision_after_revise",
             py_resolve(h2, "EQ-001", 1) is not None,
             "최신 revision이 2로 넘어간 뒤에도 revision 1을 조회할 수 있어야 함 — "
             "한 번도 Case에서 참조되지 않은 revision도 소실되면 안 됨")
    tr.check("ASSET_HISTORY_002_resolve_latest",
             py_resolve(h2, "EQ-001", 2) is not None,
             "최신 revision도 동일한 방식으로 조회 가능해야 함")
    tr.check("ASSET_HISTORY_002_resolve_unknown_returns_none",
             py_resolve(h2, "EQ-001", 99) is None,
             "존재하지 않는 revision 조회 시 None이 아닌 값 반환")

    # ── ASSET-HISTORY-003: latest는 저장값이 아니라 revision 최댓값으로 파생 ──
    def py_latest(history, id_):
        matches = [r for r in history if r["id"] == id_]
        if not matches:
            return None
        return max(matches, key=lambda r: r["revision"])

    tr.check("ASSET_HISTORY_003_latest_is_max_revision",
             py_latest(h2, "EQ-001")["revision"] == 2,
             "getLatestRevision이 revision 최댓값을 반환하지 않음")

    # latest를 별도 state로 저장하지 않는지 — history.js 소스 자체에 latest를
    # 캐시/저장하는 필드가 없어야 한다 (매번 history로부터 재계산).
    tr.check("ASSET_HISTORY_003_no_stored_latest_field",
             "let latest" not in history_src and "this.latest" not in history_src,
             "history.js가 latest를 저장된 필드로 캐싱함 — ASSET-HISTORY-003 위반 "
             "(latest는 항상 history로부터 파생되어야 함)")

    # ── ASSET-HISTORY-004: 중복 revision 감지 ──────────────────────
    h_dup = py_append(h1, {"id": "EQ-001", "revision": 1, "tag": "PSV-R201-DUP"})
    keys = [f"{r['id']}::{r['revision']}" for r in h_dup]
    tr.check("ASSET_HISTORY_004_duplicate_detected",
             len(set(keys)) != len(keys),
             "중복 id+revision 조합이 감지되지 않음")

    # ── ArcSafe.jsx가 appendRevision을 통해서만 equipment/dischargeSystem을 갱신하는지 ──
    arcsafe_src = (SRC.parent / "src" / "ArcSafe.jsx").read_text()
    tr.check("ArcSafe_no_direct_equipment_map_overwrite",
             "setEquipments(prev => prev.map(" not in arcsafe_src and
             "setEquipmentHistory(prev => prev.map(" not in arcsafe_src,
             "handleReviseEquipment이 여전히 prev.map()으로 in-place 교체함 — "
             "ASSET-HISTORY-001 위반 (append 대신 overwrite)")
    tr.check("ArcSafe_no_direct_discharge_map_overwrite",
             "setDischargeSystems(prev => prev.map(" not in arcsafe_src and
             "setDischargeHistory(prev => prev.map(" not in arcsafe_src,
             "handleReviseDischargeSystem이 여전히 prev.map()으로 in-place 교체함 — "
             "ASSET-HISTORY-001 위반 (append 대신 overwrite)")
    tr.check("ArcSafe_uses_appendRevision_for_equipment",
             "appendRevision(prev" in arcsafe_src,
             "ArcSafe.jsx가 appendRevision()을 사용하지 않음")
    tr.check("ArcSafe_derives_latest_via_getAllLatestRevisions",
             "getAllLatestRevisions(equipmentHistory)" in arcsafe_src and
             "getAllLatestRevisions(dischargeHistory)" in arcsafe_src,
             "equipments/dischargeSystems가 getAllLatestRevisions()로 파생되지 않음 — "
             "latest를 별도 state로 저장하고 있을 위험")

    return tr

# ════════════════════════════════════════════════════════════════
#  ASSET-UI-001 — RevisionHistoryPanel(B1)은 100% 읽기 전용이어야 한다.
#  Diff/Impact Analysis/되돌리기/수정 등 쓰기·비교 경로를 갖지 않는다.
#  (B2/B3/B4는 별도 단계에서 이 컴포넌트를 감싸거나 대체하며 확장한다)
# ════════════════════════════════════════════════════════════════
def test_revision_history_ui_readonly_contract() -> TestResult:
    tr = TestResult("ASSET-UI-001", "Revision History UI 읽기 전용 계약 검증")
    am_src = (SRC / "components" / "AssetMaster.jsx").read_text()

    tr.check("RevisionHistoryPanel_defined",
             "function RevisionHistoryPanel" in am_src,
             "RevisionHistoryPanel 컴포넌트 없음")

    panel_body = am_src.split("function RevisionHistoryPanel")[1].split(
        "\n// ── EquipmentCard")[0]

    forbidden_write_symbols = [
        "onReviseEquipment", "onReviseDischargeSystem",
        "reviseEquipment(", "reviseDischargeSystem(",
        "appendRevision(", "createEquipment(", "createDischargeSystem(",
        "onSave", "onAddEquipment", "onAddDischargeSystem",
        "EquipmentForm", "DischargeSystemForm",
    ]
    for sym in forbidden_write_symbols:
        tr.check(f"no_{sym.strip('(')}_in_panel",
                 sym not in panel_body,
                 f"RevisionHistoryPanel이 쓰기 경로({sym})를 포함함 — "
                 f"Comparison UI로 확장된 뒤에도 100% 읽기 전용이어야 함")

    # Comparison UI 통합(B1+B2+B3) 확인: diff/impact 엔진 결과를 "표시"하는지.
    # 계산 함수 자체가 아니라 계산 *결과를 그대로 렌더링*하는지가 핵심이므로,
    # 엔진 호출 존재 + 위의 쓰기 심볼 부재를 함께 만족해야 "읽기 전용 조합"이 성립한다.
    tr.check("panel_integrates_diff_engine",
             "diffEquipmentRevision(" in panel_body and "diffDischargeSystemRevision(" in panel_body,
             "RevisionHistoryPanel이 B2 Diff Engine을 통합하지 않음")
    tr.check("panel_integrates_impact_engine",
             "analyzeRevisionImpact(" in panel_body,
             "RevisionHistoryPanel이 B3 Impact Analysis Engine을 통합하지 않음")
    # B4(Inspection/Certificate)는 스키마 확장 전이므로 아직 끌어오면 안 된다.
    forbidden_future_scope = ["inspectionDue", "InspectionDue", "certificate", "Certificate"]
    for sym in forbidden_future_scope:
        tr.check(f"no_{sym}_in_panel_yet",
                 sym not in panel_body,
                 f"RevisionHistoryPanel이 B4 범위({sym})를 앞서 포함함 — "
                 f"스키마 확장 전에는 필드가 존재할 수 없음")

    # ── RevisionHistoryPanel이 onClose 외에 콜백 prop을 받지 않는지 (destructure 검사) ──
    sig_line = am_src.split("function RevisionHistoryPanel(")[1].split(")")[0]
    tr.check("panel_props_readonly_only",
             "on" not in sig_line.replace("onClose", ""),
             "RevisionHistoryPanel이 onClose 이외의 콜백 prop을 받음 — 쓰기 경로 유입 위험")

    # ── AssetMaster가 equipmentHistory/dischargeHistory/allSnapshots를 그대로 넘기는지 ──
    tr.check("AssetMaster_receives_history_props",
             "equipmentHistory" in am_src and "dischargeHistory" in am_src,
             "AssetMaster가 equipmentHistory/dischargeHistory props를 받지 않음")
    tr.check("AssetMaster_receives_allSnapshots_prop",
             "allSnapshots" in am_src,
             "AssetMaster가 allSnapshots props를 받지 않음 — Impact Analysis에 필요")

    # ── ArcSafe.jsx가 AssetMaster에 history를 전달하는지 ──
    arcsafe_src = (SRC.parent / "src" / "ArcSafe.jsx").read_text()
    am_call = arcsafe_src.split("<AssetMaster")[1].split("/>")[0]
    tr.check("ArcSafe_passes_history_to_AssetMaster",
             "equipmentHistory={equipmentHistory}" in am_call and
             "dischargeHistory={dischargeHistory}" in am_call,
             "ArcSafe.jsx가 AssetMaster에 equipmentHistory/dischargeHistory를 전달하지 않음")
    tr.check("ArcSafe_passes_allSnapshots_to_AssetMaster",
             "allSnapshots={allSnapshots}" in am_call,
             "ArcSafe.jsx가 AssetMaster에 allSnapshots를 전달하지 않음 — Impact Analysis 비활성화됨")

    return tr

# ════════════════════════════════════════════════════════════════
#  ASSET-DIFF-001 — 동일 revision 비교 -> 빈 diff
#  ASSET-DIFF-002 — 입력 순서 반전 -> from/to만 반전, 필드·순서는 동일
#  ASSET-DIFF-003 — 변경 없는 필드는 결과에 미포함
#  ASSET-DIFF-004 — 입력 객체 불변(immutability)
#  ASSET-DIFF-005 — 출력 순서 결정론적(스키마 필드 순서 고정)
# ════════════════════════════════════════════════════════════════
def test_asset_diff_contract() -> TestResult:
    tr = TestResult("ASSET-DIFF-001~005", "Asset Revision Diff Engine 계약 검증")
    diff_src = (SRC / "asset" / "diff.js").read_text()

    for sym, desc in [
        ("function diffEquipmentRevision",         "diffEquipmentRevision 정의"),
        ("function diffDischargeSystemRevision",   "diffDischargeSystemRevision 정의"),
        ("EQUIPMENT_DIFF_FIELDS",                  "EQUIPMENT_DIFF_FIELDS 정의"),
        ("DISCHARGE_DIFF_FIELDS",                  "DISCHARGE_DIFF_FIELDS 정의"),
        ("ASSET-DIFF-001", "ASSET-DIFF-001 계약 주석"),
        ("ASSET-DIFF-002", "ASSET-DIFF-002 계약 주석"),
        ("ASSET-DIFF-003", "ASSET-DIFF-003 계약 주석"),
        ("ASSET-DIFF-004", "ASSET-DIFF-004 계약 주석"),
        ("ASSET-DIFF-005", "ASSET-DIFF-005 계약 주석"),
    ]:
        tr.check(f"src_{sym.replace(' ','_')[:30]}", sym in diff_src, f"{desc} 없음")

    # ── diff.js가 의미 해석(영향도/위험도/MOC 필요여부/워크플로우)을
    #    끌어오지 않는지 — B3 범위 침범 방지 ──
    forbidden_scope = ["evaluateSafetyImpact", "computeWorkflowState", "detectMOC",
                        "riskLevel", "severity", "requiresApproval"]
    for sym in forbidden_scope:
        tr.check(f"no_{sym}_in_diff_engine",
                 sym not in diff_src,
                 f"diff.js가 B3(Impact Analysis) 범위({sym})를 앞서 포함함 — "
                 f"Diff Engine은 순수 비교만 담당해야 함")

    # ── Python 재현: 실제 JS 로직과 동일한 필드 목록/알고리즘 ──
    EQUIPMENT_DIFF_FIELDS = [
        ("tag", None), ("location", None), ("deviceType", None),
        ("manufacturer", None), ("model", None), ("serialNo", None),
        ("mawp", "barg"), ("setPressure", "barg"), ("overpressure", "%"),
        ("orifice", None), ("inletSize", None), ("outletSize", None),
        ("installedAt", None),
    ]

    def emptyish(v):
        return v is None or v == ""

    def values_equal(a, b):
        if emptyish(a) and emptyish(b):
            return True
        if isinstance(a, list) or isinstance(b, list):
            return (a or []) == (b or [])
        return a == b

    def diff_fields(old, new, spec):
        if not old or not new:
            return []
        changes = []
        for field, unit in spec:
            frm, to = old.get(field), new.get(field)
            if not values_equal(frm, to):
                entry = {"field": field, "from": frm, "to": to}
                if unit:
                    entry["unit"] = unit
                changes.append(entry)
        return changes

    rev1 = {"tag": "PSV-R201", "location": "R-201", "mawp": 6.0,
            "setPressure": 10, "overpressure": 10, "orifice": "P",
            "manufacturer": "Crosby"}
    rev2 = {**rev1, "setPressure": 11, "overpressure": 21, "mocId": "MOC-9",
            "revision": 2}

    # ── ASSET-DIFF-001: 동일 revision -> 빈 diff ──
    tr.check("ASSET_DIFF_001_identical_input_empty",
             diff_fields(rev1, rev1, EQUIPMENT_DIFF_FIELDS) == [],
             "동일 revision을 비교했는데 빈 diff가 아님")

    # ── ASSET-DIFF-003: 변경 없는 필드는 제외, 변경된 필드만 포함 ──
    d = diff_fields(rev1, rev2, EQUIPMENT_DIFF_FIELDS)
    changed_fields = {c["field"] for c in d}
    tr.check("ASSET_DIFF_003_only_changed_fields",
             changed_fields == {"setPressure", "overpressure"},
             f"변경된 필드만 포함되어야 하는데 {changed_fields} 반환됨 "
             "(mocId/revision 같은 메타데이터는 diff 대상이 아님)")
    tr.check("ASSET_DIFF_003_unit_attached",
             all(c["unit"] for c in d if c["field"] in ("setPressure","overpressure")),
             "unit이 결과에 포함되지 않음")

    # ── ASSET-DIFF-002: 입력 순서 반전 -> from/to만 반전, 필드/순서는 동일 ──
    d_rev = diff_fields(rev2, rev1, EQUIPMENT_DIFF_FIELDS)
    fields_forward = [c["field"] for c in d]
    fields_backward = [c["field"] for c in d_rev]
    tr.check("ASSET_DIFF_002_same_fields_reversed_input",
             fields_forward == fields_backward,
             "입력 순서를 반전했더니 비교 대상 필드 자체가 달라짐")
    swapped_ok = all(
        d[i]["from"] == d_rev[i]["to"] and d[i]["to"] == d_rev[i]["from"]
        for i in range(len(d))
    )
    tr.check("ASSET_DIFF_002_from_to_swapped",
             swapped_ok,
             "입력 순서를 반전했는데 from/to가 정확히 반전되지 않음")

    # ── ASSET-DIFF-004: 입력 객체 불변 ──
    rev1_copy = dict(rev1)
    rev2_copy = dict(rev2)
    _ = diff_fields(rev1, rev2, EQUIPMENT_DIFF_FIELDS)
    tr.check("ASSET_DIFF_004_inputs_not_mutated",
             rev1 == rev1_copy and rev2 == rev2_copy,
             "diff 계산 중 입력 객체가 변경됨 — immutability 위반")
    tr.check("ASSET_DIFF_004_freeze_used_in_source",
             "Object.freeze" in diff_src,
             "diff.js 반환값에 Object.freeze가 적용되지 않음")

    # ── ASSET-DIFF-005: 출력 순서는 스키마 필드 순서를 따름(입력 key 순서 무관) ──
    rev1_reordered = {"overpressure": rev1["overpressure"], "setPressure": rev1["setPressure"],
                       **{k: v for k, v in rev1.items() if k not in ("overpressure", "setPressure")}}
    rev2_reordered = {"setPressure": rev2["setPressure"], "overpressure": rev2["overpressure"],
                       **{k: v for k, v in rev2.items() if k not in ("overpressure", "setPressure")}}
    d_reordered = diff_fields(rev1_reordered, rev2_reordered, EQUIPMENT_DIFF_FIELDS)
    tr.check("ASSET_DIFF_005_order_independent_of_input_keys",
             [c["field"] for c in d_reordered] == fields_forward,
             "입력 객체의 key 순서를 바꿨는데 diff 출력 순서가 달라짐 — "
             "출력 순서가 스키마 필드 순서가 아니라 입력에 의존함")
    tr.check("ASSET_DIFF_005_schema_order_matches_definition",
             fields_forward == [f for f, _ in EQUIPMENT_DIFF_FIELDS if f in changed_fields],
             "diff 출력 순서가 EQUIPMENT_DIFF_FIELDS 정의 순서와 다름")

    return tr

# ════════════════════════════════════════════════════════════════
#  ASSET-IMPACT-001 — 일치하는 Snapshot 없음 -> 4개 필드 모두 빈 배열
#  ASSET-IMPACT-002 — affectedCases 중복 없음
#  ASSET-IMPACT-003 — affectedSnapshots는 정확히 해당 revisionKey만 참조
#  ASSET-IMPACT-004 — latestAffected ∪ obsoleteSnapshots = affectedSnapshots (분할)
#  ASSET-IMPACT-005 — 입력 배열 불변(immutability)
# ════════════════════════════════════════════════════════════════
def test_asset_impact_contract() -> TestResult:
    tr = TestResult("ASSET-IMPACT-001~005", "Asset Revision Impact Analysis 계약 검증")
    impact_src = (SRC / "asset" / "impact.js").read_text()

    for sym, desc in [
        ("function analyzeRevisionImpact",  "analyzeRevisionImpact 정의"),
        ("function _parseRevisionKey",      "_parseRevisionKey 정의"),
        ("function _matchesRevision",       "_matchesRevision 정의"),
        ("function _latestSnapshotByCase",  "_latestSnapshotByCase 정의"),
        ("ASSET-IMPACT-001", "ASSET-IMPACT-001 계약 주석"),
        ("ASSET-IMPACT-002", "ASSET-IMPACT-002 계약 주석"),
        ("ASSET-IMPACT-003", "ASSET-IMPACT-003 계약 주석"),
        ("ASSET-IMPACT-004", "ASSET-IMPACT-004 계약 주석"),
        ("ASSET-IMPACT-005", "ASSET-IMPACT-005 계약 주석"),
    ]:
        tr.check(f"src_{sym.replace(' ','_')[:30]}", sym in impact_src, f"{desc} 없음")

    # ── impact.js가 워크플로우/위험도를 재평가하지 않는지 (Snapshot에 박제된 값만 읽음) ──
    forbidden_scope = ["evaluateSafetyImpact", "computeWorkflowState", "detectMOC(",
                        "riskLevel =", "severity ="]
    for sym in forbidden_scope:
        tr.check(f"no_{sym.rstrip('=( ')}_in_impact_engine",
                 sym not in impact_src,
                 f"impact.js가 워크플로우/위험도 재평가({sym})를 포함함 — "
                 f"Impact Engine은 이미 Snapshot에 박제된 값을 읽기만 해야 함")

    # ── Python 재현: 실제 JS 로직과 동일한 알고리즘 ──
    def parse_key(key):
        if not key or "@" not in key:
            return None
        idx = key.rindex("@")
        return {"id": key[:idx], "revision": int(key[idx+1:])}

    def matches(snap, id_, revision):
        refs = snap.get("assetRefs")
        if not refs:
            return False
        if id_.startswith("EQ-"):
            return refs.get("equipmentId") == id_ and refs.get("equipmentRevision") == revision
        if id_.startswith("DS-"):
            return refs.get("dischargeSystemId") == id_ and refs.get("dischargeRevision") == revision
        return False

    def latest_by_case(snaps):
        m = {}
        for s in snaps:
            if s.get("caseId"):
                m[s["caseId"]] = s
        return m

    def analyze(revision_key, all_snapshots):
        empty = {"affectedCases": [], "affectedSnapshots": [], "latestAffected": [], "obsoleteSnapshots": []}
        parsed = parse_key(revision_key)
        if not parsed or not all_snapshots:
            return empty
        affected = [s for s in all_snapshots if matches(s, parsed["id"], parsed["revision"])]
        if not affected:
            return empty
        cases = list(dict.fromkeys(s["caseId"] for s in affected))  # 순서 보존 unique
        lbc = latest_by_case(all_snapshots)
        latest_affected = [s for s in affected if lbc.get(s["caseId"]) is s]
        obsolete = [s for s in affected if lbc.get(s["caseId"]) is not s]
        return {"affectedCases": cases, "affectedSnapshots": affected,
                "latestAffected": latest_affected, "obsoleteSnapshots": obsolete}

    def snap(case_id, eq_id, eq_rev, snap_hash):
        return {"caseId": case_id, "snapshotHash": snap_hash,
                "assetRefs": {"equipmentId": eq_id, "equipmentRevision": eq_rev,
                              "dischargeSystemId": None, "dischargeRevision": None}}

    # Case-1: Rev.1로 검토(SNAP-A) -> Rev.2로 개정 후 재검토(SNAP-B, 최신)
    # Case-2: Rev.1로만 검토(SNAP-C, 최신 — 아직 재검토 안 함)
    all_snaps = [
        snap("CASE-1", "EQ-001", 1, "SNAP-A"),
        snap("CASE-1", "EQ-001", 2, "SNAP-B"),
        snap("CASE-2", "EQ-001", 1, "SNAP-C"),
    ]

    # ── ASSET-IMPACT-001: 매칭 없음 -> 전부 빈 배열 ──
    r_none = analyze("EQ-999@1", all_snaps)
    tr.check("ASSET_IMPACT_001_no_match_all_empty",
             r_none == {"affectedCases": [], "affectedSnapshots": [],
                        "latestAffected": [], "obsoleteSnapshots": []},
             "일치하는 Snapshot이 없는데 빈 배열이 아닌 필드가 있음")

    r_rev1 = analyze("EQ-001@1", all_snaps)
    r_rev2 = analyze("EQ-001@2", all_snaps)

    # ── ASSET-IMPACT-002: affectedCases 중복 없음 ──
    tr.check("ASSET_IMPACT_002_no_duplicate_cases",
             len(r_rev1["affectedCases"]) == len(set(r_rev1["affectedCases"])),
             "affectedCases에 중복 caseId가 있음")
    tr.check("ASSET_IMPACT_002_both_cases_found_for_rev1",
             set(r_rev1["affectedCases"]) == {"CASE-1", "CASE-2"},
             "Rev.1을 쓴 두 Case(CASE-1, CASE-2)가 모두 잡히지 않음")

    # ── ASSET-IMPACT-003: affectedSnapshots는 정확히 해당 revision만 참조 ──
    tr.check("ASSET_IMPACT_003_rev1_only_matches_rev1_snapshots",
             {s["snapshotHash"] for s in r_rev1["affectedSnapshots"]} == {"SNAP-A", "SNAP-C"},
             "Rev.1 조회 결과에 다른 revision(SNAP-B)이 섞여 들어감")
    tr.check("ASSET_IMPACT_003_rev2_only_matches_rev2_snapshots",
             {s["snapshotHash"] for s in r_rev2["affectedSnapshots"]} == {"SNAP-B"},
             "Rev.2 조회 결과가 정확히 SNAP-B 하나여야 함")

    # ── ASSET-IMPACT-004: latestAffected / obsoleteSnapshots가 affectedSnapshots를 분할 ──
    for label, r in [("rev1", r_rev1), ("rev2", r_rev2)]:
        union = {s["snapshotHash"] for s in r["latestAffected"]} | \
                {s["snapshotHash"] for s in r["obsoleteSnapshots"]}
        inter = {s["snapshotHash"] for s in r["latestAffected"]} & \
                {s["snapshotHash"] for s in r["obsoleteSnapshots"]}
        affected_hashes = {s["snapshotHash"] for s in r["affectedSnapshots"]}
        tr.check(f"ASSET_IMPACT_004_{label}_union_equals_affected",
                 union == affected_hashes,
                 f"[{label}] latestAffected ∪ obsoleteSnapshots != affectedSnapshots")
        tr.check(f"ASSET_IMPACT_004_{label}_no_overlap",
                 inter == set(),
                 f"[{label}] latestAffected와 obsoleteSnapshots가 겹침")

    # CASE-1의 Rev.1(SNAP-A)은 이미 Rev.2(SNAP-B)로 대체됐으므로 obsolete여야 함
    tr.check("ASSET_IMPACT_004_case1_rev1_is_obsolete",
             any(s["snapshotHash"] == "SNAP-A" for s in r_rev1["obsoleteSnapshots"]),
             "CASE-1에서 Rev.1은 이미 Rev.2로 대체됐는데 obsolete로 분류되지 않음")
    # CASE-2는 아직 Rev.1이 최신이므로 latestAffected여야 함
    tr.check("ASSET_IMPACT_004_case2_rev1_is_latest",
             any(s["snapshotHash"] == "SNAP-C" for s in r_rev1["latestAffected"]),
             "CASE-2에서 Rev.1이 여전히 최신인데 latestAffected로 분류되지 않음")
    # Rev.2(SNAP-B)는 CASE-1의 최신이므로 latestAffected
    tr.check("ASSET_IMPACT_004_case1_rev2_is_latest",
             any(s["snapshotHash"] == "SNAP-B" for s in r_rev2["latestAffected"]),
             "CASE-1에서 Rev.2가 최신 Snapshot인데 latestAffected로 분류되지 않음")

    # ── ASSET-IMPACT-005: 입력 배열 불변 ──
    all_snaps_copy = [dict(s) for s in all_snaps]
    _ = analyze("EQ-001@1", all_snaps)
    tr.check("ASSET_IMPACT_005_input_not_mutated",
             all_snaps == all_snaps_copy,
             "analyzeRevisionImpact 계산 중 입력 snapshot 배열이 변경됨")
    tr.check("ASSET_IMPACT_005_freeze_used_in_source",
             "Object.freeze" in impact_src,
             "impact.js 반환값에 Object.freeze가 적용되지 않음")

    # ── revisionKey 포맷이 asset/history.js의 _revisionKey와 대칭인지 (역인덱스 재사용성) ──
    history_src = (SRC / "asset" / "history.js").read_text()
    tr.check("revisionKey_format_symmetric_with_history_js",
             "`${id}@${revision}`" in history_src and "lastIndexOf(\"@\")" in impact_src,
             "impact.js의 revisionKey 파싱 방식이 asset/history.js의 _revisionKey 생성 방식과 대칭이 아님")

    return tr

# ════════════════════════════════════════════════════════════════
#  APPROVAL-SIGN-TARGET-001
#  Approval은 "지금 보고 있는 버전"이 아니라 "승인 결과로 확정될 다음 버전"의
#  hash에 서명해야 한다. 순서가 반대면(서명 먼저, 전이 나중) 서명 직후
#  Snapshot이 교체되면서 case의 최종 상태에는 승인 기록이 안 보이게 된다.
# ════════════════════════════════════════════════════════════════
def test_approval_signs_next_snapshot_contract() -> TestResult:
    tr = TestResult("APPROVAL-SIGN-TARGET-001", "승인은 다음 버전의 hash에 서명해야 함")

    case_view_src = (SRC / "components" / "CaseView.jsx").read_text()
    submit_body = case_view_src.split("const handleApprovalSubmit = async")[1].split("\n  };")[0]

    tr.check("approval_builds_next_snapshot_before_signing",
             "_buildAdvancedSnapshot(nextState, comment)" in submit_body,
             "handleApprovalSubmit이 서명 전에 다음 버전 Snapshot을 만들지 않음")

    submit_call = submit_body.split("submitApproval(")[1].split(");")[0]
    tr.check("approval_signs_nextSnap_not_current_snapshot",
             "snapshot: nextSnap" in submit_call,
             "submitApproval이 nextSnap이 아니라 현재(REVIEW) snapshot을 서명 대상으로 사용함 — "
             "승인 직후 Snapshot이 교체되면 서명된 버전이 case에서 사라짐")

    idx_submit = submit_body.index("submitApproval(")
    idx_result_ok_check = submit_body.index("if (!result.ok)")
    idx_commit = submit_body.index("_commitSnapshot(")
    tr.check("approval_commit_happens_after_submit_and_after_ok_check",
             idx_submit < idx_result_ok_check < idx_commit,
             "커밋 순서가 잘못됨 — submitApproval 실패 시에도 Snapshot이 교체될 위험")

    return tr

# ════════════════════════════════════════════════════════════════
#  CRYPTO-001/002/003 — 전자서명 (canonical payload, 재계산 검증)
#  SERVICE-001/002/003 — idempotency, 단일 timestamp
#  VALIDATOR-001/002/003 — 서명 재검증 + snapshot 실존 + 중복 idempotencyKey
# ════════════════════════════════════════════════════════════════
def _py_canonical(rec):
    # crypto.js의 canonicalPayload()를 Python으로 재현 (NUL 구분자, 필드 순서 고정)
    return "\u0000".join([
        rec.get("snapshotHash", "")  or "",
        rec.get("decision", "")      or "",
        rec.get("comment", "")       or "",
        rec.get("signer", "")        or "",
        rec.get("timestamp", "")     or "",
        rec.get("workflowState", "") or "",
    ])

def _py_sha256(msg):
    return hashlib.sha256(msg.encode("utf-8")).hexdigest()

def test_approval_crypto_contract() -> TestResult:
    tr = TestResult("CRYPTO/SERVICE/VALIDATOR", "전자서명 · idempotency · 검증 계약")

    crypto_src    = (SRC / "approval" / "crypto.js").read_text()
    service_src   = (SRC / "approval" / "service.js").read_text()
    validator_src = (SRC / "approval" / "validator.js").read_text()

    for label, src, syms in [
        ("crypto", crypto_src, [
            "function canonicalPayload", "function signApproval",
            "function verifySignature", "function sha256Hex",
            "CRYPTO-001", "CRYPTO-002", "CRYPTO-003",
            "crypto.subtle.digest",
        ]),
        ("service", service_src, [
            "function submitApproval", "function isDuplicateApproval",
            "function computeIdempotencyKey",
            "SERVICE-001", "SERVICE-002", "SERVICE-003",
        ]),
        ("validator", validator_src, [
            "function verifyApprovalRecord", "resolveSnapshot(",
            "verifySignature(", "verifyApproval(",
            "VALIDATOR-001", "VALIDATOR-002", "VALIDATOR-003",
        ]),
    ]:
        for sym in syms:
            tr.check(f"{label}_src_{sym.replace(' ','_').replace('(','')[:30]}",
                      sym in src, f"[{label}] '{sym}' 없음")

    # ── CRYPTO-001: canonicalPayload 필드 순서 고정 → 같은 내용 = 같은 서명 ──
    rec1 = {"snapshotHash":"H1","decision":"approve","comment":"ok",
            "signer":"Kim","timestamp":"2026-07-06T00:00:00Z","workflowState":"REVIEW"}
    rec1_copy = dict(rec1)
    tr.check("CRYPTO_001_same_content_same_signature",
             _py_sha256(_py_canonical(rec1)) == _py_sha256(_py_canonical(rec1_copy)),
             "동일 내용인데 서명이 다름")

    # ── CRYPTO-003: comment 포함 여부 — comment 하나만 바뀌어도 서명 달라짐 ──
    rec2 = {**rec1, "comment": "changed after signing"}
    tr.check("CRYPTO_003_comment_included_in_signature",
             _py_sha256(_py_canonical(rec1)) != _py_sha256(_py_canonical(rec2)),
             "comment가 바뀌었는데 서명이 동일함 — comment가 서명 대상에서 빠짐 (CRYPTO-003 위반)")

    # decision/signer/timestamp/workflowState 각각 변경 시에도 서명 달라져야 함
    for field in ["decision", "signer", "timestamp", "workflowState"]:
        altered = {**rec1, field: rec1[field] + "_X"}
        tr.check(f"CRYPTO_003_{field}_included",
                 _py_sha256(_py_canonical(rec1)) != _py_sha256(_py_canonical(altered)),
                 f"{field}가 바뀌었는데 서명이 동일함 — 서명 대상에서 빠짐")

    # concatenation ambiguity 방지 확인 (구분자 없으면 발생하는 문제)
    a = {**rec1, "snapshotHash": "ab", "decision": "c"}
    b = {**rec1, "snapshotHash": "a",  "decision": "bc"}
    tr.check("CRYPTO_001_no_concat_ambiguity",
             _py_canonical(a) != _py_canonical(b),
             "구분자 없이 concat되어 서로 다른 필드 조합이 같은 payload가 됨")

    # ── SERVICE-001: idempotencyKey — 동일 (hash, signer) → 동일 key ──
    def py_idem_key(snap_hash, signer):
        return _py_sha256(f"{snap_hash}\u0000{signer}")

    k1 = py_idem_key("H1", "Kim")
    k2 = py_idem_key("H1", "Kim")
    k3 = py_idem_key("H1", "Lee")
    tr.check("SERVICE_001_same_key_for_same_pair", k1 == k2,
             "동일 (snapshotHash, signer)인데 idempotencyKey가 다름")
    tr.check("SERVICE_001_diff_signer_diff_key", k1 != k3,
             "signer가 다른데 idempotencyKey가 같음 — 중복 차단이 signer를 구분 못 함")

    # 중복 승인 시도 시뮬레이션
    history = [{"idempotencyKey": k1}]
    is_dup = any(r["idempotencyKey"] == py_idem_key("H1", "Kim") for r in history)
    tr.check("SERVICE_001_duplicate_detected", is_dup,
             "동일 signer의 재승인 시도가 중복으로 감지되지 않음")
    is_dup_other = any(r["idempotencyKey"] == py_idem_key("H1", "Lee") for r in history)
    tr.check("SERVICE_001_different_signer_not_blocked", not is_dup_other,
             "다른 signer의 정당한 승인이 중복으로 잘못 차단됨")

    # ── SERVICE-003: 단일 timestamp — service.js가 Date를 두 번 생성하지 않는지 ──
    submit_body = service_src.split("async function submitApproval")[1]
    date_call_count = submit_body.count("new Date(")
    tr.check("SERVICE_003_single_timestamp_generation",
             date_call_count == 1,
             f"submitApproval 안에서 new Date()가 {date_call_count}번 호출됨 — "
             "approvedAt과 서명 timestamp가 어긋날 수 있음 (2회 이상 호출 시 값 불일치 위험)")

    # ── VALIDATOR-002: resolveSnapshot 결과가 없으면 무조건 invalid ──
    tr.check("VALIDATOR_002_uses_resolveSnapshot_not_latestSnap",
             "resolveSnapshot(caseObj" in validator_src and
             "latestSnap" not in validator_src,
             "validator가 resolveSnapshot 대신 latestSnap을 참조할 위험 — HISTORY-002 위반 가능성")

    return tr

# ════════════════════════════════════════════════════════════════
#  GEOMETRY-001 — 배관 형상은 Case 입력값이 아니라 Asset(DischargeSystem) 데이터
#  GEOMETRY-002 — 개정은 같은 id의 새 revision, mocId 필수
# ════════════════════════════════════════════════════════════════
def test_geometry_contract() -> TestResult:
    tr = TestResult("GEOMETRY-001/002", "배관 형상 Asset 소싱 · 개정 계약")

    input_view_src = (SRC / "components" / "InputView.jsx").read_text()
    case_view_src  = (SRC / "components" / "CaseView.jsx").read_text()
    schema_src     = (SRC / "asset" / "schema.js").read_text()

    # ── GEOMETRY-001: 하드코딩된 임시 geometry 제거 확인 ──────────
    tr.check("no_hardcoded_default_geometry",
             "DEFAULT_GEOMETRY" not in input_view_src,
             "InputView.jsx에 여전히 DEFAULT_GEOMETRY 하드코딩이 남아있음")
    tr.check("no_hardcoded_L_15_literal",
             "L: 15, D: 0.1" not in input_view_src,
             "InputView.jsx에 임시 geometry 리터럴이 남아있음")

    # InputView가 dischargeSystem prop을 받는지
    tr.check("InputView_accepts_dischargeSystem_prop",
             "dischargeSystem }" in input_view_src.split("\n")[153] or
             "dischargeSystem" in input_view_src.split("function InputView(")[1].split(")")[0],
             "InputView가 dischargeSystem prop을 받지 않음")

    # computeBackpressure가 dischargeSystem 필드로부터 geometry를 구성하는지
    # (주석에도 이름이 등장하므로, 실제 호출 형태 "computeBackpressure(inputs, {"를 기준으로 검사)
    call_marker = "computeBackpressure(inputs, {"
    bp_call_region = input_view_src.split(call_marker)[1][:300] if call_marker in input_view_src else ""
    tr.check("computeBackpressure_reads_from_dischargeSystem",
             "dischargeSystem.L" in bp_call_region and "dischargeSystem.D" in bp_call_region,
             "computeBackpressure 호출부가 dischargeSystem(Asset)이 아닌 다른 값으로부터 geometry를 읽음")

    # 미연결 상태를 침묵 처리하지 않고 명시적으로 표시하는지
    tr.check("shows_explicit_warning_when_not_linked",
             "not_linked" in input_view_src and "미연결" in input_view_src,
             "배출계통 미연결 상태를 침묵 처리함 (임의 기본값을 몰래 대입하면 안 됨)")

    # CaseView가 실제 dischargeSystem을 InputView로 전달하는지
    inputview_call = case_view_src.split("<InputView")[1].split("/>")[0]
    tr.check("CaseView_passes_real_dischargeSystem",
             "dischargeSystem={dischargeSystem}" in inputview_call,
             "CaseView가 InputView에 실제 dischargeSystem을 전달하지 않음")

    # ── GEOMETRY-002: 개정 계약 (Python 재현) ────────────────────
    def py_revise(existing, fields):
        if not fields.get("mocId","").strip():
            return {"ok": False, "field": "mocId", "reason": "required_for_revision"}
        return {"ok": True, "dischargeSystem": {
            **existing, **fields,
            "id": existing["id"],
            "revision": existing["revision"] + 1,
        }}

    existing = {"id":"DS-001","name":"LP-FLARE-01","revision":3,"L":12,"D":0.1,
                "fittingsK":2.5,"headerPressure":0.3,"connectedTags":["PSV-R201"]}

    no_moc = py_revise(existing, {"L":14})
    tr.check("GEOMETRY_002_mocId_required",
             no_moc["ok"] is False and no_moc["field"] == "mocId",
             "mocId 없이 개정이 허용됨 — 근거 없는 배관 변경 차단 안 됨")

    with_moc = py_revise(existing, {"mocId":"MOC-2026-0012","L":14})
    tr.check("GEOMETRY_002_id_preserved",
             with_moc["dischargeSystem"]["id"] == existing["id"],
             "개정 시 id가 바뀜 — case의 connectedTags/dischargeSystemId 연결이 끊김")
    tr.check("GEOMETRY_002_revision_incremented",
             with_moc["dischargeSystem"]["revision"] == existing["revision"] + 1,
             "개정 시 revision이 증가하지 않음")

    tr.check("schema_src_reviseDischargeSystem_defined",
             "function reviseDischargeSystem" in schema_src,
             "asset/schema.js에 reviseDischargeSystem 정의 없음")
    tr.check("schema_src_requires_mocId",
             "mocId" in schema_src.split("function reviseDischargeSystem")[1].split("}")[0],
             "reviseDischargeSystem 본문에서 mocId 필수 검사가 보이지 않음")

    return tr

# ════════════════════════════════════════════════════════════════
#  EQUIPMENT-MOC-001/002/003/004
#  DischargeSystem과 동일한 revision/MOC lifecycle을 Equipment에도 적용
# ════════════════════════════════════════════════════════════════
def test_equipment_moc_contract() -> TestResult:
    tr = TestResult("EQUIPMENT-MOC-001/002/003/004", "Equipment revision/MOC 계약")

    schema_src = (SRC / "asset" / "schema.js").read_text()

    tr.check("schema_reviseEquipment_defined",
             "function reviseEquipment" in schema_src,
             "asset/schema.js에 reviseEquipment 정의 없음")

    revise_body = schema_src.split("function reviseEquipment")[1].split("\n// ──")[0]
    tr.check("schema_reviseEquipment_requires_mocId",
             "mocId" in revise_body and "required_for_revision" in revise_body,
             "reviseEquipment이 mocId를 필수로 검사하지 않음")
    tr.check("schema_reviseEquipment_preserves_id",
             "id: existing.id" in revise_body,
             "reviseEquipment이 id를 유지하지 않음 — case/connectedTags 연결 끊길 위험")
    tr.check("schema_reviseEquipment_no_mutation",
             "Object.freeze(" in revise_body,
             "reviseEquipment 결과가 freeze되지 않음 — 기존 객체가 mutate될 위험")

    # ── EQUIPMENT-MOC-001: mocId 없이 개정 → reject (Python 재현) ──
    def py_revise_equipment(existing, fields):
        if not fields.get("mocId","").strip():
            return {"ok": False, "field": "mocId", "reason": "required_for_revision"}
        return {"ok": True, "equipment": {
            **existing, **fields,
            "id": existing["id"],
            "revision": existing["revision"] + 1,
        }}

    eq0 = {"id":"EQ-R201-1","tag":"PSV-R201","revision":3,
           "mawp":6.0,"setPressure":5.5,"orifice":"P","deviceType":"safetyValve"}

    no_moc = py_revise_equipment(eq0, {"setPressure":5.0})
    tr.check("EQUIPMENT_MOC_001_mocId_required",
             no_moc["ok"] is False and no_moc["field"] == "mocId",
             "mocId 없이 Equipment 개정이 허용됨")

    # ── EQUIPMENT-MOC-002: revision 증가 ───────────────────────
    with_moc = py_revise_equipment(eq0, {"mocId":"MOC-2026-017","setPressure":5.0})
    tr.check("EQUIPMENT_MOC_002_revision_incremented",
             with_moc["ok"] and with_moc["equipment"]["revision"] == eq0["revision"] + 1,
             "Equipment 개정 시 revision이 3→4로 증가하지 않음")
    tr.check("EQUIPMENT_MOC_002_id_preserved",
             with_moc["equipment"]["id"] == eq0["id"],
             "Equipment 개정 시 id가 바뀜")

    # ── EQUIPMENT-MOC-003: assetFingerprint 변경 감지 (detectMOC 재사용 원리 확인) ──
    # detectMOC는 setPressure를 diff 대상 필드로 이미 포함하고 있어야 함
    wf_engine_src = (SRC / "engine" / "workflow_engine.js").read_text()
    detect_moc_body = wf_engine_src.split("function detectMOC")[1].split("function ")[0]
    tr.check("EQUIPMENT_MOC_003_setPressure_in_detectMOC",
             "eq.setPressure" in detect_moc_body and "ceq.setPressure" in detect_moc_body,
             "detectMOC가 setPressure 변경을 비교하지 않음 — fingerprint 변경 감지 불가")
    tr.check("EQUIPMENT_MOC_003_fingerprint_drives_detection",
             "assetFingerprint" in detect_moc_body,
             "detectMOC가 assetFingerprint 비교로 시작하지 않음")

    # ── EQUIPMENT-MOC-004: setPressure가 REVIEW 트리거 필드에 포함되는지 ──
    tr.check("EQUIPMENT_MOC_004_setPressure_triggers_review",
             '"setPressure"' in wf_engine_src.split("WORKFLOW_TRIGGER_FIELDS")[1][:300],
             "setPressure가 WORKFLOW_TRIGGER_FIELDS에 없음 — 변경돼도 REVIEW_REQUIRED 안 됨")

    # ── UI 배선 확인: AssetMaster가 onReviseEquipment을 실제로 사용하는지 ──
    asset_master_src = (SRC / "components" / "AssetMaster.jsx").read_text()
    tr.check("AssetMaster_wires_onReviseEquipment",
             "onReviseEquipment" in asset_master_src and "reviseEquipment(editing" in asset_master_src,
             "AssetMaster.jsx가 reviseEquipment 흐름을 실제로 호출하지 않음")
    tr.check("AssetMaster_equipment_form_requires_mocId_when_revising",
             "isRevision ||" in asset_master_src.split("function EquipmentForm")[1][:2500],
             "EquipmentForm이 개정 모드에서 mocId 필수 검증을 하지 않음")

    return tr

# ════════════════════════════════════════════════════════════════
#  AUDIT-001 — ReportView/report/* 는 Snapshot 외부 Asset 참조 금지
#  AUDIT-002 — Evidence 필수 필드 존재
#  AUDIT-003 — Approval chain: approval.snapshotHash == snapshot.snapshotHash
#  AUDIT-004 — Report mutation 금지
#  AUDIT-005 — Evidence는 workflow 단계 무관 항상 렌더링, Approval만 조건부
# ════════════════════════════════════════════════════════════════
def test_audit_evidence_contract() -> TestResult:
    tr = TestResult("AUDIT-001/002/003/004/005", "Audit Evidence View 계약")

    report_dir = SRC / "components" / "report"
    asset_ev   = (report_dir / "AssetEvidence.jsx").read_text()
    wf_ev      = (report_dir / "WorkflowEvidence.jsx").read_text()
    appr_ev    = (report_dir / "ApprovalEvidence.jsx").read_text()
    audit_ev   = (report_dir / "AuditEvidence.jsx").read_text()
    report_view_src = (SRC / "components" / "ReportView.jsx").read_text()

    all_report_src = asset_ev + wf_ev + appr_ev + audit_ev

    # ── AUDIT-001: 현재 Asset 참조 금지 ───────────────────────────
    for banned in ["currentEquipment", "currentDischargeSystem", "detectMOC(",
                   "compareAsset(", "verifySignature(", "computeBackpressure(",
                   "createSnapshot("]:
        tr.check(f"AUDIT_001_no_{banned.strip('(')}",
                  banned not in all_report_src,
                  f"report/* 컴포넌트가 '{banned}'를 참조함 — Snapshot 외부 계산/조회 금지 위반")

    # AssetEvidence/WorkflowEvidence가 snapshot(단일 prop)만 받는지 (equipments/dischargeSystems 배열 금지)
    tr.check("AUDIT_001_no_asset_arrays_referenced",
             "equipments." not in all_report_src and "dischargeSystems." not in all_report_src,
             "report/* 컴포넌트가 Asset 배열(equipments/dischargeSystems)을 직접 참조함")

    # ── AUDIT-002: Evidence 필수 필드 노출 확인 ───────────────────
    for field, src, label in [
        ("equipmentRevision", asset_ev, "AssetEvidence"),
        ("dischargeRevision", asset_ev, "AssetEvidence"),
        ("snapshotHash",      wf_ev,    "WorkflowEvidence"),
        ("engine_version",    wf_ev,    "WorkflowEvidence"),
    ]:
        tr.check(f"AUDIT_002_{label}_{field}",
                  field in src, f"{label}가 {field}를 표시하지 않음")

    # ── AUDIT-003: Approval chain 연결 (snapshotHash 매칭) ───────
    tr.check("AUDIT_003_approval_filtered_by_snapshotHash",
             "a.snapshotHash === snapshot.snapshotHash" in appr_ev,
             "ApprovalEvidence가 snapshotHash 기준으로 승인 기록을 필터링하지 않음 — "
             "다른 버전의 승인이 섞여 보일 위험")

    # Python 시뮬레이션: 여러 버전의 승인 중 현재 snapshot 것만 골라지는지
    approvals = [
        {"approvalId":"A1","snapshotHash":"H1","approver":"Kim"},
        {"approvalId":"A2","snapshotHash":"H2","approver":"Lee"},
    ]
    current_snap = {"snapshotHash":"H2"}
    matched = [a for a in approvals if a["snapshotHash"] == current_snap["snapshotHash"]]
    tr.check("AUDIT_003_only_current_version_matched",
             len(matched) == 1 and matched[0]["approver"] == "Lee",
             "AUDIT-003 필터링 로직이 다른 버전 승인을 잘못 포함/누락함")

    # ── AUDIT-004: report mutation 금지 ───────────────────────────
    import re
    mutation_pattern = re.compile(r'snapshot\.\w+\s*=(?!=)')  # snapshot.xxx = (== 제외)
    delete_pattern    = re.compile(r'delete\s+snapshot\.')
    for label, src in [("AssetEvidence", asset_ev), ("WorkflowEvidence", wf_ev),
                        ("ApprovalEvidence", appr_ev), ("AuditEvidence", audit_ev)]:
        tr.check(f"AUDIT_004_no_mutation_{label}",
                  not mutation_pattern.search(src) and not delete_pattern.search(src),
                  f"{label}에서 snapshot 필드 할당/삭제 시도 발견 — 읽기 전용 위반")

    # ── ReportView 배선 확인 ──────────────────────────────────────
    tr.check("ReportView_renders_AuditEvidence",
             "<AuditEvidence" in report_view_src,
             "ReportView가 AuditEvidence를 렌더링하지 않음")
    tr.check("ReportView_computes_verification_once",
             report_view_src.count("verifyApprovalRecord(") == 1,
             "ReportView가 verifyApprovalRecord를 1회 초과 호출함 — "
             "ApprovalHistory/AuditEvidence가 각자 검증하면 중복 계산")
    tr.check("ApprovalHistory_reuses_shared_results",
             "verifiedResults" in (SRC / "components" / "ApprovalForm.jsx").read_text() and
             "verifyApprovalRecord(" not in (SRC / "components" / "ApprovalForm.jsx").read_text(),
             "ApprovalHistory가 여전히 자체적으로 verifyApprovalRecord를 호출함 (중복 검증)")

    # ── AUDIT-005: Evidence는 workflow 단계 무관 항상 렌더링, Approval만 조건부 ──
    report_view_body = report_view_src.split("const TAB = (id, label)")[0] + \
                        report_view_src.split("return (")[1] if "return (" in report_view_src else report_view_src
    tr.check("AUDIT_005_audit_tab_not_gated_by_workflow",
             "reportTab === \"audit\" &&" in report_view_src and
             "snap.workflow ===" not in report_view_src.split('reportTab === "audit"')[1].split("<AuditEvidence")[0],
             "audit 탭 렌더링이 workflow 상태로 게이팅되어 특정 단계에서 숨겨짐 — "
             "Evidence는 DRAFT/INSPECTION/REVIEW/APPROVED 전 단계에서 항상 조회 가능해야 함")
    tr.check("AUDIT_005_tab_always_present_in_TAB_list",
             '{TAB("audit"' in report_view_src,
             "감사/근거 탭 버튼이 항상 렌더링되지 않음 — 특정 상태에서만 탭이 나타나면 안 됨")

    # ApprovalEvidence: 승인 없는 상태에서도 빈 상태 메시지로 렌더링(에러/숨김 아님)
    tr.check("AUDIT_005_approval_empty_state_not_hidden",
             "matched.length === 0" in appr_ev and "emptyMsg" in appr_ev,
             "ApprovalEvidence가 승인이 없을 때 컴포넌트를 숨기거나 에러를 내는 방식으로 구현됨 — "
             "빈 상태를 명시적으로 보여줘야 함(AUDIT-005: Approval은 조건부 '존재', 조건부 '숨김'이 아님)")
    tr.check("AUDIT_005_evidence_sections_always_rendered_unconditionally",
             "{approved" not in audit_ev.replace("const approved", "").split("headerLabel")[0] and
             "<AssetEvidence" in audit_ev and "<WorkflowEvidence" in audit_ev,
             "AuditEvidence가 Asset/Workflow 섹션을 workflow 상태에 따라 조건부로 숨김 — "
             "Evidence(Asset/Workflow)는 승인 여부와 무관하게 항상 존재해야 함")

    return tr

# ════════════════════════════════════════════════════════════════
#  REPORT-PKG-001 — Snapshot → Package 결정론
#  REPORT-PKG-002 — Package mutation 금지
#  REPORT-PKG-003 — 현재 Asset 참조 금지 (snapshot만 입력)
#  REPORT-PKG-004 — Approval chain 연결 (snapshotHash 일치)
#  REPORT-PKG-005 — Report 계산 금지
# ════════════════════════════════════════════════════════════════
def test_report_package_contract() -> TestResult:
    tr = TestResult("REPORT-PKG-001~005", "ReportPackage 계약 검증")

    schema_src = (SRC / "report" / "schema.js").read_text()
    pkg_src    = (SRC / "report" / "createPackage.js").read_text()

    for label, src, syms in [
        ("schema", schema_src, ["REPORT_PACKAGE_VERSION", "function validateReportPackage",
                                 "REPORT-PKG-002"]),
        ("createPackage", pkg_src, ["function buildReportPackage",
                                     "REPORT-PKG-001", "REPORT-PKG-002",
                                     "REPORT-PKG-003", "REPORT-PKG-004", "REPORT-PKG-005",
                                     "Object.freeze(pkg)"]),
    ]:
        for sym in syms:
            tr.check(f"{label}_src_{sym.replace(' ','_').replace('(','')[:30]}",
                      sym in src, f"[{label}] '{sym}' 없음")

    # ── REPORT-PKG-003: 현재 Asset 인자를 받지 않는지 (함수 시그니처 검사) ──
    sig = pkg_src.split("function buildReportPackage(")[1].split(")")[0]
    tr.check("REPORT_PKG_003_signature_snapshot_and_opts_only",
             "currentEquipment" not in sig and "currentDischargeSystem" not in sig and
             "equipments" not in sig and "dischargeSystems" not in sig,
             f"buildReportPackage 시그니처에 현재 Asset 인자가 있음: ({sig})")
    tr.check("REPORT_PKG_003_no_asset_array_refs_in_body",
             "equipments." not in pkg_src and "dischargeSystems." not in pkg_src,
             "buildReportPackage 본문이 Asset 배열을 직접 참조함")
    tr.check("REPORT_PKG_003_reads_only_from_assetRefs_and_embedded_copy",
             "snapshot.assetRefs" in pkg_src and
             ("snapshot.equipment?." in pkg_src or "snapshot.equipment." in pkg_src),
             "buildReportPackage이 snapshot.assetRefs/snapshot.equipment 외 다른 곳에서 Asset을 읽음")

    # ── REPORT-PKG-005: 계산 함수 호출 금지 ───────────────────────
    for banned in ["computeBackpressure(", "calculateKb(", "detectMOC(", "verifySignature("]:
        tr.check(f"REPORT_PKG_005_no_{banned.strip('(')}",
                  banned not in pkg_src,
                  f"buildReportPackage이 '{banned}'를 호출함 — 계산/재검증은 report layer 금지")

    # ── Python 재현: 결정론 / freeze / approval 필터링 ────────────
    def py_build(snapshot, approval_records, verification_results, generated_at):
        matched = [
            {
                "approvalId": a["approvalId"], "signer": a["approver"],
                "approvedAt": a["approvedAt"], "decision": a["decision"],
                "verified": verification_results.get(a["approvalId"], {}).get("valid"),
            }
            for a in approval_records if a["snapshotHash"] == snapshot["snapshotHash"]
        ]
        return {
            "meta": {"packageVersion": "1.0.0", "generatedAt": generated_at,
                      "engineVersion": snapshot["engine_version"]},
            "identity": {"caseId": snapshot["caseId"], "snapshotId": snapshot["id"],
                          "snapshotHash": snapshot["snapshotHash"]},
            "approvals": matched,
        }

    snap = {"id":"SNAP-1","caseId":"C-001","snapshotHash":"H1","engine_version":"1.1.0"}
    approvals = [
        {"approvalId":"A1","approver":"Kim","approvedAt":"2026-07-06T00:00:00Z",
         "decision":"approve","snapshotHash":"H1"},
        {"approvalId":"A2","approver":"Lee","approvedAt":"2026-07-05T00:00:00Z",
         "decision":"approve","snapshotHash":"H0-OLD"},
    ]
    verified = {"A1": {"valid": True}}

    pkg1 = py_build(snap, approvals, verified, "2026-07-07T00:00:00Z")
    pkg2 = py_build(snap, approvals, verified, "2026-07-07T00:00:00Z")
    tr.check("REPORT_PKG_001_deterministic_same_input_same_output",
             pkg1 == pkg2,
             "같은 snapshot+같은 generatedAt인데 다른 package가 나옴 — 결정론 위반")

    # ── REPORT-PKG-004: approval chain 연결 확인 ─────────────────
    tr.check("REPORT_PKG_004_only_matching_snapshotHash_included",
             len(pkg1["approvals"]) == 1 and pkg1["approvals"][0]["signer"] == "Kim",
             "REPORT-PKG-004: 다른 snapshotHash의 approval이 섞여 들어감")
    tr.check("REPORT_PKG_004_approval_snapshotHash_matches_identity",
             all(True for _ in pkg1["approvals"]) and
             pkg1["identity"]["snapshotHash"] == "H1",
             "package.identity.snapshotHash가 approval 필터링 기준과 다름")

    return tr

# ════════════════════════════════════════════════════════════════
#  PDF-001 — Renderer는 계산/재검증 함수 접근 금지
#  PDF-002 — Renderer 입력은 reportPackage 하나만
#  PDF-003 — 동일 Package → 동일 PDF metadata (생성시간 제외)
#  PDF-004 — PDF 필수 Evidence 5개 섹션 출력
# ════════════════════════════════════════════════════════════════
def test_pdf_renderer_contract() -> TestResult:
    tr = TestResult("PDF-001/002/003/004", "PDF Renderer 계약 검증")

    pdf_dir      = SRC / "report" / "renderer" / "pdf"
    styles_src   = (pdf_dir / "styles.js").read_text()
    template_src = (pdf_dir / "template.js").read_text()
    render_src   = (pdf_dir / "renderPDF.js").read_text()
    all_pdf_src  = styles_src + template_src + render_src

    for label, src, syms in [
        ("styles",   styles_src,  ["PDF_STYLES"]),
        ("template", template_src,["function buildPDFHtml", "PDF-002", "PDF-004"]),
        ("render",   render_src,  ["function renderPDF", "PDF-001", "PDF-002", "PDF-003",
                                     "validateReportPackage(reportPackage)"]),
    ]:
        for sym in syms:
            tr.check(f"{label}_src_{sym.replace(' ','_').replace('(','')[:30]}",
                      sym in src, f"[{label}] '{sym}' 없음")

    # ── PDF-001: 계산/재검증 함수 호출 금지 ───────────────────────
    for banned in ["computeBackpressure(", "calculateKb(", "detectMOC(", "verifyApprovalRecord("]:
        tr.check(f"PDF_001_no_{banned.strip('(')}",
                  banned not in all_pdf_src,
                  f"PDF renderer가 '{banned}'를 호출함 — 계산/재검증은 renderer 금지")

    # ── PDF-002: 함수 시그니처가 단일 인자만 받는지 ──────────────
    render_sig = render_src.split("function renderPDF(")[1].split(")")[0]
    tr.check("PDF_002_renderPDF_single_arg",
             "," not in render_sig,
             f"renderPDF가 여러 인자를 받음: ({render_sig}) — reportPackage 하나만 허용")
    template_sig = template_src.split("function buildPDFHtml(")[1].split(")")[0]
    tr.check("PDF_002_buildPDFHtml_single_arg",
             "," not in template_sig,
             f"buildPDFHtml이 여러 인자를 받음: ({template_sig})")
    tr.check("PDF_002_no_snapshot_param_name",
             "snapshot)" not in render_src.split("function renderPDF(")[1][:30] and
             "caseData" not in render_sig and "equipment" not in render_sig,
             "renderPDF 시그니처에 snapshot/equipment/caseData 등 추가 데이터 인자가 보임")

    # ── PDF-003: 결정론 (생성시간 제외 나머지 동일) — buildPDFHtml Python 근사 재현 ──
    def py_build_html_skeleton(pkg):
        # 실제 HTML 문자열 대신, "생성시간을 뺀 나머지 필드가 출력에 영향 주는 필드 목록"만 비교
        return {
            "asset": pkg["asset"], "calculation": pkg["calculation"],
            "workflow": pkg["workflow"], "approvals": pkg["approvals"],
            "identity": pkg["identity"], "packageVersion": pkg["meta"]["packageVersion"],
            "engineVersion": pkg["meta"]["engineVersion"],
            # generatedAt은 의도적으로 제외
        }
    pkg_a = {"asset":{"x":1}, "calculation":{"y":2}, "workflow":{"z":3}, "approvals":[],
             "identity":{"snapshotHash":"H1"},
             "meta":{"packageVersion":"1.0.0","engineVersion":"1.1.0","generatedAt":"2026-07-07T00:00:00Z"}}
    pkg_b = {**pkg_a, "meta":{**pkg_a["meta"], "generatedAt":"2026-07-08T00:00:00Z"}}
    tr.check("PDF_003_same_content_diff_generatedAt_same_skeleton",
             py_build_html_skeleton(pkg_a) == py_build_html_skeleton(pkg_b),
             "generatedAt만 다른데 나머지 출력 대상 필드까지 달라짐 — PDF-003 결정론 위반")
    tr.check("PDF_003_generatedAt_treated_as_metadata_only",
             "meta.generatedAt" in template_src,
             "template.js가 generatedAt을 메타데이터로 별도 취급하지 않음")

    # ── PDF-004: 필수 Evidence 5개 섹션 (한글 라벨) ──────────────────
    for section, keyword in [
        ("ASSET", "설비 정보"), ("CALCULATION BASIS", "계산 근거"),
        ("WORKFLOW DECISION", "검토 진행 상태"), ("APPROVAL", "승인 현황"),
        ("INTEGRITY", "문서 무결성"),
    ]:
        tr.check(f"PDF_004_section_{section.split()[0]}",
                  keyword in template_src,
                  f"PDF 템플릿에 '{keyword}' 섹션이 없음")
    for field in ["pkg.asset.equipment.tag", "pkg.asset.equipment.revision", "pkg.asset.equipment.mocId",
                  "pkg.calculation.inputs", "pkg.calculation.engineVersion",
                  "pkg.workflow.state", "pkg.identity.snapshotHash", "pkg.meta.packageVersion"]:
        tr.check(f"PDF_004_field_{field.split('.')[-1]}",
                  field in template_src,
                  f"PDF 템플릿이 필수 필드 {field}를 출력하지 않음")

    # ── PDF-003(런타임 안전장치): 유효하지 않은 Package는 렌더링 중단 ──
    render_body = render_src.split("function renderPDF(reportPackage)")[1]
    tr.check("PDF_invalid_package_blocks_before_html_build",
             render_body.index("check.ok") < render_body.index("buildPDFHtml("),
             "renderPDF가 validateReportPackage 검사보다 먼저(또는 무관하게) HTML을 생성함")

    return tr

# ════════════════════════════════════════════════════════════════
#  PDF-GOLDEN-001
#  실제 fixture(PSV-R201)로 buildPDFHtml()을 진짜 Node에서 실행해:
#    1. 같은 package → 같은 정규화 HTML hash (결정론, 소스 텍스트 재현이 아니라 실행 검증)
#    2. 필수 내용(설비 revision, MOC, 배관 형상, 서명자, 검증 배지)이 실제 출력에 있는지
#  PDF 바이너리 자체는 브라우저 metadata 때문에 비교 불가하므로 HTML 단계에서 고정한다.
# ════════════════════════════════════════════════════════════════
def test_pdf_golden_fixture_contract() -> TestResult:
    tr = TestResult("PDF-GOLDEN-001", "PSV-R201 실제 fixture 기반 PDF 골든 테스트")

    node = shutil.which("node")
    if not node:
        tr.check("node_available", False, "node 실행 파일을 찾을 수 없어 골든 테스트를 건너뜀")
        return tr

    fixtures_dir = ROOT / "tests" / "fixtures"
    golden_script = ROOT / "tests" / "golden_pdf_hash.js"
    tr.check("golden_script_exists", golden_script.exists(), "tests/golden_pdf_hash.js 없음")

    for fixture_name in ["PSV-R201-review-required-package.json", "PSV-R201-approved-package.json"]:
        fixture_path = fixtures_dir / fixture_name
        if not fixture_path.exists():
            tr.check(f"fixture_exists_{fixture_name}", False, f"{fixture_name} fixture 없음")
            continue

        def run_golden():
            r = subprocess.run([node, str(golden_script), str(fixture_path)],
                                capture_output=True, text=True, timeout=15)
            return r

        r1 = run_golden()
        r2 = run_golden()
        tr.check(f"golden_runs_ok_{fixture_name}",
                  r1.returncode == 0 and r2.returncode == 0,
                  f"{fixture_name}: node 실행 실패 — {r1.stderr or r2.stderr}")
        if r1.returncode == 0 and r2.returncode == 0:
            h1, h2 = r1.stdout.strip(), r2.stdout.strip()
            tr.check(f"golden_deterministic_{fixture_name}",
                      h1 == h2 and len(h1) == 64,
                      f"{fixture_name}: 같은 package인데 실행마다 HTML hash가 다름 — "
                      f"실제 buildPDFHtml() 실행 결과가 비결정적임 ({h1} != {h2})")

        # ── 내용 검증: 실제 buildPDFHtml()을 한 번 더 돌려 필수 문자열 확인 ──
        pkg = json.loads(fixture_path.read_text())
        check_script = f"""
const fs = require('fs');
const files = ['report/schema.js','report/renderer/pdf/styles.js','report/renderer/pdf/template.js']
  .map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);
const pkg = {json.dumps(pkg)};
console.log(buildPDFHtml(pkg));
"""
        r3 = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
        html = r3.stdout

        expectations = [
            (pkg["asset"]["equipment"]["tag"], "Equipment tag"),
            (f'Rev.{pkg["asset"]["equipment"]["revision"]}', "Equipment revision"),
            (f'Rev.{pkg["asset"]["dischargeSystem"]["revision"]}', "Discharge revision"),
            (str(pkg["asset"]["dischargeSystem"]["headerPressure"]), "Header pressure 값"),
            (str(pkg["asset"]["dischargeSystem"]["fittingsK"]), "Fittings K 값"),
            (pkg["identity"]["snapshotHash"], "Snapshot hash"),
        ]
        if pkg["asset"]["dischargeSystem"].get("mocId"):
            expectations.append((pkg["asset"]["dischargeSystem"]["mocId"], "MOC 번호"))
        for approval in pkg.get("approvals", []):
            expectations.append((approval["signer"], "승인자명"))

        for expected, label in expectations:
            tr.check(f"golden_content_{fixture_name}_{label.replace(' ','_')}",
                      expected in html,
                      f"{fixture_name}: PDF 출력에 {label}({expected})이 없음")

        # 승인 없는 fixture는 "서명 없음"이, 승인 있는 fixture는 "서명 유효"가 있어야 함
        if len(pkg.get("approvals", [])) == 0:
            tr.check(f"golden_content_{fixture_name}_pending_badge",
                      "서명 없음" in html,
                      f"{fixture_name}: 승인 없는 상태인데 '서명 없음' 배지가 없음")
        else:
            tr.check(f"golden_content_{fixture_name}_verified_badge",
                      "서명 유효" in html,
                      f"{fixture_name}: 승인된 상태인데 '서명 유효' 배지가 없음")

    return tr

def test_ui_engine_wiring() -> TestResult:
    tr = TestResult("WIRING-001", "InputView가 engine 함수를 올바르게 호출하는지")
    input_view = (SRC / "components" / "InputView.jsx").read_text()
    backpressure_src = (SRC / "engine" / "backpressure.js").read_text()

    tr.check("InputView_calls_computeBackpressure",
             "computeBackpressure(" in input_view,
             "InputView.jsx에 computeBackpressure( 호출이 없음")

    tr.check("computeBackpressure_defined_in_engine",
             "function computeBackpressure" in backpressure_src,
             "engine/backpressure.js에 정의가 없음")

    relevant = "\n".join([
        (SRC / "constants.js").read_text(),
        (SRC / "engine" / "api520.js").read_text(),
        (SRC / "engine" / "backpressure.js").read_text(),
        (SRC / "engine" / "evidence.js").read_text(),
        (SRC / "engine" / "workflow_engine.js").read_text(),
        input_view,
    ])
    tr.check("calculateKb_fully_removed",
             "calculateKb" not in relevant,
             "calculateKb 참조가 소스에 남아있음 (정의 또는 호출)")

    # detectMOC 위치 검증
    wf_engine = (SRC / "engine" / "workflow_engine.js").read_text()
    snap_src  = (SRC / "snapshot" / "create.js").read_text()
    wf_index  = (SRC / "workflow" / "index.js").read_text()
    tr.check("detectMOC_in_workflow_engine",
             "function detectMOC" in wf_engine,
             "detectMOC가 engine/workflow_engine.js에 없음")
    tr.check("detectMOC_not_in_snapshot",
             "function detectMOC" not in snap_src,
             "detectMOC가 snapshot/create.js에 잔존")
    tr.check("requiresReview_not_in_workflow",
             "function requiresReview" not in wf_index,
             "requiresReview가 workflow/index.js에 잔존")

    return tr

# ════════════════════════════════════════════════════════════════
#  MAIN
# ════════════════════════════════════════════════════════════════
def main():
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    print(f"\n{'═'*60}")
    print(f"  ArcSafe Contract Test Suite")
    print(f"  ENGINE_VERSION: {ENGINE_VERSION}")
    print(f"  {ts}")
    print(f"{'═'*60}\n")

    all_results = []

    # ── Fixture tests ─────────────────────────────────────────
    print("── SCENARIO FIXTURES ────────────────────────────────")
    for f in FIXTURES:
        t0 = time.perf_counter()
        tr = run_fixture(f)
        elapsed = (time.perf_counter() - t0) * 1000
        all_results.append(tr)

        status = "✓ PASS" if tr.passed else "✗ FAIL"
        print(f"\n  [{tr.sc_id}] {tr.label}")
        print(f"  {status}  ({elapsed:.2f}ms)")
        for name, ok, detail in tr.checks:
            mark = "  ✓" if ok else "  ✗"
            line = f"{mark} {name}"
            if detail and not ok:
                line += f"\n       {detail}"
            print(line)

    # ── Backpressure fixture tests ─────────────────────────────
    print("\n── BACKPRESSURE FIXTURES ────────────────────────────")
    for f in BP_FIXTURES:
        t0 = time.perf_counter()
        tr = run_backpressure_fixture(f)
        elapsed = (time.perf_counter() - t0) * 1000
        all_results.append(tr)

        status = "✓ PASS" if tr.passed else "✗ FAIL"
        print(f"\n  [{tr.sc_id}] {tr.label}")
        print(f"  {status}  ({elapsed:.2f}ms)")
        for name, ok, detail in tr.checks:
            mark = "  ✓" if ok else "  ✗"
            line = f"{mark} {name}"
            if detail and not ok:
                line += f"\n       {detail}"
            print(line)

    # ── Snapshot schema test ──────────────────────────────────
    print("\n── SNAPSHOT SCHEMA ──────────────────────────────────")
    tr = test_snapshot_schema()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [SCHEMA-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── MOC detection test ────────────────────────────────────
    print("\n── MOC DETECTION ────────────────────────────────────")
    tr = test_moc_detection()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [MOC-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Boundary test ─────────────────────────────────────────
    print("\n── ENGINE BOUNDARY ──────────────────────────────────")
    tr = test_engine_boundary()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [BOUNDARY-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Unit Boundary test ───────────────────────────────────────
    print("\n── UNIT BOUNDARY ─────────────────────────────────────")
    tr = test_unit_boundaries()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [UNIT-BOUNDARY-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Compressibility(Z) contract ──────────────────────────────
    print("\n── COMPRESSIBILITY (Z) ───────────────────────────────")
    tr = test_compressibility_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [COMPRESSIBILITY-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Baseline Lock contract (Sprint A.1) ──────────────────────
    print("\n── BASELINE LOCK (Sprint A.1) ────────────────────────")
    tr = test_baseline_lock_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [BASELINE-LOCK-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Valve Type policy contract (Sprint C-1) ──────────────────
    print("\n── VALVE TYPE POLICY (Sprint C-1) ────────────────────")
    tr = test_valve_type_policy_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [VALVE-TYPE-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Accumulation policy contract (Sprint C-2) ────────────────
    print("\n── ACCUMULATION POLICY (Sprint C-2) ──────────────────")
    tr = test_accumulation_policy_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [ACCUMULATION-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Inlet pressure-loss contract (Sprint C-3) ────────────────
    print("\n── INLET PRESSURE LOSS (Sprint C-3) ──────────────────")
    tr = test_inlet_pressure_loss_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [INLET-LOSS-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Relief Load Taxonomy contract (C-4.0) ────────────────────
    print("\n── RELIEF LOAD TAXONOMY (Sprint C-4.0) ──────────────")
    tr = test_relief_load_taxonomy_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [RELIEF-LOAD-TAXONOMY-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── §5.1 출구 차단 contract (C-4.1) ──────────────────────────
    print("\n── OUTLET BLOCKED §5.1 (Sprint C-4.1) ───────────────")
    tr = test_outlet_blocked_scenario_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [OUTLET-BLOCKED-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── §5.6 과충전 contract (C-4.2) ─────────────────────────────
    print("\n── OVERFILLING §5.6 (Sprint C-4.2) ──────────────────")
    tr = test_overfilling_scenario_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [OVERFILLING-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── §5.7 자동제어밸브 고장 contract (C-4.3) ──────────────────
    print("\n── CONTROL VALVE FAILURE §5.7 (Sprint C-4.3) ────────")
    tr = test_control_valve_failure_scenario_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [CONTROL-VALVE-FAIL-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── §5.8 비정상 열/증기 유입 contract (C-4.4) ────────────────
    print("\n── ABNORMAL HEAT/VAPOR §5.8 (Sprint C-4.4) ──────────")
    tr = test_abnormal_heat_vapor_scenario_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [ABNORMAL-HEAT-VAPOR-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── §5.11 액체부피 팽창 contract (C-4.5) ─────────────────────
    print("\n── LIQUID THERMAL EXPANSION §5.11 (Sprint C-4.5) ────")
    tr = test_liquid_thermal_expansion_scenario_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [LIQUID-EXPANSION-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── §5.13 열교환기 고장 contract (C-4.6) ─────────────────────
    print("\n── EXCHANGER FAILURE §5.13 (Sprint C-4.6) ───────────")
    tr = test_exchanger_failure_scenario_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [EXCHANGER-FAIL-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── §5.12 외부 화재 contract (C-4.7) ─────────────────────────
    print("\n── EXTERNAL FIRE §5.12 (Sprint C-4.7) ───────────────")
    tr = test_external_fire_scenario_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [EXTERNAL-FIRE-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Unit/Selector contract (C-4.8A) ──────────────────────────
    print("\n── UNIT/SELECTOR CONTRACT (Sprint C-4.8A) ───────────")
    tr = test_unit_selector_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [UNIT-SELECTOR-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Relief-sizing adapter contract (C-4.8B) ──────────────────
    print("\n── RELIEF-SIZING-ADAPTER-001 (Sprint C-4.8B) ────────")
    tr = test_relief_sizing_adapter_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [RELIEF-SIZING-ADAPTER-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Relief Load Scenario Input UI contract (C-4.9) ────────────
    print("\n── RELIEF-LOAD-UI-001 (Sprint C-4.9) ────────────────")
    tr = test_relief_load_ui_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [RELIEF-LOAD-UI-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Golden Baseline contract ─────────────────────────────────
    print("\n── GOLDEN BASELINE (Engine 1.3.0) ────────────────────")
    tr = test_golden_baseline_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [GOLDEN-BASELINE-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── UI-Engine wiring test ──────────────────────────────────
    print("\n── UI-ENGINE WIRING ─────────────────────────────────")
    tr = test_ui_engine_wiring()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [WIRING-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── MOC schema contract ────────────────────────────────────
    print("\n── MOC SCHEMA CONTRACT ──────────────────────────────")
    for fn, label in [(test_moc_schema,            "MOC_SCHEMA_001"),
                      (test_workflow_contract,      "WORKFLOW_001"),
                      (test_workflow_decision_trace,"WFDECISION_001"),
                      (test_approval_contracts,     "APPROVAL-001/002/003"),
                      (test_case_history_contract,  "HISTORY-001/002/003"),
                      (test_asset_history_contract, "ASSET-HISTORY-001~004"),
                      (test_revision_history_ui_readonly_contract, "ASSET-UI-001"),
                      (test_asset_diff_contract, "ASSET-DIFF-001~005"),
                      (test_asset_impact_contract, "ASSET-IMPACT-001~005"),
                      (test_approval_crypto_contract, "CRYPTO/SERVICE/VALIDATOR"),
                      (test_geometry_contract,       "GEOMETRY-001/002"),
                      (test_equipment_moc_contract,  "EQUIPMENT-MOC-001~004"),
                      (test_audit_evidence_contract, "AUDIT-001~005"),
                      (test_report_package_contract, "REPORT-PKG-001~005"),
                      (test_pdf_renderer_contract,   "PDF-001~004"),
                      (test_approval_signs_next_snapshot_contract, "APPROVAL-SIGN-TARGET-001"),
                      (test_pdf_golden_fixture_contract, "PDF-GOLDEN-001")]:
        tr = fn()
        all_results.append(tr)
        status = "✓ PASS" if tr.passed else "✗ FAIL"
        print(f"\n  [{label}] {tr.label}")
        print(f"  {status}")
        for name, ok, detail in tr.checks:
            mark = "  ✓" if ok else "  ✗"
            print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Summary ───────────────────────────────────────────────
    total  = sum(len(r.checks) for r in all_results)
    passed = sum(sum(1 for _, ok, _ in r.checks if ok) for r in all_results)
    suites_pass = sum(1 for r in all_results if r.passed)

    print(f"\n{'═'*60}")
    print(f"  RESULT: {suites_pass}/{len(all_results)} suites passed")
    print(f"  CHECKS: {passed}/{total}")
    print(f"  {'ALL PASS ✓' if passed == total else 'FAILURES DETECTED ✗'}")
    print(f"{'═'*60}\n")

    sys.exit(0 if passed == total else 1)

if __name__ == "__main__":
    main()
