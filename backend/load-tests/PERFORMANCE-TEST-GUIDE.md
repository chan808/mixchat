# 부하 테스트 및 성능 모니터링 실전 가이드

## 목표
- N+1 문제 해결 전후 성능 비교
- Grafana로 실시간 메트릭 확인
- Before/After 데이터로 포트폴리오 자료 수집

---

## 전체 워크플로우

```
1. 환경 준비 (Docker + Spring Boot 실행)
   ↓
2. Grafana 대시보드 설정
   ↓
3. Before 측정 (N+1 문제 있는 상태)
   - K6 부하 테스트 실행
   - Grafana 메트릭 확인
   - 스크린샷 캡처
   ↓
4. N+1 문제 해결 (Fetch Join 적용)
   ↓
5. After 측정 (N+1 해결된 상태)
   - K6 부하 테스트 재실행
   - Grafana 메트릭 확인
   - 스크린샷 캡처
   ↓
6. 결과 비교 및 분석
```

---

## STEP 1: 환경 준비

### 1-1. Docker Compose 실행

```bash
cd C:\Users\freetime\Desktop\project3\AIBE3_final_project_team3_BE
docker compose up -d
```

**확인할 서비스:**
- MySQL (3306)
- MongoDB (27017)
- Redis (6379)
- MinIO (9000)
- Prometheus (9090)
- Grafana (3001)

### 1-2. Spring Boot 애플리케이션 실행

```bash
./gradlew bootRun
```

또는 IDE에서 실행

**확인 방법:**
```bash
curl http://localhost:8080/actuator/health
```

응답이 `{"status":"UP"}` 이면 정상

---

## STEP 2: Grafana 대시보드 설정

### 2-1. Grafana 접속

브라우저에서:
```
http://localhost:3001
```

**로그인 정보:**
- Username: `admin`
- Password: `admin`

### 2-2. Prometheus 데이터소스 확인

좌측 메뉴 → **Configuration (⚙️) → Data Sources**

- Prometheus가 이미 등록되어 있어야 함
- URL: `http://prometheus:9090`
- Status: 초록색 체크 표시

### 2-3. JVM 대시보드 Import

1. 좌측 메뉴 → **Dashboards → Import**
2. **Import via grafana.com** 입력란에 `4701` 입력
3. **Load** 클릭
4. **Prometheus** 데이터소스 선택
5. **Import** 클릭

**대시보드 이름:** "JVM (Micrometer)"

### 2-4. Spring Boot Statistics 대시보드 Import

같은 방식으로:
1. Dashboard ID `11378` 입력
2. Import

**대시보드 이름:** "Spring Boot Statistics"

### 2-5. 대시보드 설정

- **Time Range** (우측 상단): Last 15 minutes
- **Refresh** (우측 상단): 5s (자동 갱신)

---

## STEP 3: Before 성능 측정 (N+1 문제 있는 상태)

### 3-1. 현재 상태 확인

ChatMessageService.java 파일에서 N+1 문제가 있는 코드:

```java
// Line 112, 206
List<ChatMember> allMembers = chatRoomMemberRepository
        .findByChatRoomIdAndChatRoomType(roomId, chatRoomType); // ← N+1 발생
```

이 코드는 Fetch Join이 없어서, 각 ChatMember마다 Member를 별도 조회함.

### 3-2. 테스트 데이터 준비

공개 채팅방이 필요함. Swagger에서:

```
POST /api/v1/chats/rooms/group/public
{
  "groupChatRoomName": "성능 테스트 방 1",
  "isPublic": true
}
```

3~5개 정도 생성

### 3-3. Grafana 화면 준비

2개 대시보드를 브라우저 탭으로 열어둠:
1. JVM (Micrometer)
2. Spring Boot Statistics

**주요 관찰 지표:**
- **Heap Memory Used**: JVM 메모리 사용량
- **GC Time**: Garbage Collection 시간
- **HTTP Request Count**: 요청 수
- **HTTP Request Duration p95**: 응답 시간 95 percentile
- **DB Connection Pool**: 데이터베이스 연결 사용량

### 3-4. K6 부하 테스트 실행

새 터미널 열어서:

```bash
cd C:\Users\freetime\Desktop\project3\load-tests
k6 run --out json=results/before-test.json --summary-export=results/before-summary.json chat-api-test-quick.js
```

**테스트 시나리오:**
- 5분간 실행
- 50명 → 100명 → 200명 순차 증가

### 3-5. 실시간 모니터링

K6 실행 중 Grafana에서 확인할 것:

