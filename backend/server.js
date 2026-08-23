const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ── District registry — keys are LOWERCASE, match frontend id fields exactly ──
const DISTRICTS = {
    jalna: {
        name: 'Jalna',
        state: 'Maharashtra',
        lat: 19.8297, lon: 75.8800,
        agroZone: 'Marathwada Drought-Prone Zone',
        primaryCrops: ['Cotton', 'Soybean', 'Sorghum (Jowar)', 'Sweet Orange'],
    },
    bikaner: {
        name: 'Bikaner',
        state: 'Rajasthan',
        lat: 28.0167, lon: 73.3119,
        agroZone: 'Western Arid Desert Zone',
        primaryCrops: ['Bajra (Pearl Millet)', 'Moth Bean', 'Guar', 'Mustard'],
    },
    dewas: {
        name: 'Dewas',
        state: 'Madhya Pradesh',
        lat: 22.9624, lon: 76.0507,
        agroZone: 'Malwa Plateau Agricultural Belt',
        primaryCrops: ['Soybean', 'Wheat', 'Gram (Chickpea)', 'Cotton'],
    },
    // KEY: lowercase "anantapur" — matches frontend district id exactly
    anantapur: {
        name: 'Anantapur',
        state: 'Andhra Pradesh',
        lat: 14.6819, lon: 77.6006,
        agroZone: 'Rayalaseema Semi-Arid Zone',
        primaryCrops: ['Groundnut', 'Sunflower', 'Paddy', 'Red Chilli'],
    },
};

// ── Pure function: compute parametricDeficitEngine from raw sensor values ─────
function buildDeficitEngine(precipMm, moistureFraction) {
    const rainfallShortfallPercentage = Math.max(15, Math.min(85, 100 - (precipMm * 12 + 35)));
    const soilMoistureDeficitPercentage = Math.max(10, Math.min(90, (1 - moistureFraction) * 100 - 25));
    const droughtDurationWeeks = Math.max(1, Math.min(8, Math.floor(rainfallShortfallPercentage / 12)));
    const isTriggerMet = rainfallShortfallPercentage >= 30 || droughtDurationWeeks >= 2;

    let severityLevel = 'NORMAL';
    if (rainfallShortfallPercentage >= 60) severityLevel = 'CATASTROPHIC_DROUGHT';
    else if (rainfallShortfallPercentage >= 45) severityLevel = 'SEVERE_DROUGHT';
    else if (rainfallShortfallPercentage >= 30) severityLevel = 'MODERATE_DEFICIT';

    return { rainfallShortfallPercentage, soilMoistureDeficitPercentage, droughtDurationWeeks, isTriggerMet, severityLevel };
}

