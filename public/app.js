const CATEGORY_COLORS = {
  Stable: '#2a9d6f',
  Tight: '#d9a11a',
  Fragile: '#d76b1e',
  Critical: '#bd3b3b'
};

const CATEGORY_ORDER = ['Stable', 'Tight', 'Fragile', 'Critical'];

let baseState = null;
let simState = null;
let currentStep = 1;

const els = {
  siteLabel: document.getElementById('siteLabel'),
  refreshStateBtn: document.getElementById('refreshStateBtn'),
  riskSentence: document.getElementById('riskSentence'),
  heatmapCurrent: document.getElementById('heatmapCurrent'),
  heatmapPost: document.getElementById('heatmapPost'),
  miniHeatmap: document.getElementById('miniHeatmap'),
  snapshotList: document.getElementById('snapshotList'),
  stressRackInfo: document.getElementById('stressRackInfo'),
  toDefineChangeBtn: document.getElementById('toDefineChangeBtn'),
  currentSetpoint: document.getElementById('currentSetpoint'),
  setpointSlider: document.getElementById('setpointSlider'),
  proposedSetpoint: document.getElementById('proposedSetpoint'),
  previewHeadroom: document.getElementById('previewHeadroom'),
  previewCritical: document.getElementById('previewCritical'),
  simulateBtn: document.getElementById('simulateBtn'),
  postSummary: document.getElementById('postSummary'),
  topAffected: document.getElementById('topAffected'),
  toTradeoffBtn: document.getElementById('toTradeoffBtn'),
  tradeDoHeadroom: document.getElementById('tradeDoHeadroom'),
  tradeApplyHeadroom: document.getElementById('tradeApplyHeadroom'),
  tradeDoCritical: document.getElementById('tradeDoCritical'),
  tradeApplyCritical: document.getElementById('tradeApplyCritical'),
  tradeoffSentence: document.getElementById('tradeoffSentence'),
  toSummaryBtn: document.getElementById('toSummaryBtn'),
  decisionSelect: document.getElementById('decisionSelect'),
  summaryBullets: document.getElementById('summaryBullets'),
  operatorName: document.getElementById('operatorName'),
  operatorNotes: document.getElementById('operatorNotes'),
  summaryTimestamp: document.getElementById('summaryTimestamp'),
  downloadBriefBtn: document.getElementById('downloadBriefBtn')
};

function badgeClass(category) {
  return category.toLowerCase();
}

function setStep(step) {
  currentStep = step;
  document.querySelectorAll('.step').forEach((node) => {
    node.classList.toggle('active', Number(node.dataset.step) === step);
  });

  document.querySelectorAll('.screen').forEach((node, idx) => {
    node.classList.toggle('active', idx + 1 === step);
  });
}

function renderHeatmap(target, racks, { mini = false, highlightDelta = false } = {}) {
  target.innerHTML = '';
  racks
    .slice()
    .sort((a, b) => a.row.localeCompare(b.row) || a.col - b.col)
    .forEach((rack) => {
      const el = document.createElement('div');
      el.className = `rack ${mini ? 'mini' : ''} ${highlightDelta && rack.changed ? 'delta' : ''}`;
      el.style.background = CATEGORY_COLORS[rack.category];
      el.textContent = rack.id;
      el.title = `${rack.id} | ${rack.zone} | ${rack.category} (${rack.inletTemp}C inlet)`;
      target.appendChild(el);
    });
}

function renderSnapshot() {
  const risky = ['Tight', 'Fragile', 'Critical'].includes(baseState.overallHeadroom);

  els.riskSentence.textContent = `Current load leaves ${baseState.overallHeadroom.toLowerCase()} thermal margin. Increasing setpoint may push zones critical.`;

  els.snapshotList.innerHTML = `
    <li>Current setpoint: ${baseState.currentSetpoint.toFixed(1)}C</li>
    <li>Overall headroom category: <span class="badge ${badgeClass(baseState.overallHeadroom)}">${baseState.overallHeadroom}</span></li>
    <li>Fragile/Critical racks: ${baseState.fragileOrCriticalCount}</li>
  `;

  const s = baseState.stressRack;
  els.stressRackInfo.textContent = `${s.id} (${s.zone}) is ${s.category}; inlet ${s.inletTemp}C near threshold ${s.threshold}C.`;
  els.toDefineChangeBtn.disabled = !risky;

  renderHeatmap(els.heatmapCurrent, baseState.racks);
}

function renderSliderPreview() {
  const delta = Number(els.setpointSlider.value);
  const proposed = baseState.currentSetpoint + delta;
  els.currentSetpoint.textContent = `${baseState.currentSetpoint.toFixed(1)}C`;
  els.proposedSetpoint.textContent = `${proposed.toFixed(1)}C (+${delta.toFixed(1)}C)`;

  const predictedIndex = Math.min(
    CATEGORY_ORDER.indexOf(baseState.overallHeadroom) + Math.round(delta / 0.7),
    CATEGORY_ORDER.length - 1
  );
  const predicted = CATEGORY_ORDER[predictedIndex];

  els.previewHeadroom.className = `badge ${badgeClass(predicted)}`;
  els.previewHeadroom.textContent = `${baseState.overallHeadroom} -> ${predicted}`;

  const estimatedCritical = Math.max(0, baseState.criticalCount + Math.floor(delta / 0.5));
  els.previewCritical.className = estimatedCritical > baseState.criticalCount ? 'badge critical' : 'badge neutral';
  els.previewCritical.textContent = `${baseState.criticalCount} -> ${estimatedCritical}`;
}