**JVM (Micrometer) 대시보드:**
- Heap Memory: 사용량이 얼마나 증가하는가?
- GC Count: GC가 얼마나 자주 발생하는가?
- Threads: 스레드 수가 안정적인가?

**Spring Boot Statistics 대시보드:**
- Requests per second: 초당 요청 처리량
- Response time p95: 95%의 요청이 몇 초 안에 처리되는가?
- Error rate: 에러 발생률

### 3-6. 로그에서 N+1 확인

Spring Boot 실행 중인 터미널에서 SQL 로그 확인:

```sql
-- 예상되는 N+1 패턴:
-- 1. 채팅방 멤버 목록 조회 (1번 쿼리)
SELECT ... FROM chat_member WHERE chat_room_id = ?

-- 2. 각 멤버마다 개별 Member 조회 (N번 쿼리) ← 문제!
SELECT ... FROM member WHERE id = ?
SELECT ... FROM member WHERE id = ?
SELECT ... FROM member WHERE id = ?
...
```

### 3-7. 결과 캡처

K6 테스트 완료 후:

1. **K6 콘솔 출력** 복사 (텍스트 파일로 저장)
2. **Grafana 스크린샷** 캡처:
   - JVM Heap Memory 그래프
   - HTTP Request Duration p95 그래프
   - GC Time 그래프
3. **SQL 로그** 복사 (N+1 패턴 보이는 부분)

파일명 예시:
- `before-k6-output.txt`
- `before-grafana-heap.png`
- `before-grafana-response-time.png`
- `before-sql-n+1.txt`

---

## STEP 4: N+1 문제 해결

### 4-1. Fetch Join 쿼리 활성화

**파일:** `ChatRoomMemberRepository.java`

**변경 전 (Line 52-53):**
```java
// @Query("SELECT cm FROM ChatMember cm JOIN FETCH cm.member m WHERE cm.chatRoomId = :chatRoomId AND cm.chatRoomType = :chatRoomType")
// List<ChatMember> findByChatRoomIdAndChatRoomTypeWithMembers(@Param("chatRoomId") Long chatRoomId, @Param("chatRoomType") ChatRoomType chatRoomType);
```

**변경 후:**
```java
@Query("SELECT cm FROM ChatMember cm JOIN FETCH cm.member m WHERE cm.chatRoomId = :chatRoomId AND cm.chatRoomType = :chatRoomType")
List<ChatMember> findByChatRoomIdAndChatRoomTypeWithMembers(@Param("chatRoomId") Long chatRoomId, @Param("chatRoomType") ChatRoomType chatRoomType);
```

### 4-2. Service 코드 수정

**파일:** `ChatMessageService.java`

**변경할 위치:**
- Line 112
- Line 206

**변경 전:**
```java
List<ChatMember> allMembers = chatRoomMemberRepository
        .findByChatRoomIdAndChatRoomType(roomId, chatRoomType);
```

**변경 후:**
```java
List<ChatMember> allMembers = chatRoomMemberRepository
        .findByChatRoomIdAndChatRoomTypeWithMembers(roomId, chatRoomType);
```

### 4-3. 애플리케이션 재시작

```bash
# 기존 실행 중인 Spring Boot 종료 (Ctrl + C)
# 재시작
./gradlew bootRun
```

### 4-4. N+1 해결 확인

같은 API 호출 후 SQL 로그 확인:

```sql
-- 해결 후 예상 패턴:
-- 1번의 JOIN 쿼리로 모든 데이터 조회
SELECT cm.*, m.*
FROM chat_member cm
JOIN member m ON cm.member_id = m.id
WHERE cm.chat_room_id = ?
```

추가 Member 조회 쿼리가 없어야 함!

---

## STEP 5: After 성능 측정 (N+1 해결 후)

### 5-1. 동일 조건으로 K6 재실행

```bash
cd C:\Users\freetime\Desktop\project3\load-tests
k6 run --out json=results/after-test.json --summary-export=results/after-summary.json chat-api-test-quick.js
```

**중요:** Before와 완전히 동일한 조건으로 실행
- 같은 테스트 스크립트
- 같은 테스트 데이터
- 같은 시간대 (서버 상태 유사)

### 5-2. Grafana 모니터링

Before와 동일한 지표 확인:
- Heap Memory
- GC Time
- HTTP Request Duration p95
- Error Rate

### 5-3. 결과 캡처

1. **K6 콘솔 출력** 복사
2. **Grafana 스크린샷** 캡처 (Before와 동일한 그래프)
3. **SQL 로그** 복사 (JOIN 쿼리 1번만 실행되는 것 확인)

