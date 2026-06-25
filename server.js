const express = require('express');
const path = require('path');
const fs = require('fs');
const { sportData } = require('./radar-sport-api-master/index');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Sportradar API wrapper
const sport = new sportData('bet365', { getCommonContents: false });
const WORLD_CUP_SEASON_ID = 101177;

// In-memory cache for API responses
let cache = {
    fixtures: null,
    tables: null,
    lastFetched: 0
};

// Fallback files paths (in case Sportradar API is down or rate-limited)
const FALLBACK_FIXTURES = path.join(__dirname, 'world_cup_fixtures.json');
const FALLBACK_TABLES = path.join(__dirname, 'world_cup_tables.json');

// Baseline strength rating for World Cup teams (scale 1 to 10)
const TEAM_BASELINES = {
    'Argentina': 9.8,
    'France': 9.7,
    'Brazil': 9.6,
    'England': 9.5,
    'Spain': 9.4,
    'Portugal': 9.3,
    'Germany': 9.2,
    'Netherlands': 9.0,
    'Uruguay': 8.8,
    'Italy': 8.7,
    'Belgium': 8.6,
    'Croatia': 8.5,
    'Colombia': 8.3,
    'Morocco': 8.1,
    'Senegal': 8.0,
    'USA': 7.9,
    'Mexico': 7.8,
    'Japan': 7.7,
    'Korea Republic': 7.6,
    'Switzerland': 7.5,
    'Austria': 7.4,
    'Denmark': 7.3,
    'Sweden': 7.2,
    'Turkiye': 7.1,
    'Ecuador': 7.0,
    'Canada': 7.0,
    'Norway': 6.9,
    'Paraguay': 6.8,
    'Scotland': 6.7,
    'Egypt': 6.7,
    'Ivory Coast': 6.6,
    'South Africa': 6.5,
    'Algeria': 6.5,
    'Czechia': 6.4,
    'Ghana': 6.3,
    'Tunisia': 6.2,
    'Saudi Arabia': 6.0,
    'Uzbekistan': 5.9,
    'Qatar': 5.8,
    'Jordan': 5.7,
    'Iraq': 5.7,
    'Panama': 5.6,
    'Cape Verde': 5.5,
    'Bosnia and Herzegovina': 5.5,
    'Congo DR': 5.4,
    'Haiti': 5.0,
    'Curacao': 4.9,
    'New Zealand': 4.8
};

// Host countries for World Cup 2026 (they get a minor home advantage)
const HOST_COUNTRIES = ['USA', 'Mexico', 'Canada'];

// Fetch World Cup data from Sportradar or fall back to local JSON files
async function fetchWorldCupData() {
    const now = Date.now();
    // Cache for 10 minutes
    if (cache.fixtures && cache.tables && (now - cache.lastFetched < 10 * 60 * 1000)) {
        return;
    }

    try {
        console.log('Fetching World Cup data from Sportradar API...');
        
        // Fetch fixtures and standings parallelly
        const [fixturesRes, tablesRes] = await Promise.all([
            sport.getByPath(`en/America:Argentina:Buenos_Aires/gismo/stats_season_fixtures2/${WORLD_CUP_SEASON_ID}/1`),
            sport.getInfo('Europe:Berlin', 'stats_season_tables', WORLD_CUP_SEASON_ID)
        ]);

        if (fixturesRes && fixturesRes.doc && fixturesRes.doc[0]) {
            cache.fixtures = fixturesRes;
            fs.writeFileSync(FALLBACK_FIXTURES, JSON.stringify(fixturesRes, null, 2));
        }
        if (tablesRes && tablesRes.data) {
            cache.tables = tablesRes;
            fs.writeFileSync(FALLBACK_TABLES, JSON.stringify(tablesRes, null, 2));
        }
        
        cache.lastFetched = now;
        console.log('World Cup data successfully cached.');
    } catch (err) {
        console.warn('Sportradar API call failed. Loading local backup database...', err.message);
        
        // Load fallback files
        if (fs.existsSync(FALLBACK_FIXTURES)) {
            cache.fixtures = JSON.parse(fs.readFileSync(FALLBACK_FIXTURES, 'utf8'));
        }
        if (fs.existsSync(FALLBACK_TABLES)) {
            cache.tables = JSON.parse(fs.readFileSync(FALLBACK_TABLES, 'utf8'));
        }
        
        cache.lastFetched = now - 9 * 60 * 1000; // try again in 1 minute
    }
}

// External Live Games Cache
let externalGamesCache = { data: null, lastFetched: 0 };

function normalizeTeamName(name) {
    if (!name) return '';
    const map = {
        'United States': 'USA',
        'Turkey': 'Turkiye',
        'South Korea': 'Korea Republic',
        'Korea': 'Korea Republic',
        'Czech Republic': 'Czechia',
        'Democratic Republic of the Congo': 'Congo DR',
        'DR Congo': 'Congo DR',
        'Iran': 'Iran'
    };
    return map[name] || name;
}

