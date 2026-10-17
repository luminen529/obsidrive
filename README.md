# ObsiDrive

Obsidian 볼트를 **본인 Google Drive의 숨김 앱 폴더**로 동기화하는 플러그인입니다.
노트뿐 아니라 **Obsidian 설정, 테마, CSS 스니펫, 커뮤니티 플러그인(코드+설정)** 까지 여러 기기에서 똑같이 맞춥니다.

- 🙈 **Drive에 보이지 않음**: Google Drive의 `appDataFolder`에 저장해서 Drive 웹이나 앱의 "내 드라이브"에 폴더나 파일이 나타나지 않습니다.
- 🔒 **최소 권한**: `drive.appdata` 권한 하나만 요청합니다. Drive의 다른 파일은 읽거나 쓸 수 없습니다.
- 🖥️📱 **데스크톱과 모바일 지원**: Obsidian 1.13.2 이상
- 🚫 **중간 서버 없음**: 본인이 만든 Google Cloud OAuth 클라이언트로 Google API와 직접 통신합니다. 인증 정보는 OS 키체인(Obsidian Secret Storage)에 저장합니다.

홈페이지: <https://luminen529.github.io/obsidrive/> · 개인정보처리방침: <https://luminen529.github.io/obsidrive/privacy.html>

---

## 주요 기능

### 3-way 동기화
각 기기는 "마지막 동기화 직후 상태"(기준 상태)를 기억합니다. 동기화할 때 **로컬 / 원격 / 기준** 셋을 비교해서 어느 쪽이 바뀌었는지 판단합니다.

| 로컬 | 원격 | 결과 |
|---|---|---|
| 변경 | 그대로 | 업로드 |
| 그대로 | 변경 | 다운로드 |
| 변경 | 변경 (내용 다름) | **충돌 처리** |
| 삭제 | 그대로 | 원격 삭제(보관) |
| 그대로 | 삭제 | 로컬 휴지통으로 |
| 삭제 | 변경 | 다운로드 (**수정이 삭제를 이김**) |
| 변경 | 삭제 | 업로드 (**수정이 삭제를 이김**) |

변경 여부는 수정 시각과 크기로 먼저 거르고, 의심되면 **SHA-256 해시로 내용을 비교**합니다. 파일을 열기만 해서 시각만 바뀐 경우에는 전송하지 않습니다.

### 충돌 방지와 안전장치
- **충돌 시 둘 다 보관**(기본): 내 버전은 `노트 (conflict 2026-10-17 190233 Windows).md`로 옮기고 원격 버전을 원래 이름에 둡니다. 설정에서 "최근 수정본 / 항상 로컬 / 항상 원격"으로 바꿀 수 있습니다.
- **설정 폴더 파일**은 충돌 사본이 의미가 없어서 기본으로 더 최근 수정본을 씁니다. 단, 기기가 처음 동기화할 때는 **원격 설정을 우선**하고, 플러그인 활성화 목록은 **합칩니다**. 새로 만든 보관함의 기본 설정이 기존 설정을 덮어쓰지 않습니다.
- **첫 동기화는 수동**: 원격 볼트마다 첫 동기화는 `지금 동기화`로 직접 시작해야 하고, 그 전에는 자동 동기화가 돌지 않습니다.
- **기준 상태가 없으면 절대 삭제하지 않음**: 상태 파일이 깨지거나 원격 볼트를 바꿔도 삭제는 일어나지 않습니다.
- **대량 삭제 보호**: 한 번에 많은 파일이 지워질 예정이면 확인을 받고, 자동 동기화는 멈춥니다.
- **원격 휴지통**: 원격에서 삭제된 파일은 30일(설정 가능) 동안 보관되어 복원할 수 있습니다. 로컬 삭제는 Obsidian의 휴지통 설정을 따릅니다.
- **동기화 도중 편집 보호**: 덮어쓰거나 지우기 직전에 다시 확인해서, 그 사이에 편집한 파일은 다음 동기화로 넘깁니다.
- **원격 동시성 검사와 무결성 검사**: 업로드 직전에 원격이 바뀌지 않았는지 확인하고, 다운로드한 내용은 해시로 검증한 뒤에만 씁니다.
- **원격 중복 정리, 대소문자 충돌 보호, 이름 변경 감지**(큰 첨부파일을 옮겨도 다시 전송하지 않음), **지수 백오프 재시도**

### 동기화 대상

