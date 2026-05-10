FROM node:20

WORKDIR /frontend

COPY package*.json ./

RUN npm ci

COPY . .

ENV NODE_OPTIONS="--max-old-space-size=8192"

EXPOSE 3000

CMD ["npm", "run", "dev"]