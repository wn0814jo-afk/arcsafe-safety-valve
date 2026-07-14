//  REPORT PACKAGE SCHEMA
//  Snapshot을 최종 출력(PDF/HTML/JSON)과 분리시키는 계약 레이어.
//  이 파일은 "형태가 맞는지"만 검증한다 — 계산도, Asset 재조회도, Approval
//  재판단도 하지 않는다. buildReportPackage()가 만든 결과를 사후 점검할 때만 쓴다.
//
//  계약:
//    REPORT-PKG-002: ReportPackage는 생성 이후 절대 수정되지 않는다(freeze).
// ════════════════════════════════════════════════════════════════

const REPORT_PACKAGE_VERSION = "1.0.0";

const REPORT_PACKAGE_REQUIRED_KEYS = [
  "meta", "identity", "asset", "calculation", "workflow", "approvals",
];

// ── validateReportPackage ──────────────────────────────────────
// 순수 형태 검증. true/false 판단 로직(계산)이 전혀 없다 — 키 존재 확인뿐.
function validateReportPackage(pkg) {
  if (!pkg || typeof pkg !== "object") {
    return { ok: false, reason: "package is not an object" };
  }
  // ENGINE-VERSION-LOCK-001: buildReportPackage가 이미 판정해 넘긴 실패
  // 사유를 그대로 통과시킨다 — "missing keys" 같은 일반 메시지로 뭉개지 않는다.
  if (pkg.ok === false && pkg.contract === "ENGINE-VERSION-LOCK-001") {
    return { ok: false, reason: pkg.detail || "INVALID_STATE: engine version mismatch", contract: pkg.contract };
  }
  const missing = REPORT_PACKAGE_REQUIRED_KEYS.filter(k => !(k in pkg));
  if (missing.length > 0) {
    return { ok: false, reason: `missing keys: ${missing.join(", ")}` };
  }
  if (pkg.meta.packageVersion !== REPORT_PACKAGE_VERSION) {
    return { ok: false, reason: `unsupported packageVersion: ${pkg.meta.packageVersion}` };
  }
  if (!pkg.identity.snapshotHash) {
    return { ok: false, reason: "identity.snapshotHash missing — package has no signable identity" };
  }
  return { ok: true };
}
