// server/index.js
// Backend Express pour VERIF AI.
//
// Flux d'accès : le client clique "Payer et vérifier" → redirigé vers Stripe
// Checkout → paiement de 2,99€ → Stripe le redirige vers cette page avec un
// identifiant de session → le serveur VÉRIFIE ce paiement directement auprès
// de Stripe (jamais fait confiance au navigateur) → un accès à usage unique
// est débloqué automatiquement, sans aucune action manuelle de ta part.
//
// Remboursement : quand une carte payée arrive en dépôt-vente, tu rembourses
// les 2,99€ à la main depuis ton Dashboard Stripe (Paiements > Rembourser).
// C'est un choix business volontaire, ça ne nécessite aucun code.

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Stripe = require('stripe');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// CORS — autorise le site vitrine (autre domaine) à appeler l'API du catalogue.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,x-admin-secret');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PRICE_EUR_CENTS = parseInt(process.env.PRICE_EUR_CENTS || '299', 10); // 2,99€ par défaut

if (!ANTHROPIC_API_KEY) console.warn('[VERIF AI] ANTHROPIC_API_KEY manquante dans .env');
if (!STRIPE_SECRET_KEY) console.warn('[VERIF AI] STRIPE_SECRET_KEY manquante dans .env — le paiement ne fonctionnera pas.');
if (!ADMIN_SECRET) console.warn('[VERIF AI] ADMIN_SECRET manquante dans .env — page admin inutilisable.');

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ---------------------------------------------------------------------------
// STOCKAGE — un seul fichier JSON qui trace tous les "accès" accordés,
// qu'ils viennent d'un paiement Stripe ou d'un code manuel (admin).
// Chaque entrée n'ouvre droit qu'à UNE analyse.
// ---------------------------------------------------------------------------
const GRANTS_FILE = path.join(__dirname, '..', 'data', 'grants.json');

function loadGrants() {
  try { return JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf-8')); }
  catch { return []; }
}
function saveGrants(grants) {
  fs.mkdirSync(path.dirname(GRANTS_FILE), { recursive: true });
  fs.writeFileSync(GRANTS_FILE, JSON.stringify(grants, null, 2));
}
// ---------------------------------------------------------------------------
// CATALOGUE — liste des cartes/produits affichés sur le site vitrine.
// Géré depuis la page catalogue-admin.html (protégée par ADMIN_SECRET).
// ---------------------------------------------------------------------------
const CATALOG_FILE = path.join(__dirname, '..', 'data', 'catalog.json');

function loadCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8')); }
  catch { return []; }
}
function saveCatalog(items) {
  fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(items, null, 2));
}
function checkAdmin(req) {
  return ADMIN_SECRET && req.headers['x-admin-secret'] === ADMIN_SECRET;
}

// Public : le site vitrine récupère la liste des produits à afficher.
app.get('/api/catalog', (req, res) => {
  res.json(loadCatalog());
});

// Admin : ajouter un produit.
app.post('/api/admin/catalog/add', (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ message: 'Non autorisé.' });
  const { name, price, description, emoji, category } = req.body
// Jetons de session temporaires en mémoire (30 min pour faire l'analyse après avoir payé).
const activeSessions = new Map(); // token -> { used, createdAt }
const SESSION_TTL_MS = 30 * 60 * 1000;

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, s] of activeSessions.entries()) {
    if (now - s.createdAt > SESSION_TTL_MS) activeSessions.delete(token);
  }
}
function issueSessionToken() {
  cleanupExpiredSessions();
  const token = crypto.randomBytes(24).toString('hex');
  activeSessions.set(token, { used: false, createdAt: Date.now() });
  return token;
}

// ---------------------------------------------------------------------------
// PAIEMENT — création de la session Stripe Checkout
// ---------------------------------------------------------------------------
app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ message: 'Le paiement n\'est pas configuré côté serveur.' });
  }

  try {
    // On déduit l'URL du site depuis la requête, pour que ça marche aussi bien
    // en local (http://localhost:3000) qu'une fois mis en ligne, sans rien coder en dur.
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'VERIF AI — Pré-diagnostic d\'authenticité (1 carte)',
            description: 'Analyse indicative recto/verso. Remboursable si la carte est envoyée en dépôt-vente.'
          },
          unit_amount: PRICE_EUR_CENTS
        },
        quantity: 1
      }],
      success_url: `${baseUrl}/verif-ai.html?checkout_session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/verif-ai.html?canceled=true`
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[VERIF AI] Erreur création session Stripe:', err);
    return res.status(500).json({ message: "Impossible de démarrer le paiement pour le moment." });
  }
});

