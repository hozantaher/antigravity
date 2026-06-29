-- 151_contacts_phone.sql
--
-- Operator-confirmed phone on a contact (#1581 M2.2). The whole výkup closes by
-- phone, but until now a contact carried only an email — the seller's number
-- lived only inside the reply body. mineReplySignals / parseSignature extract it
-- (a regex GUESS), so rather than silently write a guess onto the canonical
-- contact, the operator clicks "uložit ke kontaktu" in the reply and the dashboard
-- PATCHes it here (audit-logged). This column is the confirmed result.
--
-- Nullable text, no format constraint at the DB layer — the BFF validates the
-- E.164-ish shape before writing. Idempotent (IF NOT EXISTS). Applied to PROD
-- 2026-06-01.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone text;
