# 채팅 시스템 부하 테스트 가이드

MixChat 채팅 시스템의 성능 검증 및 부하 테스트 스위트

---

## 빠른 시작

**가장 추천하는 테스트** (AI 없이 안전하게 시작):

```bash
cd /c/Users/freetime/Desktop/project3/load-tests

# 1. Direct & Group 채팅 테스트 (8분, Ollama 불필요)
k6 run chat-direct-group-load-test.js \
  --env BASE_URL=http://localhost:8080 \
  --env TEST_DURATION=medium
```

---

## 테스트 파일 가이드

### 권장 테스트 (고급 기능)

| 파일명 | 용도 | 소요시간 | Ollama<br>필요 | 권장 순서 |
|--------|------|---------|---------------|---------|
| **`chat-direct-group-load-test.js`** | Direct/Group 채팅 전용 | 3-12분 | ❌ | **1순위** ⭐ |
| **`chat-comprehensive-with-ai-load-test.js`** | AI 3가지 기능 완벽 테스트 | 3-12분 | ✅ | 3순위 |
| `chat-concurrency-test.js` | 동시성/Lock 검증 | 2-3분 | ❌ | 2순위 |
| `chat-ai-stress-test.js` | AI 채팅방만 집중 테스트 | 3-9분 | ✅ | 디버깅용 |

**AI 기능 3가지**:
1. 자동 번역 (모든 채팅방, Ollama→OpenAI fallback)
2. AI 피드백/학습노트 (모든 채팅방, OpenAI 전용)
3. AI 채팅방 (Ollama)

### 레거시 테스트 (참고용)

| 파일명 | 용도 | 비고 |
|--------|------|------|
| `chat-api-test-quick.js` | 5분 빠른 테스트 | 기본 기능만 |
| `chat-api-test.js` | 기본 REST API 테스트 | 단순 |
| `stress-test.js` | 스트레스 테스트 | 구버전 |

> **권장**: 새로운 고급 테스트 사용 (위 표 참고)

---

## 추천 실행 시나리오

### 시나리오 A: 일상 테스트 (AI 없이) - 권장

**언제**: 매일, 팀원 허락 불필요
**소요시간**: 8분

```bash
# Direct & Group 채팅 성능 검증
k6 run chat-direct-group-load-test.js \
  --env BASE_URL=http://localhost:8080 \
  --env TEST_DURATION=medium

# 동시성 검증 (시퀀스 중복 체크)
k6 run chat-concurrency-test.js \
  --env BASE_URL=http://localhost:8080 \
  --env TEST_MODE=single
```

**검증 항목**:
- Direct/Group 채팅 성능
- 메시지 송수신 (300명까지)
- 시퀀스 무결성 (중복 0개)

---

### 시나리오 B: 완전 테스트 (AI 포함)

**언제**: 주간, 배포 전, **팀원 Ollama 서버 허락 필요**
**소요시간**: 12분

```bash
# AI 3가지 기능 완벽 검증
k6 run chat-comprehensive-with-ai-load-test.js \
  --env BASE_URL=http://localhost:8080 \
  --env TEST_DURATION=full
```

**검증 항목**:
- Direct/Group/AI 모든 채팅
- 자동 번역 (Ollama→OpenAI fallback)
- AI 피드백 (OpenAI 전용)
- AI 채팅방 (Ollama)
- 500명 동시 접속

---

### 시나리오 C: 문제 진단 (디버깅)

**언제**: 성능 문제 발생 시

```bash
# AI만 집중 테스트 (Ollama 병목 확인)
k6 run chat-ai-stress-test.js \
  --env BASE_URL=http://localhost:8080 \
  --env TEST_DURATION=light

# 동시성 문제 확인 (Lock 검증)
k6 run chat-concurrency-test.js \
  --env BASE_URL=http://localhost:8080 \
  --env TEST_MODE=spike
```

