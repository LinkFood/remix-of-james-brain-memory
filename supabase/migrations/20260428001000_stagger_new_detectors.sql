-- Stagger the 5 new detector RTH crons across a 5-minute window so they
-- don't all fire at the exact same second (along with 5+ other RTH crons).
-- d1 stays at :00,:05,:10... (anchor); d2-d5 offset to :01-:04 lanes.
-- Pure schedule change — no logic, watermarks, configs touched.
SET search_path = public, extensions;

DO $cron$
BEGIN
  -- d1 smart_money_repeat: stays at :00 minute lane (anchor)
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-smart-money-repeat-rth') THEN
    PERFORM cron.unschedule('ct-detector-smart-money-repeat-rth');
  END IF;
  PERFORM cron.schedule(
    'ct-detector-smart-money-repeat-rth',
    '0,5,10,15,20,25,30,35,40,45,50,55 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-smart-money-repeat', '{}'::jsonb);$body$
  );

  -- d2 weekly_atm_voi: :01 lane
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-weekly-atm-voi-rth') THEN
    PERFORM cron.unschedule('ct-detector-weekly-atm-voi-rth');
  END IF;
  PERFORM cron.schedule(
    'ct-detector-weekly-atm-voi-rth',
    '1,6,11,16,21,26,31,36,41,46,51,56 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-weekly-atm-voi', '{}'::jsonb);$body$
  );

  -- d3 zerodte_opening_call: :02 lane
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-zerodte-opening-call-rth') THEN
    PERFORM cron.unschedule('ct-detector-zerodte-opening-call-rth');
  END IF;
  PERFORM cron.schedule(
    'ct-detector-zerodte-opening-call-rth',
    '2,7,12,17,22,27,32,37,42,47,52,57 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-zerodte-opening-call', '{}'::jsonb);$body$
  );

  -- d4 zerodte_put_voi_extreme: :03 lane
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-zerodte-put-voi-rth') THEN
    PERFORM cron.unschedule('ct-detector-zerodte-put-voi-rth');
  END IF;
  PERFORM cron.schedule(
    'ct-detector-zerodte-put-voi-rth',
    '3,8,13,18,23,28,33,38,43,48,53,58 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-zerodte-put-voi', '{}'::jsonb);$body$
  );

  -- d5 small_cap_inverted_put: :04 lane
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-small-cap-inverted-put-rth') THEN
    PERFORM cron.unschedule('ct-detector-small-cap-inverted-put-rth');
  END IF;
  PERFORM cron.schedule(
    'ct-detector-small-cap-inverted-put-rth',
    '4,9,14,19,24,29,34,39,44,49,54,59 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-small-cap-inverted-put', '{}'::jsonb);$body$
  );
END
$cron$;