// ---------------------------------------------------------------------------
// CONFIRMATION DE PAIEMENT — appelée automatiquement par la page au retour
// de Stripe. On vérifie DIRECTEMENT auprès de Stripe (jamais confiance au
// paramètre d'URL seul), pour empêcher toute manipulation côté client.
// ---------------------------------------------------------------------------
app.post('/api/confirm-payment', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ message: 'Le paiement n\'est pas configuré côté serveur.' });
  }

  const { checkoutSessionId } = req.body;
  if (!checkoutSessionId) {
    return res.status(400).json({ message: 'Identifiant de paiement manquant.' });
  }

  try {
    const grants = loadGrants();

    // Empêche de réutiliser la même session Stripe deux fois (ex: rafraîchir la page de succès).
    const existing = grants.find(g => g.id === checkoutSessionId);
    if (existing) {
      return res.status(410).json({ message: 'Ce paiement a déjà été utilisé pour débloquer une analyse.' });
    }

    const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ message: 'Paiement non confirmé.' });
    }

    grants.push({
      id: checkoutSessionId,
      type: 'stripe',
      amount: session.amount_total,
      used: true,
      createdAt: new Date().toISOString()
    });
    saveGrants(grants);

    const sessionToken = issueSessionToken();
    return res.json({ sessionToken });
  } catch (err) {
    console.error('[VERIF AI] Erreur confirmation paiement:', err);
    return res.status(500).json({ message: "Impossible de vérifier le paiement pour le moment." });
  }
});

// ---------------------------------------------------------------------------
// ADMIN — génération de codes manuels (cas exceptionnels uniquement, ex: geste
// commercial). Le flux normal des clients passe entièrement par Stripe ci-dessus.
// ---------------------------------------------------------------------------
app.post('/api/admin/generate-code', (req, res) => {
  const { secret, note } = req.body;
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).json({ message: 'Mot de passe administrateur incorrect.' });
  }
  const grants = loadGrants();
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  grants.push({ id: code, type: 'manual', used: false, note: note || '', createdAt: new Date().toISOString() });
  saveGrants(grants);
  return res.json({ code });
});

app.post('/api/admin/list-grants', (req, res) => {
  const { secret } = req.body;
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).json({ message: 'Mot de passe administrateur incorrect.' });
  }
  return res.json({ grants: loadGrants().slice().reverse() });
});

app.post('/api/redeem-code', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: 'Merci de saisir un code.' });

  const grants = loadGrants();
  const entry = grants.find(g => g.type === 'manual' && g.id === code.trim().toUpperCase());

  if (!entry) return res.status(404).json({ message: "Ce code n'existe pas." });
  if (entry.used) return res.status(410).json({ message: 'Ce code a déjà été utilisé.' });

  entry.used = true;
  entry.usedAt = new Date().toISOString();
  saveGrants(grants);

  return res.json({ sessionToken: issueSessionToken() });
});

// ---------------------------------------------------------------------------
// PROMPT SYSTÈME
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Tu es un assistant d'aide à l'inspection visuelle de cartes à collectionner Pokémon, utilisé en interne par une boutique de dépôt-vente (KTS TCG).

IMPORTANT — cadre de ta mission :
Tu n'es PAS un service d'authentification certifiée. Tu fournis un pré-diagnostic visuel indicatif à partir d'une photo, destiné à aider un humain à décider s'il doit pousser l'inspection plus loin (loupe, poids, texture, comparaison avec une base de données officielle). Les contrefaçons de bonne qualité peuvent être indétectables sur une simple photo : reste donc toujours prudent dans tes conclusions et ne déclare jamais une authenticité "garantie" ou "certaine".

