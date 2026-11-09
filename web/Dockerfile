# syntax=docker/dockerfile:1

# Imagen del mapa de Acuacar. La imagen lleva SOLO el código y los límites
# geográficos: los JSON de cifras que genera el ETL no van dentro (se montan al
# correr el contenedor, ver deploy/README.md), así cambiar cifras no obliga a
# reconstruir la imagen.

# 1) Dependencias: capa aparte para reutilizar la caché mientras no cambie package-lock.json.
# `scripts/` viene aquí porque el postinstall copia el worker de MapLibre.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

# 2) Compilación: next build con salida "standalone" (ver next.config.mjs).
# public/maplibre no está en git: se vuelve a generar aquí.
# NEXT_PUBLIC_API_URL queda escrita en el JavaScript del navegador al compilar
# (es una dirección pública, no un secreto).
FROM node:22-alpine AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node scripts/copiar-worker-maplibre.mjs && npm run build

# 3) Ejecución: usuario sin privilegios.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "server.js"]
