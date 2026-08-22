const app = document.querySelector('[data-password-app]');

if (app) {
  const language = app.dataset.language === 'pt-BR' ? 'pt-BR' : 'en';
  const copy = {
    en: {
      password: 'Password', passphrase: 'Passphrase', show: 'Show', hide: 'Hide', copied: 'Value copied.', generated: 'New value generated.',
      showLabel: 'Show generated value', hideLabel: 'Hide generated value',
      copyFailed: 'Clipboard access was blocked. Show the value and copy it manually.',
      noSets: 'Select at least one character set.', low: 'Limited', medium: 'Reasonable', high: 'Strong', veryHigh: 'Very strong'
    },
    'pt-BR': {
      password: 'Senha', passphrase: 'Frase-senha', show: 'Mostrar', hide: 'Ocultar', copied: 'Valor copiado.', generated: 'Novo valor gerado.',
      showLabel: 'Mostrar valor gerado', hideLabel: 'Ocultar valor gerado',
      copyFailed: 'O acesso à área de transferência foi bloqueado. Mostre o valor e copie-o manualmente.',
      noSets: 'Selecione pelo menos um conjunto de caracteres.', low: 'Limitado', medium: 'Razoável', high: 'Forte', veryHigh: 'Muito forte'
    }
  }[language];

  const words = language === 'pt-BR'
    ? [
      'abacate','abelha','abrigo','agua','alameda','alvorada','amora','ancora',
      'areia','arvore','asa','ave','bambu','barco','brisa','bosque',
      'cafe','campo','canoa','canto','casa','cedro','ceu','chama',
      'chuva','clara','colina','coral','corda','cravo','duna','erva',
      'estrela','faixa','farol','feira','flor','floresta','folha','fonte',
      'fruta','garoa','gema','gira','grama','ilha','jardim','lago',
      'laranja','leve','linha','lua','luz','madeira','manga','mapa',
      'mar','mel','mesa','milho','montanha','neblina','noite','norte',
      'nuvem','oceano','oliva','onda','ouro','papel','pedra','pera',
      'pinha','ponte','praia','prisma','raio','rede','rio','rosa',
      'safira','sal','selo','serra','sol','sombra','sul','terra',
      'trigo','trilha','tulipa','vale','vento','verde','vidro','violeta',
      'amendoa','arara','azul','balao','baunilha','broto','cacto','caminho',
      'cereja','ciranda','cobre','cometa','cristal','doce','eco','ferro',
      'figo','fio','fogueira','garrafa','horizonte','inverno','jasmim','limao',
      'lobo','manha','mirante','musgo','navio','orvalho','pipa','pomar'
    ]
    : [
      'anchor','apple','arch','ash','atlas','autumn','badge','bamboo',
      'beacon','berry','birch','bloom','blue','breeze','brick','brook',
      'cabin','cactus','cedar','chalk','charm','cherry','cloud','coral',
      'cosmos','creek','dawn','delta','dune','eagle','ember','fern',
      'field','flame','flora','forest','fossil','fox','frost','garden',
      'glass','grove','harbor','hazel','hill','honey','iris','island',
      'jade','jazz','juniper','kite','lake','leaf','lemon','light',
      'lilac','linen','lotus','lunar','maple','meadow','mint','moss',
      'night','north','nova','ocean','olive','orbit','owl','paper',
      'peach','pearl','pebble','pine','plum','pond','prism','quartz',
      'rain','raven','reed','reef','river','robin','rose','rust',
      'sage','sand','shell','sky','slate','snow','solar','sparrow',
      'spruce','star','stone','storm','sun','tide','timber','trail',
      'tulip','vale','velvet','vine','violet','wave','wheat','willow',
      'wind','winter','wood','wren','amber','canyon','clover','comet',
      'copper','cricket','echo','fjord','glacier','ink','lagoon','marble'
    ];

  const form = app.querySelector('[data-generator-form]');
  const output = app.querySelector('[data-generated-value]');
  const visibilityButton = app.querySelector('[data-toggle-visibility]');
  const copyButton = app.querySelector('[data-copy-value]');
  const status = app.querySelector('[data-status]');
  const entropyOutput = app.querySelector('[data-entropy]');
  const strengthOutput = app.querySelector('[data-strength-label]');
  const modeBadge = app.querySelector('[data-mode-badge]');
  const passwordSettings = app.querySelector('[data-password-settings]');
  const passphraseSettings = app.querySelector('[data-passphrase-settings]');

  function randomInt(max) {
    if (!Number.isSafeInteger(max) || max <= 0) throw new RangeError('Invalid random range');
    const range = 0x100000000;
    const limit = range - (range % max);
    const value = new Uint32Array(1);
    do crypto.getRandomValues(value); while (value[0] >= limit);
    return value[0] % max;
  }

  function clampNumber(input, minimum, maximum) {
    const value = Math.min(maximum, Math.max(minimum, Number.parseInt(input.value, 10) || minimum));
    input.value = String(value);
    return value;
  }

  function shuffle(values) {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const other = randomInt(index + 1);
      [values[index], values[other]] = [values[other], values[index]];
    }
    return values;
  }

  function strengthLabel(bits) {
    if (bits < 45) return copy.low;
    if (bits < 60) return copy.medium;
    if (bits < 80) return copy.high;
    return copy.veryHigh;
  }

  function updateResult(value, entropy, mode) {
    output.value = value;
    output.type = 'password';
    visibilityButton.setAttribute('aria-pressed', 'false');
    visibilityButton.setAttribute('aria-label', copy.showLabel);
    visibilityButton.textContent = copy.show;
    entropyOutput.textContent = `${Math.floor(entropy)} bits`;
    strengthOutput.textContent = strengthLabel(entropy);
    modeBadge.textContent = mode === 'password' ? copy.password : copy.passphrase;
    status.textContent = '';
    requestAnimationFrame(() => { status.textContent = copy.generated; });
  }

  function passwordResult() {
    const includeAmbiguous = form.elements.ambiguous.checked;
    const sets = [];
    if (form.elements.lowercase.checked) sets.push(includeAmbiguous ? 'abcdefghijklmnopqrstuvwxyz' : 'abcdefghijkmnopqrstuvwxyz');
    if (form.elements.uppercase.checked) sets.push(includeAmbiguous ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : 'ABCDEFGHJKLMNPQRSTUVWXYZ');
    if (form.elements.numbers.checked) sets.push(includeAmbiguous ? '0123456789' : '23456789');
    if (form.elements.symbols.checked) sets.push('!@#$%^&*()-_=+[]{};:,.?');
    if (!sets.length) throw new Error(copy.noSets);

    const length = clampNumber(form.elements['password-length'], 12, 128);
    const combined = sets.join('');
    const result = sets.map((set) => set[randomInt(set.length)]);
    while (result.length < length) result.push(combined[randomInt(combined.length)]);
    return { value: shuffle(result).join(''), entropy: length * Math.log2(combined.length) };
  }

  function passphraseResult() {
    const count = clampNumber(form.elements['word-count'], 6, 14);
    const separator = form.elements['word-separator'].value;
    const capitalize = form.elements['capitalize-words'].checked;
    const result = Array.from({ length: count }, () => words[randomInt(words.length)]);
    const normalized = capitalize ? result.map((word) => word[0].toUpperCase() + word.slice(1)) : result;
    return { value: normalized.join(separator), entropy: count * Math.log2(words.length) };
  }

  function selectedMode() {
    return form.elements['generator-mode'].value;
  }

  function generate() {
    try {
      const mode = selectedMode();
      const result = mode === 'password' ? passwordResult() : passphraseResult();
      updateResult(result.value, result.entropy, mode);
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function updateMode() {
    const passphrase = selectedMode() === 'passphrase';
    passwordSettings.hidden = passphrase;
    passphraseSettings.hidden = !passphrase;
    generate();
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); generate(); });
  form.elements['generator-mode'].forEach((control) => control.addEventListener('change', updateMode));

  visibilityButton.addEventListener('click', () => {
    const visible = output.type === 'text';
    output.type = visible ? 'password' : 'text';
    visibilityButton.setAttribute('aria-pressed', String(!visible));
    visibilityButton.setAttribute('aria-label', visible ? copy.showLabel : copy.hideLabel);
    visibilityButton.textContent = visible ? copy.show : copy.hide;
  });

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      status.textContent = copy.copied;
    } catch (_) {
      status.textContent = copy.copyFailed;
    }
  });

  generate();
}
