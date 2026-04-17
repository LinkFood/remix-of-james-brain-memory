# Core Logic Agent Memory

## Project: JAC Agent OS
- Location: `/Users/jameschellis/jac-agent-os`
- 13 dashboard widgets currently registered in `src/lib/widget-registry.ts`
- Widget pattern: component in `src/components/sandbox/widgets/`, register in widget-registry, done
- Adding a new widget (data-only, no backend): ~30 min (confirmed by Research Results widget)
- Adding a widget with a new dependency: +30 min for integration
- Tables NOT in generated types (use `as any` cast): `jac_reflections`, `brain_entities`, `entity_mentions`, `jac_principles`, `entry_relationships`

## Key Data Tables for Widget Ideas
- `entries`: Main brain table. Well-populated. Has `importance_score`, `access_count`, `last_accessed_at`, `tags`, `content_type`, `created_at`
- `entry_relationships`: Has `source_entry_id`, `related_entry_id`, `similarity_score`, `relationship_type`. Created by backfill-embeddings.
- `brain_entities`: Has `name`, `entity_type` (person/project/place/concept/org), `mention_count`, `first_seen`, `last_seen`. Populated by extract-entities (fire-and-forget from smart-save and jac-reflect).
- `entity_mentions`: Links entities to entries/reflections. Has `context_snippet`.
- `jac_principles`: Has `principle`, `confidence`, `times_applied`, `source_reflection_ids`, `last_validated`. Populated weekly by distill-principles cron.
- `agent_activity_log`: Well-populated. Has `agent`, `step`, `status`, `detail`, `duration_ms`, `created_at`.
- `agent_tasks`: Has `intent`, `status`, `cost_usd`, `tokens_in/out`, `created_at`, `completed_at`.
- `brain_insights`: Has `type` (pattern/overdue/stale/schedule/suggestion/heartbeat/activity/morning_brief), `title`, `body`, `priority`, `entry_ids`, `expires_at`, `dismissed`.

## Existing Dependencies (relevant to widget ideas)
- `recharts` (2.15.4) -- already installed, used for charts
- `react-grid-layout` (2.2.2) -- dashboard grid
- `@react-three/fiber` + `@react-three/drei` + `three` -- 3D rendering available but unused
- `date-fns` (3.6.0) -- date utilities
- `react-markdown` (10.1.0) -- markdown rendering
- NO d3 or d3-force installed

## ElevenLabs Status
- `elevenlabs-tts` edge function EXISTS and is fully wired (TTS only, not STT)
- `ELEVENLABS_API_KEY` in Supabase secrets
- Does NOT have STT -- only text-to-speech
- Voice Memo widget would need STT (which ElevenLabs offers but isn't wired up yet)

## Constraint: No New External Dependencies
- CLAUDE.md says "no new external dependencies" but package.json already has recharts, three.js, etc.
- Interpret as: don't add new npm packages or new external APIs. Use what's there.
- d3-force would be a new dep -- blocker for force-directed graph unless done with canvas/SVG manually or three.js
