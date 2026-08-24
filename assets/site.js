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
  const themeAsset = theme === 'dark' ? '/assets/favicon.svg' : '/assets/favicon-alt.svg';
  document.querySelectorAll('[data-theme-asset]').forEach((asset) => {
    asset.setAttribute(asset.tagName === 'LINK' ? 'href' : 'src', themeAsset);
  });
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

if ('serviceWorker' in navigator && navigator.serviceWorker.controller?.scriptURL?.endsWith('/sw.js')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

const toolFilter = document.querySelector('[data-tool-filter]');
if (toolFilter) {
  const search = toolFilter.querySelector('[data-tool-search]');
  const category = toolFilter.querySelector('[data-tool-category]');
  const count = toolFilter.querySelector('[data-tool-count]');
  const cards = [...document.querySelectorAll('[data-tool-card]')];
  const normalize = (value) => String(value || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
  const update = () => {
    const term = normalize(search.value).trim();
    const selectedCategory = category.value;
    const visibleCards = [];
    for (const card of cards) {
      const matchesText = !term || normalize(card.textContent).includes(term);
      const matchesCategory = !selectedCategory || card.dataset.category === selectedCategory;
      card.hidden = !(matchesText && matchesCategory);
      card.removeAttribute('data-grid-column-end');
      card.removeAttribute('data-grid-last-row');
      card.removeAttribute('data-grid-last');
      if (!card.hidden) visibleCards.push(card);
    }
    const lastRowSize = visibleCards.length % 3 || Math.min(3, visibleCards.length);
    const lastRowStart = Math.max(0, visibleCards.length - lastRowSize);
    visibleCards.forEach((card, index) => {
      card.toggleAttribute('data-grid-column-end', (index + 1) % 3 === 0);
      card.toggleAttribute('data-grid-last-row', index >= lastRowStart);
      card.toggleAttribute('data-grid-last', index === visibleCards.length - 1);
    });
    count.textContent = (count.dataset.template || '{count} tools shown').replace('{count}', String(visibleCards.length));
  };
  toolFilter.addEventListener('input', update);
  toolFilter.addEventListener('change', update);
  toolFilter.addEventListener('reset', () => requestAnimationFrame(update));
  update();
}
