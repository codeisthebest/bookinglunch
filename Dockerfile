# 訂餐系統（Node.js 22）。只有純 JavaScript 依賴，不需要編譯工具。
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/bookinglunch.db \
    DATA_FILE=/data/db.json

WORKDIR /app

# 先複製 lockfile 安裝依賴，程式碼沒變時可重用這一層快取
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# 資料目錄交給非 root 的 node 使用者。掛載具名 volume 時會沿用這個擁有者
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node:sqlite 在 Node 22 仍標示為實驗性功能，關閉啟動時的警告訊息
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
