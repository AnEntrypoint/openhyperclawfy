FROM node:20-slim

WORKDIR /app

# Copy hyperfy build output (needed for world-node-client.js)
COPY hyperfy/build ./hyperfy/build

# Copy agent-manager
COPY agent-manager/package.json agent-manager/package-lock.json* ./agent-manager/

WORKDIR /app/agent-manager
RUN npm install --production

COPY agent-manager/src ./src

EXPOSE 5000

CMD ["node", "src/index.js"]
