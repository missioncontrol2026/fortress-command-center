FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional --ignore-scripts
COPY . .
ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
