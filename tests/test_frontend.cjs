const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

// Load the real browser functions with just enough DOM for their initial bindings.
const elements = {};
const drawing = new Proxy({}, { get: (target, property) => target[property] ?? (() => {}) });
function element() {
  return {
    value: '', dataset: {}, children: [], listeners: {}, attributes: {},
    getContext() { return drawing; },
    getBoundingClientRect() { return { width: 800, height: 335 }; },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
  };
}
const context = vm.createContext({
  Intl, Date, URLSearchParams, console, window: { devicePixelRatio: 1 },
  getComputedStyle() { return { getPropertyValue() { return '#000000'; } }; },
  cancelAnimationFrame() {},
  document: {
    getElementById(id) { return elements[id] ||= element(); },
    createElement() { return element(); },
  },
});
const source = fs.readFileSync('static/app.js', 'utf8');
vm.runInContext(source.slice(0, source.indexOf("$('file-input').addEventListener")), context);
function run(code) { return JSON.parse(vm.runInContext(`JSON.stringify((${code}) ?? null)`, context)); }

test('date parsing rejects invalid dates and numeric measurements', () => {
  assert.equal(run("dateValue('2024-02-29')"), Date.UTC(2024, 1, 29));
  assert.equal(run("dateValue('2023-02-29')"), null);
  assert.equal(run("dateValue('2024-02-30')"), null);
  assert.equal(run("dateValue('2024/2/9')"), Date.UTC(2024, 1, 9));
  assert.equal(run('dateValue(12345)'), null);
  assert.equal(run("dateValue('12345')"), null);
  assert.equal(run("dateValue('2024-01-01 23:00:00')"), Date.UTC(2024, 0, 1, 23));
});

test('row numbering translates to zero-based selection and exclusive endpoint', () => {
  vm.runInContext("state.metadata = {total_rows: 5}; state.mode = 'row'; $('start-row').value = '2'; $('end-row').value = '4';", context);
  assert.deepEqual(run('selectedRows()'), { rows: [1, 2, 3], following: [4] });
  const request = run('requestOptions(2)');
  assert.equal(request.path, '/plot_values?start_num=1&end_num=4');
  assert.equal(JSON.parse(request.options.body).prediction, 2);
});

test('date filter handles unsorted rows and includes the full end day', () => {
  vm.runInContext(`
    state.mode = 'date'; state.metadata = {total_rows: 4};
    state.rawColumns = {date: ['2024-01-04', '2024-01-02 23:00:00', '2024-01-03', '2024-01-01']};
    $('date-column').value = 'date'; $('start-date').value = '2024-01-01'; $('end-date').value = '2024-01-02';
  `, context);
  assert.deepEqual(run('selectedRows()'), { rows: [3, 1], following: [2, 0] });
  const request = run('requestOptions(2)');
  assert.deepEqual(JSON.parse(request.options.body).rows, [3, 1]);
  assert.equal(request.path, '/plot_values?');
});

test('frontend constructs forecast dates with leap years and month ends', () => {
  elements['x-column'].value = 'date';
  assert.deepEqual(run("futureLabels(['2024-01-01','2024-01-02','2024-01-03'], 2)"), ['2024-01-04', '2024-01-05']);
  assert.deepEqual(run("futureLabels(['2023-11-30','2023-12-31','2024-01-31'], 3)"), ['2024-02-29', '2024-03-31', '2024-04-30']);
  assert.deepEqual(run("futureLabels(['2024-01-01','2024-01-03','2024-01-04'], 2)"), ['Step +1', 'Step +2']);
});

test('frontend derives plot slices, original row labels, and observed comparisons', () => {
  elements['x-column'].value = 'date';
  const data = run(`chartData({
    value: [10,20,30,40], x_axis: ['2024-01-01','2024-01-02','2024-01-03','2024-01-04'],
    prediction: [31,32], lower: [29,30], upper: [33,34]
  }, {rows: [0,1,2], following: [3]})`);
  assert.deepEqual(data.value, [10, 20, 30]);
  assert.deepEqual(data.row_numbers, [1, 2, 3]);
  assert.deepEqual(data.actual_value, [40]);
  assert.deepEqual(data.prediction_x_axis, ['2024-01-04', '2024-01-05']);
});

test('chart viewport stays inside the data and keeps at least five points', () => {
  assert.deepEqual(run('clampChartView(-50, -30, 100)'), { start: 0, end: 20 });
  assert.deepEqual(run('clampChartView(90, 110, 100)'), { start: 79, end: 99 });
  assert.deepEqual(run('clampChartView(30, 31, 100)'), { start: 30, end: 34 });
  assert.deepEqual(run('clampChartView(10, 500, 100)'), { start: 0, end: 99 });
  assert.deepEqual(run('clampChartView(0, 0, 1)'), { start: 0, end: 0 });
  assert.deepEqual(run('clampChartView(5, 10, 0)'), { start: 0, end: 0 });
  assert.deepEqual(run('clampChartView(NaN, Infinity, 10)'), { start: 0, end: 9 });
});

function chartFixture() {
  vm.runInContext(`
    state.busy = false; state.hover = null; state.view = null;
    state.data = {
      value: Array.from({length: 100}, (_, i) => i),
      x_axis: Array.from({length: 100}, (_, i) => i + 1),
      prediction: [100,101,102,103,104,105,106,107,108,109],
      prediction_x_axis: [101,102,103,104,105,106,107,108,109,110],
      actual_value: [], lower: [], upper: []
    };
  `, context);
}

