# Для Hugging Face Spaces (Docker). Берёт свежий код из GitHub при каждой сборке.
FROM node:20-slim
ADD https://github.com/t7y6j92zn9-pixel/nerdiest/archive/refs/heads/main.tar.gz /tmp/src.tar.gz
RUN mkdir -p /app && tar -xzf /tmp/src.tar.gz -C /app --strip-components=1 && cd /app && npm install --omit=dev && chown -R 1000:1000 /app
WORKDIR /app
USER 1000
ENV PORT=7860 DATA_FILE=/tmp/data.json
EXPOSE 7860
CMD ["node", "server.js"]
