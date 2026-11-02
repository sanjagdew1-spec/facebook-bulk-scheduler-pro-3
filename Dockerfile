FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY worker-runner.js page-worker-scheduler.js ./
COPY test/page-worker-scheduler.test.js ./test/
RUN node --test ./test/page-worker-scheduler.test.js
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
