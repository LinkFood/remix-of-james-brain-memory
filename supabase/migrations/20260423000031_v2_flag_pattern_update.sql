-- ============================================================================
-- Co-Trader v2 — ct_update_flag_pattern helper
-- ============================================================================
-- Called by ct-flag-grader after each grade write. Builds a stable signature
-- hash from (specialist_ticker, sorted tags, score bucketed to nearest 10)
-- and upserts ct_flag_patterns with running hit-rate stats.
--
-- Signature bucketing keeps the pattern space small enough for meaningful
-- sample sizes per pattern, while still discriminating between tag cohorts
-- and score bands.
-- ============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_update_flag_pattern(
  p_flag_id UUID,
  p_outcome TEXT,
  p_alpha   NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  _ticker         TEXT;
  _tags           TEXT[];
  _sorted_tags    TEXT[];
  _score          NUMERIC;
  _score_bucket   INT;
  _direction      TEXT;
  _signature      JSONB;
  _sig_hash       TEXT;
  _delta_obs      INT := 1;
  _delta_win      INT := 0;
  _delta_partial  INT := 0;
  _delta_loss     INT := 0;
  _existing       RECORD;
  _new_obs        INT;
  _new_wins       INT;
  _new_partials   INT;
  _new_losses     INT;
  _new_hit_rate   NUMERIC;
  _new_avg_alpha  NUMERIC;
BEGIN
  -- 1. Load the graded flag.
  SELECT specialist_ticker, tags, score, direction
    INTO _ticker, _tags, _score, _direction
    FROM public.ct_flags
   WHERE id = p_flag_id;

  IF _ticker IS NULL THEN
    RETURN jsonb_build_object('error', 'flag not found', 'flag_id', p_flag_id);
  END IF;

  -- 2. Normalize tags (sort, de-null).
  IF _tags IS NULL THEN
    _sorted_tags := ARRAY[]::TEXT[];
  ELSE
    SELECT COALESCE(array_agg(t ORDER BY t), ARRAY[]::TEXT[])
      INTO _sorted_tags
      FROM unnest(_tags) AS t
     WHERE t IS NOT NULL AND t <> '';
  END IF;

  -- 3. Score bucket = floor(score / 10) * 10.
  _score_bucket := (FLOOR(COALESCE(_score, 0) / 10.0) * 10)::INT;

  -- 4. Build signature + hash. md5 is fine — we don't need crypto, we need
  --    a stable pigeonhole of (ticker, sorted_tags, score_bucket, direction).
  _signature := jsonb_build_object(
    'specialist_ticker', _ticker,
    'direction',         _direction,
    'tags',              to_jsonb(_sorted_tags),
    'score_bucket',      _score_bucket
  );
  _sig_hash := md5(_signature::text);

  -- 5. Outcome delta counters.
  CASE p_outcome
    WHEN 'win'     THEN _delta_win := 1;
    WHEN 'partial' THEN _delta_partial := 1;
    WHEN 'loss'    THEN _delta_loss := 1;
    ELSE -- 'invalidated_early' or any other label: count as observation, no win/loss.
  END CASE;

  -- 6. Upsert. Recompute hit_rate + rolling avg alpha in one statement.
  SELECT n_observations, n_wins, n_partials, n_losses, avg_alpha_pct
    INTO _existing
    FROM public.ct_flag_patterns
   WHERE specialist_ticker = _ticker AND signature_hash = _sig_hash;

  IF _existing IS NULL THEN
    _new_obs       := _delta_obs;
    _new_wins      := _delta_win;
    _new_partials  := _delta_partial;
    _new_losses    := _delta_loss;
    _new_hit_rate  := CASE WHEN _new_obs > 0
                           THEN (_new_wins + 0.5 * _new_partials) / _new_obs
                           ELSE NULL END;
    _new_avg_alpha := p_alpha;

    INSERT INTO public.ct_flag_patterns (
      specialist_ticker, signature_hash, signature,
      n_observations, n_wins, n_partials, n_losses,
      hit_rate, avg_alpha_pct, last_seen_at, updated_at
    ) VALUES (
      _ticker, _sig_hash, _signature,
      _new_obs, _new_wins, _new_partials, _new_losses,
      _new_hit_rate, _new_avg_alpha, now(), now()
    );
  ELSE
    _new_obs       := _existing.n_observations + _delta_obs;
    _new_wins      := _existing.n_wins + _delta_win;
    _new_partials  := _existing.n_partials + _delta_partial;
    _new_losses    := _existing.n_losses + _delta_loss;
    _new_hit_rate  := CASE WHEN _new_obs > 0
                           THEN (_new_wins + 0.5 * _new_partials) / _new_obs
                           ELSE NULL END;
    -- Rolling average, null-safe. If new alpha null, keep prior.
    IF p_alpha IS NULL THEN
      _new_avg_alpha := _existing.avg_alpha_pct;
    ELSIF _existing.avg_alpha_pct IS NULL THEN
      _new_avg_alpha := p_alpha;
    ELSE
      _new_avg_alpha := (
        (_existing.avg_alpha_pct * _existing.n_observations) + p_alpha
      ) / _new_obs;
    END IF;

    UPDATE public.ct_flag_patterns
       SET n_observations = _new_obs,
           n_wins         = _new_wins,
           n_partials     = _new_partials,
           n_losses       = _new_losses,
           hit_rate       = _new_hit_rate,
           avg_alpha_pct  = _new_avg_alpha,
           last_seen_at   = now(),
           updated_at     = now()
     WHERE specialist_ticker = _ticker AND signature_hash = _sig_hash;
  END IF;

  RETURN jsonb_build_object(
    'ok',             true,
    'signature_hash', _sig_hash,
    'n_observations', _new_obs,
    'hit_rate',       _new_hit_rate,
    'avg_alpha_pct',  _new_avg_alpha
  );
END
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_update_flag_pattern(UUID, TEXT, NUMERIC)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_update_flag_pattern IS
  'V2 pattern update: signature = (specialist_ticker, direction, sorted_tags, score_bucket_10). Upserts ct_flag_patterns with running hit_rate + avg_alpha_pct.';

-- ----------------------------------------------------------------------------
-- Config seed — target threshold for grader outcome tiering
-- ----------------------------------------------------------------------------
INSERT INTO public.ct_config (key, value, description, category, default_value) VALUES
  ('grader.target_threshold_pct', '0.5'::jsonb,
   'Underlying % move in direction of flag required for win outcome. Partial if between 0 and this; loss if negative.',
   'scoring', '0.5'::jsonb)
ON CONFLICT (key) DO NOTHING;