function renderSimulationViews() {
  if (!simState) return;

  renderHeatmap(els.heatmapPost, simState.postRacks, { highlightDelta: true });
  renderHeatmap(els.miniHeatmap, simState.postRacks, { mini: true });

  els.postSummary.textContent = `Post-change headroom: ${simState.postHeadroom}. Fragile/Critical racks: ${simState.postFragileOrCriticalCount}.`;

  els.topAffected.innerHTML = '';
  simState.topAffected.forEach((rack) => {
    const li = document.createElement('li');
    li.innerHTML = `${rack.id}: <span class="badge ${badgeClass(rack.prevCategory)}">${rack.prevCategory}</span> -> <span class="badge ${badgeClass(
      rack.category
    )}">${rack.category}</span>`;
    els.topAffected.appendChild(li);
  });

  els.tradeDoHeadroom.innerHTML = `<span class="badge ${badgeClass(baseState.overallHeadroom)}">${baseState.overallHeadroom}</span>`;
  els.tradeApplyHeadroom.innerHTML = `<span class="badge ${badgeClass(simState.postHeadroom)}">${simState.postHeadroom}</span>`;
  els.tradeDoCritical.innerHTML = `<span class="badge neutral">${baseState.criticalCount}</span>`;
  els.tradeApplyCritical.innerHTML = `<span class="badge ${
    simState.postCriticalCount > baseState.criticalCount ? 'critical' : 'neutral'
  }">${simState.postCriticalCount}</span>`;

  els.tradeoffSentence.textContent = `Applying increases critical racks from ${baseState.criticalCount} to ${simState.postCriticalCount}.`;

  const timeStamp = new Date().toLocaleString();
  els.summaryTimestamp.textContent = `Generated: ${timeStamp}`;
  els.summaryBullets.innerHTML = `
    <li>Change evaluated: Setpoint +${simState.setpointDelta.toFixed(1)}C (to ${simState.proposedSetpoint.toFixed(1)}C).</li>
    <li>Headroom shift: ${baseState.overallHeadroom} -> ${simState.postHeadroom}.</li>
    <li>Critical racks shift: ${baseState.criticalCount} -> ${simState.postCriticalCount}.</li>
    <li>Thermal map updated from live telemetry simulation (${simState.simulatedInMs} ms).</li>
  `;
}

async function getJSON(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}`);
  }
  return response.json();
}

async function loadInitialState() {
  baseState = await getJSON('/api/state');
  simState = null;

  els.siteLabel.textContent = `${baseState.site} | ${baseState.source}`;

  els.setpointSlider.min = baseState.allowedDeltaRange.min;
  els.setpointSlider.max = baseState.allowedDeltaRange.max;
  els.setpointSlider.step = baseState.allowedDeltaRange.step;
  els.setpointSlider.value = 0.6;

  renderSnapshot();
  renderSliderPreview();
  setStep(1);
}

async function runSimulation() {
  const delta = Number(els.setpointSlider.value);
  simState = await getJSON('/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delta })
  });

  renderSimulationViews();
}

async function navigateToStep(targetStep) {
  if (targetStep >= 3 && !simState) {
    await runSimulation();
  }
  setStep(targetStep);
}

function attachEvents() {
  els.refreshStateBtn.addEventListener('click', async () => {
    baseState = await getJSON('/api/refresh', { method: 'POST' });
    simState = null;
    renderSnapshot();
    renderSliderPreview();
    setStep(1);
  });

  els.toDefineChangeBtn.addEventListener('click', () => setStep(2));
  els.setpointSlider.addEventListener('input', renderSliderPreview);

  els.simulateBtn.addEventListener('click', async () => {
    els.simulateBtn.textContent = 'Running...';
    els.simulateBtn.disabled = true;
    try {
      await navigateToStep(3);
    } finally {
      els.simulateBtn.textContent = 'Simulate Exposure';
      els.simulateBtn.disabled = false;
    }
  });

  els.toTradeoffBtn.addEventListener('click', async () => navigateToStep(4));
  els.toSummaryBtn.addEventListener('click', async () => navigateToStep(5));

  document.querySelectorAll('.step').forEach((node) => {
    node.addEventListener('click', async () => {
      const targetStep = Number(node.dataset.step);
      await navigateToStep(targetStep);
    });
  });

  els.downloadBriefBtn.addEventListener('click', () => {
    const selectedDecision = els.decisionSelect.value;
    const operator = els.operatorName.value.trim() || 'Unknown Operator';
    const notes = els.operatorNotes.value.trim();

    const decisionLi = document.createElement('li');
    decisionLi.textContent = `Decision selected: ${selectedDecision}. Operator: ${operator}.`;
    const existingDecision = document.querySelector('#summaryBullets li[data-decision="true"]');
    if (existingDecision) existingDecision.remove();
    decisionLi.dataset.decision = 'true';
    els.summaryBullets.appendChild(decisionLi);

    const existingNotes = document.querySelector('#summaryBullets li[data-notes="true"]');
    if (existingNotes) existingNotes.remove();
    if (notes) {
      const notesLi = document.createElement('li');
      notesLi.textContent = `Operator notes: ${notes}`;
      notesLi.dataset.notes = 'true';
      els.summaryBullets.appendChild(notesLi);
    }

    window.print();
  });
}

attachEvents();
loadInitialState().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  alert('Failed to load state from backend.');
});
