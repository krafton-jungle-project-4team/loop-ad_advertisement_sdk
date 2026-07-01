# loop-ad_advertisement_sdk

Loop Ad Advertisement SDK는 고객사 웹사이트 또는 데모 쇼핑몰 프론트엔드에서
Loop Ad Dashboard API에 광고 decision을 요청하고, 받은 광고 소재를 지정한 DOM
영역에 렌더링하는 브라우저 SDK입니다.

SDK는 광고 노출과 클릭을 직접 전송하지 않습니다. `onImpression`, `onClick`
callback으로 tracking 값을 넘기며, host application이 필요할 때
`loop-ad_event_sdk`로 `ad_impression`, `ad_click` 이벤트를 보냅니다.

## 역할 경계

- 광고 decision 요청과 최소 DOM 렌더링만 담당합니다.
- CSS, 레이아웃, fallback UI는 host application이 담당합니다.
- `userId`는 host application이 준비해서 `init()`에 넘깁니다.
- `loop-ad_event_sdk`를 import하지 않습니다. 두 SDK 연결은 callback에서 처리합니다.

## 사용 방식

SDK는 두 가지 방식으로 붙일 수 있습니다.

- npm package: TypeScript 앱 번들러에서 `import { init } ...` 형태로 사용합니다.
- script tag: 빌드된 IIFE bundle을 `<script src="...">`로 직접 불러옵니다.

script tag 방식은 Shopify 앱, CMS, 정적 HTML, 외부 고객사 페이지처럼 npm build
pipeline에 SDK를 직접 넣기 어려운 경우를 위한 경로입니다.

## 설치와 배포

이 패키지는 GitHub Packages npm registry에
`@krafton-jungle-project-4team/loop-ad_advertisement_sdk` 이름으로 배포합니다. PR이
`main`에 merge되면 GitHub Actions가 KST 날짜와 workflow run number를 조합해
`0.1.YYYYMMDD-run.N.A` 형식의 버전을 만들고 publish합니다.

같은 workflow가 browser IIFE bundle도 GitHub Pages로 배포합니다. public repo에서
Pages 배포가 한 번 성공하면 아래 URL을 script tag에서 바로 사용할 수 있습니다.

```text
https://krafton-jungle-project-4team.github.io/loop-ad_advertisement_sdk/loop-ad-advertisement-sdk.iife.js
```

설치하는 프로젝트의 `.npmrc`에 GitHub Packages registry를 추가합니다.

```text
@krafton-jungle-project-4team:registry=https://npm.pkg.github.com
```

그 다음 패키지를 설치합니다.

```bash
npm install @krafton-jungle-project-4team/loop-ad_advertisement_sdk
```

로컬 또는 데모에서 browser bundle을 직접 만들 때는 아래 명령을 사용합니다.

```bash
npm install
npm run build
```

생성되는 주요 산출물:

```text
dist/index.mjs
dist/index.cjs
dist/loop-ad-advertisement-sdk.iife.js
dist/types/index.d.ts
```

`dist/`는 빌드 산출물이므로 git에는 커밋하지 않습니다.

## 권장 사용

앱의 auth/session layer에서 `userId`가 준비된 뒤 SDK를 시작합니다.

```ts
import {
  init,
  type AdvertisementFilledDecision
} from "@krafton-jungle-project-4team/loop-ad_advertisement_sdk";

function trackAdImpression(decision: AdvertisementFilledDecision): void {
  eventSdk.track("ad_impression", decision.tracking);
}

function trackAdClick(decision: AdvertisementFilledDecision): void {
  eventSdk.track("ad_click", decision.tracking);
}

const ads = init({
  apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
  projectId: "demo-shoppingmall",
  userId: user.id
});

const decision = await ads.render({
  placementKey: "C1_MAIN_TOP",
  targetId: "loopad-main-banner",
  context: {
    channel: "demo",
    device: "mobile"
  },
  onImpression: trackAdImpression,
  onClick: trackAdClick
});

if (decision.status === "empty") {
  // 광고가 없을 때 fallback UI는 host application에서 처리합니다.
}
```

