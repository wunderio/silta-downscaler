FROM node:22.20-alpine3.22

WORKDIR /app
COPY . .

RUN npm install

CMD node index.js
EXPOSE 3000