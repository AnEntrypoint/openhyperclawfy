FROM node:20-slim

WORKDIR /app

# Copy package files (relative to context ./agent-manager)
COPY package.json package-lock.json* ./

RUN npm install --production

# Copy src folder (relative)
COPY src/ ./src/

# If you have other files (e.g. examples/)
# COPY examples/ ./examples/

EXPOSE 6000

CMD ["node", "src/index.js"]