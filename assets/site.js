const root = document.documentElement;
root.classList.add('reveal-ready');
const themeToggle = document.querySelector('[data-theme-toggle]');
const themeIcon = document.querySelector('[data-theme-icon]');
const menuToggle = document.querySelector('[data-menu-toggle]');
const navigation = document.querySelector('[data-navigation]');

function systemTheme() {
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  root.dataset.theme = theme;
  if (themeToggle) {
    const label = theme === 'dark' ? themeToggle.dataset.lightLabel : themeToggle.dataset.darkLabel;
    themeToggle.setAttribute('aria-label', label || (theme === 'dark' ? 'Use light theme' : 'Use dark theme'));
  }
  if (themeIcon) themeIcon.textContent = theme === 'dark' ? '◐' : '◑';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0b0d' : '#f2f1ea');
}

let savedTheme;
try { savedTheme = localStorage.getItem('castrom13-theme'); } catch (_) {}
applyTheme(savedTheme || systemTheme());

themeToggle?.addEventListener('click', () => {
  const nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  try { localStorage.setItem('castrom13-theme', nextTheme); } catch (_) {}
});

document.querySelectorAll('[data-language]').forEach((link) => {
  link.addEventListener('click', () => {
    try { localStorage.setItem('castrom13-language', link.dataset.language); } catch (_) {}
  });
});

function setMenu(open) {
  if (!menuToggle || !navigation) return;
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.querySelector('.sr-only').textContent = open
    ? (menuToggle.dataset.closeLabel || 'Close navigation')
    : (menuToggle.dataset.openLabel || 'Open navigation');
  navigation.dataset.open = String(open);
}

menuToggle?.addEventListener('click', () => setMenu(menuToggle.getAttribute('aria-expanded') !== 'true'));
navigation?.addEventListener('click', (event) => { if (event.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || menuToggle?.getAttribute('aria-expanded') !== 'true') return;
  setMenu(false);
  menuToggle.focus();
});

const revealItems = document.querySelectorAll('[data-reveal]');
if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  revealItems.forEach((item) => revealObserver.observe(item));

  // Content must never depend on the entrance effect. This also covers browsers
  // that expose IntersectionObserver but fail to deliver callbacks reliably.
  window.setTimeout(() => {
    revealItems.forEach((item) => {
      item.classList.add('is-visible');
      revealObserver.unobserve(item);
    });
  }, 1800);
} else {
  revealItems.forEach((item) => item.classList.add('is-visible'));
}

matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  try {
    if (!localStorage.getItem('castrom13-theme')) applyTheme(systemTheme());
  } catch (_) {
    applyTheme(systemTheme());
  }
});

if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