async function fetchExternalLiveGames() {
    const now = Date.now();
    if (externalGamesCache.data && now - externalGamesCache.lastFetched < 30 * 1000) {
        return externalGamesCache.data;
    }
    return new Promise((resolve) => {
        const https = require('https');
        https.get('https://worldcup26.ir/get/games', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed && parsed.games) {
                        externalGamesCache.data = parsed.games;
                        externalGamesCache.lastFetched = now;
                        resolve(parsed.games);
                    } else {
                        resolve([]);
                    }
                } catch (e) {
                    console.error('Error parsing external games:', e);
                    resolve(externalGamesCache.data || []);
                }
            });
        }).on('error', (e) => {
            console.error('Error fetching external games:', e);
            resolve(externalGamesCache.data || []);
        });
    });
}

function getActualMatchMinute(minutesSinceKickoff, apiStatus) {
    const statusStr = apiStatus ? apiStatus.toString().toLowerCase().replace(/\s/g, '') : '';
    
    // If external API explicitly says it's halftime
    if (statusStr === 'halftime' || statusStr === 'ht' || statusStr === 'intervalo') {
        return 'Intervalo';
    }

    // First Half (including injury time up to 55m if API is still saying "live")
    if (minutesSinceKickoff <= 55) {
        if (minutesSinceKickoff > 45 && !apiStatus) {
            // For purely simulated matches without API, limit injury time to 48'
            if (minutesSinceKickoff > 48) return 'Intervalo';
        }
        return Math.floor(minutesSinceKickoff);
    } 
    // Interval window for simulated matches
    else if (minutesSinceKickoff > 55 && minutesSinceKickoff <= 60 && !apiStatus) {
        return 'Intervalo';
    } 
    // Second Half (Offset by 15 min interval)
    else {
        return Math.floor(minutesSinceKickoff) - 15;
    }
}

// Helper: check if a match has been played (has real goals scored)
function isMatchPlayed(m) {
    return m.result && m.result.home !== null && m.result.away !== null && !m.postponed && !m.canceled;
}

// Helper: check if a match is upcoming (in the future, no real score yet)
function isMatchUpcoming(m) {
    if (m.postponed || m.canceled || m.tobeannounced) return false;
    const nowUts = Date.now() / 1000;
    // If timestamp is in the future OR result has null goals
    const inFuture = m.time && m.time.uts > nowUts;
    const noScore = !m.result || m.result.home === null || m.result.away === null;
    return inFuture || noScore;
}

// Calculate team stats from matches played so far
function calculateTeamStats(matches) {
    const stats = {};

    matches.forEach(m => {
        // Skip matches not played yet or cancelled/postponed
        if (!isMatchPlayed(m)) return;
        
        const homeName = m.teams.home.name;
        const awayName = m.teams.away.name;

        // Skip placeholders
        if (/^[0-9]+[A-L]$/.test(homeName) || /^[A-L]$/.test(homeName) || homeName.startsWith('W') || homeName.startsWith('RU')) return;
        if (/^[0-9]+[A-L]$/.test(awayName) || /^[A-L]$/.test(awayName) || awayName.startsWith('W') || awayName.startsWith('RU')) return;

        const homeGoals = m.result.home;
        const awayGoals = m.result.away;

        // Initialize team stats if not present
        if (!stats[homeName]) stats[homeName] = { gp: 0, pts: 0, w: 0, d: 0, l: 0, gs: 0, gc: 0 };
        if (!stats[awayName]) stats[awayName] = { gp: 0, pts: 0, w: 0, d: 0, l: 0, gs: 0, gc: 0 };

        stats[homeName].gp += 1;
        stats[awayName].gp += 1;
        stats[homeName].gs += homeGoals;
        stats[homeName].gc += awayGoals;
        stats[awayName].gs += awayGoals;
        stats[awayName].gc += homeGoals;

        if (homeGoals > awayGoals) {
            stats[homeName].pts += 3;
            stats[homeName].w += 1;
            stats[awayName].l += 1;
        } else if (homeGoals < awayGoals) {
            stats[awayName].pts += 3;
            stats[awayName].w += 1;
            stats[homeName].l += 1;
        } else {
            stats[homeName].pts += 1;
            stats[awayName].pts += 1;
            stats[homeName].d += 1;
            stats[awayName].d += 1;
        }
    });

    return stats;
}