**분석 포인트**:
- AI 응답 시간 >10초 → Ollama 병목
- 시퀀스 중복 >0 → Lock 미작동
- 타임아웃율 >10% → DB 커넥션 풀 부족

---

## 사전 준비

### 1. k6 설치

```bash
# Windows
choco install k6

# macOS
brew install k6

# Linux
sudo apt-get update && sudo apt-get install k6

# 확인
k6 version
```

### 2. 백엔드 서버 실행

```bash
# 필수 서비스
docker-compose up -d mysql mongodb redis

# AI 테스트 시 추가 필요
docker-compose up -d ollama

# 백엔드 애플리케이션
cd C:\Users\freetime\Desktop\project3\AIBE3_final_project_team3_BE
./gradlew bootRun

# 헬스 체크
curl http://localhost:8080/actuator/health
```

### 3. 테스트 데이터 생성

<details>
<summary><b>테스트 유저 100명 생성 (SQL)</b></summary>

```sql
-- MySQL 접속
mysql -u root -p mixchat_db

-- 테스트 유저 생성
INSERT INTO member (email, password, nickname, english_level, created_at, modified_at)
SELECT
  CONCAT('test', n, '@test.com'),
  '$2a$10$dXJ3SW6G7P1eXVhd7VKRluCMaS.96EvPPT.aGcWELdPLBVhJDVZTi',
  CONCAT('TestUser', n),
  'INTERMEDIATE',
  NOW(),
  NOW()
FROM (
  SELECT @row := @row + 1 AS n
  FROM (SELECT 0 UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3) t1,
       (SELECT 0 UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3) t2,
       (SELECT 0 UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3) t3,
       (SELECT 0 UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3) t4,
       (SELECT @row := 0) t5
  LIMIT 100
) numbers;
```

</details>

<details>
<summary><b>AI 페르소나 5개 생성 (SQL) - AI 테스트 시 필요</b></summary>

```sql
INSERT INTO user_prompt (member_id, persona_name, persona_description, role_play_type, created_at, modified_at)
VALUES
  (1, 'Friendly Teacher', 'A warm and encouraging English teacher', 'TEACHER', NOW(), NOW()),
  (1, 'Native Speaker', 'A casual native English speaker', 'FRIEND', NOW(), NOW()),
  (1, 'Business Coach', 'Professional business English coach', 'BUSINESS', NOW(), NOW()),
  (1, 'Travel Guide', 'Helpful travel companion', 'FRIEND', NOW(), NOW()),
  (1, 'Tech Mentor', 'Programming and tech mentor', 'TEACHER', NOW(), NOW());
```

</details>

---

## 각 테스트별 상세 가이드

### 1. Direct & Group 전용 테스트 (추천)

**파일**: `chat-direct-group-load-test.js`

**용도**: AI 기능 제외, Direct/Group 채팅만 집중 테스트

**실행**:
```bash
# Short (3분): 빠른 검증
k6 run chat-direct-group-load-test.js --env TEST_DURATION=short

# Medium (8분): 표준 테스트
k6 run chat-direct-group-load-test.js --env TEST_DURATION=medium

# Full (12분): 최대 800명 동시 접속
k6 run chat-direct-group-load-test.js --env TEST_DURATION=full
```

**테스트 내용**:
- Direct 채팅 (1:1)
- Group 채팅 (5명~100명 다양한 크기)
- 메시지 송수신 (읽기 70%, 쓰기 30%)
- 방 관리 (생성, 참가, 초대, 강퇴)

**장점**:
- Ollama 불필요
- 팀원 허락 필요 없음
- AI 없어서 높은 부하 가능 (최대 800명)

---

### 2. AI 완전 종합 테스트

**파일**: `chat-comprehensive-with-ai-load-test.js`

**용도**: AI 3가지 기능 + Direct/Group 모두 테스트

**실행**:
```bash
k6 run chat-comprehensive-with-ai-load-test.js \
  --env BASE_URL=http://localhost:8080 \
  --env TEST_DURATION=full \
  --env AI_TIMEOUT=30000
```

