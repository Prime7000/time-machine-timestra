const $ = (id) => document.getElementById(id);
const state = { metadata: null, data: null, rawColumns: {}, mode: 'row', busy: false, hover: null, view: null };
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const canvas = $('chart');
const ctx = canvas.getContext('2d');
let previewTimer;
let animationFrame;
let chartGeometry;
const chartPointers = new Map();
let chartGesture;

function format(value) {
  return value === null || value === undefined ? '—' : number.format(value);
}

function showNotice(message = '', success = false) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('success', success);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) {
    const detail = result.detail;
    throw new Error(Array.isArray(detail) ? detail.map((item) => item.msg).join('; ') : detail || 'The request failed. Please try again.');
  }
  return result;
}

function setBusy(busy, forecasting = false) {
  state.busy = busy;
  $('settings').disabled = busy || !state.metadata;
  $('file-input').disabled = busy;
  $('clear').disabled = busy || !state.metadata;
  $('chart-loading').hidden = !forecasting;
  $('run').textContent = forecasting ? 'Generating forecast…' : '✧  Generate forecast  →';
  $('replay').disabled = busy || !state.data;
  $('download').disabled = busy || !state.data?.prediction.length;
  $('forecast-form').setAttribute('aria-busy', String(busy));
  updateChartNavigation();
}

function fillSelect(element, columns, includeRows = false) {
  element.replaceChildren();
  if (includeRows) element.add(new Option('Row number', ''));
  for (const column of columns) element.add(new Option(column, column));
}

function dateValue(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(.*)$/);
  if (!match || (match[4] && !/^[T\s]/.test(match[4]))) return null;
  const day = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const midnight = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) return null;
  if (!match[4].trim()) return midnight;
  let time = match[4].trim().replace(/^T/, '');
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(time)) time += 'Z';
  const timestamp = Date.parse(`${day}T${time}`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function prepareMetadata(metadata) {
  state.rawColumns = {};
  const dates = [];
  const ranges = {};
  // Fetch raw stored values; date detection and ranges belong to the browser.
  await Promise.all(metadata.plot_against.map(async (column) => {
    const result = await api(`/get_date?${new URLSearchParams({ date_col: column })}`);
    state.rawColumns[column] = result.dates_value;
  }));
  for (const column of metadata.plot_against) {
    const parsed = state.rawColumns[column].map(dateValue);
    if (!parsed.length || parsed.some((value) => value === null)) continue;
    const sorted = parsed.slice().sort((a, b) => a - b);
    dates.push(column);
    ranges[column] = {
      start: new Date(sorted[0]).toISOString().slice(0, 10),
      end: new Date(sorted.at(-1)).toISOString().slice(0, 10),
    };
  }
  return { ...metadata, all_columns: [...metadata.columns, ...metadata.plot_against], date_col: dates, date_ranges: ranges };
}

function setMetadata(metadata, filename = 'Current dataset.csv') {
  state.metadata = metadata;
  $('file-name').textContent = filename;
  $('file-detail').textContent = 'Click or drop a CSV to replace';
  $('dataset-summary').hidden = false;
  $('row-count').textContent = `${number.format(metadata.total_rows)} rows`;
  fillSelect($('value-column'), metadata.columns);
  fillSelect($('x-column'), metadata.all_columns, true);
  fillSelect($('date-column'), metadata.date_col);
  // Prefer a column explicitly named date over other date-like metadata columns.
  const dateColumn = metadata.date_col.find((column) => column.toLowerCase() === 'date') || metadata.date_col[0];
  if (dateColumn) {
    $('x-column').value = dateColumn;
    $('date-column').value = dateColumn;
    setDateBounds();
  }
  $('start-row').value = 1;
  $('end-row').value = metadata.total_rows;
  $('start-row').max = metadata.total_rows;
  $('end-row').max = metadata.total_rows;
  setMode('row');
  setBusy(false);
}

function setDateBounds() {
  const range = state.metadata.date_ranges[$('date-column').value];
  if (!range) return;
  for (const id of ['start-date', 'end-date']) {
    $(id).min = range.start;
    $(id).max = range.end;
  }
  $('start-date').value = range.start;
  $('end-date').value = range.end;
}

function setMode(mode) {
  state.mode = mode;
  $('row-fields').hidden = mode !== 'row';
  $('date-fields').hidden = mode !== 'date';
  for (const name of ['row', 'date']) {
    $(`${name}-mode`).classList.toggle('active', name === mode);
    $(`${name}-mode`).setAttribute('aria-pressed', String(name === mode));
  }
  $('date-mode').disabled = !state.metadata?.date_col.length;
  $('date-mode').title = $('date-mode').disabled ? 'This dataset has no complete date column' : 'Filter by a date range';
  $('start-row').required = mode === 'row';
  $('end-row').required = mode === 'row';
  $('start-date').required = mode === 'date';
  $('end-date').required = mode === 'date';
  $('window-hint').textContent = mode === 'row'
    ? 'Row numbers start at 1. Both ends are included.'
    : 'Both dates are included. History is ordered by date.';
  for (const id of ['start-row', 'end-row']) $(id).disabled = mode !== 'row';
  for (const id of ['date-column', 'start-date', 'end-date']) $(id).disabled = mode !== 'date';
}

function selectedRows() {
  const total = state.metadata.total_rows;
  const allRows = Array.from({ length: total }, (_, index) => index);
  if (state.mode === 'row') {
    const start = Number($('start-row').value) - 1;
    const end = Number($('end-row').value);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > total) {
      throw new Error('Choose a nonempty row range within your dataset.');
    }
    return { rows: allRows.slice(start, end), following: allRows.slice(end) };
  }
  const start = Date.parse(`${$('start-date').value}T00:00:00Z`);
  const end = Date.parse(`${$('end-date').value}T00:00:00Z`) + 86400000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Choose a valid start and end date.');
  const dates = state.rawColumns[$('date-column').value].map(dateValue);
  const ordered = allRows.sort((a, b) => dates[a] - dates[b]);
  const rows = ordered.filter((row) => dates[row] >= start && dates[row] < end);
  if (!rows.length) throw new Error('No rows match these dates. Choose another date range.');
  return { rows, following: ordered.filter((row) => dates[row] > dates[rows.at(-1)]) };
}

