FROM node:18.17-alpine3.17

WORKDIR /app
COPY . .

RUN npm install

CMD node index.js
EXPOSE 3000