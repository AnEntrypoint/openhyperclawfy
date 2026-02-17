# Use a slim Node base
FROM node:20-slim

# Set working dir
WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --production

# Copy the source code (no prefix needed - context is ./agent-manager/)
COPY src/ ./src/

# If you have other folders like examples/ or config, copy them too
# COPY examples/ ./examples/
# COPY .env.example ./.env.example

# Expose the agent-manager port (6000 as in your compose)
EXPOSE 6000

# Run the server
CMD ["node", "src/index.js"]