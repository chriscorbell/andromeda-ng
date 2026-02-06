FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./

RUN apt-get update \
  && apt-get install -y python3 make g++ \
  && npm install \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "dist/index.js"]
