function setTheme(theme, remember = false) {
  if (theme !== 'dark') theme = 'light';
  document.documentElement.dataset.theme = theme;
  let browserColor = '#f8f9fb';
  if (theme === 'dark') browserColor = '#121820';
  document.querySelector('meta[name="theme-color"]').content = browserColor;
  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    if (theme === 'dark') {
      toggle.textContent = '☀ Light';
      toggle.setAttribute('aria-label', 'Switch to light mode');
    } else {
      toggle.textContent = '☾ Dark';
      toggle.setAttribute('aria-label', 'Switch to dark mode');
    }
    toggle.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  if (remember) {
    try { localStorage.setItem('times-forcast-theme', theme); } catch { /* The toggle still works if storage is blocked. */ }
  }
}

function toggleTheme() {
  let nextTheme = 'dark';
  if (document.documentElement.dataset.theme === 'dark') nextTheme = 'light';
  setTheme(nextTheme, true);
}

// Apply before styles load to avoid a bright flash when dark mode is saved.
let savedTheme;
try { savedTheme = localStorage.getItem('times-forcast-theme'); } catch { /* Use the system preference. */ }
let initialTheme = 'light';
if (window.matchMedia('(prefers-color-scheme: dark)').matches) initialTheme = 'dark';
if (savedTheme === 'light' || savedTheme === 'dark') initialTheme = savedTheme;
setTheme(initialTheme);
