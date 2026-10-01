# Образ LLM-прокси (см. docker-compose.yml, сервис api)
FROM node:22-alpine
WORKDIR /app
COPY proxy.js .
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "proxy.js"]
