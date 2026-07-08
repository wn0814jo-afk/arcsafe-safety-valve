# GitHub 커밋 인수인계 — ArcSafe

## ⚠ 확인된 사실 (이 세션에서 직접 테스트함)
이 채팅 샌드박스(bash 도구)는 **네트워크 egress가 allowlist 방식으로 제한**돼 있고
`api.github.com`이 그 목록에 없다. 실제로 `curl`로 확인한 응답:
```
Host not in allowlist: api.github.com. Add this host to your network egress settings to allow access.
```
→ 토큰이 있어도 이 환경에서는 GitHub Contents API(curl PUT 방식 포함) 자체가 불가능하다.
→ **다음 창도 이 채팅 인터페이스(bash 샌드박스)라면 똑같이 막혀 있을 가능성이 높다.**
→ 되는 경로는: (1) 이 host가 egress 허용목록에 추가된 프로젝트/설정에서 시도, (2) **Claude Code**
(로컬 실행이라 이 제약이 없음), (3) 사용자가 로컬 터미널에서 직접 curl/git 실행.

## 상태
- 로컬 git 저장소 준비 완료 (커밋 2개, `.git` 포함, 이 zip을 풀면 그대로 커밋된 상태)
- 최신 커밋: 20a1c13 ("docs: add GitHub handover notes for next session")
- 이전 커밋: 8467fda (실제 코드 변경 전체)
- BUILD_HASH: 1c10244f5702 | 377/377 contract tests PASS (이 zip 재빌드해서 재확인함)

## 첨부 파일
- `ArcSafe-git-ready.zip` — `.git` 히스토리 포함 전체 저장소

## 다음 창에서 해야 할 일 (GitHub 커넥터 활성화 후)
1. **레포 조회**: 대상 GitHub 레포(owner/repo)를 사용자에게 확인 — 기존 ArcSafe 레포가 있는지,
   없으면 새로 만들지 확인 필요.
2. **커밋 반영 방법 중 택1**:
   - (A) 기존 레포에 이 zip의 `src/`, `build.py`, `tests/`, `HANDOVER.md` 내용을 그대로
     덮어써서 새 커밋 생성 (커넥터의 파일 생성/수정 API로 반복 호출)
   - (B) 사용자가 로컬에서 `git remote add origin <URL> && git push`로 직접 push
     (네트워크 제약 없는 로컬 환경이 있다면 이 방법이 가장 간단함)
3. **커밋 메시지** (그대로 사용 가능):

```
ArcSafe v0.2.0: Approval crypto, Equipment/DischargeSystem MOC parity, Audit Evidence View, ReportPackage + PDF renderer

- case/history.js: append-only snapshotHistory, resolveSnapshot by hash
- approval/{crypto,service,validator}.js: SHA-256 signing, idempotency, verification
- asset/schema.js: reviseEquipment/reviseDischargeSystem (mocId required, revision+1)
- components/report/*: AssetEvidence, WorkflowEvidence, ApprovalEvidence, AuditEvidence
- report/{schema,createPackage}.js: Snapshot -> immutable ReportPackage
- report/renderer/pdf/*: buildPDFHtml, renderPDF (HTML->browser print)
- Fixed: approval now signs the post-transition snapshot hash, not the pre-transition one
- Fixed: ReportPackage/PDF now include backpressure basis (L/D/fittingsK/headerPressure)
- 377/377 contract tests passing, BUILD_HASH 1c10244f5702
```

## 확인 필요 사항 (다음 창 시작 시 바로 물어볼 것)
- [ ] **이번엔 네트워크(egress)가 열려있는 환경인지 먼저 테스트** —
      `curl -s -H "User-Agent: x" https://api.github.com/rate_limit` 결과가
      "Host not in allowlist"면 이 방법 자체가 안 됨 → Claude Code로 전환
- [ ] 대상 레포 owner/repo 이름
- [ ] 브랜치 (main/master 등 기존 컨벤션)
- [ ] PR로 올릴지, 바로 push할지