파일명 예시:
- `after-k6-output.txt`
- `after-grafana-heap.png`
- `after-grafana-response-time.png`
- `after-sql-join.txt`

---

## STEP 6: 결과 비교 및 분석

### 6-1. K6 메트릭 비교

| 지표 | Before | After | 개선율 |
|------|--------|-------|--------|
| http_req_duration (p95) | ? ms | ? ms | ? % |
| http_req_failed (rate) | ? % | ? % | ? % |
| iterations | ? | ? | ? % |
| data_received | ? MB | ? MB | ? % |

### 6-2. Grafana 메트릭 비교

**JVM Heap Memory:**
- Before: 최대 사용량 ? MB
- After: 최대 사용량 ? MB
- 분석: 메모리 사용량 ? % 감소

**GC Time:**
- Before: 총 GC 시간 ? 초
- After: 총 GC 시간 ? 초
- 분석: GC 부담 ? % 감소

**HTTP Request Duration (p95):**
- Before: ? ms
- After: ? ms
- 분석: 응답 시간 ? % 개선

### 6-3. SQL 쿼리 수 비교

**Before (N+1 문제):**
- 채팅방 1개당 쿼리 수: 1 + N개 (N = 멤버 수)
- 예: 멤버 10명 → 11개 쿼리

**After (Fetch Join):**
- 채팅방 1개당 쿼리 수: 1개
- 예: 멤버 10명 → 1개 쿼리

**쿼리 감소율:** 약 90% 이상

### 6-4. 포트폴리오용 정리

**개선 내용:**
1. 문제 식별: JPA N+1 문제로 인한 과도한 DB 쿼리
2. 해결 방법: JPQL Fetch Join 적용
3. 성능 개선:
   - 응답 시간 ? % 단축
   - 메모리 사용량 ? % 감소
   - DB 쿼리 수 ? % 감소
4. 모니터링: Prometheus + Grafana로 실시간 메트릭 수집

**학습 포인트:**
- Spring Boot Actuator 활용
- K6 부하 테스트 시나리오 작성
- 실시간 모니터링 대시보드 구축
- 성능 병목 지점 분석 및 해결

---

## 추가 팁

### 더 정확한 비교를 위한 방법

1. **테스트 여러 번 실행**
   - Before 3회, After 3회 실행
   - 평균값으로 비교

2. **동일한 초기 상태 유지**
   - 테스트 전마다 Docker 재시작
   - 캐시 초기화

3. **스트레스 테스트 추가**
   ```bash
   k6 run stress-test.js
   ```
   더 높은 부하에서도 개선 확인

### Grafana 대시보드 Export

나중에 재사용하기 위해:

1. 대시보드 우측 상단 **Share** 클릭
2. **Export** 탭
3. **Save to file** → JSON 파일 저장

### Prometheus 쿼리 예시

Grafana에서 직접 쿼리 작성:

```promql
# 평균 응답 시간
rate(http_server_requests_seconds_sum[1m]) / rate(http_server_requests_seconds_count[1m])

# 초당 요청 수
rate(http_server_requests_seconds_count[1m])

# 힙 메모리 사용률
jvm_memory_used_bytes{area="heap"} / jvm_memory_max_bytes{area="heap"} * 100
```

---

## 문제 해결

### Grafana에 데이터가 안 보일 때

1. Prometheus 상태 확인:
   ```
   http://localhost:9090/targets
   ```
   mixchat-backend가 UP 상태인지 확인

2. Actuator 엔드포인트 확인:
   ```bash
   curl http://localhost:8080/actuator/prometheus
   ```
   메트릭이 출력되는지 확인

3. Grafana 데이터소스 테스트:
   Configuration → Data Sources → Prometheus → Save & Test

### K6 테스트 중 에러율이 높을 때

1. 공개 채팅방 없음 → Swagger에서 생성
2. 인증 토큰 만료 → 테스트 스크립트가 매번 로그인하므로 괜찮음
3. DB 연결 부족 → application.yml에서 hikari connection pool 크기 증가

### 메모리 부족 에러

```bash
./gradlew bootRun -Dspring-boot.run.jvmArguments="-Xmx2g"
```

JVM 힙 메모리 2GB로 증가

---

## 다음 단계

1. ✅ Before 성능 측정
2. ✅ N+1 문제 해결
3. ✅ After 성능 측정
4. ✅ 결과 분석 및 문서화
5. 🔄 (선택) 다른 N+1 문제 해결
6. 🔄 (선택) QueryDSL 도입 검토
7. 🔄 (선택) Redis 캐싱 적용
8. 🔄 (선택) 스트레스 테스트로 임계점 파악
