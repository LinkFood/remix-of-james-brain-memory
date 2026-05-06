# Extracts table names from `.from('<table>')` references in supabase/functions/.
# Filters out `.storage.from('<bucket>')` calls, which are Supabase Storage
# bucket references — not Postgres tables. Handles two shapes:
#   1. Same-line:        `supabase.storage.from('bucket')`
#   2. Multi-line chain: `serviceClient.storage\n        .from('bucket')`
# Tracks previous line per-file (reset on FNR==1).
#
# Born from 2026-05-05 dumps Phase B — the original regex over-matched and
# produced false-positives for the `dumps` storage bucket.

FNR==1 { prev = "" }

/\.from\(['"][a-zA-Z_][a-zA-Z0-9_]*['"]\)/ {
  if ($0 ~ /\.storage\.from/ || prev ~ /\.storage[[:space:]]*$/) {
    prev = $0
    next
  }
  line = $0
  sub(/.*\.from\(['"]/, "", line)
  sub(/['"]\).*/, "", line)
  print line
}

{ prev = $0 }
