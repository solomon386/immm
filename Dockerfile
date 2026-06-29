FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm install -g pm2 \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads logs \
  && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["pm2-runtime", "ecosystem.config.cjs"]
