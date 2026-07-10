const DEFAULT_API_BASE = 'http://localhost:8787';

/** @type {any} */
let currentSession = null;

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
      chrome.runtime.sendMessage(message, (response) => {
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
  addTestBtn: document.getElementById('addTestBtn'),
  cartEmpty: document.getElementById('cartEmpty'),
  cartTable: document.getElementById('cartTable'),
  cartBody: document.getElementById('cartBody'),
  apiBaseInput: document.getElementById('apiBaseInput'),
  saveApiBtn: document.getElementById('saveApiBtn'),
  toggleSettingsBtn: document.getElementById('toggleSettingsBtn'),
  settingsBody: document.getElementById('settingsBody'),
  status: document.getElementById('status'),
  clearBtn: document.getElementById('clearBtn'),
  transferBtn: document.getElementById('transferBtn')
};

function setStatus(text, kind) {
  els.status.textContent = text || '';
  els.status.classList.remove('ok', 'err');
  if (kind) els.status.classList.add(kind);
}

function money(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `$${Number(value).toFixed(2)}`;
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

function render() {
  const session = currentSession;
  if (!session) {
    els.subtitle.textContent = 'No active session — start from a job card';
    els.supplierBadge.classList.add('hidden');
    els.jobLabel.textContent = '—';
    els.ymmLabel.textContent = '—';
    els.vehicleLabel.innerHTML = '—';
    els.copyVinBtn.disabled = true;
    els.fillVinBtn.disabled = true;
    els.transferBtn.disabled = true;
    els.cartEmpty.classList.remove('hidden');
    els.cartTable.classList.add('hidden');
    els.cartBody.innerHTML = '';
    return;
  }

  const supplierLabel = session.supplier === 'napa' ? 'NAPA' : "O'Reilly";
  els.subtitle.textContent = 'Shop, then transfer when ready';
  els.supplierBadge.textContent = supplierLabel;
  els.supplierBadge.classList.remove('hidden');
  els.jobLabel.textContent = session.jobNumber
    ? `Job ${session.jobNumber}`
    : session.jobCardId
      ? `Job ${session.jobCardId.slice(0, 8)}…`
      : 'Draft job';
  els.ymmLabel.textContent = ymmText(session.vehicle);
  els.vehicleLabel.innerHTML = renderVinHtml(session.vehicle);
  els.copyVinBtn.disabled = !session.vehicle?.vin;
  els.fillVinBtn.disabled = false;

  const lines = Array.isArray(session.lines) ? session.lines : [];
  els.transferBtn.disabled = lines.length === 0;

  if (!lines.length) {
    els.cartEmpty.classList.remove('hidden');
    els.cartEmpty.textContent =
      session.supplier === 'napa'
        ? 'Shop cart is empty. Add parts to your NAPA ProLink cart, then they will appear here.'
        : 'Shop cart is empty. Add parts to your O\'Reilly quote, then they will appear here.';
    els.cartTable.classList.add('hidden');
    els.cartBody.innerHTML = '';
    return;
  }

  els.cartEmpty.classList.add('hidden');
  els.cartTable.classList.remove('hidden');
  els.cartBody.innerHTML = '';
  lines.forEach((line, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${escapeHtml(line.partNumber || '—')}</td>
      <td>${escapeHtml(line.description || '')}</td>
      <td class="qty-cell"></td>
      <td>${money(line.cost)}</td>
      <td></td>
    `;

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
    tr.querySelector('.qty-cell')?.appendChild(qtyInput);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn danger-text';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => void removeLine(index));
    tr.lastElementChild.appendChild(removeBtn);
    els.cartBody.appendChild(tr);
  });
}

async function load() {
  const response = await sendMessage({ type: 'AMI_GET_SESSION' });
  if (response?.error) {
    setStatus(response.error, 'err');
    return;
  }
  currentSession = response?.session || null;
  els.apiBaseInput.value =
    response?.settings?.apiBaseUrl ||
    currentSession?.apiBaseUrl ||
    DEFAULT_API_BASE;
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

async function removeLine(index) {
  if (!currentSession) return;
  const lines = [...(currentSession.lines || [])];
  lines.splice(index, 1);
  await persistLines(
    lines,
    lines.length ? 'Part removed from shop cart' : 'Shop cart cleared'
  );
}

function postToParent(type, payload) {
  try {
    window.parent.postMessage({ source: 'ami-parts-bridge-widget', type, ...payload }, '*');
  } catch {
    // ignore
  }
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

els.fillVinBtn.addEventListener('click', () => {
  postToParent('AMI_WIDGET_FILL_VIN');
  setStatus('Requested VIN fill on this page…');
});

els.refreshBtn.addEventListener('click', () => {
  postToParent('AMI_WIDGET_SCRAPE_NOW');
  setStatus('Refreshing cart…');
  window.setTimeout(() => void load(), 600);
  window.setTimeout(() => void load(), 1400);
  window.setTimeout(async () => {
    await load();
    const count = Array.isArray(currentSession?.lines) ? currentSession.lines.length : 0;
    setStatus(
      count ? `Cart refreshed · ${count} part${count === 1 ? '' : 's'}` : 'Cart refreshed · empty',
      'ok'
    );
  }, 2200);
});

els.addTestBtn.addEventListener('click', async () => {
  if (!currentSession) {
    setStatus('Start a session from AMI Shop CRM first', 'err');
    return;
  }
  const lines = [
    ...(currentSession.lines || []),
    {
      partNumber: 'TEST-1001',
      description: 'Test oil filter (manual)',
      brand: 'Test',
      quantity: 1,
      cost: 4.25,
      vendor: currentSession.supplier === 'napa' ? 'NAPA' : "O'Reilly",
      unit: 'pc.'
    }
  ];
  const response = await sendMessage({ type: 'AMI_UPDATE_CART', lines });
  if (response?.error) {
    setStatus(response.error, 'err');
    return;
  }
  if (response?.session) currentSession = response.session;
  setStatus('Test part added — use Transfer to verify', 'ok');
  render();
});

els.toggleSettingsBtn.addEventListener('click', () => {
  const open = !els.settingsBody.classList.contains('hidden');
  els.settingsBody.classList.toggle('hidden', open);
  els.toggleSettingsBtn.textContent = open ? 'API settings ▾' : 'API settings ▴';
});

els.saveApiBtn.addEventListener('click', () => {
  if (!extensionAlive()) {
    setStatus('Extension was reloaded — refresh this supplier tab', 'err');
    return;
  }
  const apiBaseUrl = els.apiBaseInput.value.trim() || DEFAULT_API_BASE;
  try {
    chrome.storage.local.set({ amiPartsBridgeSettings: { apiBaseUrl } }, () => {
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, 'err');
        return;
      }
      setStatus(`API base saved: ${apiBaseUrl}`, 'ok');
    });
  } catch {
    setStatus('Extension was reloaded — refresh this supplier tab', 'err');
  }
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

els.transferBtn.addEventListener('click', async () => {
  if (!currentSession?.lines?.length) return;
  const count = currentSession.lines.length;
  const jobLabel = currentSession.jobNumber
    ? `#${currentSession.jobNumber}`
    : currentSession.jobCardId
      ? `#${String(currentSession.jobCardId).slice(0, 8)}…`
      : null;

  setStatus('Transferring…');
  const response = await sendMessage({
    type: 'AMI_TRANSFER',
    lines: currentSession.lines
  });
  if (!response?.ok) {
    setStatus(response?.error || 'Transfer failed', 'err');
    return;
  }
  if (response?.session) {
    currentSession = response.session;
  } else if (currentSession) {
    currentSession = { ...currentSession, lines: [] };
  }
  render();
  const jobSuffix = jobLabel ? ` to job card ${jobLabel}` : ' to the job card';
  setStatus(
    `Transferred ${count} part${count === 1 ? '' : 's'}${jobSuffix}`,
    'ok'
  );
});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!extensionAlive()) return;
    if (area !== 'local') return;
    if (changes.amiPartsBridgeSession) {
      currentSession = changes.amiPartsBridgeSession.newValue || null;
      render();
    }
  });
} catch {
  // ignore
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.source !== 'ami-parts-bridge-host') return;
  if (data.type === 'AMI_HOST_STATUS') {
    setStatus(data.text || '', data.kind);
  }
});

void load();
