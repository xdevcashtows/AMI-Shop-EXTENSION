/** @type {any} */
let currentSession = null;
/** @type {number | null} */
let currentTabId = null;
/** @type {number | null} */
let panelWindowId = null;
let activeTabIsSupplier = false;

function extensionAlive() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function sendMessage(message) {
  return new Promise((resolve) => {
    if (!extensionAlive()) {
      resolve({
        ok: false,
        error: 'Extension was reloaded — refresh this supplier tab'
      });
      return;
    }
    try {
      const payload =
        currentTabId != null ? { ...message, tabId: currentTabId } : message;
      chrome.runtime.sendMessage(payload, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({
            ok: false,
            error: /invalidated/i.test(err.message || '')
              ? 'Extension was reloaded — refresh this supplier tab'
              : err.message
          });
          return;
        }
        resolve(response ?? { ok: true });
      });
    } catch (error) {
      resolve({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Extension was reloaded — refresh this supplier tab'
      });
    }
  });
}

const els = {
  subtitle: document.getElementById('subtitle'),
  supplierBadge: document.getElementById('supplierBadge'),
  jobLabel: document.getElementById('jobLabel'),
  ymmLabel: document.getElementById('ymmLabel'),
  vehicleLabel: document.getElementById('vehicleLabel'),
  copyVinBtn: document.getElementById('copyVinBtn'),
  fillVinBtn: document.getElementById('fillVinBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  cartTitle: document.getElementById('cartTitle'),
  cartEmpty: document.getElementById('cartEmpty'),
  cartCount: document.getElementById('cartCount'),
  cartTable: document.getElementById('cartTable'),
  cartBody: document.getElementById('cartBody'),
  hoursColHeader: document.getElementById('hoursColHeader'),
  partSuppliesToggle: document.getElementById('partSuppliesToggle'),
  partSuppliesEnabled: document.getElementById('partSuppliesEnabled'),
  status: document.getElementById('status'),
  clearBtn: document.getElementById('clearBtn'),
  extractBtn: document.getElementById('extractBtn'),
  transferBtn: document.getElementById('transferBtn')
};

let extracting = false;

function setStatus(text, kind) {
  els.status.textContent = text || '';
  els.status.classList.remove('ok', 'err');
  if (kind) els.status.classList.add(kind);
}

function money(value) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD'
  });
}

function ymmText(vehicle) {
  if (!vehicle) return '—';
  const ymm = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ');
  return ymm || '—';
}

