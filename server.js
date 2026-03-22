require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);


const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey && stripeKey.startsWith('sk_') ? require('stripe')(stripeKey) : null;

const app = express();
const port = 3012;

const creditsFile = path.join(__dirname, 'credits.json');

function getCredits() {
    try {
        if (fs.existsSync(creditsFile)) {
            return JSON.parse(fs.readFileSync(creditsFile, 'utf-8'));
        }
    } catch (e) {
        console.error("Error reading credits", e);
    }
    return [];
}

function saveCredit(frameId, authorName) {
    const credits = getCredits();
    credits.unshift({ 
        frameId: parseInt(frameId, 10), 
        authorName: authorName || 'Anonyme', 
        date: new Date().toISOString() 
    });
    fs.writeFileSync(creditsFile, JSON.stringify(credits, null, 2));
}

// In-memory state for reservations
// { frameId: { userId: 'xxx', expiresAt: 123456789 } }
const reservations = {};
const RESERVATION_TIME_MS = 20 * 60 * 1000; // 20 minutes

function getCompletedFrameIds() {
    try {
        const files = fs.readdirSync('uploads/');
        const ids = files
            .filter(f => f.startsWith('frame_') && f.endsWith('.webp'))
            .map(f => parseInt(f.replace('frame_', '').replace('.webp', ''), 10));
        return new Set(ids);
    } catch (e) {
        return new Set();
    }
}

function getContinuousMax() {
    const completed = getCompletedFrameIds();
    let max = 0;
    while (completed.has(max + 1)) {
        max++;
    }
    return max;
}

// Config for Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const frameId = parseInt(req.body.frameId, 10);
        if (!frameId) return cb(new Error("Missing frameId"));
        const nextFrame = String(frameId).padStart(5, '0');
        cb(null, `frame_${nextFrame}.png`);
    }
});

const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.static('public'));
app.use('/frames', express.static('uploads'));
app.use('/templates', express.static('templates'));

let isGeneratingVideo = false;
let videoNeedsRegeneration = false;

function triggerVideoGeneration() {
    if (isGeneratingVideo) {
        videoNeedsRegeneration = true;
        return;
    }
    isGeneratingVideo = true;
    
    // Check if we have enough frames (e.g., at least 1)
    const completed = getCompletedFrameIds();
    if (completed.size === 0) {
        isGeneratingVideo = false;
        return;
    }

    console.log("Generating video...");
    const outPath = path.join(__dirname, 'public', 'animation.webm');
    const outPathTmp = path.join(__dirname, 'public', 'animation_tmp.webm');

    ffmpeg()
        .input(path.join(__dirname, 'uploads', 'frame_%05d.webp'))
        .inputFPS(10)
        .videoCodec('libvpx-vp9')
        .outputOptions([
            '-pix_fmt yuva420p',
            '-lossless 1'
        ])
        .save(outPathTmp)
        .on('end', () => {
            console.log("Video generation finished.");
            fs.renameSync(outPathTmp, outPath);
            isGeneratingVideo = false;
            if (videoNeedsRegeneration) {
                videoNeedsRegeneration = false;
                triggerVideoGeneration();
            }
        })
        .on('error', (err) => {
            console.error("Video generation error:", err);
            isGeneratingVideo = false;
        });
}


function cleanReservations() {
    const now = Date.now();
    for (const frameId in reservations) {
        if (reservations[frameId].expiresAt < now) {
            delete reservations[frameId];
        }
    }
}

app.get('/api/status', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    cleanReservations();
    const completed = getCompletedFrameIds();
    const continuousMax = getContinuousMax();

    let assignedFrameId = null;

    // Check if user already has an active reservation
    for (const id in reservations) {
        if (reservations[id].userId === userId) {
            assignedFrameId = parseInt(id, 10);
            break;
        }
    }

    if (!assignedFrameId) {
        let i = 1;
        while (true) {
            if (!completed.has(i) && !reservations[i]) {
                assignedFrameId = i;
                break;
            }
            i++;
        }
        reservations[assignedFrameId] = {
            userId: userId,
            expiresAt: Date.now() + RESERVATION_TIME_MS
        };
    }

    const currentPhase = (assignedFrameId % 8 === 0) ? 8 : assignedFrameId % 8;

    res.json({
        totalFrames: continuousMax,
        nextFrameId: assignedFrameId,
        currentPhase: currentPhase,
        expiresAt: reservations[assignedFrameId].expiresAt
    });
});

