# 부하 테스트 실행 가이드

## 📋 사전 준비

### 1. 인프라 확인
```bash
# Docker 컨테이너 실행 확인
docker-compose ps

# 필수 서비스:
# - mysql (3306)
# - redis (6379)
# - mongo (27017)
# - prometheus (9090)
# - grafana (3001)
```

### 2. Spring Boot 애플리케이션 실행
```bash
cd C:\Users\freetime\Desktop\project3\AIBE3_final_project_team3_BE

# Gradle로 실행
.\gradlew bootRun

# 또는 IDE에서 실행 (권장)
```

### 3. Actuator 확인
```bash
# Health Check
curl http://localhost:8080/actuator/health

# Prometheus 메트릭 확인
curl http://localhost:8080/actuator/prometheus | head -n 20
```

### 4. 테스트 계정 생성

**중요!** `test-data/users.json`에 정의된 계정들이 DB에 존재해야 합니다.

#### 방법 1: Swagger UI로 회원가입
1. http://localhost:8080/swagger-ui/index.html 접속
2. `/api/v1/auth/join` 엔드포인트 사용
3. 다음 계정들 생성:

```json
POST /api/v1/auth/join
{
  "email": "test1@test.com",
  "password": "test1234",
  "nickname": "테스터1",
  "phoneNumber": "01012345671"
}

POST /api/v1/auth/join
{
  "email": "test2@test.com",
  "password": "test1234",
  "nickname": "테스터2",
  "phoneNumber": "01012345672"
}

POST /api/v1/auth/join
{
  "email": "test3@test.com",
  "password": "test1234",
  "nickname": "테스터3",
  "phoneNumber": "01012345673"
}

POST /api/v1/auth/join
{
  "email": "test4@test.com",
  "password": "test1234",
  "nickname": "테스터4",
  "phoneNumber": "01012345674"
}

POST /api/v1/auth/join
{
  "email": "test5@test.com",
  "password": "test1234",
  "nickname": "테스터5",
  "phoneNumber": "01012345675"
}
```

#### 방법 2: curl로 회원가입
```bash
curl -X POST http://localhost:8080/api/v1/auth/join \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test1@test.com",
    "password": "test1234",
    "nickname": "테스터1",
    "phoneNumber": "01012345671"
  }'
```

### 5. 테스트 데이터 준비

#### 그룹 채팅방 생성 (공개방)
```bash
# test1 계정으로 로그인 후 토큰 받기
TOKEN=$(curl -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test1@test.com", "password": "test1234"}' \
  | jq -r '.data.accessToken')

# 공개 그룹방 3개 생성
curl -X POST http://localhost:8080/api/v1/chats/rooms/group \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "테스트 공개방 1",
    "description": "부하 테스트용 공개 채팅방",
    "topic": "테스트",
    "password": null
  }'

curl -X POST http://localhost:8080/api/v1/chats/rooms/group \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "테스트 공개방 2",
    "description": "부하 테스트용 공개 채팅방",
    "topic": "테스트",
    "password": null
  }'

curl -X POST http://localhost:8080/api/v1/chats/rooms/group \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "테스트 공개방 3",
    "description": "부하 테스트용 공개 채팅방",
    "topic": "테스트",
    "password": null
  }'
```

### 6. K6 설치 확인
```bash
# K6 버전 확인
k6 version

# 설치 안 되어 있다면:
# Windows (Chocolatey)
choco install k6

# 또는 다운로드
# https://k6.io/docs/get-started/installation/
```

### 7. Grafana 대시보드 설정
1. http://localhost:3001 접속 (admin/admin)
2. 좌측 메뉴 > Dashboards > Import
3. Dashboard ID **11378** 입력 (JVM Micrometer)
4. Prometheus 선택 후 Import
5. Dashboard ID **4701** 입력 (Spring Boot Statistics)

---

## 🧪 Phase 1: Smoke Test (빠른 확인)

```bash
cd C:\Users\freetime\Desktop\project3\load-tests

# 5분 간단 테스트 (10명 동시 접속)
k6 run -e PROFILE=smoke chat-api-test.js
```

**확인 사항:**
- [ ] 모든 요청이 성공하는가? (http_req_failed < 1%)
- [ ] 응답 시간이 적정한가? (p95 < 500ms)
- [ ] 에러 로그가 없는가?

---

## 📊 Phase 2: 본격 부하 테스트 (Before 측정)

### 2-1. Grafana 준비
1. JVM 대시보드 열기
2. Time Range: Last 30 minutes
3. Refresh: 5s

### 2-2. 부하 테스트 실행
```bash
# REST API 부하 테스트 (50 → 100 → 200명)
k6 run chat-api-test.js
```

**측정 시간: 약 14분**

### 2-3. 관찰 포인트

**K6 콘솔에서:**
- http_req_duration (p95, p99)
- http_req_failed (에러율)
- message_latency (커스텀 메트릭)
- room_list_latency

**Grafana에서:**
- JVM Heap Memory 사용량
- GC 빈도 및 시간
- HTTP 요청 처리 시간
- DB Connection Pool 사용률

### 2-4. 결과 저장
```bash
# JSON으로 저장
k6 run --out json=results/before-load-test.json chat-api-test.js

# 요약 리포트
k6 run --summary-export=results/before-summary.json chat-api-test.js
```

---

## 🔥 Phase 3: 스트레스 테스트 (임계점 찾기)

```bash
# 점진적 부하 증가 (50 → 100 → 200 → 300 → 500 → 1000명)
k6 run stress-test.js
```

**측정 시간: 약 26분**

### 관찰 목표
- 몇 명부터 에러율이 증가하는가?
- 몇 명부터 응답 시간이 급증하는가?
- DB Connection Pool이 고갈되는가?
- JVM Heap Memory가 부족한가?

### 결과 저장
```bash
k6 run --out json=results/before-stress-test.json stress-test.js
```

---

## 📸 Before 상태 스냅샷

### Grafana 스크린샷 캡처
1. JVM 대시보드 전체 화면
2. HTTP 요청 그래프
3. DB Connection Pool 그래프
4. GC 그래프

### 메트릭 기록
- 동시 접속자 X명일 때 p95 응답시간: ___ms
- 에러 발생 시작 시점: ___명
- CPU 사용률 피크: ___%
- Heap Memory 피크: ___MB / ___MB

---

## 🐛 트러블슈팅

### 로그인 실패 (401 Unauthorized)
- 테스트 계정이 DB에 존재하는지 확인
- 비밀번호가 올바른지 확인

### Connection Refused
- Spring Boot 앱이 실행 중인지 확인
- 포트 8080이 사용 중인지 확인

### 채팅방이 없음
- 공개 그룹방을 먼저 생성했는지 확인
- 테스트 계정으로 방을 생성했는지 확인

### K6 실행 오류
- K6가 설치되어 있는지 확인
- JavaScript 파일 경로가 올바른지 확인

---

## 📝 다음 단계

1. Before 결과 정리
2. N+1 문제 해결 (Fetch Join 적용)
3. After 측정
4. Before/After 비교 분석
5. 블로그 작성
