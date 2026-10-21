FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
# Phase 2 imports customer-auth-routes.js and token-crypto.js in addition to server.js.
# Copy the root JavaScript modules so the container starts with every required module.
COPY *.js ./
COPY *.html ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
