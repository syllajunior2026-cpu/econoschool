-- Policies pour le bucket photos-eleves
-- À exécuter dans Supabase SQL Editor

-- 1. Permettre la lecture publique (affichage photos)
CREATE POLICY "Public read photos-eleves"
ON storage.objects FOR SELECT
USING (bucket_id = 'photos-eleves');

-- 2. Permettre l'upload (INSERT)
CREATE POLICY "Allow upload photos-eleves"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'photos-eleves');

-- 3. Permettre la mise à jour (UPDATE / upsert)
CREATE POLICY "Allow update photos-eleves"
ON storage.objects FOR UPDATE
USING (bucket_id = 'photos-eleves');

-- 4. Permettre la suppression (DELETE)
CREATE POLICY "Allow delete photos-eleves"
ON storage.objects FOR DELETE
USING (bucket_id = 'photos-eleves');

-- Vérification
SELECT policyname, cmd 
FROM pg_policies 
WHERE tablename = 'objects' 
AND policyname LIKE '%photos%';
