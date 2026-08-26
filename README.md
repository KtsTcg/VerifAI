# VERIF AI — Pré-diagnostic d'authenticité (KTS TCG)

## Comment ça marche maintenant (flux automatique)

1. Le client va sur `verif-ai.html`, clique "Payer et vérifier ma carte" (2,99€).
2. Il est redirigé vers une page de paiement Stripe (sécurisée, hébergée par Stripe).
3. Une fois payé, Stripe le renvoie automatiquement sur le site.
4. Le serveur vérifie le paiement directement auprès de Stripe (jamais confiance
   au navigateur du client) et débloque l'outil pour **une seule analyse**.
5. Si la carte part ensuite en dépôt-vente chez toi, tu rembourses les 2,99€
   à la main depuis ton Dashboard Stripe (Paiements → Rembourser). Aucune
   action technique requise pour ça, juste un clic dans l'interface Stripe.

Il n'y a **aucune manipulation de ta part** dans le flux normal : ni génération
de code, ni envoi manuel. La page `/admin.html` reste disponible uniquement
pour des cas exceptionnels (ex: offrir un accès gratuit à quelqu'un en
particulier), mais n'est pas nécessaire au fonctionnement courant.

## 1. Créer un compte Stripe

1. Va sur https://dashboard.stripe.com/register et crée un compte (gratuit,
   Stripe prend une petite commission uniquement sur les paiements réussis).
2. Une fois connecté, va dans **Développeurs > Clés API**.
3. Copie la **clé secrète** (elle commence par `sk_test_...` en mode test,
   puis `sk_live_...` une fois que tu passes en vrai).

## 2. Installation du projet

```bash
npm install
```

## 3. Configuration de la clé API

1. Copie `.env.example` vers `.env` :
   ```bash
   cp .env.example .env
   ```
2. Remplis les valeurs :
   - `ANTHROPIC_API_KEY` : ta clé Claude (console.anthropic.com).
   - `STRIPE_SECRET_KEY` : la clé Stripe récupérée à l'étape 1.
   - `ADMIN_SECRET` : un mot de passe de ton choix pour la page admin.
   - `PRICE_EUR_CENTS` : le prix en centimes (299 = 2,99€), modifiable à tout moment.
3. **Ne jamais** committer ce fichier `.env` dans Git ni le partager.

## 4. Lancer le serveur en local (pour tester)

```bash
npm start
```

Le site est accessible sur http://localhost:3000/verif-ai.html.

En mode test Stripe (clé `sk_test_...`), utilise une carte de test comme
`4242 4242 4242 4242`, n'importe quelle date future et n'importe quel CVC —
aucun vrai paiement n'est effectué, mais tout le flux fonctionne normalement.

## 5. Mettre le site en ligne (obligatoire pour un usage réel)

Comme les clients paient et utilisent l'outil à distance, il faut héberger
ce serveur en ligne (ex: Render.com, Railway...). Sur la plateforme choisie :
- Ajoute les mêmes variables d'environnement que dans ton `.env` (dans les
  réglages du projet sur la plateforme, pas dans un fichier).
- Une fois en ligne, remplace `STRIPE_SECRET_KEY` par ta clé `sk_live_...`
  (mode production) quand tu es prêt à encaisser pour de vrai.

## 6. Limites à connaître (important)

Ce diagnostic s'appuie sur un modèle d'IA généraliste analysant une photo.
Il est utile comme **premier filtre** mais présente des limites réelles :

- Il ne peut pas évaluer le poids, la texture au toucher, ou la découpe
  précise du carton — des critères souvent décisifs pour repérer une
  contrefaçon de bonne qualité.
- La qualité de la photo (éclairage, netteté, angle) influence fortement
  la fiabilité du résultat.
- Un "Vraisemblablement Authentique" n'est **pas une garantie**.

L'interface affiche déjà ces avertissements au client — évite de les
retirer, ils te protègent en cas de litige.
