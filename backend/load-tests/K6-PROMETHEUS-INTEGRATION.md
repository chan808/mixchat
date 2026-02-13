# K6 → Prometheus 연동 가이드 (선택사항)

## 현재 상태

- ✅ K6 테스트 독립 실행 (콘솔 출력)
- ✅ Spring Boot → Prometheus → Grafana (서버 메트릭)
- ❌ K6 메트릭 → Prometheus (미연동)

## 연동이 필요한가?

### 연동 안 해도 되는 경우 (현재로 충분)
- Before/After 성능 비교만 하면 됨
- K6 콘솔 + Grafana 스크린샷으로 충분
- 블로그 작성 목적

### 연동이 필요한 경우
- K6와 서버 메트릭을 하나의 Grafana 대시보드에서 동시 확인
- K6 VU 수와 서버 CPU 사용률 상관관계 분석
- 더 프로페셔널한 모니터링 환경

---

## 방법 1: Prometheus Remote Write (복잡)

### 1-1. xk6로 K6 빌드

```bash
# xk6 설치 (Go 필요)
go install go.k6.io/xk6/cmd/xk6@latest

# Prometheus Remote Write 플러그인 포함 빌드
xk6 build --with github.com/grafana/xk6-output-prometheus-remote
```

### 1-2. K6 실행 시 Prometheus로 전송

```bash
./k6 run --out experimental-prometheus-rw \
  -e K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
  chat-api-test.js
```

**단점:**
- Go 설치 필요
- K6 커스텀 빌드 필요
- 설정 복잡

---

## 방법 2: JSON 결과 + 수동 분석 (현재 방식, 권장)

```bash
# K6 결과를 JSON으로 저장
k6 run --out json=results/before-test.json chat-api-test.js

# 요약 리포트
k6 run --summary-export=results/before-summary.json chat-api-test.js
```

**장점:**
- ✅ 간단함
- ✅ 추가 도구 불필요
- ✅ 결과 파일로 영구 보존
- ✅ 엑셀/스프레드시트로 분석 가능

**Grafana에서:**
- Spring Boot 메트릭 스크린샷 캡처
- K6 콘솔 결과 텍스트 복사
- 블로그에 함께 게시

---

## 방법 3: Grafana K6 Cloud (유료)

- https://grafana.com/products/cloud/k6/
- K6 결과를 클라우드에 자동 전송
- 아름다운 대시보드 제공
- 무료 플랜 제한적

---

## 추천

**현재 프로젝트 목적 (포트폴리오):**
- **방법 2 (JSON 결과 + Grafana 스크린샷) 권장**
- 충분히 프로페셔널함
- 블로그 작성에 적합
- 시간 대비 효과 최고

**만약 K6 연동까지 하고 싶다면:**
- 나중에 추가해도 됨
- 먼저 N+1 해결하고 Before/After 비교가 우선
