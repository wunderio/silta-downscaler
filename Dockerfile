FROM node:22.22.3-alpine3.22

WORKDIR /app
COPY . .

RUN npm ci

CMD ["node", "index.js"]
EXPOSE 3000
