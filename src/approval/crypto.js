//  APPROVAL CRYPTO
//  전자서명 — Web Crypto API(SubtleCrypto) 기반 SHA-256.
//  이 파일은 순수 서명/검증 계산만 담당한다.
//  누가 승인할 수 있는지, 중복 승인인지 같은 정책은 service.js/validator.js가 처리.
//
//  계약:
//    CRYPTO-001: canonicalPayload()는 필드 순서·구분자가 고정된다.
//                순서가 바뀌면 내용이 같아도 다른 서명이 나온다.
//    CRYPTO-002: signApproval() / verifySignature()는 async다.
//                Web Crypto API(subtle.digest)는 Promise 기반이라 동기화 불가.
//    CRYPTO-003: 서명 대상은 snapshotHash + decision + comment + signer +
//                timestamp + workflowState 전부. comment도 서명 대상이다 —
//                승인/반려 사유는 의견이 아니라 판단 근거이며 PSM 감사에서
//                증거로 취급된다.
// ════════════════════════════════════════════════════════════════

// ── canonicalPayload ───────────────────────────────────────────
// 서명 생성과 검증 양쪽에서 반드시 이 함수만 사용해야 한다.
// NUL(\u0000) 구분자 사용 — 필드 값 안에 나타날 가능성이 사실상 없어
// "ab"+"c" 와 "a"+"bc" 같은 concatenation ambiguity를 막는다.
function canonicalPayload(record) {
  return [
    record.snapshotHash  || "",
    record.decision      || "",
    record.comment       || "",
    record.signer        || "",
    record.timestamp     || "",
    record.workflowState || "",
  ].join("\u0000");
}

// ── sha256Hex ──────────────────────────────────────────────────
async function sha256Hex(message) {
  const data   = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── signApproval ───────────────────────────────────────────────
// record: { snapshotHash, decision, comment, signer, timestamp, workflowState }
// 반환: signature (hex string, 64자)
async function signApproval(record) {
  return sha256Hex(canonicalPayload(record));
}

// ── verifySignature ────────────────────────────────────────────
// record.signature가 나머지 필드로부터 재계산한 값과 일치하는지 확인.
// 필드 하나라도 서명 이후 바뀌면 불일치 — 즉 위변조 탐지.
async function verifySignature(record) {
  if (!record || !record.signature) {
    return { valid: false, reason: "CRYPTO-002: signature missing" };
  }
  const recomputed = await signApproval(record);
  if (recomputed !== record.signature) {
    return {
      valid: false,
      reason: "CRYPTO-003: signature mismatch — record fields altered after signing",
      expected:   record.signature,
      recomputed,
    };
  }
  return { valid: true };
}