**테스트 내용**:
- 자동 번역 (40% 사용자)
- AI 피드백 (30% 사용자, OpenAI 전용)
- AI 채팅방 (15% 사용자)
- Direct/Group 일반 채팅 (나머지)

**주의**:
- **팀원 Ollama 서버 허락 필요**
- Ollama 서버 모니터링 권장

---

### 3. 동시성 테스트

**파일**: `chat-concurrency-test.js`

**용도**: Pessimistic Lock 및 시퀀스 무결성 검증

**실행**:
```bash
# Single: 1개 방에 집중 공격
k6 run chat-concurrency-test.js --env TEST_MODE=single

# Multi: 10개 방에 분산
k6 run chat-concurrency-test.js --env TEST_MODE=multi

# Spike: 순간 500명 동시 전송
k6 run chat-concurrency-test.js --env TEST_MODE=spike
```

**필수 확인**:
- `sequence_duplicates = 0` (1개라도 있으면 심각)
- Lock 대기 시간 분포
- DB 커넥션 풀 상태

---

### 4. AI 집중 스트레스 테스트

**파일**: `chat-ai-stress-test.js`

**용도**: Ollama 성능 한계 측정

**실행**:
```bash
# Light (3분): GPU 없는 환경
k6 run chat-ai-stress-test.js --env TEST_DURATION=light

# Medium (6분): GPU 있는 환경
k6 run chat-ai-stress-test.js --env TEST_DURATION=medium

# Full (9분): 극한 테스트
k6 run chat-ai-stress-test.js --env TEST_DURATION=full
```

**분석 포인트**:
- AI 응답 시간 P95
- 타임아웃 발생률
- Ollama CPU/GPU 사용률

---

## 결과 분석

### 합격 기준

| 메트릭 | 목표 | 측정 |
|--------|------|------|
| HTTP 성공률 | >99% | `http_req_failed` |
| 평균 응답 시간 | <1초 | `http_req_duration avg` |
| P95 응답 시간 | <2초 | `http_req_duration p(95)` |
| 메시지 성공률 | >99% | `message_success_rate` |
| 시퀀스 중복 | 0개 | `sequence_duplicates` |
| AI 응답 P95 | <10초 | `ai_response_latency p(95)` |

### 주요 메트릭 해석

```
✓ checks........................: 99.50%
  http_req_duration..............: avg=450ms  p(95)=1200ms
  http_req_failed................: 0.50%
  message_success_rate...........: 99.50%
  sequence_duplicates............: 0
```

**판정**: ✅ 합격 (모든 임계값 통과)

### AI 테스트 결과 해석

**정상 (Ollama GPU 있음)**:
```
ai_response_latency: avg=3500ms  p(95)=8000ms
ai_success_rate: 98.5%
ai_timeout_rate: 0.5%
```
판정: ✅ 양호

**병목 (Ollama GPU 없음)**:
```
ai_response_latency: avg=15000ms  p(95)=28000ms
ai_success_rate: 85%
ai_timeout_rate: 12%
```
판정: ❌ Ollama 병목 심각 → GPU 추가 또는 OpenAI 전환

### 동시성 테스트 결과

**정상**:
```
sequence_duplicates: 0
concurrent_send_latency: avg=800ms  p(95)=2500ms
```
판정: ✅ Pessimistic Lock 정상 작동

**문제**:
```
sequence_duplicates: 5
concurrency_timeout_rate: 10%
```
판정: ❌ Lock 미작동 또는 DB 커넥션 풀 고갈

---

## 문제 해결

### 로그인 실패

```sql
-- 테스트 유저 확인
SELECT email FROM member WHERE email LIKE 'test%';

-- 비밀번호 초기화 (test1234)
UPDATE member
SET password = '$2a$10$dXJ3SW6G7P1eXVhd7VKRluCMaS.96EvPPT.aGcWELdPLBVhJDVZTi'
WHERE email LIKE 'test%';
```

### AI 채팅방 생성 실패

