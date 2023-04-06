const defaultPage = 'about-me';
const main = () => {
    document.querySelector(`section[id='page/${defaultPage}']`).classList.toggle('visible');
    document.querySelector(`li[data-link=${defaultPage}]`).classList.toggle('active');
};
main();

const showPage = (target) => {
    Array.of(...target.parentNode.querySelectorAll('li')).forEach(li => li.classList.remove('active'))
    target.classList.toggle('active');
    Array.of(...document.querySelectorAll('section[id*=page]')).forEach(section => section.classList.remove('visible'));
    document.querySelector(`section[id='page/${target.dataset.link}']`).classList.toggle('visible');
};