Analyse l'image (et le verso si fourni) selon ces axes :
1. Typographie et alignement des polices (PV, nom de l'attaque, texte de copyright, numéro de collection).
2. Présence et cohérence des détails holographiques ou de texture, si visibles sur la photo.
3. Couleurs, netteté et cadrage des bordures (recto et verso).
4. Orthographe et cohérence générale du texte avec les conventions connues des cartes officielles (mise en page, symboles d'énergie, logo).
5. Qualité d'impression générale (pixellisation suspecte, flou anormal, bavures d'encre).

Contraintes :
- Si la photo est trop floue, mal cadrée, ou ne montre pas assez d'éléments pour juger un critère, dis-le explicitement dans le champ correspondant plutôt que d'inventer un verdict.
- N'affirme jamais avoir consulté une base de données externe : tu raisonnes uniquement à partir de ce que tu observes sur l'image et de tes connaissances générales sur les codes visuels des cartes Pokémon.
- Le champ "indice_confiance" reflète ta confiance dans TON diagnostic (pas une probabilité scientifique d'authenticité).

Tu dois répondre STRICTEMENT en JSON valide, sans texte avant ou après, selon ce schéma exact :

{
  "statut": "Vraisemblablement Authentique" | "Douteux / Suspect" | "Contrefaçon Détectée",
  "indice_confiance": <entier entre 0 et 100>,
  "points_controle": [
    { "nom": "Bordures", "statut": "ok" | "attention" | "problème", "detail": "<observation courte>" },
    { "nom": "Polices / Typographie", "statut": "ok" | "attention" | "problème", "detail": "<observation courte>" },
    { "nom": "Symboles / Holographie", "statut": "ok" | "attention" | "problème", "detail": "<observation courte>" },
    { "nom": "Qualité d'impression", "statut": "ok" | "attention" | "problème", "detail": "<observation courte>" }
  ],
  "remarques": "<recommandation synthétique en une ou deux phrases, incluant si besoin un conseil de vérification complémentaire>"
}`;

// ---------------------------------------------------------------------------
// ANALYSE — protégée par jeton de session à usage unique.
// ---------------------------------------------------------------------------
app.post('/api/verify-card', async (req, res) => {
  try {
    const { frontImage, backImage, sessionToken } = req.body;

    if (!sessionToken) {
      return res.status(401).json({ message: 'Accès refusé : paiement non validé pour cette session.' });
    }
    cleanupExpiredSessions();
    const session = activeSessions.get(sessionToken);
    if (!session) return res.status(401).json({ message: 'Session invalide ou expirée.' });
    if (session.used) return res.status(410).json({ message: 'Cette session a déjà servi à une analyse.' });
    if (!frontImage) return res.status(400).json({ message: "L'image recto est obligatoire." });
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ message: 'Clé API manquante côté serveur.' });

    session.used = true;

    const content = [
      { type: 'text', text: 'Voici la photo recto de la carte à analyser.' },
      toImageBlock(frontImage)
    ];
    if (backImage) {
      content.push({ type: 'text', text: 'Voici la photo verso de la même carte.' });
      content.push(toImageBlock(backImage));
    }
    content.push({ type: 'text', text: 'Analyse cette carte selon les critères indiqués et réponds uniquement avec le JSON demandé.' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[VERIF AI] Erreur API Anthropic:', response.status, errText);
      return res.status(502).json({ message: "Le service d'analyse n'a pas répondu correctement." });
    }

    const data = await response.json();
    const rawText = (data.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    const parsed = safeParseJson(rawText);
    if (!parsed) {
      console.error('[VERIF AI] Réponse non-JSON reçue du modèle:', rawText);
      return res.status(502).json({ message: 'Le rapport reçu était mal formé. Réessaie.' });
    }

    return res.json(parsed);
  } catch (err) {
    console.error('[VERIF AI] Erreur serveur:', err);
    return res.status(500).json({ message: "Erreur interne pendant l'analyse." });
  }
});

function toImageBlock(dataUrl) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("Format d'image invalide (dataURL attendu).");
  const [, mediaType, base64Data] = match;
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } };
}

function safeParseJson(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[VERIF AI] Serveur lancé sur http://localhost:${PORT}`);
});
