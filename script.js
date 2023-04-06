import socials from './socials.js'

const defaultPage = 'about-me';
const main = () => {
    document.querySelector(`section[id='page/${defaultPage}']`).classList.toggle('visible');
    document.querySelector(`li[data-link=${defaultPage}]`).classList.toggle('active');
};
main();

window.showPage = (target) => {
    Array.of(...target.parentNode.querySelectorAll('li')).forEach(li => li.classList.remove('active'))
    target.classList.toggle('active');
    Array.of(...document.querySelectorAll('section[id*=page]')).forEach(section => section.classList.remove('visible'));
    document.querySelector(`section[id='page/${target.dataset.link}']`).classList.toggle('visible');
};

window.stringToDomElement = (string) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(string, "text/html");
    return doc.body.firstChild;
}

window.copyText = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      console.log('Async: Copying to clipboard was successful!');
    }, function(err) {
      console.error('Async: Could not copy text: ', err);
    });
}

socials.forEach((social) => document.querySelector('#socials').appendChild(stringToDomElement(`<img src="${social.image}" ${social.url ? `onclick="window.open('${social.url}', '_blank').focus()"` : ''} class="badge" data-name="${social.name}" ${social.username ? `onclick="navigator.clipboard.writeText('${social.username}')"` : ''} ${social.username ? `data-username="${social.username}"` : ''}/>`)))