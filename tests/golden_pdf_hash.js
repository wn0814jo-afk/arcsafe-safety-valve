// PDF-GOLDEN 해시 계산기.
// 사용: node golden_pdf_hash.js <fixture.json 경로>
// stdout: 정규화된 HTML의 SHA-256 hex (생성시간 등 메타데이터 라인은 정규화 시 제거)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SRC = path.join(__dirname, "..", "src");
const files = [
  "report/schema.js",
  "report/renderer/pdf/styles.js",
  "report/renderer/pdf/template.js",
].map(f => fs.readFileSync(path.join(SRC, f), "utf8")).join("\n");

const fixturePath = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

// eslint-disable-next-line no-eval
eval(files); // buildPDFHtml, PDF_STYLES 등을 전역으로 로드 (다른 report/*.js와 동일한 concat 모델 재현)

const html = buildPDFHtml(pkg);

// 정규화: "Generated At" 값(가변)만 제거하고 나머지 구조/내용은 그대로 비교 대상에 남김
const normalized = html.replace(/Generated At<\/span><span class="v">[^<]*<\/span>/, "Generated At</span><span class=\"v\">[NORMALIZED]</span>");

const hash = crypto.createHash("sha256").update(normalized).digest("hex");
console.log(hash);