app.post('/api/extend-reservation', express.json(), (req, res) => {
    const userId = req.body.userId;
    const frameId = req.body.frameId;

    if (!userId || !frameId) return res.status(400).json({ error: 'Missing params' });

    if (reservations[frameId] && reservations[frameId].userId === userId) {
        reservations[frameId].expiresAt = Date.now() + RESERVATION_TIME_MS;
        return res.json({ success: true, expiresAt: reservations[frameId].expiresAt });
    } else {
        return res.status(404).json({ error: 'Reservation not found or expired' });
    }
});

// API to upload a new frame

app.post('/api/upload', upload.single('frame'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const frameId = req.body.frameId;
    const authorName = req.body.authorName;
    const authorEmail = req.body.authorEmail;
    const turnstileToken = req.body['cf-turnstile-response'];
    const paymentIntentId = req.body.paymentIntentId;
    
    // 1) Vérification Turnstile (Captcha)
    if (process.env.TURNSTILE_SECRET_KEY) {
        if (!turnstileToken) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Captcha manquant' });
        }
        
        const cfResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `secret=${process.env.TURNSTILE_SECRET_KEY}&response=${turnstileToken}`
        });
        const cfResult = await cfResponse.json();
        if (!cfResult.success) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Captcha invalide' });
        }
    }

    // 2) Modération IA via OpenAI (GPT-4o Vision)
    if (process.env.OPENAI_API_KEY) {
        console.log(`Modération de la frame ${frameId} par OpenAI...`);
        try {
            // Lecture de l'image en Base64 pour l'envoyer à l'IA
            const imageBuffer = fs.readFileSync(req.file.path);
            const base64Image = imageBuffer.toString('base64');
            
            const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                },
                body: JSON.stringify({
                    model: "gpt-4o",
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "Cette image est du pixel art soumise par un utilisateur. Y a-t-il des symboles de haine, des croix gammées, du texte insultant ou du contenu offensant grave ? Réponds uniquement par OUI ou NON." },
                                { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } }
                            ]
                        }
                    ],
                    max_tokens: 10
                })
            });
            
            const aiData = await aiResponse.json();
            const verdict = aiData.choices[0].message.content.trim().toUpperCase();
            
            if (verdict.includes('OUI')) {
                console.log(`⚠️ Frame ${frameId} rejetée par l'IA.`);
                fs.unlinkSync(req.file.path);
                
                // Annuler l'empreinte bancaire
                if (paymentIntentId && stripe) {
                    try {
                        await stripe.paymentIntents.cancel(paymentIntentId);
                        console.log("Empreinte bancaire annulée.");
                    } catch (e) { console.error("Erreur annulation Stripe", e); }
                }
                return res.status(400).json({ error: 'Image rejetée par la modération.' });
            }
            console.log("✅ Frame validée par l'IA.");
        } catch (err) {
            console.error("Erreur API OpenAI", err);
            // On continue si l'IA plante (fail-open) ou tu peux choisir de bloquer (fail-closed)
        }
    }

    if (reservations[frameId]) {
        delete reservations[frameId]; 
    }
    
    // Process with Sharp to WebP
    const webpPath = req.file.path.replace('.png', '.webp');
    try {
        await sharp(req.file.path).webp({ quality: 80 }).toFile(webpPath);
        fs.unlinkSync(req.file.path);
        
        saveCredit(frameId, authorName);
        triggerVideoGeneration();
        
        // --- DEBUT INTEGRATION CROSSMINT ---
        if (authorEmail && process.env.CROSSMINT_API_KEY) {
            console.log(`Minting NFT pour ${authorEmail} (Frame ${frameId})...`);
            try {
                // Pour l'instant, comme tu es en local, on simule une URL publique. 
                // Sur le VPS, ce sera ton vrai domaine : https://ton-site.com
                const publicImageUrl = `https://ton-site.com/uploads/${req.file.filename.replace('.png', '.webp')}`;
                
                const response = await fetch('https://staging.crossmint.com/api/2022-06-09/collections/default/nfts', {
                    method: 'POST',
                    headers: {
                        'x-api-key': process.env.CROSSMINT_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        recipient: `email:${authorEmail}:polygon-amoy`,
                        metadata: {
                            name: `Mosaic Army Frame #${frameId}`,
                            image: publicImageUrl,
                            description: `Créé par ${authorName} pour le projet collaboratif Mosaic Army.`,
                            attributes: [
                                { display_type: "number", trait_type: "Frame Number", value: frameId },
                                { trait_type: "Artist", value: authorName }
                            ]
                        }
                    })
                });
                
                const data = await response.json();
                if (response.ok) {
                    console.log("✅ NFT minté avec succès sur Crossmint!", data);
                } else {
                    console.error("❌ Erreur API Crossmint:", data);
                }
            } catch (err) {
                console.error("❌ Exception Minting Crossmint:", err);
            }
        }
        // --- FIN INTEGRATION CROSSMINT ---
        
        res.json({ success: true, filename: req.file.filename.replace('.png', '.webp') });
    } catch (e) {
        console.error("Image processing error", e);
        res.status(500).json({ error: "Processing failed" });
    }
});


