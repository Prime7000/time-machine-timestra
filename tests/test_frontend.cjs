const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

// Load the real browser functions with just enough DOM for their initial bindings.
const elements = {};
const context = vm.createContext({
  Intl, Date, URLSearchParams, console,
  document: { getElementById(id) { return elements[id] ||= { value: '', getContext() { return {}; } }; } },
});
const source = fs.readFileSync('static/app.js', 'utf8');
vm.runInContext(source.slice(0, source.indexOf("$('file-input').addEventListener")), context);
function run(code) { return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)); }

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
