//  PSV ASSET SCHEMA v2
//  Equipment = 밸브 자체 (거의 불변, 교체/MOC 시 변경)
//  DischargeSystem = 배출계통 (배관 개조 MOC 시 변경, 복수 PSV 공유 가능)
// ════════════════════════════════════════════════════════════════

// ── PSVEquipment ─────────────────────────────────────────────
function validateEquipment(eq) {
  if (!eq.tag || !eq.tag.trim())
    return { ok:false, field:"tag", reason:"required" };
  if (!eq.mawp || Number(eq.mawp) <= 0)
    return { ok:false, field:"mawp", reason:"must_be_positive" };
  if (!eq.setPressure || Number(eq.setPressure) <= 0)
    return { ok:false, field:"setPressure", reason:"must_be_positive" };
  if (Number(eq.setPressure) > Number(eq.mawp))
    return { ok:false, field:"setPressure", reason:"exceeds_mawp" };
  // PRESSURE-001: overpressure는 relieving pressure(절대압) 산정에 쓰이는
  // Design Basis — Case가 아니라 Asset(Equipment)이 소유. 계산 신뢰성
  // 계약이므로 누락/음수를 허용하지 않는다.
  if (eq.overpressure === undefined || eq.overpressure === null || isNaN(Number(eq.overpressure)))
    return { ok:false, field:"overpressure", reason:"required" };
  if (Number(eq.overpressure) < 0)
    return { ok:false, field:"overpressure", reason:"must_be_non_negative" };
  return { ok:true };
}

function createEquipment(fields) {
  const valid = validateEquipment(fields);
  if (!valid.ok) throw new Error(`EQUIPMENT_INVALID: ${valid.field} — ${valid.reason}`);
  return Object.freeze({
    id:           `EQ-${fields.tag.replace(/[^A-Z0-9]/gi,"").toUpperCase()}-${Date.now()}`,
    tag:          fields.tag.trim(),
    revision:     Number(fields.revision ?? 1),
    mocId:        fields.mocId || null,
    location:     fields.location || "",
    manufacturer: fields.manufacturer || "",
    model:        fields.model || "",
    serialNo:     fields.serialNo || "",
    deviceType:   fields.deviceType || "safetyValve",
    mawp:         Number(fields.mawp),
    setPressure:  Number(fields.setPressure),
    overpressure: Number(fields.overpressure),
    orifice:      fields.orifice || "",
    inletSize:    fields.inletSize || "",
    outletSize:   fields.outletSize || "",
    installedAt:  fields.installedAt || "",
    registeredAt: new Date().toISOString(),
  });
}

// ── reviseEquipment ────────────────────────────────────────────
// EQUIPMENT-MOC-001/002: reviseDischargeSystem과 동일한 계약.
// mocId 없이는 개정 불가, id는 유지, revision만 증가.
function reviseEquipment(existing, fields) {
  if (!fields.mocId || !fields.mocId.trim()) {
    return { ok:false, field:"mocId", reason:"required_for_revision" };
  }
  const merged = { ...existing, ...fields, id: existing.id };
  const valid = validateEquipment(merged);
  if (!valid.ok) return valid;

  return {
    ok: true,
    equipment: Object.freeze({
      ...existing,
      ...fields,
      id:           existing.id,               // identity 유지
      revision:     Number(existing.revision) + 1,
      mocId:        fields.mocId.trim(),
      mawp:         Number(fields.mawp),
      setPressure:  Number(fields.setPressure),
      overpressure: Number(fields.overpressure),
      registeredAt: existing.registeredAt,     // 최초 등록일 유지
      revisedAt:    new Date().toISOString(),
    }),
  };
}

// ── DischargeSystem ──────────────────────────────────────────
// 하나의 배출계통을 여러 PSV가 공유할 수 있음 (connectedTags)
function validateDischargeSystem(ds) {
  if (!ds.name || !ds.name.trim())
    return { ok:false, field:"name", reason:"required" };
  if (!ds.D || Number(ds.D) <= 0)
    return { ok:false, field:"D", reason:"must_be_positive" };
  if (Number(ds.L) < 0)
    return { ok:false, field:"L", reason:"must_be_non_negative" };
  const validDest = ["flare","atm","closed"];
  if (!validDest.includes(ds.destination))
    return { ok:false, field:"destination", reason:"must_be_flare_atm_closed" };
  return { ok:true };
}

