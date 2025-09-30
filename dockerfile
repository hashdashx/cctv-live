
FROM node:18-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install --only=production
COPY . .
EXPOSE 8081
CMD ["npm","start"]
