-- ════════════════════════════════════════════════════════════════════════
-- 027 — Voice Profiles for Per-Sender Tone Consistency
-- ════════════════════════════════════════════════════════════════════════
--
-- Trigger: 2026-05-01 brutal humanlike scoring composite 17/100. Two
-- specific findings drive this migration:
--   1. 0/36 emails contained diacritics (huge fingerprint signal).
--   2. Only 2 distinct greetings appeared across 36 sends.
--
-- Both stem from same root cause: every mailbox pulled from the same
-- hardcoded greeting pool in services/common/humanize/tone.go, and
-- diacritics were degraded by ImperfectEngine without restore pass.
--
-- This migration introduces a voice_profiles table + FK on
-- outreach_mailboxes so each mailbox emits a distinct stylistic
-- fingerprint (greeting set, diacritic density, hedging tone).
--
-- Layer cake:
--   - voice_profiles                          — per-voice spec
--   - outreach_mailboxes.voice_profile_id     — FK binding mailbox→voice
--
-- Selection logic lives in services/common/humanize/voice_profile.go:
-- SelectGreeting hashes (profile_id, step, name, sendTime/300) →
-- greeting index. Same minute + same recipient = same greeting
-- (deterministic retry); across the day greeting rotates through pool.
--
-- JSONB chosen over TEXT[] to avoid lib/pq dependency in
-- services/orchestrator (currently uses pure database/sql). Greeting
-- arrays are small (3-5 entries) so JSONB overhead is negligible.
--
-- Coordinates with the Display-Name PR (also touches outreach_mailboxes
-- schema). No conflict — voice_profile_id vs display_name are
-- independent ALTER TABLE additions; either order works. The
-- idempotent DO $$ guard skips the FK add when re-applied.

CREATE TABLE IF NOT EXISTS voice_profiles (
    id                      BIGSERIAL PRIMARY KEY,
    name                    TEXT NOT NULL UNIQUE,
    greetings_step0         JSONB NOT NULL DEFAULT '[]'::jsonb,
    greetings_step1         JSONB NOT NULL DEFAULT '[]'::jsonb,
    greetings_step2         JSONB NOT NULL DEFAULT '[]'::jsonb,
    signature_closings      JSONB NOT NULL DEFAULT '[]'::jsonb,
    comma_density           DOUBLE PRECISION NOT NULL DEFAULT 1.8,
    hedging_prob            DOUBLE PRECISION NOT NULL DEFAULT 0.0
                            CHECK (hedging_prob >= 0 AND hedging_prob <= 1),
    diacritics_restore_prob DOUBLE PRECISION NOT NULL DEFAULT 0.55
                            CHECK (diacritics_restore_prob >= 0 AND diacritics_restore_prob <= 1),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE voice_profiles IS
'Per-sender writing voice. Mailboxes bind via outreach_mailboxes.voice_profile_id; humanize.Engine.WithVoice loads it at PrepareEmail time. Source: services/common/humanize/voice_profile.go.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'outreach_mailboxes'
           AND column_name = 'voice_profile_id'
    ) THEN
        ALTER TABLE outreach_mailboxes
            ADD COLUMN voice_profile_id BIGINT REFERENCES voice_profiles(id)
                ON DELETE SET NULL;
    END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_outreach_mailboxes_voice_profile_id
    ON outreach_mailboxes (voice_profile_id);

COMMENT ON COLUMN outreach_mailboxes.voice_profile_id IS
'FK → voice_profiles.id. NULL = fall through to humanize.DefaultVoiceProfile().';

