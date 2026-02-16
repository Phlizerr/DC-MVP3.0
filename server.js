const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const publicDir = path.join(__dirname, 'public');

const CATEGORY_ORDER = ['Stable', 'Tight', 'Fragile', 'Critical'];
const CATEGORY_COLORS = {
  Stable: '#2a9d6f',
  Tight: '#d9a11a',
  Fragile: '#d76b1e',
  Critical: '#bd3b3b'
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomFrom(min, max) {
  return Math.random() * (max - min) + min;
}

function formatSetpoint(value) {
  return Math.round(value * 10) / 10;
}

function determineCategory(thermalMargin, inletTemp, threshold) {
  const overThreshold = inletTemp > threshold;
  if (overThreshold || thermalMargin < 1.8) {
    return 'Critical';
  }
  if (thermalMargin < 3.0) {
    return 'Fragile';
  }
  if (thermalMargin < 4.5) {
    return 'Tight';
  }
  return 'Stable';
}

function getOverallHeadroomCategory(racks) {
  const worstIndex = racks.reduce((maxIdx, rack) => {
    const idx = CATEGORY_ORDER.indexOf(rack.category);
    return Math.max(maxIdx, idx);
  }, 0);
  return CATEGORY_ORDER[worstIndex];
}

function countFragileOrCritical(racks) {
  return racks.filter((r) => r.category === 'Fragile' || r.category === 'Critical').length;
}

function countCritical(racks) {
  return racks.filter((r) => r.category === 'Critical').length;
}

function buildBaseRacks() {
  const rows = ['A', 'B', 'C', 'D'];
  const cols = [1, 2, 3, 4, 5, 6];
  const racks = [];

  rows.forEach((row, rIdx) => {
    cols.forEach((col, cIdx) => {
      const threshold = randomFrom(32.5, 34.5);
      const baselineInlet = randomFrom(27.0, 33.8) + rIdx * 0.2 + cIdx * 0.08;
      const thermalMargin = threshold - baselineInlet;
      const category = determineCategory(thermalMargin, baselineInlet, threshold);
      const loadBand = baselineInlet > 31.5 ? 'Peak' : baselineInlet > 29.0 ? 'Elevated' : 'Nominal';

      racks.push({
        id: `R${row}${String(col).padStart(2, '0')}`,
        zone: `Zone-${row}`,
        row,
        col,
        threshold: Number(threshold.toFixed(1)),
        inletTemp: Number(baselineInlet.toFixed(1)),
        thermalMargin: Number(thermalMargin.toFixed(1)),
        category,
        loadBand
      });
    });
  });

  return racks;
}

function enforceRiskMoment(racks) {
  const sorted = [...racks].sort((a, b) => a.thermalMargin - b.thermalMargin);
  for (let i = 0; i < 4; i += 1) {
    const rack = sorted[i];
    rack.inletTemp = Number((rack.threshold - randomFrom(1.6, 2.7)).toFixed(1));
    rack.thermalMargin = Number((rack.threshold - rack.inletTemp).toFixed(1));
    rack.category = determineCategory(rack.thermalMargin, rack.inletTemp, rack.threshold);
  }
  return racks;
}

function buildInitialState() {
  const currentSetpoint = formatSetpoint(randomFrom(21.0, 22.7));
  let racks = buildBaseRacks();
  racks = enforceRiskMoment(racks);

  const overallHeadroom = getOverallHeadroomCategory(racks);
  const fragileOrCriticalCount = countFragileOrCritical(racks);

  const stressRack = [...racks].sort((a, b) => a.thermalMargin - b.thermalMargin)[0];

  return {
    timestamp: new Date().toISOString(),
    site: 'HPC Hall 2',
    source: 'DCIM/SCADA live telemetry (simulated feed)',
    currentSetpoint,
    overallHeadroom,
    fragileOrCriticalCount,
    criticalCount: countCritical(racks),
    racks,
    stressRack,
    allowedDeltaRange: {
      min: 0.0,
      max: 2.0,
      step: 0.2
    }
  };
}

function simulateChange(baseState, setpointDelta) {
  const delta = clamp(Number(setpointDelta), 0, 2);

  const postRacks = baseState.racks.map((rack) => {
    // First-order thermal model calibrated-like coefficient, slightly varying by zone/load.
    const zoneWeight = rack.zone.endsWith('D') ? 0.14 : rack.zone.endsWith('C') ? 0.1 : 0.06;
    const loadWeight = rack.loadBand === 'Peak' ? 0.2 : rack.loadBand === 'Elevated' ? 0.12 : 0.04;
    const k = 0.65 + zoneWeight + loadWeight;
    const tempIncrease = k * delta;

    const newInlet = Number((rack.inletTemp + tempIncrease).toFixed(1));
    const newMargin = Number((rack.threshold - newInlet).toFixed(1));
    const newCategory = determineCategory(newMargin, newInlet, rack.threshold);

    return {
      ...rack,
      inletTemp: newInlet,
      thermalMargin: newMargin,
      category: newCategory,
      prevCategory: rack.category,
      changed: newCategory !== rack.category
    };
  });

  const overallHeadroom = getOverallHeadroomCategory(postRacks);
  const criticalCount = countCritical(postRacks);
  const fragileOrCriticalCount = countFragileOrCritical(postRacks);

  const topAffected = [...postRacks]
    .sort((a, b) => {
      const catDelta = CATEGORY_ORDER.indexOf(b.category) - CATEGORY_ORDER.indexOf(a.category);
      if (catDelta !== 0) return catDelta;
      return a.thermalMargin - b.thermalMargin;
    })
    .slice(0, 3)
    .map((rack) => ({ id: rack.id, category: rack.category, prevCategory: rack.prevCategory }));

  const failureFlags = {
    inletSafeThresholdBreached: postRacks.some((rack) => rack.inletTemp > rack.threshold),
    headroomMarginBreached: postRacks.some((rack) => rack.thermalMargin < 1.8),
    coolingSafeRangeBreached: delta > 1.6 && fragileOrCriticalCount > baseState.fragileOrCriticalCount
  };

  return {
    setpointDelta: Number(delta.toFixed(1)),
    proposedSetpoint: formatSetpoint(baseState.currentSetpoint + delta),
    postHeadroom: overallHeadroom,
    postCriticalCount: criticalCount,
    postFragileOrCriticalCount: fragileOrCriticalCount,
    topAffected,
    postRacks,
    failureFlags,
    simulatedInMs: Math.floor(randomFrom(620, 1480))
  };
}

let currentState = buildInitialState();

function sendJSON(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function parseRequestBody(req, callback) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
    if (body.length > 1e6) {
      req.socket.destroy();
    }
  });
  req.on('end', () => {
    try {
      const parsed = body ? JSON.parse(body) : {};
      callback(null, parsed);
    } catch (err) {
      callback(err);
    }
  });
}

function serveStatic(req, res) {
  const reqPath = req.url === '/' ? '/index.html' : req.url;
  const safePath = path.normalize(reqPath).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };

    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/state') {
    sendJSON(res, 200, currentState);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/refresh') {
    currentState = buildInitialState();
    sendJSON(res, 200, currentState);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/simulate') {
    parseRequestBody(req, (err, body) => {
      if (err) {
        sendJSON(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      const delta = body && typeof body.delta !== 'undefined' ? body.delta : 0;
      const result = simulateChange(currentState, delta);
      sendJSON(res, 200, result);
    });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`HPC MVP server running at http://localhost:${PORT}`);
});
