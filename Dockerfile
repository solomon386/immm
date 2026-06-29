FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

# apt-get 替换为国内源，加速构建
RUN sed -i 's|http://deb.debian.org|https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list
RUN sed -i 's|http://security.debian.org|https://mirrors.tuna.tsinghua.edu.cn/debian-security|g' /etc/apt/sources.list

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm install -g pm2 \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p uploads logs \
  && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["pm2-runtime", "ecosystem.config.cjs"]
