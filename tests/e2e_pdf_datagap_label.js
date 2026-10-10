#!/usr/bin/env node
/**
 * PDF 리포트 — 내부 키(inletPiping) 비노출 / 한글 문구 검증 (표시 계층 전용)
 *   node tests/e2e_pdf_datagap_label.js [out.html 경로(선택: 육안 확인용 HTML 저장 디렉터리)]
 * golden_pdf_hash.js 와 같은 방식(schema/styles/template 3개 파일을 eval)으로 buildPDFHtml 을 실제 실행한다.
 * 확인:
 *   A) 인입배관 정보 있음(fixture 그대로) — 영문 키 없음, 배관 행(L/D/ΣK 값) 유지
 *   B) 인입배관 정보 없음(dataGaps=["inletPiping"], INSUFFICIENT_INPUT) — 한글 문구만 표시, 영문 키 없음, "미등록" 유지
 *   C) 데이터는 변환하지 않음 — 패키지의 dataGaps 값은 그대로 "inletPiping"
 * Engine/Snapshot/판정/해시 계산은 호출하지 않는다.
 */
const fs = require("fs"), path = require("path");
const SRC = path.join(__dirname, "..", "src");
eval(["report/schema.js", "report/renderer/pdf/styles.js", "report/renderer/pdf/template.js"]
  .map(f => fs.readFileSync(path.join(SRC, f), "utf8")).join("\n"));

const outDir = process.argv[2];
const load = n => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8"));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond ? "" : "  " + (extra || ""))); };
// 사용자에게 보이는 텍스트만 (style/script 와 태그 제거)
const visible = html => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");

// A) 인입배관 있음
const pkgA = load("PSV-R201-review-required-package.json");
const htmlA = buildPDFHtml(pkgA);
const txtA = visible(htmlA);
ok("A: 인입배관 있음 — 영문 키 inletPiping 미노출", !txtA.includes("inletPiping"));
ok("A: 인입배관 행에 L/D/ΣK 값 출력", txtA.includes("3 m / 80 mm / 1.5"), "인입배관 값 행 없음");
ok("A: 보류 안내 없음(dataGaps 비어 있음)", !txtA.includes("일부 세부 판정 보류"));

// B) 인입배관 없음
const pkgB = JSON.parse(JSON.stringify(pkgA));
pkgB.asset.equipment.inletPiping = null;
pkgB.calculation.result.dataGaps = ["inletPiping"];
pkgB.calculation.result.verdict = "INSUFFICIENT_INPUT";
delete pkgB.calculation.result.checklist.inletLossOK;
pkgB.calculation.result.stepData.inletLoss = { pressureLossAvailable: false };
const htmlB = buildPDFHtml(pkgB);
const txtB = visible(htmlB);
ok("B: 인입배관 없음 — 영문 키 inletPiping 미노출", !txtB.includes("inletPiping"), txtB.match(/.{30}inletPiping.{30}/)?.[0]);
ok("B: 한글 문구 표시 \"인입배관 정보(길이·내경·ΣK) 데이터가 없어\"", txtB.includes("인입배관 정보(길이·내경·ΣK) 데이터가 없어"));
ok("B: 보류 안내 문구 유지(sizing 영향 없음·GO 임의 취급 안 함)", txtB.includes("나머지 계산 결과에는 영향이 없습니다") && txtB.includes("적정(GO)으로 임의 취급하지 않습니다"));
ok("B: 배관 행 \"미등록\"·압력손실 \"계산 불가\" 유지", txtB.includes("미등록") && txtB.includes("계산 불가"));
ok("B: 문서 식별자(스냅샷 해시)·서명 상태는 A와 동일하게 출력", txtB.includes(pkgB.identity.snapshotHash) && txtB.includes("서명 없음"));

// C) 데이터 불변
ok("C: 패키지 dataGaps 값은 변환되지 않음", JSON.stringify(pkgB.calculation.result.dataGaps) === '["inletPiping"]');
ok("C: 모르는 키는 그대로 표시", _pdfFormatDataGaps(["foo", "inletPiping"]) === "foo, 인입배관 정보(길이·내경·ΣK)" && _pdfFormatDataGaps(null) === "");

if (outDir) {
  fs.writeFileSync(path.join(outDir, "report_with_inletPiping.html"), htmlA);
  fs.writeFileSync(path.join(outDir, "report_without_inletPiping.html"), htmlB);
}
console.log(`\nRESULT: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