// ── GET /api/weather/:district ────────────────────────────────────────────────
// Response shape:
//   { district: { name, state, agroZone, primaryCrops[] }, parametricDeficitEngine: { ... } }
app.get('/api/weather/:district', async (req, res) => {
    const key = req.params.district.toLowerCase().trim();
    const info = DISTRICTS[key];

    if (!info) {
        return res.status(404).json({
            error: `Unknown district key "${key}". Valid keys: ${Object.keys(DISTRICTS).join(', ')}`,
        });
    }

    let precipMm = 0;
    let moistureFraction = 0.22; // safe default

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${info.lat}&longitude=${info.lon}&current=precipitation&hourly=soil_moisture_3_to_9cm&forecast_days=1`;
        const { data } = await axios.get(url, { timeout: 8000 });
        precipMm = data.current?.precipitation ?? 0;
        moistureFraction = data.hourly?.soil_moisture_3_to_9cm?.[0] ?? 0.22;
    } catch (err) {
        // Open-Meteo unreachable — use district-specific agronomic fallback values
        console.warn(`[KrishiSat] Open-Meteo fetch failed for "${key}": ${err.message}. Using fallback.`);
        // Anantapur (Rayalaseema) is historically the most water-stressed of the 4 districts
        precipMm = key === 'anantapur' ? 0.4 : key === 'bikaner' ? 0.6 : 1.8;
        moistureFraction = key === 'anantapur' ? 0.10 : key === 'bikaner' ? 0.14 : 0.21;
    }

    return res.json({
        district: {
            name: info.name,
            state: info.state,
            agroZone: info.agroZone,
            primaryCrops: info.primaryCrops,
        },
        parametricDeficitEngine: buildDeficitEngine(precipMm, moistureFraction),
    });
});

// ── POST /api/calculate-payout ────────────────────────────────────────────────
// Request body:  { shortfall: Number, weeks: Number }
// Response:      { payoutPerHectare: Number, tier: String }
app.post('/api/calculate-payout', (req, res) => {
    const shortfall = Number(req.body?.shortfall) || 0;
    const weeks = Number(req.body?.weeks) || 0;

    let payoutPerHectare = 0;
    let tier = 'BELOW_THRESHOLD';

    if (shortfall >= 60 || weeks >= 5) {
        payoutPerHectare = 50000;
        tier = 'TIER_3_CATASTROPHIC';
    } else if (shortfall >= 45 || weeks >= 3) {
        payoutPerHectare = 37500;
        tier = 'TIER_2_SEVERE';
    } else if (shortfall >= 30 || weeks >= 2) {
        payoutPerHectare = 25000;
        tier = 'TIER_1_MODERATE';
    }

    return res.json({ payoutPerHectare, tier });
});

// ── GET /api/ledger ───────────────────────────────────────────────────────────
// Response: Array of 12 randomized transaction objects
// Each object: { farmerName, cooperative, tier, amount, timestamp }
app.get('/api/ledger', (req, res) => {
    // Regional Indian names covering all 4 districts
    const names = [
        'Ramesh Pawar', 'Sanjay Deshmukh', 'Anil Kadam',
        'Amol Patil', 'Vikas Shinde', 'Hari Singh Bhati',
        'Rajendra Prasad', 'Mahendra Choudhary', 'Gopal Purohit',
        'Devendra Singh', 'Gaurav Malviya', 'Satish Patel',
        'Vijay Solanki', 'Rahul Verma', 'Yogesh Joshi',
        'K. Raghavulu', 'N. Venkatesh', 'M. Lakshmaiah',
        'P. Srinivasa Rao', 'Chandra Reddy',
    ];

    const regions = [
        { cooperative: 'Jalna, Maharashtra', base: 'MH-COOP-' },
        { cooperative: 'Bikaner, Rajasthan', base: 'RJ-COOP-' },
        { cooperative: 'Dewas, Madhya Pradesh', base: 'MP-COOP-' },
        { cooperative: 'Anantapur, Andhra Pradesh', base: 'AP-COOP-' },
    ];

    const tiers = [
        { label: 'TIER 1 MODERATE', amount: 25000 },
        { label: 'TIER 2 SEVERE', amount: 37500 },
        { label: 'TIER 3 CATASTROPHIC', amount: 50000 },
    ];

    const transactions = Array.from({ length: 12 }, (_, i) => {
        const name = names[Math.floor(Math.random() * names.length)];
        const region = regions[Math.floor(Math.random() * regions.length)];
        const tier = tiers[Math.floor(Math.random() * tiers.length)];

        const time = new Date();
        time.setMinutes(time.getMinutes() - i * 35);

        return {
            // farmerName is DYNAMIC — pulled from the names array above, never hardcoded
            farmerName: `${name} (${region.base}${2400 + i})`,
            cooperative: region.cooperative,
            tier: tier.label,
            amount: tier.amount,
            timestamp: time.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + ' IST',
        };
    });

    return res.json(transactions);
});

// ── Health check — confirms server is alive ───────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

app.listen(5000, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║  KrishiSat Core Data Engine  — port 5000    ║');
    console.log('  ║  Districts: jalna · bikaner · dewas ·        ║');
    console.log('  ║             anantapur                        ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
});