function createDischargeSystem(fields) {
  const valid = validateDischargeSystem(fields);
  if (!valid.ok) throw new Error(`DISCHARGE_INVALID: ${valid.field} — ${valid.reason}`);
  return Object.freeze({
    id:              `DS-${fields.name.replace(/[^A-Z0-9]/gi,"").toUpperCase()}-${Date.now()}`,
    name:            fields.name.trim(),
    revision:        Number(fields.revision ?? 1),
    mocId:           fields.mocId || null,
    destination:     fields.destination,
    L:               Number(fields.L ?? 15),
    D:               Number(fields.D),
    fittingsK:       Number(fields.fittingsK ?? 3.0),
    headerPressure:  Number(fields.headerPressure ?? 0.3),
    connectedTags:   Array.isArray(fields.connectedTags) ? [...fields.connectedTags] : [],
    registeredAt:    new Date().toISOString(),
  });
}

// ── reviseDischargeSystem ─────────────────────────────────────
// GEOMETRY-002: 개정은 새 엔티티가 아니라 같은 id의 새 revision.
// mocId 없이는 개정 불가 — "배관을 왜 바꿨는지" 근거 없는 변경 차단.
function reviseDischargeSystem(existing, fields) {
  if (!fields.mocId || !fields.mocId.trim()) {
    return { ok:false, field:"mocId", reason:"required_for_revision" };
  }
  const merged = { ...existing, ...fields, id: existing.id };
  const valid = validateDischargeSystem(merged);
  if (!valid.ok) return valid;

  return {
    ok: true,
    dischargeSystem: Object.freeze({
      ...existing,
      ...fields,
      id:            existing.id,              // identity 유지 — case 연결 안 끊김
      revision:      Number(existing.revision) + 1,
      mocId:         fields.mocId.trim(),
      L:             Number(fields.L),
      D:             Number(fields.D),
      fittingsK:     Number(fields.fittingsK),
      headerPressure:Number(fields.headerPressure),
      connectedTags: Array.isArray(fields.connectedTags) ? [...fields.connectedTags] : existing.connectedTags,
      registeredAt:  existing.registeredAt,     // 최초 등록일 유지
      revisedAt:     new Date().toISOString(),
    }),
  };
}

// ── Destination 레이블 ────────────────────────────────────────
const DESTINATION_LABEL = {
  flare:  "플레어 헤더",
  atm:    "대기 직방출",
  closed: "밀폐 시스템",
};

const DESTINATION_NOTE = {
  flare:  "대기 연소 처리",
  atm:    "비독성·비가연성 유체만 허용",
  closed: "회수·처리 계통",
};

// ── 샘플 데이터 ──────────────────────────────────────────────
const SAMPLE_EQUIPMENT = [
  {
    tag:"PSV-R201",  location:"반응기 R-201 상부",
    deviceType:"safetyValve", mawp:6.0, setPressure:5.5, overpressure:10, orifice:"P",
    inletSize:"3\"", outletSize:"4\"",
    manufacturer:"Crosby", model:"JOS-E",
  },
  {
    tag:"PSV-R302",  location:"N₂ 퍼지 헤더",
    deviceType:"safetyValve", mawp:13.0, setPressure:12.0, overpressure:10, orifice:"J",
    inletSize:"2\"", outletSize:"3\"",
    manufacturer:"Anderson Greenwood", model:"Series 81",
  },
  {
    tag:"PSV-S12",   location:"스팀 트레이싱 헤더",
    deviceType:"safetyValve", mawp:9.0, setPressure:8.0, overpressure:10, orifice:"P",
    inletSize:"3\"", outletSize:"4\"",
    manufacturer:"Crosby", model:"HB-BP",
  },
];

const SAMPLE_DISCHARGE_SYSTEMS = [
  {
    name:"LP-FLARE-01",
    destination:"flare", L:12, D:0.100, fittingsK:2.5, headerPressure:0.3,
    connectedTags:["PSV-R201"],
  },
  {
    name:"HP-FLARE-01",
    destination:"flare", L:8,  D:0.075, fittingsK:1.5, headerPressure:0.5,
    connectedTags:["PSV-R302"],
  },
  {
    name:"STM-FLARE-01",
    destination:"flare", L:25, D:0.100, fittingsK:4.0, headerPressure:1.2,
    connectedTags:["PSV-S12"],
  },
];
