FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm install

COPY . .
RUN npx prisma generate && npm run build

EXPOSE 3001
CMD ["node", "dist/main.js"]
