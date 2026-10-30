function setTheme(theme, remember = false) {
  theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#121820' : '#f8f9fb';
  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.textContent = theme === 'dark' ? '☀ Light' : '☾ Dark';
    toggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
    toggle.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  if (remember) {
    try { localStorage.setItem('times-forcast-theme', theme); } catch { /* The toggle still works if storage is blocked. */ }
  }
}

// Apply before styles load to avoid a bright flash when dark mode is saved.
let savedTheme;
try { savedTheme = localStorage.getItem('times-forcast-theme'); } catch { /* Use the system preference. */ }
setTheme(savedTheme === 'light' || savedTheme === 'dark'
  ? savedTheme
  : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
