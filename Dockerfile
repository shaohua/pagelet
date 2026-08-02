FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY cli/package.json cli/package.json
COPY demo/package.json demo/package.json
COPY shared/package.json shared/package.json

RUN npm ci

COPY . .
RUN npm run build
RUN npm ci --omit=dev

FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web ./web
COPY --from=build /app/shared ./shared

EXPOSE 8080
CMD ["node", "web/dist/server/main.js"]
