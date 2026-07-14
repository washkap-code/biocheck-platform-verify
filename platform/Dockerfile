# BioCheck platform image. Multi-stage: dev (compose) and production runner.
FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM deps AS dev
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS production
ENV NODE_ENV=production
# Non-root runtime user.
RUN addgroup -S biocheck && adduser -S biocheck -G biocheck
COPY --from=build --chown=biocheck:biocheck /app/.next/standalone ./
COPY --from=build --chown=biocheck:biocheck /app/.next/static ./.next/static
COPY --from=build --chown=biocheck:biocheck /app/public ./public
USER biocheck
EXPOSE 3000
CMD ["node", "server.js"]
