FROM node:20-alpine

# mdbtools for migration script (only needed on first run, stays in image for convenience)
RUN apk add --no-cache mdbtools

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Data volume: SQLite database and any runtime uploads
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "src/app.js"]
