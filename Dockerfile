FROM node:18-slim AS build

WORKDIR /app

RUN npm install -g pnpm && pnpm install
COPY package.json pnpm-lock.yaml ./

COPY . .
RUN pnpm build

FROM node:18-slim AS production

WORKDIR /app

RUN npm install -g pnpm && pnpm install --production

COPY --from=build /app/dist ./dist

CMD ["node", "dist/main.js"]
