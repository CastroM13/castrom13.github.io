const defaultPage = 'about-me';

// eval is evil, so no eval for u
const definitelyNotEval = eval;
window['eval'] = null


const renderer = async (page) => await Promise.all([`_pages/${page}/index.html`,`_pages/${page}/script.js`, `_pages/${page}/styles.css`].map(r => fetch(r).then(r => r.ok ? r : null)))
  .then(result => result.map(r => r && r.text()))
  .then(async results => {
    const html = await results[0] || await fetch('_pages/error/404.html').then(e => e.text())
    const js = await results[1]
    const css = await results[2]

    document.querySelector(`section[id='pages/${page}']`).innerHTML = null;
    document.head.querySelectorAll(`link[id*='pages/']`).forEach(d => d.remove());
    if (html) {
      document.querySelector(`section[id='pages/${page}']`).appendChild(stringToDomElement(html))
    }
    if(css) {
      var styles = document.createElement('link');
      styles.rel = 'stylesheet';
      styles.type = 'text/css';
      styles.media = 'screen';
      styles.id = `_pages/${page}/styles.css`;
      styles.href = `_pages/${page}/styles.css`;
      document.head.appendChild(styles);
    }
    if (js) {
      definitelyNotEval(js)
    }
  })

const main = () => {
  fetch('socials.json')
    .then(result => result.json())
    .then(result => result.forEach((social) => document.querySelector('#socials').appendChild(stringToDomElement(`<img src="${social.image}" ${social.url ? `onclick="open('${social.url}', '_blank').focus()"` : ''} class="badge" data-name="${social.name}" ${social.username ? `onclick="navigator.clipboard.writeText('${social.username}')"` : ''} ${social.username ? `data-username="${social.username}"` : ''}/>`))));
  
  renderer(defaultPage)
  document.querySelector(`section[id='pages/${defaultPage}']`).classList.toggle('visible');
  document.querySelector(`li[data-link=${defaultPage}]`).classList.toggle('active');
};

window.onload=main();

showPage = (target) => {
  Array.of(...target.parentNode.querySelectorAll('li')).forEach(li => li.classList.remove('active'))
  target.classList.toggle('active');
  Array.of(...document.querySelectorAll('section[id*=page]')).forEach(section => section.classList.remove('visible'));
  document.querySelector(`section[id='pages/${target.dataset.link}']`).classList.toggle('visible');
  renderer(target.dataset.link)
  // (renderer[target.dataset.link] || (()=>{}))();
};

stringToDomElement = (string) => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(string, "text/html");
  return doc.body.firstChild;
}

copyText = (text) => {
  navigator.clipboard.writeText(text).then(() => {
    console.log('Async: Copying to clipboard was successful!');
  }, function (err) {
    console.error('Async: Could not copy text: ', err);
  });
}