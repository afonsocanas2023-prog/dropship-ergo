FROM node:20-alpine
RUN npm install -g pnpm
WORKDIR /app
COPY pnpm-lock.yaml ./
COPY package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm prisma generate
RUN pnpm build
EXPOSE 3000
CMD ["node", "dist/webhooks/index.js"]