| 항목 | 경로 | 기본값 |
|---|---|---|
| 노트·첨부파일 | 볼트 전체 (점으로 시작하는 폴더 제외) | 켬 |
| Obsidian 설정 | `.obsidian/*.json` | 켬 |
| 테마 | `.obsidian/themes/*/` | 켬 |
| CSS 스니펫 | `.obsidian/snippets/*.css` | 켬 |
| 커뮤니티 플러그인 | `.obsidian/plugins/*/{main.js,manifest.json,styles.css}` + `community-plugins.json` | 켬 |
| 플러그인 설정 | `.obsidian/plugins/*/data.json` | 켬 |
| 워크스페이스 | `workspace.json`, `workspace-mobile.json` | 끔 |

ObsiDrive 자신의 폴더(설정, 동기화 상태)는 동기화하지 않습니다. 제외 패턴(glob 또는 `/정규식/`)과 최대 파일 크기도 설정할 수 있습니다.

### 자동 동기화
Obsidian 시작 시, 주기적으로(기본 5분), 편집이 멈춘 뒤(기본 30초), 앱으로 돌아왔을 때, 네트워크가 복구됐을 때 동기화합니다. 다른 기기에서 설정이나 플러그인이 바뀌어 내려오면 **다시 로드** 버튼이 있는 알림을 띄웁니다.

## 명령어

| 명령 | 설명 |
|---|---|
| ObsiDrive: 지금 동기화 | 리본 아이콘(↻)으로도 실행 |
| ObsiDrive: 동기화 미리보기 | 아무것도 바꾸지 않고 예정된 작업만 보여줌 |
| ObsiDrive: 동기화 로그 보기 | 데스크톱에서는 상태 표시줄을 클릭해도 열림 |
| ObsiDrive: 원격 휴지통에서 복원 | 삭제 보관본에서 파일 되살리기 |
| ObsiDrive: 자동 동기화 일시정지/재개 | |
| ObsiDrive: 진행 중인 동기화 취소 | |

## 설치

### BRAT으로 설치 (권장, 모바일 포함)

1. 커뮤니티 플러그인에서 **BRAT**(Obsidian42 - BRAT)를 설치하고 켭니다.
2. BRAT 설정에서 **Add beta plugin**을 누르고 `luminen529/obsidrive`를 입력합니다.
3. 커뮤니티 플러그인 목록에서 **ObsiDrive**를 켭니다.

새 버전은 [Releases](https://github.com/luminen529/obsidrive/releases)에 올라가고, BRAT이 자동으로 업데이트합니다.

### 직접 빌드

1. 빌드합니다.
   ```bash
   npm install
   ```
   ```bash
   npm run build
   ```
2. `main.js`, `manifest.json`, `styles.css`를 볼트의 `.obsidian/plugins/obsidrive/` 폴더에 복사하고, 커뮤니티 플러그인에서 켭니다.

### Google Drive 연결

Google Cloud에서 Google Drive API를 켜고 **데스크톱 앱** 유형의 OAuth 클라이언트를 만든 뒤, 플러그인 설정에 Client ID와 Client Secret을 넣고 로그인합니다.
모바일에서는 브라우저에서 허용한 뒤 주소창의 리디렉션 URL을 복사해 붙여넣는 방식으로 로그인합니다.

## 참고

- 숨김 폴더도 Drive 저장 용량에 포함됩니다.
- 빈 폴더 자체는 동기화하지 않습니다.
- 파일 내용을 암호화하지는 않습니다. 숨김 폴더에는 이 OAuth 클라이언트만 접근할 수 있습니다.
- [remotely-save](https://github.com/remotely-save/remotely-save)를 참고해 설계했지만 코드는 새로 작성했습니다.

## 개발

```bash
npm run dev
```

```bash
npm test
```

| 파일 | 역할 |
|---|---|
| `src/sync/planner.ts` | 순수 3-way 계획 함수 (I/O 없음) |
| `src/sync/engine.ts` | 실행과 안전장치 (LocalFs / RemoteStore / StateStore 인터페이스) |
| `src/drive.ts` | Drive v3 클라이언트 (appDataFolder, multipart/resumable 업로드, 재시도) |
| `src/auth.ts` | OAuth PKCE (데스크톱 루프백 / 수동 붙여넣기) |
| `src/obsidianFs.ts` | Obsidian Vault/Adapter 연동 |
| `src/filter.ts` | 동기화 대상 판정 |
| `tests/` | 가짜 Drive·파일시스템으로 두 기기 시나리오 테스트 |
