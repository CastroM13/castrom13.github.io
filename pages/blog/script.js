const slider = document.querySelector('.slider');
const btnLeft = document.querySelector('.left');
const btnRight = document.querySelector('.right');

btnLeft.addEventListener('click', (event) => {
  if (event.detail == 1) {
    slider.scrollBy({
      left: -slider.offsetWidth,
      behavior: 'smooth'
    });
  }
});

btnRight.addEventListener('click', (event) => {
  if (event.detail == 1) {
    slider.scrollBy({
      left: slider.offsetWidth,
      behavior: 'smooth'
    });
  }
});

console.log(slider.querySelectorAll(".slide"))