function renderVinHtml(vehicle) {
  const vin = String(vehicle?.vin || '').trim();
  if (!vin) return '—';
  if (vin.length <= 4) {
    return `<span class="vin-tail">${escapeHtml(vin)}</span>`;
  }
  const head = vin.slice(0, -4);
  const tail = vin.slice(-4);
  return `${escapeHtml(head)}<span class="vin-tail">${escapeHtml(tail)}</span>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setCartCount(count) {
  if (!els.cartCount) return;
  if (count > 0) {
    els.cartCount.textContent = String(count);
    els.cartCount.classList.remove('hidden');
  } else {
    els.cartCount.classList.add('hidden');
  }
}

function supplierDisplayName(supplier, long) {
  if (supplier === 'napa') return long ? 'NAPA ProLink' : 'NAPA';
  if (supplier === 'webest') return 'WebEst';
  if (supplier === 'autointegrate') return 'Auto Integrate';
  if (supplier === 'erepair') return long ? 'eRepair / Wheels' : 'eRepair';
  return long ? "O'Reilly / FirstCall" : "O'Reilly";
}

function isFleetSyncSupplier(supplier) {
  return supplier === 'autointegrate' || supplier === 'erepair';
}

function isLaborOnlyLine(line) {
  return (
    line?.lineKind === 'labor' ||
    (!String(line?.partNumber || '').trim() &&
      !(Number(line?.cost) > 0) &&
      Number(line?.laborHours) > 0)
  );
}

function normalizeLaborCategory(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isSuppliesActivityCategory(value) {
  const normalized = normalizeLaborCategory(value);
  return (
    normalized === 'paint panel' ||
    normalized === 'paint' ||
    normalized === 'clearcoat' ||
    normalized === 'clear coat' ||
    normalized === 'underside' ||
    normalized === 'blend' ||
    normalized === 'edging'
  );
}

function formatCartHours(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return String(Math.round(value * 100) / 100);
}

function sumPartSuppliesHours(lines) {
  return (lines || []).reduce((sum, line) => {
    if (!isLaborOnlyLine(line)) return sum;
    const category = line.laborCategory || line.description || '';
    if (!isSuppliesActivityCategory(category)) return sum;
    const hours = Number(line.laborHours);
    return sum + (Number.isFinite(hours) ? hours : 0);
  }, 0);
}

function isPartSuppliesEnabled(session) {
  return session?.partSuppliesEnabled !== false;
}

function buildPartSuppliesLine(hours) {
  return {
    partNumber: '',
    description: 'Paint Supplies',
    laborCategory: 'Paint Supplies',
    laborHours: hours,
    quantity: hours,
    cost: 0,
    lineKind: 'part',
    vendor: 'WebEst'
  };
}

function linesForTransfer(session) {
  const lines = Array.isArray(session?.lines) ? [...session.lines] : [];
  const hours = sumPartSuppliesHours(lines);
  if (isPartSuppliesEnabled(session) && hours > 0) {
    lines.push(buildPartSuppliesLine(hours));
  }
  return lines;
}

function setPartSuppliesToggleVisible(visible) {
  els.partSuppliesToggle?.classList.toggle('hidden', !visible);
}

function jobNumberLabel(session) {
  if (session?.jobNumber) return `Job ${session.jobNumber}`;
  if (session?.jobCardId) return `Job ${String(session.jobCardId).slice(0, 8)}…`;
  return 'Draft job';
}

function applyChrome({ fleet, hasSession, hasVin }) {
  document.body.classList.toggle('layout-fleet', fleet);
  document.body.classList.toggle('layout-shop', !fleet);
  if (els.cartTitle) {
    els.cartTitle.textContent = fleet ? 'Repair Order' : 'Shop Cart';
  }
  els.copyVinBtn?.classList.toggle('hidden', fleet);
  els.fillVinBtn?.classList.toggle('hidden', fleet);
  els.refreshBtn?.classList.toggle('hidden', fleet);
  els.clearBtn?.classList.toggle('hidden', fleet);
  els.extractBtn?.classList.toggle('hidden', !fleet);
  if (els.copyVinBtn) els.copyVinBtn.disabled = fleet || !hasVin;
  if (els.fillVinBtn) els.fillVinBtn.disabled = fleet || !hasVin;
  if (els.extractBtn) els.extractBtn.disabled = !hasSession || extracting;
  if (els.transferBtn) {
    els.transferBtn.textContent = fleet ? 'Update Job Card' : 'Transfer to Job Card';
  }
}

function wasTransferred(session) {
  return Boolean(session?.transferredAt) && !(session?.lines || []).length;
}

function renderEmptyState({ title, hint }) {
  els.cartEmpty.classList.remove('hidden');
  els.cartEmpty.innerHTML = `
      <span class="empty-title">${escapeHtml(title)}</span>
      <span class="empty-hint">${escapeHtml(hint)}</span>
    `;
  els.cartTable.classList.add('hidden');
  els.cartBody.innerHTML = '';
}

function render() {
  const session = currentSession;
  if (!activeTabIsSupplier) {
    applyChrome({ fleet: false, hasSession: false, hasVin: false });
    els.subtitle.textContent = 'Switch to a supplier tab';
    els.supplierBadge.classList.add('hidden');
    els.jobLabel.textContent = '—';
    els.ymmLabel.textContent = '—';
    els.vehicleLabel.innerHTML = '—';
    els.transferBtn.disabled = true;
    setCartCount(0);
    els.hoursColHeader?.classList.add('hidden');
    setPartSuppliesToggleVisible(false);
    renderEmptyState({
      title: 'No supplier tab selected',
      hint: 'Switch to a NAPA, O’Reilly, WebEst, Auto Integrate, or eRepair tab to see that job’s cart.'
    });
    return;
  }

  if (!session) {
    applyChrome({ fleet: false, hasSession: false, hasVin: false });
    els.subtitle.textContent = 'No active session — start from a job card';
    els.supplierBadge.classList.add('hidden');
    els.jobLabel.textContent = '—';
    els.ymmLabel.textContent = '—';
    els.vehicleLabel.innerHTML = '—';
    els.transferBtn.disabled = true;
    setCartCount(0);
    els.hoursColHeader?.classList.add('hidden');
    setPartSuppliesToggleVisible(false);
    renderEmptyState({
      title: 'No active session',
      hint: 'Start shopping from a job card in AMI Shop CRM.'
    });
    return;
  }

  const supplierLabel = supplierDisplayName(session.supplier, false);
  const isWebEst = session.supplier === 'webest';
  const isFleetSync = isFleetSyncSupplier(session.supplier);
  const transferred = wasTransferred(session);
  applyChrome({
    fleet: isFleetSync,
    hasSession: true,
    hasVin: Boolean(session.vehicle?.vin)
  });
  els.subtitle.textContent = transferred
    ? 'Already transferred from this window'
    : isFleetSync
      ? 'Open the repair order, then extract'
      : 'Shop, then transfer when ready';
  els.supplierBadge.textContent = supplierLabel;
  els.supplierBadge.classList.remove('hidden');
  els.jobLabel.textContent = `${jobNumberLabel(session)} · ${supplierLabel}`;
  els.ymmLabel.textContent = ymmText(session.vehicle);
  els.vehicleLabel.innerHTML = renderVinHtml(session.vehicle);

  const lines = Array.isArray(session.lines) ? session.lines : [];
  const showHours =
    isWebEst || lines.some((line) => Number(line?.laborHours) > 0);
  els.hoursColHeader?.classList.toggle('hidden', !showHours);
  els.transferBtn.disabled = lines.length === 0;
  setCartCount(lines.length);

  if (!lines.length) {
    setPartSuppliesToggleVisible(false);
    if (transferred) {
      renderEmptyState({
        title: isFleetSync ? 'Job card updated' : 'Transferred',
        hint: isFleetSync
          ? 'This window is no longer waiting on the job card. Open another repair order and extract again if you need to update it.'
          : 'This window is no longer waiting on the job card. You can close it, or keep shopping to transfer more items.'
      });
      return;
    }
    const supplierName = supplierDisplayName(session.supplier, true);
    const emptyHint = isFleetSync
      ? `Open a ${supplierName} repair order, dismiss any notices, then click Extract Data.`
      : isWebEst
        ? `Add parts to the ${supplierName} estimate and they’ll show up here.`
        : `Add parts to your ${supplierName} cart and they’ll show up here.`;
    renderEmptyState({
      title: isFleetSync
        ? 'No repair-order lines'
        : isWebEst
          ? 'No estimate lines'
          : 'Cart is empty',
      hint: emptyHint
    });
    return;
  }

  els.cartEmpty.classList.add('hidden');
  els.cartTable.classList.remove('hidden');
  els.cartBody.innerHTML = '';
  lines.forEach((line, index) => {
    const laborOnly = isLaborOnlyLine(line);
    const kindLabel =
      line.lineKind === 'labor' || laborOnly
        ? 'LABOR'
        : line.lineKind === 'part'
          ? 'PART'
          : '';
    const label = [kindLabel, String(line.description || line.laborCategory || '').trim()]
      .filter(Boolean)
      .join(' · ');
    const hours =
      Number.isFinite(Number(line.laborHours)) && Number(line.laborHours) > 0
        ? String(line.laborHours)
        : '—';
    const hoursTitle = line.laborCategory
      ? `${hours} hrs · ${line.laborCategory}`
      : `${hours} hrs`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="part-cell">${escapeHtml(line.partNumber || '—')}</td>
      <td class="desc-cell" title="${escapeHtml(label)}">${escapeHtml(label)}</td>
      <td class="qty-cell num"></td>
      ${
        showHours
          ? `<td class="hours-cell num" title="${escapeHtml(hoursTitle)}">${escapeHtml(hours)}</td>`
          : ''
      }
      <td class="cost-cell">${laborOnly ? money(line.sellPrice ?? line.cost) : money(line.cost)}</td>
    `;

    const qtyCell = tr.querySelector('.qty-cell');
    if (laborOnly) {
      if (qtyCell) qtyCell.textContent = '—';
    } else {
      const qtyInput = document.createElement('input');
      qtyInput.type = 'number';
      qtyInput.className = 'qty-input';
      qtyInput.min = '1';
      qtyInput.step = '1';
      qtyInput.value = String(Math.max(1, Number(line.quantity) || 1));
      qtyInput.title = 'Edit quantity';
      qtyInput.setAttribute('aria-label', `Quantity for ${line.partNumber || 'part'}`);
      qtyInput.addEventListener('change', () => void updateQuantity(index, qtyInput.value));
      qtyInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          qtyInput.blur();
        }
      });
      qtyCell?.appendChild(qtyInput);
    }

    els.cartBody.appendChild(tr);
  });

  const suppliesHours = sumPartSuppliesHours(lines);
  const showSupplies = suppliesHours > 0;
  setPartSuppliesToggleVisible(showSupplies);
  if (els.partSuppliesEnabled) {
    els.partSuppliesEnabled.checked = isPartSuppliesEnabled(session);
  }

  if (showSupplies && isPartSuppliesEnabled(session)) {
    const hoursLabel = formatCartHours(suppliesHours);
    const tr = document.createElement('tr');
    tr.className = 'part-supplies-row';
    tr.innerHTML = `
      <td class="part-cell">—</td>
      <td class="desc-cell" title="Paint Supplies">Paint Supplies</td>
      <td class="qty-cell num">—</td>
      ${
        showHours
          ? `<td class="hours-cell num" title="${escapeHtml(hoursLabel)} hrs">${escapeHtml(hoursLabel)}</td>`
          : ''
      }
      <td class="cost-cell">
        <span>—</span>
        <button type="button" class="part-supplies-remove" aria-label="Hide Paint Supplies" title="Hide Paint Supplies">×</button>
      </td>
    `;
    tr.querySelector('.part-supplies-remove')?.addEventListener('click', () => {
      void setPartSuppliesEnabled(false);
    });
    els.cartBody.appendChild(tr);
  }
}

