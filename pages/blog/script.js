const slider = document.querySelector('.slider');
const btnLeft = document.querySelector('.left');
const btnRight = document.querySelector('.right');

btnLeft.addEventListener('click', () => {
  slider.scrollBy({
    left: -slider.offsetWidth,
    behavior: 'smooth'
  });
});

btnRight.addEventListener('click', () => {
  slider.scrollBy({
    left: slider.offsetWidth,
    behavior: 'smooth'
  });
});
