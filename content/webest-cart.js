(function () {
  const VENDOR = 'WebEst';
  const Ami = globalThis.AmiChrome;
  const NETWORK_SOURCE = 'ami-parts-bridge-network';
  const GRID_READ_SOURCE = 'ami-parts-bridge-read-webest-grid';
  const DELETE_SOURCE = 'ami-parts-bridge-webest-delete';
  const FILL_VIN_SOURCE = 'ami-parts-bridge-webest-fill-vin';

  /** @type {Map<string, any[]>} */
  const sectionLines = new Map();
  /** @type {any[]} */
  let networkLines = [];
  /** @type {string} */
  let lastSentSignature = '';
  /** @type {string} */
  let lastSectionRequestId = '';
  /** @type {{ url: string, body: string, contentType: string }} */
  let lastDeleteTemplate = { url: '', body: '', contentType: 'application/json' };
  /** @type {string} */
  let lastEstimateApiUrl = '';
  /** @type {string} */
  let lastDeletedId = '';
  let deleteSeq = 0;
  let dead = false;

  function markDead() {
    dead = true;
  }

  function isAddPartsPage() {
    return /\/estimate\/\d+\/add-parts/i.test(window.location.pathname);
  }

  function shopPrefix() {
    const match = window.location.pathname.match(/^(\/\d+)/);
    return match ? match[1] : '';
  }

  function parseMoney(text) {
    if (text == null || text === '') return undefined;
    if (typeof text === 'number' && Number.isFinite(text)) return text;
    if (typeof text === 'object' && text !== null && 'value' in text) {
      return parseMoney(/** @type {{ value?: unknown }} */ (text).value);
    }
    const cleaned = String(text).replace(/[^0-9.-]/g, '');
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : undefined;
  }

  function hoursValue(row, key) {
    const value = parseMoney(row?.[key]);
    return value && value > 0 ? value : 0;
  }

  function estimateLineIdFromExternal(externalId) {
    const match = String(externalId || '').trim().match(/^(\d+)/);
    return match ? match[1] : '';
  }

  /** @returns {{ hours: number, category: string }[]} */
  function parseLaborItems(text) {
    const raw = String(text || '')
      .replace(/<br\s*\/?>/gi, ', ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .trim();
    if (!raw || /^included$/i.test(raw)) return [];
    /** @type {{ hours: number, category: string }[]} */
    const results = [];
    const re = /(\d+(?:\.\d+)?)\s*hrs?\.?\s*([A-Za-z][A-Za-z /&-]*)/gi;
    let match;
    while ((match = re.exec(raw))) {
      const hours = Number(match[1]);
      const category = String(match[2] || '')
        .trim()
        .replace(/[.,;]+$/, '');
      if (Number.isFinite(hours) && hours > 0) {
        results.push({ hours, category });
      }
    }
    return results;
  }

  function laborOpFromCategory(category) {
    const value = String(category || '').toLowerCase();
    if (value.includes('r&i') || value.includes('r & i') || /\bri\b/.test(value)) {
      return 'R&I';
    }
    if (/(paint|clear|blend|underside|edging|refinish)/.test(value)) {
      return 'Refinish';
    }
    return 'Replace';
  }

  function optionLaborItems(row) {
    if (!row || typeof row !== 'object') return [];
    const specs = [
      { name: 'Clearcoat', key: /clear\s*coat/i },
      { name: 'Underside', key: /underside/i },
      { name: 'Blend', key: /blend/i },
      { name: 'Edging', key: /edging/i }
    ];
    /** @type {{ hours: number, category: string }[]} */
    const items = [];
    const keys = Object.keys(row);
    specs.forEach((spec) => {
      let hours = 0;
      let checked = false;
      let sawFlag = false;
      keys.forEach((key) => {
        if (!spec.key.test(key)) return;
        const value = row[key];
        if (typeof value === 'boolean') {
          sawFlag = true;
          checked = checked || value;
          return;
        }
        if (typeof value === 'number' && value > 0 && value < 100) {
          hours = value;
          return;
        }
        if (value && typeof value === 'object') {
          if ('Checked' in value || 'IsChecked' in value || 'Selected' in value) {
            sawFlag = true;
            checked = Boolean(
              value.Checked ?? value.IsChecked ?? value.Selected ?? value.Enabled
            );
          }
          const time = Number(value.Time ?? value.Hours ?? value.Value ?? 0);
          if (Number.isFinite(time) && time > 0) hours = time;
        }
      });
      if (sawFlag && checked && hours > 0) {
        items.push({ hours, category: spec.name });
      }
    });
    return items;
  }

  function laborItemsFromRow(row) {
    const parsed = parseLaborItems(
      row.LaborItems ?? row.laborItems ?? row.Labor ?? row.labor
    );
    if (parsed.length) return { items: parsed, source: 'display' };
    /** @type {{ hours: number, category: string }[]} */
    const items = [];
    const rr = hoursValue(row, 'RRTime');
    const laborName = String(row.LaborName || '').trim();
    if (rr > 0) {
      const category =
        !laborName || /paint/i.test(laborName) ? 'Body' : laborName;
      items.push({ hours: rr, category });
    }
    const paint = hoursValue(row, 'PaintTime');
    if (paint > 0) items.push({ hours: paint, category: 'Paint Panel' });
    const options = optionLaborItems(row);
    options.forEach((item) => {
      if (
        items.some(
          (existing) =>
            existing.category.toLowerCase() === item.category.toLowerCase()
        )
      ) {
        return;
      }
      items.push(item);
    });
    return { items, source: 'times' };
  }

  function laborLinesFromItems(id, description, group, sectionId, items, source) {
    return items.map((item, index) => {
      const category = String(item.category || '').trim();
      return {
        externalId: `${id}-labor-${index}`,
        estimateLineId: id,
        partNumber: '',
        description,
        quantity: 0,
        cost: 0,
        sellPrice: 0,
        vendor: VENDOR,
        op: laborOpFromCategory(category),
        group: group || sectionId,
        laborHours: item.hours,
        laborCategory: category || undefined,
        lineKind: 'labor',
        laborSource: source,
        sectionId
      };
    });
  }

  function extraPaintHours(row) {
    if (!row || typeof row !== 'object') return 0;
    const keys = [
      'PaintHours',
      'BlendHours',
      'ClearcoatHours',
      'EdgingHours',
      'RefinishHours',
      'PaintLaborHours'
    ];
    let total = 0;
    for (const key of keys) {
      const value = parseMoney(row[key]);
      if (value && value > 0) total += value;
    }
    return total;
  }

  /**
   * Old Add Parts grid (`GetManualEntryList`).
   * @param {Record<string, any>} row
   * @returns {any[]}
   */
  function normalizeManualRow(row) {
    if (!row || typeof row !== 'object') return [];

    const id = row.ID ?? row.Id ?? row.id;
    const partName = String(row.PartName ?? row.partName ?? '').trim();
    const partNumber = String(row.PartNumber ?? row.partNumber ?? '').trim();
    const op = String(row.OP ?? row.Op ?? row.op ?? '').trim();
    const group = String(row.Group ?? row.group ?? '').trim();
    const quantityRaw = Number(row.Quantity ?? row.quantity ?? 0);
    const price = parseMoney(row.PartPrice ?? row.partPrice) ?? 0;
    const laborItems = parseLaborItems(row.LaborItems ?? row.laborItems);
    const paintHours = extraPaintHours(row);
    const firstLabor = laborItems[0];
    const extraLabors = laborItems.slice(1);
    const hasPart = Boolean(partNumber) || price > 0;
    const laborHours = firstLabor?.hours;
    const laborCategory = firstLabor?.category;
    const description =
      partName || (op ? `${op} line` : '') || 'Estimate line';

    if (
      !hasPart &&
      !(laborHours > 0) &&
      extraLabors.length === 0 &&
      !(paintHours > 0)
    ) {
      return [];
    }

    /** @type {'part' | 'labor' | 'both'} */
    let lineKind = 'part';
    if (hasPart && laborHours > 0) lineKind = 'both';
    else if (!hasPart) lineKind = 'labor';

    const quantity =
      Number.isFinite(quantityRaw) && quantityRaw > 0
        ? quantityRaw
        : hasPart
          ? 1
          : 0;

    const estimateLineId = id != null ? String(id) : undefined;
    /** @type {any[]} */
    const lines = [
      {
        externalId: estimateLineId,
        estimateLineId,
        partNumber,
        description,
        quantity,
        cost: price,
        sellPrice: price,
        vendor: VENDOR,
        op: op || undefined,
        group: group || undefined,
        laborHours: laborHours || undefined,
        laborCategory: laborCategory || undefined,
        lineKind
      }
    ];

    extraLabors.forEach((item, index) => {
      lines.push({
        externalId: estimateLineId ? `${estimateLineId}-labor-${index + 1}` : undefined,
        estimateLineId,
        partNumber: '',
        description,
        quantity: 0,
        cost: 0,
        sellPrice: 0,
        vendor: VENDOR,
        op: laborOpFromCategory(item.category),
        group: group || undefined,
        laborHours: item.hours,
        laborCategory: item.category || undefined,
        lineKind: 'labor'
      });
    });

    if (paintHours > 0) {
      lines.push({
        externalId: estimateLineId ? `${estimateLineId}-paint` : undefined,
        estimateLineId,
        partNumber: '',
        description,
        quantity: 0,
        cost: 0,
        sellPrice: 0,
        vendor: VENDOR,
        op: op || undefined,
        group: group || undefined,
        laborHours: paintHours,
        laborCategory: 'Paint',
        lineKind: 'labor'
      });
    }

    return lines;
  }

  /**
   * add-parts-new `GetSectionData` part row (on estimate when EstimateLineID > 0).
   * @param {Record<string, any>} row
   * @returns {any[]}
   */
  function normalizeSectionPart(row) {
    if (!row || typeof row !== 'object') return [];

    const estimateLineId = Number(row.EstimateLineID ?? row.ID ?? 0);
    if (!(estimateLineId > 0)) return [];

    const partNumber = String(row.PartNumber ?? row.partNumber ?? '').trim();
    const description = String(
      row.Description ||
        row.PartName ||
        row.partName ||
        row.comment ||
        row.Part_Text ||
        ''
    )
      .replace(/\s+/g, ' ')
      .trim() || 'Estimate line';
    const price = parseMoney(row.Price ?? row.PartPrice ?? row.partPrice) ?? 0;
    const group = String(row.Reference || '').trim();
    const sectionId =
      row.SectionID != null ? String(row.SectionID) : undefined;
    const hasPart = Boolean(partNumber) || price > 0;
    const id = String(estimateLineId);
    const { items, source } = laborItemsFromRow(row);
    if (!hasPart && !items.length) return [];

    /** @type {any[]} */
    const lines = [];
    if (hasPart) {
      lines.push({
        externalId: id,
        estimateLineId: id,
        partNumber,
        description,
        quantity: 1,
        cost: price,
        sellPrice: price,
        vendor: VENDOR,
        op: String(row.Action || row.OP || row.Op || '').trim() || 'Replace',
        group: group || sectionId,
        lineKind: 'part',
        sectionId
      });
    }
    lines.push(
      ...laborLinesFromItems(id, description, group, sectionId, items, source)
    );
    return lines;
  }

  function flattenSectionLines() {
    /** @type {any[]} */
    const lines = [];
    for (const bucket of sectionLines.values()) {
      lines.push(...bucket);
    }
    return lines;
  }

  function rebuildNetworkLines() {
    networkLines = flattenSectionLines();
    void pushCartUpdate(true);
  }

  function extractListRows(data) {
    if (!data) return null;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.Data)) return data.Data;
    if (Array.isArray(data.data)) return data.data;
    if (data.d) return extractListRows(data.d);
    if (data.Data && typeof data.Data === 'object') {
      return extractListRows(data.Data);
    }
    return null;
  }

  function extractParts(data) {
    if (!data || typeof data !== 'object') return null;
    if (Array.isArray(data.Parts)) return data.Parts;
    if (data.d) return extractParts(data.d);
    return null;
  }

  function applyManualRows(rows) {
    if (!Array.isArray(rows)) return;
    const lines = [];
    for (const row of rows) {
      lines.push(...normalizeManualRow(row));
    }
    sectionLines.clear();
    sectionLines.set('__manual__', lines);
    rebuildNetworkLines();
  }

  function applySectionParts(sectionId, parts) {
    const key = String(sectionId || lastSectionRequestId || '0');
    const onEstimate = Array.isArray(parts)
      ? parts.filter((part) => Number(part?.EstimateLineID ?? part?.ID ?? 0) > 0)
      : [];
    const incoming = [];
    for (const row of onEstimate) {
      incoming.push(...normalizeSectionPart(row));
    }
    const existing = sectionLines.get(key) || [];
    sectionLines.set(key, mergeIncomingWithExistingLabor(incoming, existing));
    rebuildNetworkLines();
  }

  function applyFullEstimateParts(parts) {
    const previous = flattenSectionLines();
    const grouped = new Map();
    for (const part of Array.isArray(parts) ? parts : []) {
      if (Number(part?.EstimateLineID ?? part?.ID ?? 0) <= 0) continue;
      const key = String(part.SectionID ?? lastSectionRequestId ?? '0');
      const list = grouped.get(key) || [];
      list.push(part);
      grouped.set(key, list);
    }
    const incoming = [];
    for (const list of grouped.values()) {
      for (const row of list) {
        incoming.push(...normalizeSectionPart(row));
      }
    }
    const merged = mergeIncomingWithExistingLabor(incoming, previous);
    sectionLines.clear();
    for (const line of merged) {
      const key = String(line.sectionId || lastSectionRequestId || '0');
      const bucket = sectionLines.get(key) || [];
      bucket.push(line);
      sectionLines.set(key, bucket);
    }
    rebuildNetworkLines();
  }

  function linesLaborHours(lines) {
    return (lines || []).reduce(
      (sum, line) => sum + (Number(line?.laborHours) || 0),
      0
    );
  }

  function laborLineCount(lines) {
    return (lines || []).filter((line) => Number(line?.laborHours) > 0).length;
  }

  function groupByEstimateLineId(lines) {
    /** @type {Map<string, any[]>} */
    const map = new Map();
    for (const line of lines || []) {
      const id = String(
        line?.estimateLineId || estimateLineIdFromExternal(line?.externalId) || ''
      );
      if (!id) continue;
      const list = map.get(id) || [];
      list.push(line);
      map.set(id, list);
    }
    return map;
  }

  function lineLaborSource(lines) {
    if ((lines || []).some((line) => line.laborSource === 'display')) {
      return 'display';
    }
    if ((lines || []).some((line) => Number(line.laborHours) > 0)) {
      return 'times';
    }
    return 'none';
  }

  function mergeIncomingWithExistingLabor(incomingLines, existingLines) {
    const oldById = groupByEstimateLineId(existingLines);
    const newById = groupByEstimateLineId(incomingLines);
    /** @type {any[]} */
    const result = [];
    for (const [id, next] of newById) {
      const prev = oldById.get(id) || [];
      const nextLabor = laborLineCount(next);
      const prevLabor = laborLineCount(prev);
      const nextSource = lineLaborSource(next);
      const prevSource = lineLaborSource(prev);
      const keepPrevLabor =
        (prevSource === 'display' && nextSource !== 'display') ||
        (nextLabor <= 0 && prevLabor > 0);
      if (nextSource === 'display' && nextLabor >= prevLabor) {
        result.push(...next);
      } else if (keepPrevLabor && prevLabor > 0) {
        const nextPart =
          next.find((line) => line.lineKind === 'part') ||
          next.find((line) => line.lineKind !== 'labor');
        const prevPart =
          prev.find((line) => line.lineKind === 'part') ||
          prev.find((line) => line.lineKind !== 'labor');
        if (nextPart && nextPart.lineKind === 'part') {
          result.push({
            ...prevPart,
            ...nextPart,
            laborHours: undefined,
            laborCategory: undefined,
            lineKind: 'part'
          });
        } else if (prevPart && prevPart.lineKind === 'part') {
          result.push(prevPart);
        }
        for (const line of prev) {
          if (line !== prevPart && Number(line.laborHours) > 0) result.push(line);
        }
      } else if (nextLabor > prevLabor) {
        result.push(...next);
      } else {
        result.push(...next);
      }
    }
    return result;
  }

  function upsertEstimatePart(part) {
    if (!part || typeof part !== 'object') return false;
    const id = Number(part.EstimateLineID ?? part.ID ?? 0);
    if (!(id > 0)) return false;
    const sectionId = String(part.SectionID ?? lastSectionRequestId ?? '0');
    const existing = sectionLines.get(sectionId) || [];
    const kept = existing.filter(
      (line) => String(line.estimateLineId || '') !== String(id)
    );
    const current = existing.filter(
      (line) => String(line.estimateLineId || '') === String(id)
    );
    const incoming = normalizeSectionPart(part);
    sectionLines.set(
      sectionId,
      [...kept, ...mergeIncomingWithExistingLabor(incoming, current)]
    );
    rebuildNetworkLines();
    return true;
  }

  function dropEstimateLine(id) {
    const key = String(id || '');
    if (!key) return;
    for (const [sectionId, lines] of sectionLines.entries()) {
      sectionLines.set(
        sectionId,
        lines.filter((line) => String(line.estimateLineId || '') !== key)
      );
    }
    rebuildNetworkLines();
  }

  function snapshotSections() {
    /** @type {Record<string, any[]>} */
    const copy = {};
    for (const [key, lines] of sectionLines.entries()) {
      copy[key] = lines.slice();
    }
    return copy;
  }

  function restoreSections(snapshot) {
    sectionLines.clear();
    for (const [key, lines] of Object.entries(snapshot || {})) {
      sectionLines.set(key, Array.isArray(lines) ? lines : []);
    }
    rebuildNetworkLines();
  }

  function parseJsonBody(payload) {
    if (payload == null) return null;
    if (typeof payload === 'object') return payload;
    const trimmed = String(payload).trim();
    if (!trimmed) return null;
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function sectionIdFromBody(body) {
    const data = parseJsonBody(body);
    if (data && typeof data === 'object') {
      const id = data.SectionID ?? data.sectionID ?? data.sectionId;
      if (id != null && String(id)) return String(id);
    }
    const match = String(body || '').match(/SectionID=(\d+)/i);
    return match ? match[1] : '';
  }

  function isManualEntryListUrl(url) {
    return /GetManualEntryList/i.test(String(url || ''));
  }

  function isSectionDataUrl(url) {
    return /GetSectionData/i.test(String(url || ''));
  }

  function isSaveEstimateLineUrl(url) {
    return /SaveEstimateLine/i.test(String(url || ''));
  }

  function isDeleteEstimateLineUrl(url) {
    return /DeleteEstimateLine/i.test(String(url || ''));
  }

  function isLinePreviewUrl(url) {
    return /GetLinePreview/i.test(String(url || ''));
  }

  function isLegacyMutationUrl(url) {
    const value = String(url || '');
    return (
      /\/Estimate\/AddLabor/i.test(value) ||
      /\/Estimate\/AddUpdateLineItem/i.test(value) ||
      /\/Estimate\/DeleteLineItem/i.test(value) ||
      /\/Estimate\/SaveManualEntry/i.test(value) ||
      /\/RateProfile\/DeleteME/i.test(value)
    );
  }

  function rememberDeleteTemplate(url, body) {
    const raw = typeof body === 'string' ? body : body != null ? String(body) : '';
    lastDeleteTemplate = {
      url: String(url || ''),
      body: raw,
      contentType: raw.trim().startsWith('{')
        ? 'application/json'
        : 'application/x-www-form-urlencoded'
    };
  }

  function substituteEstimateLineId(body, id) {
    const numeric = Number(id);
    const value = Number.isFinite(numeric) ? numeric : id;
    const raw = String(body || '').trim();
    if (raw.startsWith('{')) {
      try {
        const obj = JSON.parse(raw);
        const keys = [
          'EstimateLineID',
          'estimateLineID',
          'estimateLineId',
          'ID',
          'Id',
          'id',
          'LineID'
        ];
        let found = false;
        for (const key of keys) {
          if (key in obj) {
            obj[key] = value;
            found = true;
          }
        }
        if (!found) {
          obj.EstimateLineID = value;
          obj.estimateLineID = value;
          obj.ID = value;
        }
        return JSON.stringify(obj);
      } catch {
        // fall through
      }
    }
    if (raw.includes('=')) {
      const params = new URLSearchParams(raw);
      let found = false;
      for (const key of ['EstimateLineID', 'estimateLineID', 'ID', 'id']) {
        if (params.has(key)) {
          params.set(key, String(id));
          found = true;
        }
      }
      if (!found) params.set('EstimateLineID', String(id));
      return params.toString();
    }
    return JSON.stringify({
      EstimateLineID: value,
      estimateLineID: value,
      ID: value
    });
  }

  function ingestPayload(payload, url, kind) {
    const value = String(url || '');
    if (
      !/^\/Estimate\/Get(SectionData|ManualEntryList)/i.test(value) &&
      /GetSectionData|SaveEstimateLine|DeleteEstimateLine|GetLinePreview/i.test(
        value
      )
    ) {
      lastEstimateApiUrl = value.split('?')[0];
    }

    if (kind && kind !== 'response') {
      if (isSectionDataUrl(value)) {
        const sectionId = sectionIdFromBody(payload);
        if (sectionId) lastSectionRequestId = sectionId;
      }
      if (isDeleteEstimateLineUrl(value)) {
        rememberDeleteTemplate(value, payload);
        const parsed = parseJsonBody(payload);
        const id =
          parsed?.EstimateLineID ??
          parsed?.ID ??
          String(payload || '').match(/EstimateLineID=(\d+)/i)?.[1];
        if (id) lastDeletedId = String(id);
      }
      return;
    }

    if (!isAddPartsPage()) return;

    if (isLegacyMutationUrl(value)) {
      window.setTimeout(() => requestGridRead(false), 400);
      window.setTimeout(() => requestGridRead(true), 900);
    }

    if (isManualEntryListUrl(value)) {
      const data = parseJsonBody(payload);
      if (!data || data.Errors) return;
      const rows = extractListRows(data);
      if (!rows) return;
      applyManualRows(rows);
      return;
    }

    const data = parseJsonBody(payload);
    const parts = extractParts(data);
    const looksLikeSection =
      Boolean(parts) &&
      (isSectionDataUrl(value) ||
        data?.FullEstimate === true ||
        parts.some((part) => part && Number(part.EstimateLineID) > 0));

    if (looksLikeSection) {
      if (data.FullEstimate) {
        applyFullEstimateParts(parts);
      } else {
        const sectionId =
          data.SectionID ??
          data.sectionID ??
          parts.find((part) => part?.SectionID != null)?.SectionID ??
          lastSectionRequestId;
        applySectionParts(sectionId, parts);
      }
      if (!/^\/Estimate\/GetSectionData$/i.test(value)) {
        window.setTimeout(() => requestGridRead(false), 300);
        window.setTimeout(() => requestGridRead(false), 1200);
      }
      return;
    }

    if (isLinePreviewUrl(value) || isSaveEstimateLineUrl(value)) {
      if (!data) return;
      const saveParts = parts || [];
      let upserted = false;
      for (const part of saveParts) {
        if (upsertEstimatePart(part)) upserted = true;
      }
      if (!upserted) {
        const part =
          data.Part ||
          data.part ||
          (Number(data.EstimateLineID) > 0 ? data : null);
        if (part) upsertEstimatePart(part);
      }
      return;
    }

    if (isDeleteEstimateLineUrl(value)) {
      const data = parseJsonBody(payload);
      const fromBody = String(lastDeleteTemplate.body || '').match(
        /"EstimateLineID"\s*:\s*(\d+)/i
      );
      const deletedId =
        data?.EstimateLineID ??
        data?.ID ??
        data?.DeletedID ??
        lastDeletedId ??
        fromBody?.[1];
      if (deletedId) dropEstimateLine(deletedId);
    }
  }

  function requestGridRead(refresh) {
    if (dead || !isAddPartsPage()) return false;
    try {
      window.postMessage(
        {
          source: GRID_READ_SOURCE,
          refresh: Boolean(refresh)
        },
        '*'
      );
      return true;
    } catch {
      return false;
    }
  }

  function installNetworkHooks() {
    const inject = () => {
      try {
        if (!Ami?.extensionAlive()) return;
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('content/page-network-hook.js');
        script.async = false;
        script.onload = () => script.remove();
        (document.documentElement || document.head || document.body).appendChild(
          script
        );
      } catch {
        // ignore
      }
    };

    if (document.documentElement) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== NETWORK_SOURCE) return;
      ingestPayload(data.body, data.url, data.kind);
    });
  }

  function scrapeCartLines() {
    return networkLines;
  }

  function resetCart() {
    sectionLines.clear();
    networkLines = [];
    lastSentSignature = '';
    void pushCartUpdate(true);
  }

  function findVinInputs() {
    const selectors = [
      'input[name*="vin" i]',
      'input[id*="vin" i]',
      'input[placeholder*="vin" i]',
      'input[aria-label*="vin" i]',
      'textarea[name*="vin" i]',
      'textarea[id*="vin" i]',
      'input[name*="VIN"]',
      'input[id*="VIN"]'
    ];
    /** @type {Array<HTMLInputElement | HTMLTextAreaElement>} */
    const inputs = [];
    for (const selector of selectors) {
      try {
        document.querySelectorAll(selector).forEach((node) => {
          if (
            node instanceof HTMLInputElement ||
            node instanceof HTMLTextAreaElement
          ) {
            inputs.push(node);
          }
        });
      } catch {
        // some browsers reject "i" flag in selectors
      }
    }
    if (!inputs.length) {
      document.querySelectorAll('input, textarea').forEach((node) => {
        if (
          !(node instanceof HTMLInputElement) &&
          !(node instanceof HTMLTextAreaElement)
        ) {
          return;
        }
        const hay = `${node.name} ${node.id} ${node.placeholder} ${
          node.getAttribute('aria-label') || ''
        }`.toLowerCase();
        if (hay.includes('vin')) inputs.push(node);
      });
    }
    return inputs;
  }

  function clickVinAction() {
    const nodes = document.querySelectorAll(
      'button, input[type="button"], input[type="submit"], a.btn, a.button'
    );
    for (const node of nodes) {
      const text = `${node.textContent || ''} ${
        node instanceof HTMLInputElement ? node.value : ''
      }`
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (
        text === 'decode' ||
        text === 'decode vin' ||
        text === 'search vin' ||
        text === 'lookup vin' ||
        text === 'find vehicle' ||
        text === 'vin search' ||
        (text.includes('decode') && text.includes('vin'))
      ) {
        if (node instanceof HTMLElement) node.click();
        return;
      }
    }
  }

  function fillVinDom(vin) {
    const inputs = findVinInputs();
    if (!inputs.length) {
      return { ok: false, reason: 'VIN field not found on this page' };
    }
    const input = inputs[0];
    input.focus();
    input.value = vin;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' })
    );
    clickVinAction();
    return { ok: true };
  }

  function tryFillVin(vin) {
    const value = String(vin || '').trim();
    if (!value) return { ok: false, reason: 'No VIN in session' };
    const result = fillVinDom(value);
    try {
      window.postMessage({ source: FILL_VIN_SOURCE, vin: value }, '*');
    } catch {
      // ignore
    }
    return result;
  }

  function estimatePathPrefix() {
    const match = window.location.pathname.match(/^(\/\d+\/estimate\/\d+)/i);
    return match ? match[1] : '';
  }

  function siblingActionUrl(url, action) {
    const value = String(url || '').split('?')[0];
    if (
      !value ||
      !/GetSectionData|SaveEstimateLine|DeleteEstimateLine|GetLinePreview/i.test(
        value
      )
    ) {
      return '';
    }
    return value.replace(
      /GetSectionData|SaveEstimateLine|DeleteEstimateLine|GetLinePreview/i,
      action
    );
  }

  function defaultDeleteUrl() {
    return (
      lastDeleteTemplate.url ||
      siblingActionUrl(lastEstimateApiUrl, 'DeleteEstimateLine') ||
      (estimatePathPrefix()
        ? `${estimatePathPrefix()}/DeleteEstimateLine`
        : '') ||
      `${shopPrefix()}/Estimate/DeleteEstimateLine`
    );
  }

  function deleteEstimateLineOnPage(estimateLineId) {
    return new Promise((resolve) => {
      const requestId = `webest-del-${Date.now()}-${++deleteSeq}`;
      const url = lastDeleteTemplate.url || defaultDeleteUrl();
      const body = substituteEstimateLineId(
        lastDeleteTemplate.body,
        estimateLineId
      );
      const contentType = lastDeleteTemplate.body
        ? lastDeleteTemplate.contentType
        : 'application/json';

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        resolve(result);
      };

      const onMessage = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== NETWORK_SOURCE) return;
        if (data.webestDelete !== true || data.requestId !== requestId) return;
        const status = Number(data.status);
        const parsed = parseJsonBody(data.body);
        const failed =
          (Number.isFinite(status) && status > 0 && status >= 400) ||
          parsed?.Success === false;
        finish({
          ok: !failed,
          error: failed
            ? parsed?.ErrorMessage || `Delete failed (${status || 'network'})`
            : undefined
        });
      };

      window.addEventListener('message', onMessage);
      try {
        window.postMessage(
          {
            source: DELETE_SOURCE,
            url,
            body,
            contentType,
            requestId
          },
          '*'
        );
      } catch (error) {
        finish({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not delete line'
        });
        return;
      }

      window.setTimeout(() => {
        finish({ ok: false, error: 'Timed out deleting estimate line' });
      }, 8000);
    });
  }

  async function removeEstimateLine(estimateLineId) {
    const id = String(estimateLineId || '').trim();
    if (!id) return { ok: false, error: 'Missing estimate line id' };
    const snapshot = snapshotSections();
    lastDeletedId = id;
    dropEstimateLine(id);
    const result = await deleteEstimateLineOnPage(id);
    if (!result.ok) {
      restoreSections(snapshot);
      return result;
    }
    return { ok: true, lines: scrapeCartLines() };
  }

  async function pushCartUpdate(force = false) {
    if (dead) return;
    if (!Ami?.extensionAlive()) {
      markDead();
      return;
    }
    if (!isAddPartsPage() && !force) return;

    const lines = scrapeCartLines();
    const signature = JSON.stringify(
      lines.map((l) => [
        l.externalId,
        l.partNumber,
        l.description,
        l.quantity,
        l.cost,
        l.laborHours,
        l.laborCategory,
        l.lineKind
      ])
    );
    if (!force && signature === lastSentSignature) return;

    lastSentSignature = signature;
    const response = await Ami.sendMessage({
      type: 'AMI_UPDATE_CART',
      lines,
      allowEmpty: true
    });
    if (response?.error && /invalidated|refresh this tab/i.test(response.error)) {
      markDead();
    }
  }

  installNetworkHooks();

  window.setTimeout(() => requestGridRead(true), 600);
  window.setTimeout(() => requestGridRead(false), 1600);
  window.setTimeout(() => requestGridRead(true), 3200);
  window.setInterval(() => {
    if (dead) return;
    if (!isAddPartsPage()) return;
    requestGridRead(false);
  }, 2500);

  let lastPath = window.location.pathname;
  window.setInterval(() => {
    if (window.location.pathname === lastPath) return;
    lastPath = window.location.pathname;
    if (isAddPartsPage()) {
      window.setTimeout(() => requestGridRead(true), 400);
      window.setTimeout(() => requestGridRead(false), 1200);
    }
  }, 800);

  window.__amiTryFillVin = tryFillVin;

  window.addEventListener('ami-parts-bridge-fill-vin', () => {
    void Ami.sendMessage({ type: 'AMI_GET_SESSION' }).then((response) => {
      const vin = response?.session?.vehicle?.vin;
      window.dispatchEvent(
        new CustomEvent('ami-parts-bridge-fill-vin-result', {
          detail: tryFillVin(vin)
        })
      );
    });
  });

  window.addEventListener('ami-parts-bridge-reset-cart', () => {
    resetCart();
  });

  window.addEventListener('ami-parts-bridge-scrape-now', () => {
    if (!requestGridRead(true)) {
      void pushCartUpdate(true);
    }
  });

  document.addEventListener(
    'click',
    (event) => {
      if (!isAddPartsPage()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const closest = (selector) => {
        try {
          return target.closest(selector);
        } catch {
          return null;
        }
      };
      if (
        closest('.DeleteME') ||
        closest('#btnAddManualEntry') ||
        closest('.btnAdd') ||
        closest('[onclick*="DeleteME"]') ||
        closest('[onclick*="AddLabor"]')
      ) {
        window.setTimeout(() => requestGridRead(false), 400);
        window.setTimeout(() => requestGridRead(true), 900);
      }
    },
    true
  );

  Ami?.onRuntimeMessage((message, _sender, sendResponse) => {
    if (message?.type === 'AMI_TRY_FILL_VIN') {
      sendResponse(tryFillVin(message.vin));
      return;
    }
    if (message?.type === 'AMI_REMOVE_ESTIMATE_LINE') {
      const id =
        String(message.estimateLineId || '').trim() ||
        estimateLineIdFromExternal(message.externalId);
      void removeEstimateLine(id).then((result) => {
        sendResponse(
          result.ok
            ? { ok: true, lines: result.lines }
            : { ok: false, error: result.error || 'Could not remove estimate line' }
        );
      });
      return true;
    }
    if (message?.type === 'AMI_SCRAPE_NOW') {
      const started = requestGridRead(true);
      window.setTimeout(() => requestGridRead(false), 500);
      window.setTimeout(() => {
        sendResponse({
          ok: true,
          started,
          lines: scrapeCartLines(),
          source: 'GetSectionData'
        });
      }, 900);
      return true;
    }
    if (message?.type === 'AMI_SESSION_UPDATED' && message.resetCart) {
      resetCart();
      sendResponse({ ok: true });
      return;
    }
  });

  Ami?.onStorageChanged((changes, area) => {
    if (area !== 'local' || !changes.amiPartsBridgeSession) return;
    const next = changes.amiPartsBridgeSession.newValue;
    if (!next) {
      sectionLines.clear();
      networkLines = [];
      lastSentSignature = '';
      return;
    }
    const nextLines = Array.isArray(next.lines) ? next.lines : [];
    const nextSig = JSON.stringify(
      nextLines.map((l) => [
        l.externalId,
        l.partNumber,
        l.description,
        l.quantity,
        l.cost,
        l.laborHours
      ])
    );
    if (nextSig === lastSentSignature) return;
    if (isAddPartsPage()) void pushCartUpdate(true);
  });
})();