async function resolveActiveTab() {
  if (!extensionAlive()) {
    currentTabId = null;
    panelWindowId = null;
    activeTabIsSupplier = false;
    return null;
  }
  try {
    const win = await chrome.windows.getCurrent({ populate: true });
    panelWindowId = win?.id ?? null;
    const tab = (win?.tabs || []).find((item) => item.active) || null;
    currentTabId = tab?.id ?? null;
    return tab;
  } catch {
    currentTabId = null;
    return null;
  }
}

async function load() {
  const tab = await resolveActiveTab();
  const response = await sendMessage({ type: 'AMI_GET_SESSION' });
  if (response?.error) {
    setStatus(response.error, 'err');
    return;
  }
  currentSession = response?.session || null;
  activeTabIsSupplier = Boolean(
    response?.isSupplierTab ?? (tab && /web-est|napaprolink|firstcallonline|oreillyauto|autointegrate|erepair\.wheels/.test(tab.url || ''))
  );
  if (response?.tabId != null) currentTabId = response.tabId;
  render();
}

async function setPartSuppliesEnabled(enabled) {
  if (!currentSession) return;
  currentSession = { ...currentSession, partSuppliesEnabled: enabled };
  render();
  const response = await sendMessage({
    type: 'AMI_SET_CART_OPTION',
    partSuppliesEnabled: enabled
  });
  if (response?.error) {
    setStatus(response.error, 'err');
    return;
  }
  if (response?.session) {
    currentSession = response.session;
  }
  render();
}

