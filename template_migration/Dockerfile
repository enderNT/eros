FROM oven/bun:1 AS base

WORKDIR /app
COPY package.json tsconfig.json ./
RUN bun install

COPY src ./src
COPY tests ./tests
COPY .env.example ./.env.example

EXPOSE 3000

CMD ["bun", "src/index.ts"]
