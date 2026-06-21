-- PPI (active-inference) migration — ADDITIVE, backward-compatible with the count-based path.
-- Adds the f control-variate store + the probe propensity column. Safe to apply to a populated DB
-- (new table + nullable column; the count path ignores both). Validated on Neon branch ppi-port
-- (br-late-boat-af8u8ma3) off production (br-solitary-star). Apply to prod when flipping TASK_BANK_PPI on.

-- f(participant, task) — the LLM control variate; written at interview time for non-mentioned undecided
-- tasks. The active estimator uses f as a free baseline (g = f + ξ/π·(Y−f)); unbiased for any f.
CREATE TABLE IF NOT EXISTS predictions (
    participant text NOT NULL,
    task        text NOT NULL REFERENCES tasks(id),
    occupation  text,
    f           double precision NOT NULL CHECK (f >= 0 AND f <= 1),
    model       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (participant, task)
);
CREATE INDEX IF NOT EXISTS idx_predictions_occ_task ON predictions(occupation, task);

-- Probe propensity: the (predictable, floored) probability this probe was issued under the randomized
-- acquisition design. IPW divides by it. NULL for non-probe rows and pre-PPI probes.
ALTER TABLE responses ADD COLUMN IF NOT EXISTS pi double precision;