// Prediction Algorithm
function predictMatch(homeTeam, awayTeam, teamStats) {
    // If teams are placeholders (e.g. W73, 1A)
    const isHomePlaceholder = /^[0-9]+[A-L]$/.test(homeTeam) || homeTeam.length <= 3 || homeTeam.startsWith('W') || homeTeam.startsWith('RU');
    const isAwayPlaceholder = /^[0-9]+[A-L]$/.test(awayTeam) || awayTeam.length <= 3 || awayTeam.startsWith('W') || awayTeam.startsWith('RU');

    if (isHomePlaceholder || isAwayPlaceholder) {
        return {
            predicted: false,
            homeWin: 33,
            draw: 34,
            awayWin: 33,
            over25: 50,
            btts: 50,
            simulatedOdds: { homeWin: 2.8, draw: 2.7, awayWin: 2.8 }
        };
    }

    const baselineH = TEAM_BASELINES[homeTeam] || 6.5;
    const baselineA = TEAM_BASELINES[awayTeam] || 6.5;

    const statsH = teamStats[homeTeam] || { gp: 0, pts: 0, w: 0, d: 0, l: 0, gs: 0, gc: 0 };
    const statsA = teamStats[awayTeam] || { gp: 0, pts: 0, w: 0, d: 0, l: 0, gs: 0, gc: 0 };

    const ppgH = statsH.gp > 0 ? statsH.pts / statsH.gp : 0;
    const ppgA = statsA.gp > 0 ? statsA.pts / statsA.gp : 0;

    const agsH = statsH.gp > 0 ? statsH.gs / statsH.gp : 1.3;
    const agsA = statsA.gp > 0 ? statsA.gs / statsA.gp : 1.3;
    
    const agcH = statsH.gp > 0 ? statsH.gc / statsH.gp : 1.1;
    const agcA = statsA.gp > 0 ? statsA.gc / statsA.gp : 1.1;

    // Weight coefficients: baseline (40%) + tournament performance (60%)
    let strengthH = (baselineH * 0.4);
    let strengthA = (baselineA * 0.4);

    if (statsH.gp > 0) {
        strengthH += (ppgH * 1.5 + agsH * 0.5 - agcH * 0.5) * 0.6;
    } else {
        strengthH += (baselineH * 0.6);
    }

    if (statsA.gp > 0) {
        strengthA += (ppgA * 1.5 + agsA * 0.5 - agcA * 0.5) * 0.6;
    } else {
        strengthA += (baselineA * 0.6);
    }

    // Host advantage boost
    if (HOST_COUNTRIES.includes(homeTeam)) strengthH += 0.35;
    if (HOST_COUNTRIES.includes(awayTeam)) strengthA += 0.35;

    const diff = strengthH - strengthA;

    // Draw Probability
    let probDraw = 0.24 + 0.08 * Math.exp(-Math.abs(diff)); // higher draw chance when evenly matched

    // Normalize Winner Probabilities
    const ratioH = Math.exp(strengthH) / (Math.exp(strengthH) + Math.exp(strengthA));
    let probHome = (1 - probDraw) * ratioH;
    let probAway = (1 - probDraw) * (1 - ratioH);

    // Convert to percentages
    probHome = Math.round(probHome * 100);
    probDraw = Math.round(probDraw * 100);
    probAway = 100 - probHome - probDraw; // ensure they sum to exactly 100

    // Over 2.5 Goals Probability (Poisson approximation based on expected goals)
    const expectedGoals = (agsH + agcA + agsA + agcH) / 2;
    // Poisson cumulative probability for 0, 1, 2 goals
    const probUnder25 = Math.exp(-expectedGoals) * (1 + expectedGoals + (expectedGoals * expectedGoals) / 2);
    const probOver25 = Math.max(10, Math.min(90, Math.round((1 - probUnder25) * 100)));

    // Both Teams to Score (BTTS) Probability
    const expectedGoalsH = (agsH + agcA) / 2;
    const expectedGoalsA = (agsA + agcH) / 2;
    const probHomeScores = 1 - Math.exp(-expectedGoalsH);
    const probAwayScores = 1 - Math.exp(-expectedGoalsA);
    const probBtts = Math.max(10, Math.min(90, Math.round(probHomeScores * probAwayScores * 100)));

    // Simulated bookmaker odds (incorporating a standard 7% bookmaker margin)
    const oddsMargin = 0.93;
    const oddHome = Math.max(1.05, parseFloat((oddsMargin / (probHome / 100)).toFixed(2)));
    const oddDraw = Math.max(1.10, parseFloat((oddsMargin / (probDraw / 100)).toFixed(2)));
    const oddAway = Math.max(1.05, parseFloat((oddsMargin / (probAway / 100)).toFixed(2)));

    // Best Tip suggestion
    let bestTip = '';
    let bestTipDesc = '';
    let bestTipOdd = 1.0;

    if (probHome >= 55) {
        bestTip = `${homeTeam} Vence`;
        bestTipDesc = 'Resultado Final (1)';
        bestTipOdd = oddHome;
    } else if (probAway >= 55) {
        bestTip = `${awayTeam} Vence`;
        bestTipDesc = 'Resultado Final (2)';
        bestTipOdd = oddAway;
    } else if (probHome + probDraw >= 82) {
        bestTip = `${homeTeam} ou Empate`;
        bestTipDesc = 'Chance Dupla (1X)';
        bestTipOdd = parseFloat((oddsMargin / ((probHome + probDraw) / 100)).toFixed(2));
    } else if (probAway + probDraw >= 82) {
        bestTip = `${awayTeam} ou Empate`;
        bestTipDesc = 'Chance Dupla (X2)';
        bestTipOdd = parseFloat((oddsMargin / ((probAway + probDraw) / 100)).toFixed(2));
    } else if (probOver25 >= 60) {
        bestTip = 'Mais de 2.5 Gols';
        bestTipDesc = 'Total de Gols (Over 2.5)';
        bestTipOdd = parseFloat((oddsMargin / (probOver25 / 100)).toFixed(2));
    } else if (probBtts >= 60) {
        bestTip = 'Ambos Marcam Sim';
        bestTipDesc = 'Ambas Equipes Marcam';
        bestTipOdd = parseFloat((oddsMargin / (probBtts / 100)).toFixed(2));
    } else {
        // Safe default
        bestTip = 'Menos de 3.5 Gols';
        bestTipDesc = 'Total de Gols (Under 3.5)';
        // Assume under 3.5 has around 85% probability
        bestTipOdd = 1.25;
    }

    return {
        predicted: true,
        homeWin: probHome,
        draw: probDraw,
        awayWin: probAway,
        over25: probOver25,
        btts: probBtts,
        bestTip,
        bestTipDesc,
        bestTipOdd,
        simulatedOdds: {
        }
    };
}

