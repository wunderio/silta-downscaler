FROM node:22.23.5-alpine3.23

WORKDIR /app
COPY . .

RUN npm ci

CMD ["node", "index.js"]
EXPOSE 3000
