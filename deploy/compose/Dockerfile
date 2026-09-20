FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build
RUN npm install --global pnpm@11.19.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production AGENT18_HOST=0.0.0.0
USER node
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
