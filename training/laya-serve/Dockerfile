# laya-serve: the open decision model behind the same /v1/systemone endpoint as Jev.
# CPU only; the multilingual checkpoint (322M parameters) needs about 2 GB of RAM.
# A fine-tuned checkpoint mounted at /checkpoints/<name> is registered by LAYA_MODELS.
FROM python:3.12-slim
RUN pip install --no-cache-dir "laya[serve]"
ENV LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000 \
    LAYA_DEVICE=cpu \
    LAYA_PRELOAD=1 \
    LAYA_THREADS=4 \
    LAYA_JEV_STRICT=1
EXPOSE 8000
CMD ["laya-serve"]
