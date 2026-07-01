// ============================================================
// EconoSchool Pro — Fichier de configuration par établissement
// SEUL CE FICHIER EST À MODIFIER POUR CHAQUE NOUVEAU CLIENT
// ============================================================

const CONFIG = {
  // --- Identité établissement ---
  code_ecole:       'LYC001',
  nom_ecole:        'Lycée Excellence',
  type_ecole:       'Lycée',          // Lycée / Collège / École primaire / École maternelle
  statut_ecole:     'Privé',          // Privé / Public
  directeur:        '',
  tel:              '',
  adresse:          '',
  ville:            'Abidjan',
  email:            '',
  annee:            '2025-2026',

  // --- Comptes utilisateurs ---
  fondateur: {
    nom:            'Fondateur',
    login:          'fondateur',
    password:       '1234'            // À changer à la livraison
  },
  econome: {
    nom:            'Économe',
    login:          'econome',
    password:       '5678'            // À changer à la livraison
  },

  // --- Supabase (base de données cloud) ---
  supabase_url:     'https://xwsvlscuetopepdiclir.supabase.co',
  supabase_key:     'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3c3Zsc2N1ZXRvcGVwZGljbGlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzOTgxOTksImV4cCI6MjA5Mzk3NDE5OX0.UZ33u79vfOMYy-m6OYCyerXEe8Mu8Qsivbf9oEnqJmc',

  // --- SMS Orange CI ---
  orange_client_id:     'KGKO8wmUHvT0tGmoOg3PYysx6oRd1Y74',
  orange_client_secret: 'xGDDj8nLs7kzHJsrlUi6hurlZ1gmpHT5ojHUz2Vc70vc',
  orange_basic:         'Basic S0dLTzh3bVVIdlQwdEdtb09nM1BZeXN4Nm9SZDFZNzQ6eEdERGo4bkxzN2t6SEpzcklVaTZodXJJWjFnbXBIVDVvakhVejJWYzcwdmM=',
  orange_from:          '2250708840656', // Numéro expéditeur — si échec, essayer '241889'
  orange_sender:        'EconoSchool',
  orange_key:           '',   // token Bearer — généré automatiquement

  // --- Niveaux scolaires ---
  niveaux: ['6eme','5eme','4eme','3eme','Seconde','Première','Terminale'],

  // --- Classes d'examen (frais examen applicables) ---
  classes_examen: ['3eme','Terminale']
};
