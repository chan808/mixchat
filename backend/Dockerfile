# backend/Dockerfile
# syntax=docker/dockerfile:1.7

# ---- 빌드 단계 ----
FROM eclipse-temurin:21-jdk AS build
WORKDIR /app

# Gradle wrapper/설정 파일만 먼저 복사
# → 소스 변경 없이 의존성만 바뀌면 이 레이어 캐시가 재사용됨
COPY gradlew settings.gradle* build.gradle* gradle/ ./
RUN chmod +x gradlew

# 의존성 다운로드 (BuildKit 캐시 마운트로 CI 빌드 속도 개선)
# → /home/gradle/.gradle를 캐시로 유지해서 매번 다운로드하지 않음
# → || true는 의존성 일부 실패해도 다음 단계로 넘어가게 하는 안전장치
RUN --mount=type=cache,target=/home/gradle/.gradle \
    ./gradlew --no-daemon dependencies || true

# 전체 소스 복사 후 JAR 빌드
# → -x test: 테스트는 CI workflow에서 별도로 돌리는 게 정석. 이미지 빌드는 빠르게.
COPY . .
RUN --mount=type=cache,target=/home/gradle/.gradle \
    ./gradlew --no-daemon clean bootJar -x test

# ---- 실행 단계 (distroless: 경량 + 보안) ----
# distroless 이미지: 쉘, 패키지 매니저가 없어서 공격 표면이 작음
# nonroot 태그: 기본적으로 non-root 유저로 실행됨 (별도 adduser 불필요)
FROM gcr.io/distroless/java21-debian12:nonroot AS runtime
WORKDIR /app

# 빌드 결과물(JAR)만 복사 → 최종 이미지에 JDK, 소스코드, Gradle 등이 포함되지 않음
COPY --from=build /app/build/libs/*.jar /app/app.jar

EXPOSE 8080
ENV JAVA_OPTS=""
ENTRYPOINT ["java", "-jar", "/app/app.jar"]