app.get('/api/credits', (req, res) => {
    res.json(getCredits());
});

app.get('/api/stripe-config', (req, res) => {
    if (!stripe || !process.env.STRIPE_PUBLISHABLE_KEY) {
        return res.json({ enabled: false });
    }
    res.json({ enabled: true, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

app.post('/api/create-payment-intent', express.json(), async (req, res) => {
    if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: parseInt(process.env.PRICE_PER_FRAME || 100, 10),
            currency: 'eur',
            automatic_payment_methods: { enabled: true }, 
        });
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});



// --- VOTES ---
const votesFile = path.join(__dirname, 'votes.json');
function getVotes() {
    try {
        if (fs.existsSync(votesFile)) {
            return JSON.parse(fs.readFileSync(votesFile, 'utf-8'));
        }
    } catch (e) {
        console.error("Error reading votes", e);
    }
    return {};
}

app.get('/api/votes', (req, res) => {
    res.json(getVotes());
});

app.post('/api/vote/:id', (req, res) => {
    const frameId = parseInt(req.params.id, 10);
    const votes = getVotes();
    if (!votes[frameId]) votes[frameId] = 0;
    votes[frameId]++;
    fs.writeFileSync(votesFile, JSON.stringify(votes, null, 2));
    res.json({ success: true, count: votes[frameId] });
});

// --- MIDDLEWARE ADMIN ---

const adminAuth = (req, res, next) => {
    const pwd = req.headers['authorization'];
    if (pwd && pwd === (process.env.ADMIN_PASSWORD || 'kaeladmin')) {
        next();
    } else {
        res.status(403).json({ error: 'Accès refusé. Mauvais mot de passe.' });
    }
};

app.get('/api/admin/frames', adminAuth, (req, res) => {
    const credits = getCredits();
    const framesData = [];
    
    // On liste les fichiers dans uploads
    const files = fs.readdirSync(path.join(__dirname, 'uploads'));
    files.forEach(file => {
        if (file.endsWith('.webp') && file.startsWith('frame_')) {
            const num = parseInt(file.replace('frame_', '').replace('.webp', ''), 10);
            framesData.push({
                id: num,
                author: credits[num] || 'Anonyme',
                url: `/frames/${file}?t=${Date.now()}`
            });
        }
    });
    
    // Trier par ID décroissant
    framesData.sort((a, b) => b.id - a.id);
    res.json(framesData);
});

app.post('/api/admin/ban/:id', adminAuth, async (req, res) => {
    const frameId = parseInt(req.params.id, 10);
    const filePath = path.join(__dirname, 'uploads', `frame_${frameId.toString().padStart(4, '0')}.webp`);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Frame introuvable' });
    }
    
    try {
        // 1. Supprimer le fichier
        fs.unlinkSync(filePath);
        
        // 2. Supprimer de credits.json
        const credits = getCredits();
        const updatedCredits = credits.filter(c => c.frameId !== frameId);
        fs.writeFileSync(creditsFile, JSON.stringify(updatedCredits, null, 2));
        
        // 3. Supprimer de votes.json
        const votes = getVotes();
        delete votes[frameId];
        fs.writeFileSync(votesFile, JSON.stringify(votes, null, 2));
        
        // 4. Regénérer
        triggerVideoGeneration();
        
        res.json({ success: true, message: 'Frame libérée.' });
    } catch (e) {
        console.error("Erreur ban", e);
        res.status(500).json({ error: e.message });
    }
});

app.listen(port, () => {
    triggerVideoGeneration();

    console.log(`Mosaic Army server running at http://localhost:${port}`);
});
