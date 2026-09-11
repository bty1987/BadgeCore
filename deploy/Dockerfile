# BadgeCore 后台（server/，零依赖栈 D13：Node 内置 http + node:sqlite）
# 构建：docker build -f deploy/Dockerfile -t badgecore-server . （仓库根目录执行）
# 运行：docker run -d -p 8200:8200 -v badgecore-data:/app/server/data badgecore-server
FROM node:24-alpine
WORKDIR /app
COPY server/ /app/server/
ENV PORT=8200
EXPOSE 8200
CMD ["node", "/app/server/index.js"]
