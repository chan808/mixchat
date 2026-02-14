# frontend/Dockerfile
# syntax=docker/dockerfile:1.7

# ---- 베이스 이미지 ----
FROM node:20-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# alpine에서 일부 npm 패키지 빌드에 필요
RUN apk add --no-cache libc6-compat
# pnpm/yarn 지원을 위한 corepack 활성화
RUN corepack enable

# ---- 의존성 설치 단계 ----
FROM base AS deps
COPY package.json ./
# lockfile이 있으면 복사 (없는 파일은 무시됨)
COPY package-lock.json* yarn.lock* pnpm-lock.yaml* ./

# 패키지 매니저 자동 선택 + 캐시 마운트
# → lockfile 종류에 따라 pnpm/yarn/npm 중 하나를 자동 선택
# → 캐시 마운트로 재설치 시 다운로드 시간 절약
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/root/.cache/yarn \
    --mount=type=cache,target=/root/.local/share/pnpm/store \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
    elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
    else npm ci; fi

# ---- 빌드 단계 ----
FROM base AS builder

# Next.js의 NEXT_PUBLIC_* 변수는 빌드 시점에 주입됨 (런타임 아님!)
# → GitHub Actions의 build-arg로 전달받아 여기서 세팅
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN if [ -f pnpm-lock.yaml ]; then pnpm build; \
    elif [ -f yarn.lock ]; then yarn build; \
    else npm run build; fi

# ---- 실행 단계 (standalone: 경량) ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# non-root 유저 생성 (보안)
RUN addgroup -S nextjs && adduser -S nextjs -G nextjs
USER nextjs

# standalone 결과물만 복사 (node_modules 전체가 아님!)
# → .next/standalone에 서버 실행에 필요한 최소 파일만 포함됨
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
ENV PORT=3000
# standalone 모드에서는 server.js로 직접 실행
CMD ["node", "server.js"]