function requestOptions(prediction = null) {
  const params = new URLSearchParams();
  const selection = selectedRows();
  if (state.mode === 'row') {
    // The endpoint keeps Python's zero-based, end-exclusive slicing convention.
    params.set('start_num', selection.rows[0]);
    params.set('end_num', selection.rows.at(-1) + 1);
  }
  if (prediction && selection.rows.length > 32768) throw new Error('Select at most 32,768 history rows for a forecast.');
  return {
    selection,
    path: `/plot_values?${params}`,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: $('value-column').value,
        x_axis: $('x-column').value || null,
        prediction,
        rows: state.mode === 'date' ? selection.rows : null,
      }),
    },
  };
}

function futureLabels(history, horizon) {
  const labels = Array.from({ length: horizon }, (_, i) => `Step +${i + 1}`);
  if (!$('x-column').value && state.mode === 'row') return labels.map((_, i) => history.at(-1) + i + 1);
  const times = history.map(dateValue);
  if (times.length < 3 || times.some((value) => value === null)) return labels;
  const dates = times.map((time) => new Date(time));
  const last = dates.at(-1);
  const months = dates.map((date) => date.getUTCFullYear() * 12 + date.getUTCMonth());
  const monthStep = months[1] - months[0];
  const monthEnd = (date) => date.getUTCDate() === new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const sameDay = dates.every((date) => date.getUTCDate() === last.getUTCDate());
  const allMonthEnds = dates.every(monthEnd);
  const sameTime = dates.every((date) => date.toISOString().slice(11) === last.toISOString().slice(11));
  const monthly = monthStep > 0 && months.every((month, i) => i === 0 || month - months[i - 1] === monthStep) && (sameDay || allMonthEnds) && sameTime;
  const interval = times[1] - times[0];
  const regular = interval > 0 && times.every((time, i) => i === 0 || time - times[i - 1] === interval);
  if (!monthly && !regular) return labels;
  return labels.map((_, i) => {
    let next;
    if (monthly) {
      next = new Date(last);
      next.setUTCDate(1);
      next.setUTCMonth(last.getUTCMonth() + monthStep * (i + 1));
      const end = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
      next.setUTCDate(allMonthEnds ? end : Math.min(last.getUTCDate(), end));
    } else next = new Date(times.at(-1) + interval * (i + 1));
    return typeof history.at(-1) === 'string' && /[T ]\d{2}:/.test(history.at(-1)) ? next.toISOString() : next.toISOString().slice(0, 10);
  });
}

