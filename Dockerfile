FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 3001

CMD ["node", "src/app.js"]