`render()`는 `POST {apiBaseUrl}/ads/serve`로 광고를 요청하고 Dashboard API의
`{ requestId, data }` envelope에서 `data`를 unwrap해 반환합니다. 같은 target에
다시 호출하면 기존 광고 DOM과 impression observer를 정리한 뒤 새 광고를
렌더링합니다.

### Client methods

| method | 설명 |
|---|---|
| `render(options)` | 광고 decision을 요청하고 `targetId` element 안에 광고 DOM을 렌더링합니다. |
| `destroy()` | 등록된 impression observer를 정리합니다. 테스트, hot reload, microfrontend unmount에서 사용합니다. |

### Init options

| option | 필수 | 기본값 | 설명 |
|---|---:|---|---|
| `apiBaseUrl` | yes | 없음 | Dashboard API base URL. SDK는 여기에 `/ads/serve`를 붙여 요청합니다. |
| `projectId` | yes | 없음 | 광고 요청을 보낸 서비스 식별자 |
| `userId` | yes | 없음 | host application이 관리하는 사용자 식별자 |
| `debug` | no | `false` | SDK 내부 디버그 옵션. 현재 렌더링 계약에는 영향이 없습니다. |

### Render options

| option | 필수 | 기본값 | 설명 |
|---|---:|---|---|
| `placementKey` | yes | 없음 | Dashboard에서 정의한 광고 지면 key |
| `targetId` | yes | 없음 | 광고 DOM을 넣을 element id |
| `context` | no | `{}` | 광고 decision에 참고할 page, device, channel 등 flat context |
| `onImpression` | no | `null` | 광고가 50% 이상 보이면 1회 호출되는 callback |
| `onClick` | no | `null` | 광고 클릭 시 landing URL 이동 전에 호출되는 callback |

`context`에는 string, number, boolean, null 값만 남깁니다. SDK는 기본으로 현재
`pageUrl`과 감지한 `device`를 함께 보냅니다.

## script tag 사용

GitHub Pages로 배포된 IIFE bundle을 직접 불러올 수 있습니다.

```html
<div id="loopad-main-banner"></div>

<script src="https://krafton-jungle-project-4team.github.io/loop-ad_advertisement_sdk/loop-ad-advertisement-sdk.iife.js"></script>
<script>
  const ads = LoopAdAdvertisementSDK.init({
    apiBaseUrl: "https://dashboard.api.dev.loop-ad.org/api",
    projectId: "demo-shoppingmall",
    userId: "user-123"
  });

  ads.render({
    placementKey: "C1_MAIN_TOP",
    targetId: "loopad-main-banner"
  });
</script>
```

운영에서 자체 CDN, S3/CloudFront, 정적 파일 서버를 쓰고 싶으면
`dist/loop-ad-advertisement-sdk.iife.js`를 같은 방식으로 올려서 사용합니다. 로컬
예시는 [examples/basic.html](examples/basic.html)을 참고합니다.

## 렌더링 계약

- `status`가 `empty`이면 target element를 비우고 callback을 호출하지 않습니다.
- `status`가 `filled`이면 `a`, `img`, `strong`, `span`만 만들어 target에 넣습니다.
- SDK는 `innerHTML`을 사용하지 않고, 텍스트는 `textContent`로 넣습니다.
- CSS class는 `loopad-ad-` prefix를 사용합니다.
- tracking 값은 callback으로 넘기고 root anchor에 `data-loopad-*` attribute로도
  붙입니다.
- `onImpression(decision)`은 광고가 50% 이상 보이면 1회 호출됩니다.
- 클릭 시 `onClick(decision)`을 먼저 호출하고, `landingUrl`이 있으면
  `window.location.assign(landingUrl)`로 이동합니다.

## 개발과 검증

```bash
npm install
npm run verify
```
