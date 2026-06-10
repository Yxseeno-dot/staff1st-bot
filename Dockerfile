FROM node:20-alpine
RUN npm install -g openclaw@2026.5.20
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
