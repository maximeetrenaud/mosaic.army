// Global state
const playerEl = document.getElementById('hero-video');
const interactiveEl = document.getElementById('interactive-frame');
const canvas = document.getElementById('drawing-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const submitBtn = document.getElementById('submit-btn');
const authorInput = document.getElementById('author-name');
const emailInput = document.getElementById('author-email');
const paymentWrapper = document.getElementById('payment-wrapper');
const btnWrapper = document.querySelector('.btn-wrapper');
const loadingText = document.getElementById('loading-text');

let isDrawing = false;
let pixelSize = 8;
let brushMultiplier = 1;
let currentTool = 'draw';
let currentColor = '#000000';
let nextFrameId = 1;
let totalFrames = 0;
let isPlaying = false;
let currentInteractiveFrame = 1;
let currentHeroFrame = 1;
let creditsMap = {};
let votesMap = {};
let playTimeout = null;

// Palette Endesga 64
const palette64 = [
    "#0e071b","#131313","#1a1932","#1b1b1b","#1c121c","#272727","#2a2f4e","#391f21",
    "#3b1443","#3d3d3d","#424c6e","#5d5d5d","#657392","#858585","#92a1b9","#b4b4b4",
    "#c7cfdd","#ffffff","#fdd2ed","#f9e6cf","#f6ca9f","#e69c69","#edab50","#f68187",
    "#ea323c","#d95763","#c42430","#891e2b","#5d2c28","#571c27","#8a4836","#bf6f4a",
    "#ff0040","#f5555d","#c64524","#8e251d","#ff5000","#ed7614","#e07438","#ffa214",
    "#ffc825","#ffeb57","#d3fc7e","#99e65f","#5ac54f","#33984b","#1e6f50","#134c4c",
    "#0c2e44","#00396d","#0069aa","#0098dc","#00cdf9","#0cf1ff","#94fdff","#03193f",
    "#0c0293","#3003d9","#7a09fa","#db3ffd","#f389f5","#ca52c9","#c85086","#93388f",
    "#622461"
];

function initPalette() {
    const paletteContainer = document.getElementById('color-palette');
    palette64.forEach((color, index) => {
        const btn = document.createElement('div');
        btn.className = 'color-btn' + (index === 0 ? ' active' : '');
        btn.style.cssText = 'width: 20px; height: 20px; background:' + color + '; cursor: pointer; border-radius: 3px;';
        btn.addEventListener('click', () => {
            currentTool = 'draw';
            currentColor = color;
            document.querySelectorAll('.color-btn').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
        });
        paletteContainer.appendChild(btn);
    });
}

// Initialize
async function init() {
    ctx.imageSmoothingEnabled = false;
    setupDrawing();
    initPalette();
    await initStripe();
    loadStatus();
    loadCredits();
    loadTopFrames();
    startAnimation();
}

function setupDrawing() {
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    window.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('touchstart', startDrawing, { passive: false });
    canvas.addEventListener('touchmove', draw, { passive: false });
    canvas.addEventListener('touchend', stopDrawing);
}

function startDrawing(e) { e.preventDefault(); isDrawing = true; draw(e); }
function stopDrawing() { isDrawing = false; }

function draw(e) {
    if (!isDrawing) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = ((e.touches ? e.touches[0].clientX : e.clientX) - rect.left) * (canvas.width / rect.width);
    const y = ((e.touches ? e.touches[0].clientY : e.clientY) - rect.top) * (canvas.height / rect.height);
    const gridX = Math.floor(x / pixelSize) * pixelSize;
    const gridY = Math.floor(y / pixelSize) * pixelSize;
    
    if (currentTool === 'draw') { ctx.fillStyle = currentColor; ctx.fillRect(gridX, gridY, pixelSize * brushMultiplier, pixelSize * brushMultiplier); }
    else { ctx.clearRect(gridX, gridY, pixelSize * brushMultiplier, pixelSize * brushMultiplier); }
}

async function loadStatus() {
    const res = await fetch(`/api/status?userId=temp`);
    const data = await res.json();
    totalFrames = data.totalFrames;
    nextFrameId = data.nextFrameId;
    if (totalFrames > 0) {
        if (playerEl) playerEl.style.display = 'block';
        if (interactiveEl) {
            interactiveEl.style.display = 'block';
            scheduleInteractiveFrame();
        }
    }
}

function scheduleInteractiveFrame() {
    if (!isPlaying || !interactiveEl) return;
    const frameStr = String(currentInteractiveFrame).padStart(5, '0');
    interactiveEl.src = `/frames/frame_${frameStr}.webp?t=${Date.now()}`;
    updateFrameInfo(currentInteractiveFrame);
    currentInteractiveFrame = (currentInteractiveFrame % totalFrames) + 1;
    setTimeout(scheduleInteractiveFrame, 1000 / 10);
}

function startAnimation() {
    initPlayerExtras();
    loadingText.style.display = 'none';
    if (heroVideo) { heroVideo.src = `/animation.webm?t=${Date.now()}`; heroVideo.style.display = 'block'; }
    if (interactiveEl) { interactiveEl.style.display = 'block'; scheduleInteractiveFrame(); }
    setInterval(() => {
        const frameStr = String(currentHeroFrame).padStart(5, '0');
        playerEl.src = `/frames/frame_${frameStr}.webp?t=${Date.now()}`;
        currentHeroFrame = (currentHeroFrame % totalFrames) + 1;
    }, 100);
}

// Player Extras (Credits, Votes)
async function initPlayerExtras() {
    try {
        const [credRes, voteRes] = await Promise.all([fetch('/api/credits'), fetch('/api/votes')]);
        const credData = await credRes.json();
        votesMap = await voteRes.json();
        credData.forEach(c => creditsMap[c.frameId] = c.authorName);
        loadTopFrames();
    } catch (e) {}
}

function updateFrameInfo(frameId) {
    const author = creditsMap[frameId] || 'Anonyme';
    const info = document.getElementById('frame-info');
    if (info) info.innerText = `Frame #${frameId} par ${author}`;
    const vCount = document.getElementById('vote-count');
    if (vCount) vCount.innerText = votesMap[frameId] || 0;
}

async function loadTopFrames() {
    const grid = document.getElementById('top-frames-grid');
    if (!grid) return;
    const framesArr = Object.keys(votesMap).map(id => ({ id: parseInt(id), votes: votesMap[id] }));
    framesArr.sort((a, b) => b.votes - a.votes);
    grid.innerHTML = framesArr.slice(0, 12).map((f, i) => `<div>Frame #${f.id} (❤️ ${f.votes})</div>`).join('');
}

// Stripe and Upload Logic
async function initStripe() {
    const configRes = await fetch('/api/stripe-config');
    const config = await configRes.json();
    if (!config.enabled) return;

    const stripe = Stripe(config.publishableKey);
    const piRes = await fetch('/api/create-payment-intent', { method: 'POST' });
    const { clientSecret } = await piRes.json();
    const elements = stripe.elements({ clientSecret });
    elements.create('payment').mount('#payment-element');
    paymentWrapper.style.display = 'block';
    submitBtn.disabled = false;

    submitBtn.addEventListener('click', async () => {
        const token = document.querySelector('[name="cf-turnstile-response"]')?.value;
        if (!token) return alert('Captcha requis');
        const { paymentIntent } = await stripe.confirmPayment({ elements, redirect: 'if_required' });
        if (paymentIntent) uploadFrame(paymentIntent.id, token);
    });
}

async function uploadFrame(piId, token) {
    const formData = new FormData();
    formData.append('frameId', nextFrameId);
    formData.append('authorName', authorInput.value);
    formData.append('authorEmail', emailInput.value);
    formData.append('paymentIntentId', piId);
    formData.append('cf-turnstile-response', token);
    canvas.toBlob(blob => {
        formData.append('frame', blob, 'frame.webp');
        fetch('/api/upload', { method: 'POST', body: formData }).then(r => r.ok && alert('Envoyé!'));
    });
}

init();
