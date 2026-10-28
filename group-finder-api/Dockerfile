FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY group-finder-api/app.py /app/app.py
EXPOSE 10000
CMD ["python", "/app/app.py"]
