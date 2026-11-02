FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY worker-runner.js page-worker-scheduler.js ./
COPY test/page-worker-scheduler.test.js test/worker-runner-health.test.js ./test/
RUN node --check worker-runner.js && node --check page-worker-scheduler.js && node --test ./test/*.test.js
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
