# GitHub 커밋 인수인계 — ArcSafe

## 상태
- 로컬 git 저장소 준비 완료 (커밋 1개, `.git` 포함)
- 커밋 해시: 8467fda
- 커밋 메시지 요약: ArcSafe v0.2.0 — Approval 전자서명, Equipment/DischargeSystem MOC parity,
  Audit Evidence View, ReportPackage + PDF renderer, 승인 서명 대상 hash 순서 버그 수정,
  Backpressure Basis 필드 누락 수정
- BUILD_HASH: 1c10244f5702 | 377/377 contract tests PASS

## 첨부 파일
- `ArcSafe-git-ready.zip` — `.git` 히스토리 포함 전체 저장소 (이 zip을 그대로 풀면 커밋된 상태)

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
- [ ] 대상 레포 owner/repo 이름
- [ ] 브랜치 (main/master 등 기존 컨벤션)
- [ ] PR로 올릴지, 바로 push할지