function chartData(raw, selection) {
  const { rows, following } = selection;
  const labels = $('x-column').value ? raw.x_axis : raw.x_axis.map((_, index) => index + 1);
  const history = rows.map((row) => labels[row]);
  const horizon = raw.prediction.length;
  const future = futureLabels(history, horizon);
  following.slice(0, horizon).forEach((row, i) => { future[i] = labels[row]; });
  return {
    value: rows.map((row) => raw.value[row]),
    x_axis: history,
    row_numbers: rows.map((row) => row + 1),
    selected_rows: rows.length,
    prediction: raw.prediction,
    lower: raw.lower,
    upper: raw.upper,
    prediction_x_axis: future,
    actual_value: following.slice(0, horizon).map((row) => raw.value[row]),
  };
}

async function loadPlot(forecasting = false) {
  clearTimeout(previewTimer);
  if (!state.metadata || state.busy || !$('forecast-form').reportValidity()) return;
  showNotice();
  try {
    const request = requestOptions(forecasting ? Number($('horizon').value) : null);
    setBusy(true, forecasting);
    // Never leave an old forecast looking like the result of new settings.
    state.data = null;
    updateResults();
    const raw = await api(request.path, request.options);
    state.data = chartData(raw, request.selection);
    updateResults();
    animateChart();
  } catch (error) {
    state.data = null;
    updateResults();
    showNotice(error.message);
  } finally {
    setBusy(false);
  }
}

function queuePreview() {
  clearTimeout(previewTimer);
  state.data = null;
  updateResults();
  previewTimer = setTimeout(() => loadPlot(), 350);
}

async function upload(file) {
  if (!file || state.busy) return;
  clearTimeout(previewTimer);
  showNotice();
  const form = new FormData();
  form.append('file', file);
  setBusy(true);
  try {
    const metadata = await api('/upload_doc', { method: 'POST', body: form });
    state.metadata = null;
    state.data = null;
    setMetadata(await prepareMetadata(metadata), file.name);
    await loadPlot();
  } catch (error) {
    showNotice(error.message);
  } finally {
    setBusy(false);
    $('file-input').value = '';
  }
}

function updateResults() {
  const data = state.data;
  state.view = null;
  chartPointers.clear();
  chartGesture = null;
  canvas.classList.remove('dragging');
  state.hover = null;
  $('chart-tooltip').hidden = true;
  $('chart-empty').hidden = !!data;
  $('replay').disabled = !data || state.busy;
  $('download').disabled = !data?.prediction.length || state.busy;
  $('actual-legend').hidden = !data?.actual_value.length;
  $('stat-history').textContent = data ? number.format(data.selected_rows) : '—';
  const last = data?.value.at(-1);
  $('stat-last').textContent = format(last);
  $('stat-next').textContent = format(data?.prediction[0]);
  $('stat-last-detail').textContent = data ? `at ${data.x_axis.at(-1) ?? 'last selected row'}` : 'the end of your history';
  $('stat-next-detail').textContent = data?.prediction.length ? `first of ${data.prediction.length} forecast steps` : 'generate a forecast to see';
  $('forecast-count').textContent = data?.prediction.length ? `${data.prediction.length} steps ahead` : 'No forecast yet';
  $('chart-title').textContent = data ? `${$('value-column').value}, looking ahead` : 'Your series, looking ahead';
  $('chart-subtitle').textContent = data
    ? `${number.format(data.selected_rows)} observations · ${$('x-column').value || 'Row number'} axis · Steps equally spaced`
    : state.metadata ? 'Choose a valid window to preview your history.' : 'Upload a CSV to start exploring.';
  $('chart-range').textContent = data ? `${data.x_axis[0] ?? '—'} → ${data.x_axis.at(-1) ?? '—'}` : 'No history selected';
  $('chart-status').replaceChildren();
  const dot = document.createElement('span');
  dot.className = `status-dot${data ? '' : ' neutral'}`;
  $('chart-status').append(dot, data?.prediction.length ? 'Forecast complete' : data ? 'History preview' : 'Waiting for data');
  canvas.setAttribute('aria-label', data
    ? `${$('value-column').value}: ${data.selected_rows} history observations, last value ${format(last)}. ${data.prediction.length} forecast steps. First prediction ${format(data.prediction[0])}. Forecast values and bounds are in the table below.`
    : 'Upload a dataset to display its history and forecast');
  $('forecast-rows').replaceChildren();
  if (!data?.prediction.length) {
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'table-empty';
    cell.textContent = 'Choose your history and generate a forecast. The next steps will appear here.';
    const row = document.createElement('tr');
    row.append(cell);
    $('forecast-rows').append(row);
  } else {
    const fragment = document.createDocumentFragment();
    data.prediction.forEach((value, index) => {
      const row = document.createElement('tr');
      const entries = [data.prediction_x_axis[index], format(value), format(data.lower[index]), format(data.upper[index]), format(data.actual_value[index])];
      for (const entry of entries) {
        const cell = document.createElement('td');
        cell.textContent = entry ?? '—';
        row.append(cell);
      }
      fragment.append(row);
    });
    $('forecast-rows').append(fragment);
  }
  $('table-description').textContent = data?.actual_value.length
    ? 'Compare predictions with later observations in your dataset.'
    : 'Your forecast, one step at a time.';
  drawChart();
}

