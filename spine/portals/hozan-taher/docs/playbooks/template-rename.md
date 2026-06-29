# Template Rename/Delete Procedure

## Overview

As of Sprint C (migration 095), the database enforces referential integrity on `email_templates` via a PostgreSQL trigger. This prevents orphaning templates that are referenced by active campaigns.

**Protected campaign statuses:** `running`, `draft`, `paused`

**Error behavior:** When attempting to DELETE or RENAME (UPDATE name) a template that is referenced by an active campaign, PostgreSQL raises:

```
email_templates <name> is referenced by <N> active campaign(s) [ids: ...];
detach via UPDATE campaigns SET sequence_config = ... first
```

## Safe Rename Procedure

### Step 1: Identify All Campaigns Using This Template

```sql
SELECT DISTINCT c.id, c.name, c.status
  FROM campaigns c
  WHERE c.status IN ('running', 'draft', 'paused')
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(c.sequence_config) AS step
      WHERE step->>'template' = '<TEMPLATE_NAME>'
    )
  ORDER BY c.id;
```

### Step 2: Assess Campaign State

Before detaching references, verify:
- No campaign is actively sending
- Paused campaigns are intentionally paused
- Draft campaigns are work-in-progress

### Step 3: Detach All References

```sql
UPDATE campaigns
  SET sequence_config = (
    SELECT jsonb_agg(step)
      FROM jsonb_array_elements(sequence_config) AS step
      WHERE step->>'template' != '<TEMPLATE_NAME>'
  )
  WHERE id = <CAMPAIGN_ID>;
```

### Step 4: Rename the Template

```sql
UPDATE email_templates
  SET name = '<NEW_NAME>'
  WHERE name = '<OLD_NAME>';
```

### Step 5: Re-attach References (if needed)

Update campaigns to use the renamed template.

## Safe Delete Procedure

Follow Steps 1–3 from Rename Procedure, then delete:

```sql
DELETE FROM email_templates WHERE name = '<TEMPLATE_NAME>';
```

## Emergency: Forcibly Detach (Incident Only)

```sql
UPDATE campaigns
  SET sequence_config = (
    SELECT jsonb_agg(step)
      FROM jsonb_array_elements(sequence_config) AS step
      WHERE step->>'template' != '<TEMPLATE_NAME>'
  )
  WHERE status IN ('running', 'draft', 'paused')
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(sequence_config) AS step
      WHERE step->>'template' = '<TEMPLATE_NAME>'
    );
```

## Related

- Migration: `scripts/migrations/095_email_templates_referential_integrity.sql`
- Boot check: `features/platform/outreach-dashboard/src/lib/campaignTemplateRefs.js`
- Tests: `features/platform/outreach-dashboard/tests/integration/template_ref_integrity.test.js`
- Incident: Daemon crash on template rename without campaign detach (2026-05-11)
