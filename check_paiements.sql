-- ============================================================
-- EconoSchool v8.2 — Corrections table paiements
-- ============================================================

-- 1. Vérifier la structure actuelle de paiements
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'paiements'
ORDER BY ordinal_position;