INSERT INTO voice_profiles (
    id, name, greetings_step0, greetings_step1, greetings_step2,
    signature_closings, comma_density, hedging_prob, diacritics_restore_prob
)
VALUES
    (1, 'warm',
     '["Dobrý den, %NAME%","Vážený pane %NAME%","Vážená paní %NAME%","Krásný den, %NAME%"]'::jsonb,
     '["Ještě jednou dobrý den, %NAME%","Dobrý den, %NAME%","Zdravím Vás, %NAME%"]'::jsonb,
     '["Dobrý den, %NAME%","Zdravím, %NAME%"]'::jsonb,
     '["S přátelským pozdravem","S pozdravem a přáním hezkého dne","Děkuji a přeji hezký den"]'::jsonb,
     2.2, 0.25, 0.75),
    (2, 'terse',
     '["Dobrý den, %NAME%","Dobrý den"]'::jsonb,
     '["Zdravím","Dobrý den"]'::jsonb,
     '["Zdravím"]'::jsonb,
     '["Díky","S pozdravem"]'::jsonb,
     1.2, 0.0, 0.50),
    (3, 'consultative',
     '["Vážený pane %NAME%","Vážená paní %NAME%","Dobrý den, pane %NAME%","Dobrý den, paní %NAME%"]'::jsonb,
     '["Vážený pane %NAME%","Dobrý den, pane %NAME%"]'::jsonb,
     '["Vážený pane %NAME%","Dobrý den"]'::jsonb,
     '["S úctou","S pozdravem","S pozdravem a přáním všeho dobrého"]'::jsonb,
     2.5, 0.30, 0.80),
    (4, 'mobile',
     '["Zdravím, %NAME%","Zdravím Vás"]'::jsonb,
     '["Zdravím","Zdravím, %NAME%"]'::jsonb,
     '["Zdravím"]'::jsonb,
     '["Díky","Měj se","S pozdravem"]'::jsonb,
     1.0, 0.05, 0.40)
ON CONFLICT (id) DO UPDATE SET
    name                    = EXCLUDED.name,
    greetings_step0         = EXCLUDED.greetings_step0,
    greetings_step1         = EXCLUDED.greetings_step1,
    greetings_step2         = EXCLUDED.greetings_step2,
    signature_closings      = EXCLUDED.signature_closings,
    comma_density           = EXCLUDED.comma_density,
    hedging_prob            = EXCLUDED.hedging_prob,
    diacritics_restore_prob = EXCLUDED.diacritics_restore_prob,
    updated_at              = now();

SELECT setval(pg_get_serial_sequence('voice_profiles', 'id'),
              GREATEST((SELECT COALESCE(MAX(id), 0) FROM voice_profiles), 4));

-- Bind first 4 mailboxes (alphabetic) to the 4 voices. Idempotent —
-- only sets where voice_profile_id IS NULL so operator-curated
-- bindings survive re-runs.

UPDATE outreach_mailboxes
   SET voice_profile_id = 1
 WHERE voice_profile_id IS NULL
   AND address IN (
       SELECT address FROM outreach_mailboxes
        WHERE voice_profile_id IS NULL
        ORDER BY address
        LIMIT 1
   );

UPDATE outreach_mailboxes
   SET voice_profile_id = 2
 WHERE voice_profile_id IS NULL
   AND address IN (
       SELECT address FROM outreach_mailboxes
        WHERE voice_profile_id IS NULL
        ORDER BY address
        LIMIT 1
   );

UPDATE outreach_mailboxes
   SET voice_profile_id = 3
 WHERE voice_profile_id IS NULL
   AND address IN (
       SELECT address FROM outreach_mailboxes
        WHERE voice_profile_id IS NULL
        ORDER BY address
        LIMIT 1
   );

UPDATE outreach_mailboxes
   SET voice_profile_id = 4
 WHERE voice_profile_id IS NULL
   AND address IN (
       SELECT address FROM outreach_mailboxes
        WHERE voice_profile_id IS NULL
        ORDER BY address
        LIMIT 1
   );

INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'migration_applied',
    'migration_runner',
    'schema',
    '027_voice_profiles',
    jsonb_build_object(
        'description', 'voice_profiles table + outreach_mailboxes.voice_profile_id FK; 4 seeded voices',
        'idempotent', true,
        'seeded_profiles', ARRAY['warm','terse','consultative','mobile']
    )
);

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
