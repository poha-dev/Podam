FROM node:22-slim
WORKDIR /app

# better-sqlite3는 prebuilt 바이너리를 쓰지만, 없을 때를 대비해 빌드 도구를 둔다.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

# root로 돌리지 않는다. 만에 하나 앱이 뚫려도 컨테이너 안에서 할 수 있는 일이 줄어든다.
# /data 를 미리 만들어 소유자를 지정해두면, 도커가 볼륨을 만들 때 이 권한을 물려받는다.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "src/server.js"]
