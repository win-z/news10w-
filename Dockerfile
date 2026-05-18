FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV CHROME_PATH=/usr/bin/chromium
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
