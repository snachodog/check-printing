FROM node:20-slim

# mdbtools for migration script (only needed on first run, stays in image for convenience)
RUN apt-get update && apt-get install -y --no-install-recommends mdbtools && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Data volume: SQLite database and any runtime uploads
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "src/app.js"]