function animateChart() {
  cancelAnimationFrame(animationFrame);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return drawChart();
  const start = performance.now();
  function frame(now) {
    const progress = Math.min((now - start) / 900, 1);
    drawChart(1 - (1 - progress) ** 3);
    if (progress < 1) animationFrame = requestAnimationFrame(frame);
  }
  animationFrame = requestAnimationFrame(frame);
}

function clampChartView(start, end, total) {
  const last = Math.max(0, total - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { start: 0, end: last };
  const span = Math.min(last, Math.max(Math.min(4, last), end - start));
  start = Math.max(0, Math.min(last - span, start));
  return { start, end: start + span };
}

function chartView() {
  const total = state.data ? state.data.value.length + state.data.prediction.length : 0;
  return clampChartView(state.view?.start ?? 0, state.view?.end ?? total - 1, total);
}

function setChartView(start, end) {
  if (!state.data || state.busy) return;
  const total = state.data.value.length + state.data.prediction.length;
  state.view = clampChartView(start, end, total);
  state.hover = null;
  $('chart-tooltip').hidden = true;
  cancelAnimationFrame(animationFrame);
  drawChart();
}

function zoomChart(factor, anchor = 0.5) {
  const view = chartView();
  const span = view.end - view.start;
  const total = state.data ? state.data.value.length + state.data.prediction.length : 0;
  const nextSpan = Math.min(Math.max(0, total - 1), Math.max(Math.min(4, total - 1), span * factor));
  const start = view.start + span * anchor - nextSpan * anchor;
  setChartView(start, start + nextSpan);
}

function panChart(fraction) {
  const view = chartView();
  const shift = (view.end - view.start) * fraction;
  setChartView(view.start + shift, view.end + shift);
}

function resetChartView() {
  const total = state.data ? state.data.value.length + state.data.prediction.length : 0;
  setChartView(0, total - 1);
}

function focusForecast() {
  if (!state.data?.prediction.length) return;
  const history = state.data.value.length;
  const horizon = state.data.prediction.length;
  setChartView(Math.max(0, history - Math.max(5, horizon)), history + horizon - 1);
}

function updateChartNavigation() {
  const total = state.data ? state.data.value.length + state.data.prediction.length : 0;
  const view = chartView();
  const span = view.end - view.start;
  const disabled = !state.data || state.busy;
  const full = span >= total - 1;
  $('zoom-in').disabled = disabled || span <= 4;
  $('zoom-out').disabled = disabled || full;
  $('reset-view').disabled = disabled || full;
  $('pan-left').disabled = disabled || view.start <= 0;
  $('pan-right').disabled = disabled || view.end >= total - 1;
  $('focus-forecast').disabled = disabled || !state.data?.prediction.length;
  $('chart-position').disabled = disabled || full;
  $('chart-position').max = Math.max(0, total - 1 - span);
  $('chart-position').value = view.start;
  $('chart-position').setAttribute('aria-valuetext', total ? `Observations ${Math.ceil(view.start) + 1} through ${Math.floor(view.end) + 1} of ${total}` : 'No observations');
  $('zoom-level').textContent = total > 1 ? `${Number(((total - 1) / span).toFixed(1))}×` : '1×';
  canvas.dataset.zoomed = String(!full && !!state.data);
  if (state.data) {
    const labels = [...state.data.x_axis, ...state.data.prediction_x_axis];
    $('chart-range').textContent = `${labels[Math.ceil(view.start)] ?? '—'} → ${labels[Math.floor(view.end)] ?? '—'}`;
  }
}

function drawChart(progress = 1) {
  const styles = getComputedStyle(document.documentElement);
  const color = (name) => styles.getPropertyValue(`--chart-${name}`).trim();
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const plot = { left: 54, right: width - 22, top: 25, bottom: height - 41 };
  const data = state.data;
  const view = chartView();
  updateChartNavigation();
  let low = Infinity;
  let high = -Infinity;
  if (data) {
    const series = [[data.value, 0], [data.prediction, data.value.length], [data.actual_value, data.value.length]];
    if ($('show-band').checked) series.push([data.lower, data.value.length], [data.upper, data.value.length]);
    for (const [values, offset] of series) {
      for (let i = Math.max(0, Math.floor(view.start) - offset); i <= Math.min(values.length - 1, Math.ceil(view.end) - offset); i++) {
        const value = values[i];
        if (value === null || !Number.isFinite(value)) continue;
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
  }
  if (!Number.isFinite(low)) { low = 0; high = 100; }
  const padding = (high - low || Math.abs(high) || 1) * 0.13;
  low -= padding;
  high += padding;
  const total = data ? data.value.length + data.prediction.length : 10;
  const x = (index) => total === 1 ? (plot.left + plot.right) / 2 : plot.left + (index - view.start) / Math.max(view.end - view.start, 1) * (plot.right - plot.left);
  const y = (value) => plot.bottom - (value - low) / (high - low) * (plot.bottom - plot.top);
  chartGeometry = { ...plot, x, y, total, view };
  ctx.font = '10px "DM Sans", sans-serif';
  ctx.textBaseline = 'middle';
  for (let tick = 0; tick <= 4; tick++) {
    const value = low + (high - low) * tick / 4;
    const position = y(value);
    ctx.strokeStyle = color('grid');
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(plot.left, position); ctx.lineTo(plot.right, position); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color('tick'); ctx.textAlign = 'right';
    ctx.fillText(compact.format(value), plot.left - 12, position);
  }
  if (!data) return;
  const historyLength = data.value.length;
  const labels = [...data.x_axis, ...data.prediction_x_axis];
  const first = Math.ceil(view.start);
  const last = Math.floor(view.end);
  const ticks = Math.min(width < 450 ? 3 : 5, last - first + 1);
  for (let tick = 0; tick < ticks; tick++) {
    const index = ticks === 1 ? first : Math.round(first + (last - first) * tick / (ticks - 1));
    ctx.textAlign = tick === 0 ? 'left' : tick === ticks - 1 ? 'right' : 'center';
    ctx.fillStyle = color('tick');
    let label = String(labels[index] ?? '—');
    if (/^\d{4}-\d{2}-\d{2}/.test(label)) label = label.slice(0, 10);
    if (label.length > 14) label = `${label.slice(0, 12)}…`;
    ctx.fillText(label, x(index), height - 19);
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(plot.left - 2, plot.top - 8, (plot.right - plot.left + 4) * progress, plot.bottom - plot.top + 16); ctx.clip();
  if (data.prediction.length) {
    const boundary = x(historyLength - 1);
    const forecastStart = Math.max(plot.left, Math.min(plot.right, boundary));
    ctx.fillStyle = color('shade'); ctx.fillRect(forecastStart, plot.top, plot.right - forecastStart, plot.bottom - plot.top);
    ctx.strokeStyle = color('boundary'); ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(boundary, plot.top); ctx.lineTo(boundary, plot.bottom); ctx.stroke(); ctx.setLineDash([]);
    if (plot.right - forecastStart > 65) {
      ctx.font = '9px "DM Sans", sans-serif'; ctx.fillStyle = color('label'); ctx.textAlign = 'left'; ctx.fillText('FORECAST →', forecastStart + 10, plot.top + 7);
    }
    if ($('show-band').checked) {
      // Fill each finite run separately so missing forecast values never become zeros.
      let start = Math.max(0, Math.floor(view.start) - historyLength);
      const limit = Math.min(data.prediction.length, Math.ceil(view.end) - historyLength + 1);
      while (start < limit) {
        while (start < limit && (data.lower[start] === null || data.upper[start] === null)) start++;
        let end = start;
        while (end < limit && data.lower[end] !== null && data.upper[end] !== null) end++;
        if (end > start) {
          ctx.beginPath();
          ctx.moveTo(x(historyLength + start), y(data.upper[start]));
          for (let i = start + 1; i < end; i++) ctx.lineTo(x(historyLength + i), y(data.upper[i]));
          for (let i = end - 1; i >= start; i--) ctx.lineTo(x(historyLength + i), y(data.lower[i]));
          ctx.closePath(); ctx.fillStyle = color('band'); ctx.fill();
        }
        start = end + 1;
      }
    }
  }
  function line(values, offset, color, dashed = false) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.setLineDash(dashed ? [4, 4] : []);
    let drawing = false;
    // At most two points per display pixel, while preserving gaps.
    const start = Math.max(0, Math.floor(view.start) - offset);
    const end = Math.min(values.length - 1, Math.ceil(view.end) - offset);
    const stride = Math.max(1, Math.floor((end - start) / (width * 2)));
    for (let i = start; i <= end; i++) {
      if (values[i] === null) { drawing = false; continue; }
      if (drawing && i % stride !== 0 && i !== end && values[i + 1] !== null) continue;
      if (drawing) ctx.lineTo(x(i + offset), y(values[i]));
      else { ctx.moveTo(x(i + offset), y(values[i])); drawing = true; }
    }
    ctx.stroke(); ctx.setLineDash([]);
    if (values.length === 1 && values[0] !== null && offset >= view.start && offset <= view.end) {
      ctx.beginPath(); ctx.arc(x(offset), y(values[0]), 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    }
  }
  line(data.value, 0, color('history'));
  if (data.prediction.length) line([data.value.at(-1), ...data.prediction], historyLength - 1, color('forecast'));
  if (data.actual_value.length) line([data.value.at(-1), ...data.actual_value], historyLength - 1, color('actual'), true);
  ctx.restore();
  if (state.hover !== null && state.hover >= view.start && state.hover <= view.end && progress === 1) {
    const index = state.hover;
    const value = index < historyLength ? data.value[index] : data.prediction[index - historyLength];
    ctx.strokeStyle = color('hover'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x(index), plot.top); ctx.lineTo(x(index), plot.bottom); ctx.stroke(); ctx.setLineDash([]);
    if (value !== null) {
      ctx.beginPath(); ctx.arc(x(index), y(value), 4, 0, Math.PI * 2);
      ctx.fillStyle = color(index < historyLength ? 'history' : 'forecast'); ctx.fill(); ctx.strokeStyle = color('outline'); ctx.lineWidth = 2; ctx.stroke();
    }
  }
}

function showTooltip(index) {
  const data = state.data;
  if (!data || !chartGeometry) return;
  cancelAnimationFrame(animationFrame);
  state.hover = index;
  const history = index < data.value.length;
  const step = index - data.value.length;
  const tooltip = $('chart-tooltip');
  tooltip.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = history ? data.x_axis[index] ?? 'Missing axis value' : data.prediction_x_axis[step];
  tooltip.append(title);
  const lines = history ? [`History: ${format(data.value[index])}`, `Row ${data.row_numbers[index]}`]
    : [`Prediction: ${format(data.prediction[step])}`, `80% interval: ${format(data.lower[step])} – ${format(data.upper[step])}`];
  if (!history && data.actual_value[step] !== undefined) lines.push(`Observed: ${format(data.actual_value[step])}`);
  for (const text of lines) {
    const line = document.createElement('div');
    line.textContent = text;
    tooltip.append(line);
  }
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(Math.max(4, chartGeometry.x(index) - 60), canvas.clientWidth - tooltip.offsetWidth - 4)}px`;
  tooltip.style.top = '30px';
  drawChart();
}

function downloadForecast() {
  const data = state.data;
  if (!data?.prediction.length) return;
  function csvCell(value) {
    let text = String(value ?? '');
    // Axis labels originate in uploaded files; prevent spreadsheet formula execution.
    if (/^[=+@\-\t\r]/.test(text) && typeof value === 'string') text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }
  const rows = [['axis', 'prediction', 'lower_10_percent', 'upper_90_percent', 'observed']];
  data.prediction.forEach((value, i) => rows.push([data.prediction_x_axis[i], value, data.lower[i], data.upper[i], data.actual_value[i]]));
  const url = URL.createObjectURL(new Blob([rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'times-forcast.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('file-input').addEventListener('change', (event) => upload(event.target.files[0]));
for (const name of ['dragenter', 'dragover']) $('drop-zone').addEventListener(name, (event) => {
  event.preventDefault();
  if (!state.busy) $('drop-zone').classList.add('dragover');
});
for (const name of ['dragleave', 'drop']) $('drop-zone').addEventListener(name, (event) => {
  event.preventDefault(); $('drop-zone').classList.remove('dragover');
  if (name === 'drop') upload(event.dataTransfer.files[0]);
});
$('forecast-form').addEventListener('submit', (event) => { event.preventDefault(); loadPlot(true); });
for (const mode of ['row', 'date']) $(`${mode}-mode`).addEventListener('click', () => {
  setMode(mode);
  if (mode === 'date') $('x-column').value = $('date-column').value;
  queuePreview();
});
for (const id of ['value-column', 'x-column', 'start-row', 'end-row', 'start-date', 'end-date']) $(id).addEventListener('change', queuePreview);
$('date-column').addEventListener('change', () => { setDateBounds(); $('x-column').value = $('date-column').value; queuePreview(); });
function horizonChanged() {
  for (const button of document.querySelectorAll('[data-horizon]')) button.classList.toggle('active', button.dataset.horizon === $('horizon').value);
  if (state.data?.prediction.length) queuePreview();
}
$('horizon').addEventListener('input', horizonChanged);
for (const button of document.querySelectorAll('[data-horizon]')) button.addEventListener('click', () => { $('horizon').value = button.dataset.horizon; horizonChanged(); });
$('clear').addEventListener('click', async () => {
  if (state.busy) return;
  clearTimeout(previewTimer);
  setBusy(true);
  try {
    await api('/clear', { method: 'POST' });
    state.metadata = null; state.data = null; state.rawColumns = {};
    $('file-name').textContent = 'Drop your CSV here';
    $('file-detail').textContent = 'or click to browse files';
    $('dataset-summary').hidden = true;
    fillSelect($('value-column'), ['Upload a dataset first']);
    fillSelect($('x-column'), [], true);
    fillSelect($('date-column'), []);
    setMode('row');
    showNotice(); updateResults();
  } catch (error) { showNotice(error.message); }
  finally { setBusy(false); }
});
$('show-band').addEventListener('change', () => { cancelAnimationFrame(animationFrame); drawChart(); });
$('replay').addEventListener('click', () => { state.hover = null; $('chart-tooltip').hidden = true; animateChart(); });
$('download').addEventListener('click', downloadForecast);
$('zoom-in').addEventListener('click', () => zoomChart(0.65));
$('zoom-out').addEventListener('click', () => zoomChart(1 / 0.65));
$('pan-left').addEventListener('click', () => panChart(-0.25));
$('pan-right').addEventListener('click', () => panChart(0.25));
$('reset-view').addEventListener('click', resetChartView);
$('focus-forecast').addEventListener('click', focusForecast);
$('chart-position').addEventListener('input', (event) => {
  const view = chartView();
  const start = Number(event.target.value);
  setChartView(start, start + view.end - view.start);
});

function chartIndexAt(position) {
  const view = chartView();
  const fraction = (position - chartGeometry.left) / (chartGeometry.right - chartGeometry.left);
  return Math.max(Math.ceil(view.start), Math.min(Math.floor(view.end), Math.round(view.start + fraction * (view.end - view.start))));
}

function beginChartGesture() {
  const points = [...chartPointers.values()];
  if (!points.length) { chartGesture = null; canvas.classList.remove('dragging'); return; }
  chartGesture = {
    view: chartView(),
    center: points.length > 1 ? (points[0].x + points[1].x) / 2 : points[0].x,
    distance: points.length > 1 ? Math.max(1, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)) : 0,
  };
}

canvas.addEventListener('wheel', (event) => {
  if (!state.data || state.busy || !chartGeometry) return;
  const rect = canvas.getBoundingClientRect();
  const position = event.clientX - rect.left;
  if (position < chartGeometry.left || position > chartGeometry.right || event.clientY - rect.top < chartGeometry.top || event.clientY - rect.top > chartGeometry.bottom) return;
  event.preventDefault();
  const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
  zoomChart(Math.exp(Math.max(-0.7, Math.min(0.7, pixels * 0.002))), (position - chartGeometry.left) / (chartGeometry.right - chartGeometry.left));
}, { passive: false });

canvas.addEventListener('pointerdown', (event) => {
  if (!state.data || state.busy || !chartGeometry || event.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (point.x < chartGeometry.left || point.x > chartGeometry.right || point.y < chartGeometry.top || point.y > chartGeometry.bottom) return;
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture(event.pointerId);
  chartPointers.set(event.pointerId, point);
  beginChartGesture();
  state.hover = null;
  $('chart-tooltip').hidden = true;
});

canvas.addEventListener('pointermove', (event) => {
  if (!state.data || state.busy || !chartGeometry) return;
  const rect = canvas.getBoundingClientRect();
  const position = event.clientX - rect.left;
  if (chartPointers.has(event.pointerId) && chartGesture) {
    chartPointers.set(event.pointerId, { x: position, y: event.clientY - rect.top });
    const points = [...chartPointers.values()];
    const center = points.length > 1 ? (points[0].x + points[1].x) / 2 : points[0].x;
    const distance = points.length > 1 ? Math.max(1, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)) : 0;
    if (Math.abs(center - chartGesture.center) < 3 && points.length === 1 && !canvas.classList.contains('dragging')) return;
    canvas.classList.add('dragging');
    const view = chartGesture.view;
    const span = view.end - view.start;
    const scale = chartGesture.distance && distance ? chartGesture.distance / distance : 1;
    const total = state.data.value.length + state.data.prediction.length;
    const nextSpan = clampChartView(0, span * scale, total).end;
    const width = chartGeometry.right - chartGeometry.left;
    const anchor = view.start + span * (chartGesture.center - chartGeometry.left) / width;
    const start = anchor - nextSpan * (center - chartGeometry.left) / width;
    setChartView(start, start + nextSpan);
  } else if (event.pointerType !== 'touch') showTooltip(chartIndexAt(position));
});

function endChartGesture(event) {
  if (!chartPointers.has(event.pointerId)) return;
  const tap = chartPointers.size === 1 && !canvas.classList.contains('dragging') && event.type === 'pointerup';
  chartPointers.delete(event.pointerId);
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  beginChartGesture();
  if (tap && state.data) showTooltip(chartIndexAt(event.clientX - canvas.getBoundingClientRect().left));
}
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, endChartGesture);
canvas.addEventListener('dblclick', resetChartView);
function hideTooltip() { state.hover = null; $('chart-tooltip').hidden = true; drawChart(); }
canvas.addEventListener('pointerleave', () => { if (!chartPointers.size) hideTooltip(); });
canvas.addEventListener('blur', hideTooltip);
canvas.addEventListener('keydown', (event) => {
  if (!state.data || state.busy || !['ArrowLeft', 'ArrowRight', 'Escape', '+', '=', '-', '_', 'Home'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Escape') return hideTooltip();
  if (event.key === 'Home') return resetChartView();
  if (['+', '='].includes(event.key)) return zoomChart(0.65);
  if (['-', '_'].includes(event.key)) return zoomChart(1 / 0.65);
  if (event.shiftKey) return panChart(event.key === 'ArrowRight' ? 0.25 : -0.25);
  const view = chartView();
  const index = Math.max(0, Math.min(chartGeometry.total - 1, (state.hover ?? Math.ceil(view.start)) + (event.key === 'ArrowRight' ? 1 : -1)));
  if (index < view.start || index > view.end) {
    const start = index < view.start ? index : index - (view.end - view.start);
    setChartView(start, start + view.end - view.start);
  }
  showTooltip(index);
});
new ResizeObserver(() => drawChart()).observe($('chart-wrap'));

$('theme-toggle').addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
  cancelAnimationFrame(animationFrame);
  drawChart();
});
setTheme(document.documentElement.dataset.theme);
setBusy(false);
drawChart();
