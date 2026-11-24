FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY services ./services
COPY mocks ./mocks
ENV NODE_ENV=production
# команда запуска задаётся в docker-compose.yml
