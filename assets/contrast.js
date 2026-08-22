const app = document.querySelector('[data-contrast-app]');

if (app) {
  const language = app.dataset.language === 'pt-BR' ? 'pt-BR' : 'en';
  const text = {
    en: {
      pass: 'Pass', fail: 'Fail', invalid: 'Use an opaque hexadecimal color in #RGB or #RRGGBB format.',
      copied: 'CSS colors copied.', copyFailed: 'Clipboard access was blocked. Copy the values from the fields instead.',
      alreadyPasses: 'The current foreground already passes AA for normal text.',
      adjusted: 'Foreground adjusted to a nearby AA shade along a path toward black or white.',
      summary: (ratio, normal, large) => `Contrast ${ratio} to 1. Normal text ${normal}. Large text ${large}.`
    },
    'pt-BR': {
      pass: 'Passa', fail: 'Falha', invalid: 'Use uma cor hexadecimal opaca no formato #RGB ou #RRGGBB.',
      copied: 'Cores CSS copiadas.', copyFailed: 'O acesso à área de transferência foi bloqueado. Copie os valores diretamente dos campos.',
      alreadyPasses: 'O primeiro plano atual já passa em AA para texto normal.',
      adjusted: 'Primeiro plano ajustado para uma tonalidade AA próxima no caminho até preto ou branco.',
      summary: (ratio, normal, large) => `Contraste ${ratio} para 1. Texto normal: ${normal}. Texto grande: ${large}.`
    }
  }[language];

  const formatter = new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const preview = app.querySelector('[data-preview]');
  const foregroundPicker = app.querySelector('[data-foreground-picker]');
  const foregroundText = app.querySelector('[data-foreground-text]');
  const backgroundPicker = app.querySelector('[data-background-picker]');
  const backgroundText = app.querySelector('[data-background-text]');
  const error = app.querySelector('[data-color-error]');
  const status = app.querySelector('[data-status]');
  const ratioOutput = app.querySelector('[data-ratio]');
  const resultOutputs = {
    normalAA: app.querySelector('[data-normal-aa]'),
    largeAA: app.querySelector('[data-large-aa]'),
    normalAAA: app.querySelector('[data-normal-aaa]'),
    largeAAA: app.querySelector('[data-large-aaa]'),
    ui: app.querySelector('[data-ui]')
  };

  function parseHex(value) {
    const source = value.trim();
    const short = /^#?([\da-f])([\da-f])([\da-f])$/i.exec(source);
    const long = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(source);
    const parts = short ? short.slice(1).map((part) => part + part) : long?.slice(1);
    if (!parts) return null;
    return { rgb: parts.map((part) => Number.parseInt(part, 16)), hex: `#${parts.join('').toUpperCase()}` };
  }

  function luminance(rgb) {
    const channels = rgb.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
  }

  function contrastRatio(foreground, background) {
    const first = luminance(foreground);
    const second = luminance(background);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }

  function resultLabel(output, passes) {
    output.textContent = passes ? text.pass : text.fail;
    output.dataset.pass = String(passes);
  }

  function currentColors() {
    const foreground = parseHex(foregroundText.value);
    const background = parseHex(backgroundText.value);
    if (!foreground || !background) return null;
    return { foreground, background };
  }

  function calculate({ announce = true } = {}) {
    const colors = currentColors();
    if (!colors) {
      error.hidden = false;
      error.textContent = text.invalid;
      ratioOutput.textContent = '—';
      Object.values(resultOutputs).forEach((output) => {
        output.textContent = '—';
        delete output.dataset.pass;
      });
      status.textContent = '';
      return null;
    }

    error.hidden = true;
    foregroundText.value = colors.foreground.hex;
    backgroundText.value = colors.background.hex;
    foregroundPicker.value = colors.foreground.hex;
    backgroundPicker.value = colors.background.hex;
    preview.style.color = colors.foreground.hex;
    preview.style.backgroundColor = colors.background.hex;

    const ratio = contrastRatio(colors.foreground.rgb, colors.background.rgb);
    const checks = {
      normalAA: ratio >= 4.5,
      largeAA: ratio >= 3,
      normalAAA: ratio >= 7,
      largeAAA: ratio >= 4.5,
      ui: ratio >= 3
    };

    ratioOutput.textContent = `${formatter.format(ratio)}:1`;
    Object.entries(checks).forEach(([key, passes]) => resultLabel(resultOutputs[key], passes));
    if (announce) status.textContent = text.summary(formatter.format(ratio), checks.normalAA ? text.pass : text.fail, checks.largeAA ? text.pass : text.fail);
    return { ...colors, ratio };
  }

  function mix(start, end, amount) {
    return start.map((channel, index) => Math.round(channel + ((end[index] - channel) * amount)));
  }

  function rgbToHex(rgb) {
    return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }

  function distance(first, second) {
    return Math.sqrt(first.reduce((sum, channel, index) => sum + ((channel - second[index]) ** 2), 0));
  }

  function closestToward(foreground, background, endpoint, target) {
    if (contrastRatio(endpoint, background) < target) return null;
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 28; iteration += 1) {
      const middle = (low + high) / 2;
      if (contrastRatio(mix(foreground, endpoint, middle), background) >= target) high = middle;
      else low = middle;
    }
    const rgb = mix(foreground, endpoint, high);
    return { rgb, distance: distance(foreground, rgb) };
  }

  let inputTimer;
  function scheduleCalculation() {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => calculate(), 300);
  }

  foregroundPicker.addEventListener('input', () => { foregroundText.value = foregroundPicker.value.toUpperCase(); calculate({ announce: false }); });
  backgroundPicker.addEventListener('input', () => { backgroundText.value = backgroundPicker.value.toUpperCase(); calculate({ announce: false }); });
  foregroundPicker.addEventListener('change', () => calculate());
  backgroundPicker.addEventListener('change', () => calculate());
  foregroundText.addEventListener('input', scheduleCalculation);
  backgroundText.addEventListener('input', scheduleCalculation);
  foregroundText.addEventListener('blur', () => calculate());
  backgroundText.addEventListener('blur', () => calculate());
  app.querySelector('[data-contrast-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    calculate();
  });

  app.querySelector('[data-swap-colors]').addEventListener('click', () => {
    const previous = foregroundText.value;
    foregroundText.value = backgroundText.value;
    backgroundText.value = previous;
    calculate();
  });

  app.querySelector('[data-find-aa]').addEventListener('click', () => {
    const result = calculate({ announce: false });
    if (!result) return;
    if (result.ratio >= 4.5) {
      status.textContent = text.alreadyPasses;
      return;
    }
    const candidates = [
      closestToward(result.foreground.rgb, result.background.rgb, [0, 0, 0], 4.5),
      closestToward(result.foreground.rgb, result.background.rgb, [255, 255, 255], 4.5)
    ].filter(Boolean).sort((first, second) => first.distance - second.distance);
    if (!candidates.length) return;
    foregroundText.value = rgbToHex(candidates[0].rgb);
    calculate({ announce: false });
    status.textContent = text.adjusted;
  });

  app.querySelector('[data-copy-css]').addEventListener('click', async () => {
    const result = calculate({ announce: false });
    if (!result) return;
    const css = `--foreground: ${result.foreground.hex};\n--background: ${result.background.hex};\n/* WCAG contrast: ${formatter.format(result.ratio)}:1 */`;
    try {
      await navigator.clipboard.writeText(css);
      status.textContent = text.copied;
    } catch (_) {
      status.textContent = text.copyFailed;
    }
  });

  calculate({ announce: false });
}
