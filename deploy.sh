#!/usr/bin/env bash
# Deploy workflow-graph to Cloud Run (source build via Google buildpacks — no Dockerfile).
#
# Reproduces the existing service and adds the active-learning task bank. NON-DESTRUCTIVE:
# `--source` rebuilds the container and a new revision inherits the current config; the
# `--update-*` flags add/override ONLY the named vars, so existing env (MODEL, SESSIONS_DIR,
# PROLIFIC_*, NODE_ENV), the OPENAI_API_KEY secret, and the gcsfuse /app/data mount are kept.
#
# Usage:
#   ./deploy.sh                                  # normal redeploy (secret already exists)
#   DATABASE_URL='postgresql://…neon.tech/neondb?sslmode=require' ./deploy.sh   # first time: also creates the DB secret
#
# The DB connection string is stored in Secret Manager (like OPENAI_API_KEY) — never in this
# file or the service config in plaintext. The Neon schema + 96-task seed are a separate
# one-time step (scripts/new_tasks/bank_to_db.py against Neon), not part of app deploy.
set -euo pipefail

PROJECT="${PROJECT:-llm-interviewer-491820}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-workflow-graph}"
TASK_BANK_OCC="${TASK_BANK_OCC:-15-1252}"   # flips the feature on; unset/empty = dormant
DB_SECRET="${DB_SECRET:-database-url}"

# One-time: create the DATABASE_URL secret + grant the runtime SA access.
if ! gcloud secrets describe "$DB_SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "Secret '$DB_SECRET' does not exist and \$DATABASE_URL is not set." >&2
    echo "Create it once:  DATABASE_URL='postgresql://…sslmode=require' ./deploy.sh" >&2
    exit 1
  fi
  printf '%s' "$DATABASE_URL" | gcloud secrets create "$DB_SECRET" \
    --project "$PROJECT" --replication-policy=automatic --data-file=-
  SA="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
        --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null || true)"
  if [[ -z "$SA" ]]; then
    PN="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
    SA="${PN}-compute@developer.gserviceaccount.com"
  fi
  gcloud secrets add-iam-policy-binding "$DB_SECRET" --project "$PROJECT" \
    --member="serviceAccount:${SA}" --role=roles/secretmanager.secretAccessor >/dev/null
  echo "Created secret '$DB_SECRET' and granted access to ${SA}."
fi

gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --update-env-vars "TASK_BANK_OCC=${TASK_BANK_OCC}" \
  --update-secrets "DATABASE_URL=${DB_SECRET}:latest"

echo "✓ Deployed ${SERVICE} to ${REGION}. Existing env, OPENAI_API_KEY, and /app/data mount preserved."
