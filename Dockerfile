FROM node:18-slim AS build

WORKDIR /app

RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install

COPY . .
RUN pnpm build

FROM node:18-slim AS production

WORKDIR /app

RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --production

COPY --from=build /app/dist ./dist
COPY archive.db archive.db

CMD ["node", "dist/index.js"]
