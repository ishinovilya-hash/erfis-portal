# Clients 360 v1 — installation and rollback

Baseline before this change: `cd6464b`.

## Before installation

1. Check server Git status and the exact pushed commit; do not overwrite local files.
2. Create a private backup directory (0700) outside the public/repository directories.
3. Save a consistent SQLite backup using the SQLite backup API, plus the current code
   and configuration. Record counts, integrity_check, and the installed commit.
4. On a disposable copy of the database, run `initClients360` and compare every
   original object field and original table. Only the new `client_id` field and
   additive tables/indexes/meta marker should differ. Do not print client details.
5. Run `node --test server/clients360.test.js server/registry-http.test.js server/registry-update.test.js`
   with ERFIS_DB and ERFIS_DATA_DIR unset (tests create their own temporary databases).
6. Install with fast-forward only. Restart erfis-portal. Check service, HTTPS,
   counts, foreign keys and uniform client cards. Do not create test records in production.

The migration is automatic and idempotent. It adds `counterparties` and
`objects.client_id`, leaving the old `clients` table untouched. Existing holder
strings are grouped only by trim/lowercase, as in the previous UI (no fuzzy merge).
All cards have the same structure; INN/OPF/contacts are not guessed. Refused and
trash objects retain their links. Clients without contracts have an empty contracts section.

## Rollback after user testing

1. Back up the CURRENT database and code again before taking any rollback action.
2. Prefer reverting this feature commit and redeploying the previous application
   code. Keep the current database: the added table/column are compatible with
   the previous code. Do not drop tables, clear contacts, or restore an old DB
   over work entered since the update.
3. New contact data remains stored but is invisible in the old UI.
   Old UI grouping uses holder strings; client cards without objects may not be
   listed. Preserve these records for reactivation or migration.
4. If the previous application is used to add/rename objects, a later reactivation
   needs an explicit reconciliation of links; the one-time migration must NOT
   be blindly rerun. Do not delete the migration marker as a shortcut.
5. A full pre-update DB restore is only appropriate after explicitly accounting
   for and preserving all post-update changes. Obtain user approval for any loss.

AI document intake and Word generation are not included in this first stage.