async function persistLines(lines, statusText) {
  const response = await sendMessage({
    type: 'AMI_UPDATE_CART',
    lines,
    allowEmpty: true
  });
  if (response?.error) {
    setStatus(response.error, 'err');
    return false;
  }
  if (response?.session) {
    currentSession = response.session;
  } else if (currentSession) {
    currentSession = { ...currentSession, lines };
  }
  if (statusText) setStatus(statusText, 'ok');
  render();
  return true;
}

async function updateQuantity(index, rawValue) {
  if (!currentSession) return;
  const qty = Math.max(1, Math.floor(Number(rawValue)) || 1);
  const lines = (currentSession.lines || []).map((line, i) =>
    i === index ? { ...line, quantity: qty } : line
  );
  const prev = Math.max(1, Number(currentSession.lines?.[index]?.quantity) || 1);
  if (qty === prev) {
    render();
    return;
  }
  await persistLines(lines, `Quantity updated to ${qty}`);
}

els.copyVinBtn.addEventListener('click', async () => {
  const vin = currentSession?.vehicle?.vin;
  if (!vin) return;
  try {
    await navigator.clipboard.writeText(vin);
    setStatus('VIN copied', 'ok');
  } catch {
    setStatus('Could not copy VIN', 'err');
  }
});

els.fillVinBtn.addEventListener('click', async () => {
  setStatus('Requested VIN fill on supplier page…');
  const response = await sendMessage({ type: 'AMI_FILL_VIN' });
  if (response?.ok === false || response?.error) {
    setStatus(response?.error || 'Could not fill VIN', 'err');
    return;
  }
  setStatus(response?.message || 'VIN filled on page', 'ok');
});

