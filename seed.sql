-- Development seed. Reference data + one default workspace ONLY.
-- No fake campaigns, products, accounts, or analytics.
--
-- Apply with: npm run db:seed
-- Ids are fixed UUIDs so reseeding is reproducible; the statements are
-- idempotent via INSERT OR IGNORE.

-- The one default workspace.
INSERT OR IGNORE INTO workspace (id, name, slug, created_at, updated_at)
VALUES ('10502a4d-4c5f-4846-8a7b-9e2960e7348c', 'Default workspace', 'default', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');

-- Platform registry: reference rows mapping to future server/platforms adapters.
INSERT OR IGNORE INTO platform (id, adapter_key, name, created_at) VALUES
  ('ea3e4510-ff00-4222-b6f1-384ad3dcdbbd', 'pinterest', 'Pinterest', '2026-08-19T00:00:00.000Z'),
  ('393514ce-9549-45b8-81bc-2cf6dd220d4c', 'instagram', 'Instagram', '2026-08-19T00:00:00.000Z'),
  ('76c4c8dd-7258-46bc-b0c5-89daf794cb08', 'tiktok',    'TikTok',    '2026-08-19T00:00:00.000Z'),
  ('f06988ff-5e17-4502-b16e-73e3875d6ae1', 'x',         'X',         '2026-08-19T00:00:00.000Z');

-- Built-in normalized metric definitions (workspace_id NULL = built-in).
INSERT OR IGNORE INTO metric_definition (id, workspace_id, key, name, description, unit, created_at) VALUES
  ('6c37f650-d5b6-4015-8f14-95c1e85fc23a', NULL, 'impressions',      'Impressions',         'Times content was shown.',               'count',   '2026-08-19T00:00:00.000Z'),
  ('a3d20229-52e5-4769-a3a9-cb64d1a2e7d2', NULL, 'engagements',      'Engagements',         'Total engagement actions.',              'count',   '2026-08-19T00:00:00.000Z'),
  ('c5faec40-f094-42cb-b73d-67b8db70d736', NULL, 'saves',            'Saves',               'Times content was saved.',               'count',   '2026-08-19T00:00:00.000Z'),
  ('72455ca8-c160-460a-8121-da2dae4c9558', NULL, 'clicks',           'Clicks',              'Clicks on content.',                     'count',   '2026-08-19T00:00:00.000Z'),
  ('54895b39-c960-496f-82fb-c0a73c953e16', NULL, 'outbound_clicks',  'Outbound clicks',     'Clicks leaving the platform to a link.', 'count',   '2026-08-19T00:00:00.000Z'),
  ('b009f533-402e-4ac2-be27-262253cf29ea', NULL, 'conversions',      'Conversions',         'Attributed conversion events.',          'count',   '2026-08-19T00:00:00.000Z'),
  ('c37c850c-8d3a-4ae9-ac89-ce83527b4031', NULL, 'revenue',          'Revenue',             'Attributed revenue.',                    'usd',     '2026-08-19T00:00:00.000Z'),
  ('e12f4581-7489-4a92-95b1-128d9c129e01', NULL, 'orders',           'Orders',              'Total purchase orders.',                 'count',   '2026-08-19T00:00:00.000Z'),
  ('e12f4581-7489-4a92-95b1-128d9c129e02', NULL, 'conversion_rate',  'Conversion Rate',     'Conversion rate percentage.',            'percent', '2026-08-19T00:00:00.000Z'),
  ('e12f4581-7489-4a92-95b1-128d9c129e03', NULL, 'qualified_visits', 'Qualified Visits',    'High-intent or qualified visits.',       'count',   '2026-08-19T00:00:00.000Z'),
  ('e12f4581-7489-4a92-95b1-128d9c129e04', NULL, 'ctr',               'Click-Through Rate',  'Click-through rate percentage.',         'percent', '2026-08-19T00:00:00.000Z'),
  ('e12f4581-7489-4a92-95b1-128d9c129e05', NULL, 'leads',             'Leads',               'Generated leads or signups.',            'count',   '2026-08-19T00:00:00.000Z');

