#!/usr/bin/env bash
# Deploy workflow-graph to Cloud Run (source build via Google buildpacks — no Dockerfile).
#
# NON-DESTRUCTIVE: `--source` rebuilds the container and the new revision inherits the current
# config, so existing env (MODEL, SESSIONS_DIR, PROLIFIC_*, NODE_ENV), the OPENAI_API_KEY secret,
# and the gcsfuse /app/data mount are all preserved.
#
# Usage:
#   ./deploy.sh
set -euo pipefail

PROJECT="${PROJECT:-llm-interviewer-491820}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-workflow-graph}"

gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION"

echo "✓ Deployed ${SERVICE} to ${REGION}. Existing env, OPENAI_API_KEY, and /app/data mount preserved."