if (els.refreshBtn) {
  els.refreshBtn.addEventListener('click', async () => {
    setStatus('Refreshing cart…');
    const response = await sendMessage({ type: 'AMI_SCRAPE_NOW' });
    if (response?.ok === false && response.error) {
      setStatus(response.error, 'err');
    }
    window.setTimeout(() => void load(), 600);
    window.setTimeout(() => void load(), 1400);
    window.setTimeout(async () => {
      await load();
      const count = Array.isArray(currentSession?.lines)
        ? currentSession.lines.length
        : 0;
      const isWebEst = currentSession?.supplier === 'webest';
      setStatus(
        count
          ? `${isWebEst ? 'Estimate' : 'Cart'} refreshed · ${count} line${count === 1 ? '' : 's'}`
          : `${isWebEst ? 'Estimate' : 'Cart'} refreshed · empty`,
        'ok'
      );
    }, 2200);
  });
}

els.partSuppliesEnabled?.addEventListener('change', () => {
  void setPartSuppliesEnabled(Boolean(els.partSuppliesEnabled.checked));
});

els.clearBtn.addEventListener('click', async () => {
  const response = await sendMessage({ type: 'AMI_CLEAR_SESSION' });
  if (response?.error) {
    setStatus(response.error, 'err');
    return;
  }
  currentSession = null;
  setStatus('Session cleared');
  render();
});

els.extractBtn?.addEventListener('click', async () => {
  if (!currentSession || extracting) return;
  extracting = true;
  els.extractBtn.disabled = true;
  setStatus('Extracting repair-order lines…');
  try {
    const response = await sendMessage({ type: 'AMI_SCRAPE_NOW' });
    if (response?.ok === false && response.error) {
      setStatus(response.error, 'err');
      return;
    }
    const extracted = Number(response?.count) || 0;
    await load();
    if (extracted) {
      setStatus(
        `Extracted ${extracted} line${extracted === 1 ? '' : 's'}`,
        'ok'
      );
    } else {
      setStatus(
        'No repair-order lines found. Dismiss any popups, open the repair order, then try again.',
        'err'
      );
    }
  } finally {
    extracting = false;
    render();
  }
});

els.transferBtn.addEventListener('click', async () => {
  if (!currentSession?.lines?.length) return;
  if (isFleetSyncSupplier(currentSession.supplier)) {
    const jobLabel = currentSession.jobNumber
      ? `job card #${currentSession.jobNumber}`
      : 'this job card';
    const confirmed = window.confirm(
      `Replace all parts and labor on ${jobLabel} with the ${currentSession.lines.length} line(s) from this window?`
    );
    if (!confirmed) return;
  }
  const count = currentSession.lines.length;
  const jobLabel = currentSession.jobNumber
    ? `#${currentSession.jobNumber}`
    : currentSession.jobCardId
      ? `#${String(currentSession.jobCardId).slice(0, 8)}…`
      : null;

  setStatus('Transferring…');
  const response = await sendMessage({
    type: 'AMI_TRANSFER',
    lines: linesForTransfer(currentSession)
  });
  if (!response?.ok) {
    setStatus(response?.error || 'Transfer failed', 'err');
    return;
  }
  if (response?.session) {
    currentSession = response.session;
  } else if (currentSession) {
    currentSession = {
      ...currentSession,
      lines: [],
      transferredAt: new Date().toISOString()
    };
  }
  render();
  const jobSuffix = jobLabel ? ` to job card ${jobLabel}` : ' to the job card';
  const action = isFleetSyncSupplier(currentSession?.supplier)
    ? 'Updated'
    : 'Transferred';
  setStatus(
    `${action} ${count} line${count === 1 ? '' : 's'}${jobSuffix}`,
    'ok'
  );
});

function tabBelongsToPanel(tabId, windowId) {
  if (panelWindowId != null && windowId != null && windowId !== panelWindowId) {
    return false;
  }
  return true;
}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!extensionAlive()) return;
    if (area !== 'local') return;
    if (!changes.amiPartsBridgeSessionsByTab) return;
    const map = changes.amiPartsBridgeSessionsByTab.newValue || {};
    if (currentTabId == null) {
      void load();
      return;
    }
    currentSession = map[String(currentTabId)] || null;
    render();
  });
} catch {
  // ignore
}

try {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    if (!extensionAlive()) return;
    if (!tabBelongsToPanel(activeInfo.tabId, activeInfo.windowId)) return;
    void load();
  });
} catch {
  // ignore
}

try {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (!extensionAlive()) return;
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    if (panelWindowId != null && windowId !== panelWindowId) return;
    void load();
  });
} catch {
  // ignore
}

try {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!extensionAlive()) return;
    if (tabId !== currentTabId) return;
    if (changeInfo.url || changeInfo.status === 'complete') {
      void load();
    }
  });
} catch {
  // ignore
}

void load();
