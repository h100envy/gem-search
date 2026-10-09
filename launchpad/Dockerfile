FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache font-dejavu
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY launch.mjs burns.mjs scan.mjs xray.mjs bundle-index.mjs crews.mjs wallet.mjs cup.mjs advisor.mjs rpc-pool.mjs narratives.mjs council.mjs record.mjs feed.mjs pons.mjs pons-abi.json server.mjs admin.mjs bot.mjs ./
COPY bot ./bot
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8790 LAUNCH_LOG=/data/launches.jsonl NODE_ENV=production
EXPOSE 8790
CMD ["node", "server.mjs"]
