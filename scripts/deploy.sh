#!/bin/bash
set -e

# =============================================================================
# Deploy the workflow-graph app (Express API + Vite SPA) to GCP Cloud Run
# with a Cloud Storage bucket mounted for persistent session JSON.
# =============================================================================

# Auto-source .env from the repo root so vars defined there (PROJECT_ID,
# PROLIFIC_COMPLETION_CODE, MODEL, etc.) become available to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

PROJECT_ID="${PROJECT_ID:-CHANGE-ME}"
SERVICE_NAME="${SERVICE_NAME:-workflow-graph}"
REGION="${REGION:-us-central1}"
BUCKET_NAME="${BUCKET_NAME:-${SERVICE_NAME}-${PROJECT_ID}}"
MODEL="${MODEL:-gpt-4o}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud CLI is not installed or not on PATH."
  echo "Install it: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

if [[ "$PROJECT_ID" == "CHANGE-ME" ]]; then
  echo "ERROR: edit scripts/deploy.sh and set PROJECT_ID, or run with PROJECT_ID=... ./scripts/deploy.sh"
  exit 1
fi

if [[ -z "${PROLIFIC_COMPLETION_CODE:-}" ]]; then
  echo "ERROR: PROLIFIC_COMPLETION_CODE must be set before deploying."
  echo "This is the completion code Prolific redirects participants back with."
  echo "Example: PROLIFIC_COMPLETION_CODE=ABC123 PROJECT_ID=$PROJECT_ID ./scripts/deploy.sh"
  exit 1
fi

# Non-secret env vars that Cloud Run will inject into the container.
NON_SENSITIVE_VARS=""
NON_SENSITIVE_VARS+="MODEL=${MODEL},"
NON_SENSITIVE_VARS+="SESSIONS_DIR=/app/data/sessions,"
NON_SENSITIVE_VARS+="PROLIFIC_COMPLETION_CODE=${PROLIFIC_COMPLETION_CODE},"
NON_SENSITIVE_VARS+="PROLIFIC_SCREENOUT_CODE=${PROLIFIC_SCREENOUT_CODE:-},"
NON_SENSITIVE_VARS+="ATTN_CHECK_MAX_FAILS=${ATTN_CHECK_MAX_FAILS:-0},"
NON_SENSITIVE_VARS+="NODE_ENV=production"

echo "================================================"
echo "Deploying workflow-graph to GCP Cloud Run"
echo "================================================"
echo "Project: $PROJECT_ID"
echo "Service: $SERVICE_NAME"
echo "Region:  $REGION"
echo "Bucket:  $BUCKET_NAME (mounted at /app/data)"
echo "Model:   $MODEL"
echo "================================================"

gcloud config set project "$PROJECT_ID"

echo "Enabling APIs (run, cloudbuild, storage, secretmanager, artifactregistry)…"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com

echo "Ensuring storage bucket exists…"
gsutil mb -p "$PROJECT_ID" -l "$REGION" "gs://$BUCKET_NAME" 2>/dev/null || echo "  (bucket already exists)"

# Verify the OPENAI_API_KEY secret exists. Create with:
#   echo -n "$KEY" | gcloud secrets create openai-api-key --data-file=-
if ! gcloud secrets describe openai-api-key >/dev/null 2>&1; then
  echo ""
  echo "ERROR: secret 'openai-api-key' not found in Secret Manager."
  echo "Create it first:"
  echo "  echo -n 'sk-...' | gcloud secrets create openai-api-key --data-file=-"
  exit 1
fi

IMAGE="us-central1-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/$SERVICE_NAME:latest"

echo ""
echo "Building container image (this builds both the Vite frontend and the Node server)…"
gcloud builds submit . \
  --tag "$IMAGE" \
  --region "$REGION"

echo ""
echo "Deploying to Cloud Run…"
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --timeout 300 \
  --max-instances 1 \
  --set-env-vars "$NON_SENSITIVE_VARS" \
  --set-secrets "OPENAI_API_KEY=openai-api-key:latest" \
  --add-volume "name=data,type=cloud-storage,bucket=$BUCKET_NAME" \
  --add-volume-mount "volume=data,mount-path=/app/data"

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format 'value(status.url)')

echo ""
echo "================================================"
echo "Deployment complete!"
echo ""
echo "  Service URL: $SERVICE_URL"
echo "  Health:      $SERVICE_URL/health"
echo "  Sessions:    gs://$BUCKET_NAME/sessions/"
echo ""
echo "================================================"
