FROM python:3.11-slim

WORKDIR /app

# Build tools not needed — we use only pre-built wheels
RUN pip install --upgrade pip

# Install CPU-only torch first (much smaller, avoids CUDA bloat)
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# Install everything else with wheels only (no Fortran compiler needed)
COPY requirements.txt .
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
