-- ============================================================
-- Fix EconoSchool Pro — Contraintes table paiements
-- À exécuter dans Supabase SQL Editor
-- ============================================================

-- 1. Supprimer la contrainte unique sur numero_recu si elle existe
--    (elle cause des erreurs 400 quand plusieurs reçus sont vides)
ALTER TABLE paiements 
  DROP CONSTRAINT IF EXISTS paiements_numero_recu_key;

-- 2. Vérifier que eleve_id accepte NULL (pas de NOT NULL)
ALTER TABLE paiements 
  ALTER COLUMN eleve_id DROP NOT NULL;

-- 3. S'assurer que la colonne type accepte les valeurs vides
ALTER TABLE paiements 
  ALTER COLUMN type SET DEFAULT 'Scolarité';

-- 4. Vérifier le résultat
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'paiements'
ORDER BY ordinal_position;
