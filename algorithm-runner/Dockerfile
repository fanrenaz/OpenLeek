FROM python:3.12-slim
WORKDIR /srv/algorithm-runner
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
COPY requirements.lock ./
RUN pip install --no-cache-dir --requirement requirements.lock
RUN useradd --system --uid 10001 runner && chown -R runner:runner /srv/algorithm-runner
USER runner
EXPOSE 8080
CMD ["python", "watch_runner.py"]
