FROM node:18-slim

WORKDIR /app

RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --production

COPY ./dist ./dist
COPY ./assets ./assets
COPY archive.db archive.db

CMD ["node", "dist/index.js"]
