const root = document.querySelector('#root');
const portuguese = document.documentElement.lang === 'pt-BR';
const labels = portuguese
  ? {
      data: 'Dados ou URL', qrColor: 'Cor do QR code', background: 'Cor de fundo', logo: 'Enviar um logotipo opcional',
      shape: 'Formato do QR code', download: 'Formato de download', downloadAs: 'Baixar QR code como', preview: 'Prévia do QR code gerado'
    }
  : {
      data: 'Data or URL', qrColor: 'QR code color', background: 'Background color', logo: 'Upload an optional logo',
      shape: 'QR code shape', download: 'Download format', downloadAs: 'Download QR code as', preview: 'Generated QR code preview'
    };

const translations = new Map([
  ['Data or URL', 'Dados ou URL'], ['Shape', 'Formato'], ['Square', 'Quadrado'], ['Dots', 'Pontos'],
  ['Rounded', 'Arredondado'], ['Smooth', 'Suave'], ['Classy', 'Clássico'], ['Modern', 'Moderno'],
  ['QR Color', 'Cor do QR'], ['Background', 'Fundo'], ['Logo (Optional)', 'Logotipo (opcional)'],
  ['Click or drag to upload a logo', 'Clique ou arraste para enviar um logotipo'], ['Remove Logo', 'Remover logotipo']
]);

function setLabel(element, label) {
  if (element && !element.getAttribute('aria-label')) element.setAttribute('aria-label', label);
}

function improveSemantics() {
  setLabel(root?.querySelector('textarea'), labels.data);

  const colorInputs = root?.querySelectorAll('input[type="color"]') || [];
  setLabel(colorInputs[0], labels.qrColor);
  setLabel(colorInputs[1], labels.background);
  setLabel(root?.querySelector('input[type="file"]'), labels.logo);
  const textarea = root?.querySelector('textarea');
  if (textarea && portuguese) textarea.placeholder = 'Insira URL, texto ou dados de contato…';

  const shapeButtons = [...(root?.querySelectorAll('.shape-btn') || [])];
  if (shapeButtons.length) {
    shapeButtons[0].parentElement?.setAttribute('role', 'group');
    shapeButtons[0].parentElement?.setAttribute('aria-label', labels.shape);
    shapeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.classList.contains('active'))));
  }

  const downloadGroup = root?.querySelector('.export-buttons');
  const downloadButtons = [...(downloadGroup?.querySelectorAll('button.btn') || [])];
  if (downloadButtons.length) {
    downloadGroup.setAttribute('role', 'group');
    downloadGroup.setAttribute('aria-label', labels.download);
    downloadButtons.forEach((button) => setLabel(button, `${labels.downloadAs} ${button.textContent.trim()}`));
  }

  const removeLogo = root?.querySelector('.input-group > button.btn');
  if (removeLogo) removeLogo.setAttribute('aria-label', portuguese ? 'Remover logotipo' : 'Remove logo');

  const preview = root?.querySelector('.qr-canvas svg');
  if (preview) {
    preview.setAttribute('role', 'img');
    preview.setAttribute('aria-label', labels.preview);
  }

  if (portuguese && root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue.trim();
      if (translations.has(value)) node.nodeValue = node.nodeValue.replace(value, translations.get(value));
    }
  }
}

if (root) {
  new MutationObserver(improveSemantics).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  root.addEventListener('click', () => requestAnimationFrame(improveSemantics));
  improveSemantics();
}

document.querySelector('[data-qr-language]')?.addEventListener('click', (event) => {
  try { localStorage.setItem('castrom13-language', event.currentTarget.dataset.qrLanguage); } catch (_) {}
});
