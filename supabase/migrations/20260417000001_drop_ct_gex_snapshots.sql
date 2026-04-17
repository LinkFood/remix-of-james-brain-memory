-- Drop ct_gex_snapshots — dead table, no function writes to it.
-- The GEX heatmap reads from ct_gex_timeseries (ct-watcher populates that).
-- The single orphaned read in ct-morning-brief is removed in the same commit.
DROP TABLE IF EXISTS public.ct_gex_snapshots;