// Seeded PRNG (pseudo-random number generator)
function createPRNG(seed) {
    let h = 1540483477 ^ seed;
    return function() {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
}

// Generate deterministic live scores, scorers, periods, and match statistics
function getSimulatedLiveMatch(m, minutesSinceKickoff, forcedHomeScore = null, forcedAwayScore = null) {
    const homeTeam = m.teams.home.name;
    const awayTeam = m.teams.away.name;
    
    const rand = createPRNG(m._id);
    
    let homeFinal = forcedHomeScore;
    let awayFinal = forcedAwayScore;
    
    if (homeFinal === null || awayFinal === null) {
        // Strengths
        const strengthH = TEAM_BASELINES[homeTeam] || 6.5;
        const strengthA = TEAM_BASELINES[awayTeam] || 6.5;
        
        // Expected goals based on strengths
        const expH = Math.max(0.5, 1.2 + (strengthH - strengthA) * 0.3);
        const expA = Math.max(0.5, 1.2 + (strengthA - strengthH) * 0.3);
        
        function sampleGoals(lambda) {
            let L = Math.exp(-lambda);
            let k = 0;
            let p = 1.0;
            do {
                k++;
                p *= rand();
            } while (p > L && k < 10);
            return k - 1;
        }
        
        homeFinal = sampleGoals(expH);
        awayFinal = sampleGoals(expA);
    }
    
    // Players lists
    const teamPlayers = {
        'Argentina': ['L. Messi', 'J. Álvarez', 'L. Martínez', 'A. Di María', 'R. De Paul', 'E. Fernández'],
        'France': ['K. Mbappé', 'A. Griezmann', 'O. Giroud', 'K. Coman', 'M. Thuram', 'O. Dembélé'],
        'Brazil': ['Vinícius Jr.', 'Rodrygo', 'Neymar Jr.', 'Raphinha', 'Richarlison', 'Gabriel Jesus'],
        'England': ['H. Kane', 'J. Bellingham', 'B. Saka', 'P. Foden', 'M. Rashford', 'O. Watkins'],
        'Spain': ['Alvaro Morata', 'Dani Olmo', 'Nico Williams', 'Lamine Yamal', 'Ferran Torres', 'Pedri'],
        'Portugal': ['Cristiano Ronaldo', 'Bruno Fernandes', 'Bernardo Silva', 'João Félix', 'Diogo Jota', 'Rafael Leão'],
        'Germany': ['F. Wirtz', 'J. Musiala', 'K. Havertz', 'N. Füllkrug', 'L. Sané', 'S. Gnabry'],
        'Netherlands': ['M. Depay', 'C. Gakpo', 'W. Weghorst', 'X. Simons', 'D. Malen', 'V. van Dijk'],
        'Uruguay': ['D. Núñez', 'L. Suárez', 'F. Valverde', 'G. de Arrascaeta', 'F. Pellistri'],
        'Italy': ['F. Chiesa', 'G. Scamacca', 'M. Retegui', 'N. Barella', 'L. Pellegrini'],
        'Belgium': ['R. Lukaku', 'K. De Bruyne', 'L. Trossard', 'J. Doku', 'Y. Tielemans'],
        'Croatia': ['A. Kramarić', 'L. Modrić', 'I. Perišić', 'M. Pašalić', 'M. Kovačić'],
        'Colombia': ['Luis Díaz', 'James Rodríguez', 'J. Arias', 'R. Borré', 'J. Durán'],
        'Morocco': ['Y. En-Nesyri', 'H. Ziyech', 'A. El Kaabi', 'B. Diaz', 'S. Amallah'],
        'Senegal': ['Sadio Mané', 'N. Jackson', 'I. Sarr', 'H. Diallo', 'P. Gueye'],
        'USA': ['C. Pulisic', 'T. Weah', 'F. Balogun', 'W. McKennie', 'G. Reyna'],
        'Mexico': ['S. Giménez', 'H. Martín', 'U. Antuna', 'L. Romo', 'O. Pineda'],
        'Japan': ['T. Kubo', 'K. Mitoma', 'A. Ueda', 'D. Kamada', 'T. Minamino'],
        'Korea Republic': ['Son Heung-min', 'Hwang Hee-chan', 'Lee Kang-in', 'Cho Gue-sung'],
        'Switzerland': ['B. Embolo', 'X. Shaqiri', 'Z. Amdouni', 'R. Freuler', 'G. Xhaka'],
        'Scotland': ['S. McTominay', 'J. McGinn', 'L. Shankland', 'C. Adams', 'R. Christie'],
        'Haiti': ['F. Frantzdy', 'D. Nazon', 'M. Antoine', 'F. Picault'],
        'South Africa': ['P. Tau', 'T. Zwane', 'Evidence Makgopa', 'M. Mayambela'],
        'Czechia': ['P. Schick', 'T. Souček', 'L. Provod', 'J. Kuchta'],
        'Qatar': ['Akram Afif', 'Almoez Ali', 'H. Al-Haydos'],
        'Bosnia and Herzegovina': ['E. Džeko', 'E. Demirović', 'H. Hajradinović'],
        'Canada': ['Jonathan David', 'Alphonso Davies', 'C. Larin', 'T. Buchanan']
    };
    
    const genericSurnames = ['Silva', 'Santos', 'Smith', 'Johnson', 'Müller', 'Dupont', 'García', 'Fernández', 'Ivanov', 'Kim', 'Sato'];
    
    function getScorer(teamName) {
        const list = teamPlayers[teamName];
        if (list && list.length > 0) {
            const idx = Math.floor(rand() * list.length);
            return list[idx];
        }
        const surname = genericSurnames[Math.floor(rand() * genericSurnames.length)];
        const initial = String.fromCharCode(65 + Math.floor(rand() * 26)); // A-Z
        return `${initial}. ${surname}`;
    }
    
    // Generate goal minutes and scorers
    const allGoals = [];
    
    for (let i = 0; i < homeFinal; i++) {
        let min = Math.floor(rand() * 90) + 1;
        allGoals.push({ team: 'home', minute: min, scorer: getScorer(homeTeam) });
    }
    
    for (let i = 0; i < awayFinal; i++) {
        let min = Math.floor(rand() * 90) + 1;
        allGoals.push({ team: 'away', minute: min, scorer: getScorer(awayTeam) });
    }
    
    // Sort goals by minute
    allGoals.sort((a, b) => a.minute - b.minute);
    
    // Build running score
    let homeRunning = 0;
    let awayRunning = 0;
    const goalEvents = allGoals.map(g => {
        if (g.team === 'home') homeRunning++;
        else awayRunning++;
        return {
            score: `${homeRunning}:${awayRunning}`,
            minute: `${g.minute}'`,
            scorer: g.scorer,
            team: g.team,
            rawMinute: g.minute
        };
    });
    
    // Filter goals that happened up to current minutesSinceKickoff
    const activeGoals = goalEvents.filter(g => g.rawMinute <= minutesSinceKickoff);
    
    // Calculate current scores
    const currentHomeScore = activeGoals.length > 0 ? activeGoals[activeGoals.length - 1].score.split(':')[0] : 0;
    const currentAwayScore = activeGoals.length > 0 ? activeGoals[activeGoals.length - 1].score.split(':')[1] : 0;
    
    // Generate period scores
    const p1Goals = activeGoals.filter(g => g.rawMinute <= 45);
    const p1Home = p1Goals.length > 0 ? p1Goals[p1Goals.length - 1].score.split(':')[0] : 0;
    const p1Away = p1Goals.length > 0 ? p1Goals[p1Goals.length - 1].score.split(':')[1] : 0;
    
    let periods = null;
    if (minutesSinceKickoff >= 45) {
        periods = {
            p1: { home: parseInt(p1Home), away: parseInt(p1Away) }
        };
        if (minutesSinceKickoff > 90) {
            periods.ft = { home: parseInt(currentHomeScore), away: parseInt(currentAwayScore) };
        }
    }
    
    // Generate deterministic stats
    const strengthH = TEAM_BASELINES[homeTeam] || 6.5;
    const strengthA = TEAM_BASELINES[awayTeam] || 6.5;
    const homePoss = Math.max(30, Math.min(70, Math.round(50 + (strengthH - strengthA) * 2.5 + (rand() - 0.5) * 8)));
    const awayPoss = 100 - homePoss;
    
    const minutesMultiplier = Math.min(minutesSinceKickoff, 90) / 90;
    
    let homeShots = Math.round(minutesMultiplier * (3 + (strengthH / 2) + rand() * 4));
    let awayShots = Math.round(minutesMultiplier * (3 + (strengthA / 2) + rand() * 4));
    homeShots = Math.max(parseInt(currentHomeScore), homeShots);
    awayShots = Math.max(parseInt(currentAwayScore), awayShots);
    
    let homeCorners = Math.round(minutesMultiplier * (2 + (strengthH / 3) + rand() * 3));
    let awayCorners = Math.round(minutesMultiplier * (2 + (strengthA / 3) + rand() * 3));
    
    const stats = {
        possession: { home: homePoss, away: awayPoss },
        shots: { home: homeShots, away: awayShots },
        corners: { home: homeCorners, away: awayCorners }
    };
    
    return {
        homeScore: parseInt(currentHomeScore),
        awayScore: parseInt(currentAwayScore),
        goals: activeGoals.map(g => ({ score: g.score, minute: g.minute, scorer: g.scorer })),
        periods,
        stats
    };
}

// Enable CORS middleware for local frontend loading (file://)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Static files middleware
app.use(express.static(path.join(__dirname, 'public')));

// API: Get World Cup Standings/Groups
app.get('/api/worldcup/standings', async (req, res) => {
    try {
        await fetchWorldCupData();
        if (!cache.tables || !cache.tables.data || !cache.tables.data.tables) {
            return res.status(500).json({ error: 'Standings data not available' });
        }
        res.json(cache.tables.data.tables);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Get World Cup Matches with Predictions
app.get('/api/worldcup/matches', async (req, res) => {
    try {
        await fetchWorldCupData();
        if (!cache.fixtures || !cache.fixtures.doc || !cache.fixtures.doc[0] || !cache.fixtures.doc[0].data) {
            return res.status(500).json({ error: 'Fixtures data not available' });
        }

        const d = cache.fixtures.doc[0].data;
        const matches = d.matches || [];
        const teamStats = calculateTeamStats(matches);
        const extGames = await fetchExternalLiveGames();

        // Map matches and add predictions
        const processedMatches = matches.map(m => {
            const homeName = m.teams.home.name;
            const awayName = m.teams.away.name;
            const prediction = predictMatch(homeName, awayName, teamStats);

            let result = m.result;
            const extMatch = extGames.find(eg => 
                normalizeTeamName(eg.home_team_name_en) === homeName && 
                normalizeTeamName(eg.away_team_name_en) === awayName
            );

            if (extMatch && extMatch.time_elapsed !== 'notstarted') {
                if (!result) result = {};
                result.home = parseInt(extMatch.home_score) || 0;
                result.away = parseInt(extMatch.away_score) || 0;
            }

            return {
                id: m._id,
                round: m.round,
                homeTeam: {
                    name: homeName,
                    mediumName: m.teams.home.mediumname,
                    abbr: m.teams.home.abbr,
                    logoId: m.teams.home._id
                },
                awayTeam: {
                    name: awayName,
                    mediumName: m.teams.away.mediumname,
                    abbr: m.teams.away.abbr,
                    logoId: m.teams.away._id
                },
                time: m.time,
                result: result,
                periods: m.periods,
                postponed: m.postponed,
                canceled: m.canceled,
                tobeannounced: m.tobeannounced,
                prediction
            };
        });

        // Split into played and upcoming using improved helpers
        const nowUts = Date.now() / 1000;
        const played = processedMatches.filter(m => 
            m.result && m.result.home !== null && m.result.away !== null && 
            !m.postponed && !m.canceled
        );
        const upcoming = processedMatches.filter(m => {
            if (m.postponed || m.canceled || m.tobeannounced) return false;
            const inFuture = m.time && m.time.uts > nowUts;
            const noScore = !m.result || m.result.home === null || m.result.away === null;
            return inFuture || noScore;
        });

        // Sort upcoming by date (unix timestamp)
        upcoming.sort((a, b) => a.time.uts - b.time.uts);
        // Sort played by date descending (latest first)
        played.sort((a, b) => b.time.uts - a.time.uts);

        res.json({
            upcoming,
            played,
            totalMatches: processedMatches.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Generate Smart Bet Slip
app.get('/api/worldcup/generate-slip', async (req, res) => {
    try {
        const risk = req.query.risk || 'moderate'; // conservative, moderate, aggressive
        await fetchWorldCupData();
        
        const d = cache.fixtures.doc[0].data;
        const matches = d.matches || [];
        const teamStats = calculateTeamStats(matches);
        
        // Filter upcoming matches that have names (not placeholders)
        const nowUts2 = Date.now() / 1000;
        let upcoming = matches
            .filter(m => {
                if (m.postponed || m.canceled || m.tobeannounced) return false;
                const inFuture = m.time && m.time.uts > nowUts2;
                const noScore = !m.result || m.result.home === null || m.result.away === null;
                return inFuture || noScore;
            })
            .map(m => {
                const prediction = predictMatch(m.teams.home.name, m.teams.away.name, teamStats);
                return {
                    id: m._id,
                    homeTeam: m.teams.home.name,
                    awayTeam: m.teams.away.name,
                    time: m.time,
                    prediction
                };
            })
            .filter(m => m.prediction.predicted); // Filter out placeholders

        let isSimulation = false;
        if (upcoming.length === 0) {
            isSimulation = true;
            // Fallback: If no future matches exist, take the last 8 played matches to simulate upcoming ones
            const playedMatches = matches.filter(m => isMatchPlayed(m));
            const sampleMatches = playedMatches.slice(-8); 
            upcoming = sampleMatches.map(m => {
                const prediction = predictMatch(m.teams.home.name, m.teams.away.name, teamStats);
                return {
                    id: m._id,
                    homeTeam: m.teams.home.name,
                    awayTeam: m.teams.away.name,
                    time: m.time,
                    prediction
                };
            }).filter(m => m.prediction.predicted);
        }

        if (upcoming.length === 0) {
            return res.status(400).json({ error: 'Nenhuma partida disponível para palpites.' });
        }

        let selectedBets = [];

        if (risk === 'conservative') {
            // High confidence selections (Double Chance, strong favorite wins, or Under 3.5 goals)
            const sorted = upcoming.sort((a, b) => {
                const scoreA = Math.max(a.prediction.homeWin, a.prediction.awayWin);
                const scoreB = Math.max(b.prediction.homeWin, b.prediction.awayWin);
                return scoreB - scoreA;
            });
            
            // Take top 2-3 matches
            const count = Math.min(3, sorted.length);
            for (let i = 0; i < count; i++) {
                const match = sorted[i];
                let type = 'DC'; // Double Chance
                let tip = '';
                let odds = 1.30;
                let prob = 80;

                if (match.prediction.homeWin > match.prediction.awayWin) {
                    tip = `${match.homeTeam} ou Empate`;
                    odds = parseFloat((0.93 / ((match.prediction.homeWin + match.prediction.draw) / 100)).toFixed(2));
                    prob = match.prediction.homeWin + match.prediction.draw;
                } else {
                    tip = `${match.awayTeam} ou Empate`;
                    odds = parseFloat((0.93 / ((match.prediction.awayWin + match.prediction.draw) / 100)).toFixed(2));
                    prob = match.prediction.awayWin + match.prediction.draw;
                }

                selectedBets.push({
                    matchId: match.id,
                    homeTeam: match.homeTeam,
                    awayTeam: match.awayTeam,
                    matchTime: match.time,
                    tip,
                    market: 'Chance Dupla',
                    odds: Math.max(1.15, odds),
                    probability: prob
                });
            }
        } else if (risk === 'aggressive') {
            // Search for high value tips, Over 2.5, BTTS, or clean wins. Combinations of 4-5 games.
            const sorted = upcoming.sort((a, b) => {
                // Sort by exciting predictions (over25 or BTTS, or very close matches)
                const scoreA = a.prediction.over25 + a.prediction.btts;
                const scoreB = b.prediction.over25 + b.prediction.btts;
                return scoreB - scoreA;
            });

            const count = Math.min(5, sorted.length);
            for (let i = 0; i < count; i++) {
                const match = sorted[i];
                selectedBets.push({
                    matchId: match.id,
                    homeTeam: match.homeTeam,
                    awayTeam: match.awayTeam,
                    matchTime: match.time,
                    tip: match.prediction.bestTip,
                    market: match.prediction.bestTipDesc,
                    odds: match.prediction.bestTipOdd,
                    probability: Math.max(match.prediction.homeWin, match.prediction.awayWin, match.prediction.over25, match.prediction.btts)
                });
            }
        } else {
            // 'moderate'
            // Clean wins or solid goals tips, combinations of 3 games.
            const sorted = upcoming.sort((a, b) => {
                // balanced sort
                const scoreA = Math.max(a.prediction.homeWin, a.prediction.awayWin) + a.prediction.over25 * 0.5;
                const scoreB = Math.max(b.prediction.homeWin, b.prediction.awayWin) + b.prediction.over25 * 0.5;
                return scoreB - scoreA;
            });

            const count = Math.min(3, sorted.length);
            for (let i = 0; i < count; i++) {
                const match = sorted[i];
                selectedBets.push({
                    matchId: match.id,
                    homeTeam: match.homeTeam,
                    awayTeam: match.awayTeam,
                    matchTime: match.time,
                    tip: match.prediction.bestTip,
                    market: match.prediction.bestTipDesc,
                    odds: match.prediction.bestTipOdd,
                    probability: Math.max(match.prediction.homeWin, match.prediction.awayWin, match.prediction.over25, match.prediction.btts)
                });
            }
        }

        // Calculate combined odds
        const totalOdds = parseFloat(selectedBets.reduce((acc, bet) => acc * bet.odds, 1).toFixed(2));

        res.json({
            risk,
            bets: selectedBets,
            totalOdds,
            successChance: Math.round(selectedBets.reduce((acc, bet) => acc * (bet.probability / 100), 1) * 100),
            isSimulation
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Live scores cache (refreshes every 30 seconds)
let liveCache = { data: null, lastFetched: 0 };

// API: Get Live Scores — shows today's or most recent matches with scores
app.get('/api/worldcup/live', async (req, res) => {
    try {
        await fetchWorldCupData();

        if (!cache.fixtures || !cache.fixtures.doc || !cache.fixtures.doc[0]) {
            return res.json({ live: [], message: 'Dados não disponíveis.' });
        }

        const now = Date.now() / 1000;
        const allMatches = cache.fixtures.doc[0].data.matches || [];

        // Find matches happening today (started up to 4h ago or starting in next 2h)
        let todayMatches = allMatches.filter(m => {
            if (m.postponed || m.canceled || !m.time) return false;
            const diff = now - m.time.uts;
            return diff >= -7200 && diff <= 14400;
        });

        // If no matches today, show the most recent 6 played matches as "results"
        let fallbackMode = false;
        if (todayMatches.length === 0) {
            fallbackMode = true;
            const played = allMatches
                .filter(m => !m.postponed && !m.canceled && m.result && m.result.home !== null && m.result.away !== null)
                .sort((a, b) => b.time.uts - a.time.uts)
                .slice(0, 8);
            todayMatches = played;
        }

        if (todayMatches.length === 0) {
            return res.json({ live: [], message: 'Nenhum jogo recente encontrado.' });
        }

        // Use cache if fresh (30s)
        const cacheAge = Date.now() - liveCache.lastFetched;
        if (liveCache.data && cacheAge < 30000) {
            return res.json({ live: liveCache.data, fallback: fallbackMode });
        }

        const extGames = await fetchExternalLiveGames();

        const liveData = todayMatches.map((m) => {
            let minutesSinceKickoff = m.time ? (now - m.time.uts) / 60 : -999;
            const homeTeamName = m.teams.home.name;
            const awayTeamName = m.teams.away.name;

            const base = {
                id: m._id,
                homeTeam: homeTeamName,
                awayTeam: awayTeamName,
                homeAbbr: m.teams.home.abbr || '',
                awayAbbr: m.teams.away.abbr || '',
                kickoff: m.time ? m.time.uts : 0,
                scheduled: m.time ? (m.time.time + ' ' + m.time.date) : ''
            };

            const extMatch = extGames.find(eg => 
                normalizeTeamName(eg.home_team_name_en) === homeTeamName && 
                normalizeTeamName(eg.away_team_name_en) === awayTeamName
            );

            // Check if match was played (has real goals in static fixtures data)
            const localHome = m.result ? m.result.home : null;
            const localAway = m.result ? m.result.away : null;
            const isPlayed = localHome !== null && localAway !== null;
            const isLiveByTime = !isPlayed && minutesSinceKickoff >= 5 && minutesSinceKickoff <= 130;
            const isStarting = !isPlayed && minutesSinceKickoff >= 0 && minutesSinceKickoff < 5;

            if (extMatch && extMatch.time_elapsed !== 'notstarted') {
                const homeScore = parseInt(extMatch.home_score) || 0;
                const awayScore = parseInt(extMatch.away_score) || 0;
                
                let status = 'live';
                let liveMinute = extMatch.time_elapsed;
                let period = null;
                
                if (extMatch.finished === 'TRUE' || extMatch.time_elapsed === 'finished' || extMatch.time_elapsed === 'Finished') {
                    status = 'finished';
                    liveMinute = null;
                    period = 'nt';
                } else {
                    if (liveMinute === 'live' || liveMinute === 'half time' || liveMinute === 'halftime' || liveMinute === 'HT') {
                        liveMinute = getActualMatchMinute(minutesSinceKickoff, liveMinute);
                    }
                }
                
                let winner = null;
                if (status === 'finished') {
                    if (homeScore > awayScore) winner = 'home';
                    else if (homeScore < awayScore) winner = 'away';
                    else winner = 'draw';
                }

                let goals = [];
                function parseScorers(scorersStr, team) {
                    if (!scorersStr || scorersStr === 'null') return;
                    const str = scorersStr.replace(/^{/, '').replace(/}$/, '');
                    const parts = str.split('","').map(p => p.replace(/"/g, ''));
                    parts.forEach(p => {
                        const match = p.match(/(.+?)\s+(\d+\+?\d*')(\s*\(p\))?/);
                        if (match) {
                            goals.push({
                                team,
                                scorer: match[1].trim(),
                                minute: match[2],
                                score: '' 
                            });
                        }
                    });
                }
                parseScorers(extMatch.home_scorers, 'home');
                parseScorers(extMatch.away_scorers, 'away');

                let simMinutes = 90;
                if (!isNaN(parseInt(liveMinute))) {
                    simMinutes = parseInt(liveMinute);
                } else if (liveMinute === 'Intervalo') {
                    simMinutes = 45;
                } else if (liveMinute === 'Parada Técnica') {
                    simMinutes = minutesSinceKickoff < 60 ? 30 : 75;
                } else if (status !== 'finished') {
                    simMinutes = 45;
                }
                const simStats = getSimulatedLiveMatch(m, simMinutes, homeScore, awayScore).stats;

                return {
                    ...base,
                    homeScore,
                    awayScore,
                    period,
                    winner,
                    status,
                    liveMinute,
                    goals,
                    periods: null,
                    stats: simStats
                };
            }

            // Fallback to beautiful deterministic simulation engine!
            if (isPlayed) {
                const sim = getSimulatedLiveMatch(m, 999, localHome, localAway);
                return {
                    ...base,
                    homeScore: sim.homeScore,
                    awayScore: sim.awayScore,
                    period: 'nt',
                    winner: localHome > localAway ? 'home' : (localHome < localAway ? 'away' : 'draw'),
                    status: 'finished',
                    liveMinute: null,
                    goals: sim.goals,
                    periods: sim.periods,
                    stats: sim.stats
                };
            } else if (isLiveByTime || isStarting) {
                let status = 'live';
                let liveMinute = getActualMatchMinute(minutesSinceKickoff, null);
                
                let simMinutes = 90;
                if (!isNaN(parseInt(liveMinute))) {
                    simMinutes = parseInt(liveMinute);
                } else if (liveMinute === 'Intervalo') {
                    simMinutes = 45;
                } else if (liveMinute === 'Parada Técnica') {
                    simMinutes = minutesSinceKickoff < 60 ? 30 : 75;
                } else {
                    simMinutes = 45;
                }
                
                const sim = getSimulatedLiveMatch(m, simMinutes, null, null);
                
                return {
                    ...base,
                    homeScore: sim.homeScore,
                    awayScore: sim.awayScore,
                    period: minutesSinceKickoff > 45 ? 'p2' : 'p1',
                    winner: null,
                    status: 'live',
                    liveMinute: liveMinute,
                    goals: sim.goals,
                    periods: sim.periods,
                    stats: sim.stats
                };
            } else if (isStarting) {
                let liveMinute = Math.min(Math.floor(minutesSinceKickoff), 90);
                return {
                    ...base,
                    homeScore: 0,
                    awayScore: 0,
                    period: 'p1',
                    winner: null,
                    status: 'live',
                    liveMinute: liveMinute,
                    goals: [],
                    periods: null,
                    stats: {
                        possession: { home: 50, away: 50 },
                        shots: { home: 0, away: 0 },
                        corners: { home: 0, away: 0 }
                    }
                };
            } else {
                // Scheduled (future match)
                return {
                    ...base,
                    homeScore: '-',
                    awayScore: '-',
                    period: null,
                    winner: null,
                    status: 'scheduled',
                    liveMinute: null,
                    goals: [],
                    periods: null
                };
            }
        });

        liveCache = { data: liveData, lastFetched: Date.now() };
        res.json({ live: liveData, fallback: fallbackMode });

    } catch (err) {
        console.error('Live endpoint error:', err.message);
        res.status(500).json({ error: err.message, live: [] });
    }
});

// Start Server and bootstrap data
app.listen(PORT, async () => {
    console.log(`Server started on http://localhost:${PORT}`);
    // Bootstrap data on startup
    await fetchWorldCupData();
});