```sql
-- AI 페르소나 확인
SELECT id, persona_name FROM user_prompt;

-- 없으면 위 "사전 준비" 섹션 SQL 실행
```

### 시퀀스 중복 발생

```sql
-- Transaction Isolation Level 확인
SELECT @@GLOBAL.tx_isolation;

-- REPEATABLE-READ로 설정
SET GLOBAL tx_isolation = 'REPEATABLE-READ';
```

```java
// Repository에 @Lock 확인
@Lock(LockModeType.PESSIMISTIC_WRITE)
Optional<GroupChatRoom> findByIdWithLock(@Param("id") Long id);
```

### DB 커넥션 풀 고갈

로그: `HikariPool-1 - Connection is not available`

```yaml
# application.yml
spring:
  datasource:
    hikari:
      maximum-pool-size: 50  # 10에서 증가
      connection-timeout: 30000
```

---

## 테스트 비교표

언제 어떤 테스트를 사용할지 한눈에 파악:

| 상황 | 추천 테스트 | 이유 |
|------|-----------|------|
| 매일 성능 체크 | `chat-direct-group-load-test.js` | Ollama 불필요, 빠름 |
| 배포 전 검증 | `chat-comprehensive-with-ai-load-test.js` | 전체 기능 포함 |
| AI 느림 | `chat-ai-stress-test.js` | Ollama 병목 진단 |
| 메시지 순서 꼬임 | `chat-concurrency-test.js` | Lock 검증 |
| CI/CD | `chat-direct-group-load-test.js` (short) | 3분 빠른 검증 |

---

## 환경 변수 옵션

| 변수 | 설명 | 기본값 | 예시 |
|------|------|--------|------|
| `BASE_URL` | 백엔드 주소 | `http://localhost:8080` | - |
| `TEST_DURATION` | 테스트 길이 | `full` | `short`, `medium`, `full` |
| `TEST_MODE` | 동시성 모드 | `single` | `single`, `multi`, `spike` |
| `AI_TIMEOUT` | AI 타임아웃 (ms) | `30000` | `60000` (느린 환경) |
| `OLLAMA_AVAILABLE` | Ollama 사용 | `true` | `false` (없으면) |
| `OPENAI_AVAILABLE` | OpenAI 사용 | `true` | `false` (없으면) |

---

## 성능 벤치마크 목표

### 최소 요구사항

- HTTP 성공률: >99%
- 평균 응답 시간: <1초
- P95 응답 시간: <2초
- 동시 접속자: 300명
- 시퀀스 중복: 0개

### 권장 목표

- HTTP 성공률: >99.5%
- 평균 응답 시간: <500ms
- P95 응답 시간: <1초
- 동시 접속자: 500명
- AI 응답 P95: <8초 (GPU 있을 때)

---

## 추가 리소스

### 문서
- `PERFORMANCE-TEST-GUIDE.md` - 상세 분석 방법
- `EXECUTION-GUIDE.md` - 단계별 실행 가이드
- `K6-PROMETHEUS-INTEGRATION.md` - Grafana 연동

### 도구
- [k6 공식 문서](https://k6.io/docs/)
- [Grafana k6 대시보드](https://grafana.com/grafana/dashboards/)

### 모니터링

```bash
# k6 결과를 JSON으로 저장
k6 run [테스트파일] --out json=results/result.json

# Grafana Cloud로 실시간 모니터링
k6 login cloud
k6 run [테스트파일] --out cloud
```

---

## 문의 및 지원

문제 발생 시:
1. 위 "문제 해결" 섹션 확인
2. 백엔드 애플리케이션 로그 확인
3. k6 출력에서 실패한 엔드포인트 특정
4. 팀에 상세 정보 공유

**좋은 버그 리포트 예시**:
```
테스트: chat-direct-group-load-test.js (medium)
현상: message_success_rate 95% (목표 99%)
에러: http_req_duration p(95) = 3500ms (목표 2000ms)
로그: [백엔드 에러 로그 첨부]
```