test('zoom keeps the cursor anchor at the same data position', () => {
  chartFixture();
  run('zoomChart(0.5, 0.25)');
  const view = run('chartView()');
  assert.equal(view.end - view.start, 54.5);
  assert.equal(view.start + (view.end - view.start) * 0.25, 109 * 0.25);
  assert.equal(elements['zoom-level'].textContent, '2×');
  assert.equal(elements['chart-position'].disabled, false);
});

test('pan and reset preserve the series and clamp at both ends', () => {
  chartFixture();
  run('setChartView(20, 40)');
  run('panChart(0.25)');
  assert.deepEqual(run('chartView()'), { start: 25, end: 45 });
  run('panChart(-100)');
  assert.deepEqual(run('chartView()'), { start: 0, end: 20 });
  run('panChart(100)');
  assert.deepEqual(run('chartView()'), { start: 89, end: 109 });
  run('resetChartView()');
  assert.deepEqual(run('chartView()'), { start: 0, end: 109 });
  assert.equal(run('state.data.value.length'), 100);
  assert.equal(elements['chart-position'].disabled, true);
});

test('forecast focus includes recent history and the full prediction horizon', () => {
  chartFixture();
  run('focusForecast()');
  assert.deepEqual(run('chartView()'), { start: 90, end: 109 });
  assert.equal(elements['pan-right'].disabled, true);
  assert.equal(elements['pan-left'].disabled, false);
});

test('vertical scaling uses the visible values instead of distant outliers', () => {
  chartFixture();
  vm.runInContext('state.data.value = Array.from({length: 100}, (_, i) => i < 5 ? 10 + i : 10000);', context);
  run('setChartView(0, 4)');
  const middle = run('chartGeometry.y(12)');
  assert.equal(middle, (25 + 335 - 41) / 2);
  assert.equal(run('chartGeometry.x(0)'), 54);
  assert.equal(run('chartGeometry.x(4)'), 778);
});

test('helper choices exclude the target and check numeric values in the selected history', () => {
  vm.runInContext(`
    state.metadata = {columns: ['humidity', 'temperature', 'wind', 'pressure']};
    state.rawColumns = {
      humidity: [40, 50, 60], temperature: [10, null, 12],
      wind: [null, null, 3], pressure: [null, null, null]
    };
    $('value-column').value = 'humidity';
  `, context);
  assert.deepEqual(run('helperChoices([0, 1])'), [
    {column: 'temperature', eligible: true},
    {column: 'wind', eligible: false},
    {column: 'pressure', eligible: false},
  ]);
  assert.equal(run('helperChoices([2])[1].eligible'), true);
  assert.deepEqual(run('helperChoices([]).map(choice => choice.eligible)'), [false, false, false]);
});

test('forecast requests include exactly the helper columns selected in the frontend', () => {
  vm.runInContext(`
    state.metadata = {total_rows: 5}; state.mode = 'row';
    $('start-row').value = '1'; $('end-row').value = '3';
    state.helperColumns = ['temperature', 'wind'];
  `, context);
  assert.deepEqual(JSON.parse(run('requestOptions(14)').options.body).helper_columns, ['temperature', 'wind']);
  vm.runInContext('state.helperColumns = [];', context);
  assert.deepEqual(JSON.parse(run('requestOptions(14)').options.body).helper_columns, []);
});

test('rendered helper switches exclude the target and disable unusable columns', () => {
  vm.runInContext(`
    state.metadata = {total_rows: 3, columns: ['humidity', 'temperature', 'pressure']};
    state.rawColumns = {humidity: [40,50,60], temperature: [10,11,12], pressure: [null,null,null]};
    state.helperColumns = ['humidity', 'temperature', 'pressure']; state.mode = 'row';
    $('value-column').value = 'humidity'; $('start-row').value = '1'; $('end-row').value = '3';
    renderHelpers();
  `, context);
  const labels = elements['helper-options'].children;
  assert.deepEqual(labels.map(label => label.children[0].textContent), ['temperature', 'pressure']);
  assert.equal(labels[0].children[1].attributes.role, 'switch');
  assert.equal(labels[0].children[1].checked, true);
  assert.equal(labels[1].children[1].disabled, true);
  assert.deepEqual(run('state.helperColumns'), ['temperature']);
  assert.equal(elements['helper-count'].textContent, '1 on');
});

test('switch changes update helper selection and remove a newly selected target', () => {
  vm.runInContext('const originalQueuePreview = queuePreview; queuePreview = () => {};', context);
  try {
    const toggle = elements['helper-options'].children[0].children[1];
    toggle.checked = false;
    toggle.listeners.change();
    assert.deepEqual(run('state.helperColumns'), []);
    toggle.checked = true;
    toggle.listeners.change();
    assert.deepEqual(run('state.helperColumns'), ['temperature']);
    vm.runInContext("$('value-column').value = 'temperature'; renderHelpers();", context);
    assert.deepEqual(run('state.helperColumns'), []);
    assert.equal(elements['helper-count'].textContent, '0 on');
    assert.deepEqual(elements['helper-options'].children.map(label => label.children[0].textContent), ['humidity', 'pressure']);
  } finally {
    vm.runInContext('queuePreview = originalQueuePreview;', context);
  }
});
