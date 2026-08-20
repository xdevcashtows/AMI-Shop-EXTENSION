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
  cartEmpty: document.getElementById('cartEmpty'),
  cartCount: document.getElementById('cartCount'),
  cartTable: document.getElementById('cartTable'),
  cartBody: document.getElementById('cartBody'),
  hoursColHeader: document.getElementById('hoursColHeader'),
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
  return long ? "O'Reilly / FirstCall" : "O'Reilly";
}

function isLaborOnlyLine(line) {
  return (
    line?.lineKind === 'labor' ||
    (!String(line?.partNumber || '').trim() &&
      !(Number(line?.cost) > 0) &&
      Number(line?.laborHours) > 0)
  );
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
    els.fillVinBtn.classList.remove('hidden');
    els.transferBtn.disabled = true;
    setCartCount(0);
    els.hoursColHeader?.classList.add('hidden');
    els.cartEmpty.classList.remove('hidden');
    els.cartEmpty.innerHTML = `
      <span class="empty-title">No active session</span>
      <span class="empty-hint">Start shopping from a job card in AMI Shop CRM.</span>
    `;
    els.cartTable.classList.add('hidden');
    els.cartBody.innerHTML = '';
    return;
  }

  const supplierLabel = supplierDisplayName(session.supplier, false);
  const isWebEst = session.supplier === 'webest';
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
  els.fillVinBtn.classList.remove('hidden');
  els.fillVinBtn.disabled = !session.vehicle?.vin;

  const lines = Array.isArray(session.lines) ? session.lines : [];
  const showHours =
    isWebEst || lines.some((line) => Number(line?.laborHours) > 0);
  els.hoursColHeader?.classList.toggle('hidden', !showHours);
  els.transferBtn.disabled = lines.length === 0;
  setCartCount(lines.length);

  if (!lines.length) {
    els.cartEmpty.classList.remove('hidden');
    const supplierName = supplierDisplayName(session.supplier, true);
    const emptyHint = isWebEst
      ? `Add parts to the ${supplierName} estimate and they’ll show up here.`
      : `Add parts to your ${supplierName} cart and they’ll show up here.`;
    els.cartEmpty.innerHTML = `
      <span class="empty-title">${isWebEst ? 'No estimate lines' : 'Cart is empty'}</span>
      <span class="empty-hint">${emptyHint}</span>
    `;
    els.cartTable.classList.add('hidden');
    els.cartBody.innerHTML = '';
    return;
  }

  els.cartEmpty.classList.add('hidden');
  els.cartTable.classList.remove('hidden');
  els.cartBody.innerHTML = '';
  lines.forEach((line, index) => {
    const laborOnly = isLaborOnlyLine(line);
    const label = laborOnly
      ? String(line.laborCategory || line.description || '').trim()
      : String(line.description || '');
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
      <td class="cost-cell">${laborOnly ? '—' : money(line.cost)}</td>
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
}

async function load() {
  const response = await sendMessage({ type: 'AMI_GET_SESSION' });
  if (response?.error) {
    setStatus(response.error, 'err');
    return;
  }
  currentSession = response?.session || null;
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

void load();
