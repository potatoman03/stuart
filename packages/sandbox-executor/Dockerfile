FROM python:3.12-slim

# Install Node.js 22 via nodesource
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Python libraries
RUN pip install --no-cache-dir \
    python-docx \
    openpyxl \
    python-pptx \
    reportlab \
    pillow \
    matplotlib \
    pandas

# Install Node.js libraries globally
RUN npm install -g \
    docx \
    pdfkit \
    pptxgenjs \
    xlsx

# Create non-root user
RUN useradd -m -u 1000 sandbox

# Create working directories
RUN mkdir -p /workspace/sources /workspace/output && \
    chown -R sandbox:sandbox /workspace

USER sandbox
WORKDIR /workspace
