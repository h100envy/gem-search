FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY launch.mjs server.mjs admin.mjs ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8790 LAUNCH_LOG=/data/launches.jsonl NODE_ENV=production
EXPOSE 8790
CMD ["node", "server.mjs"]
