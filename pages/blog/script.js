onload = () => {
  
}

const slider = document.querySelector('.slider');
const btnLeft = document.querySelector('.left');
const btnRight = document.querySelector('.right');
const pager = document.querySelector('#pager');
let sliderIndex = 0;

const updatePagerButton = (sliderIndex) => {
  const active = pager.querySelector('.active');
  active && active.classList.remove('active');
  pager.querySelector('#slide-'+sliderIndex).classList.add('active')
};

const slide = (times = 0) => {
  const slidesSize =  (slider.querySelectorAll(".slide").length - 1);
  const higherThanZero = (sliderIndex + times) >= 0;
  const smallerThanSize = (sliderIndex + times) <= slidesSize;
  if (higherThanZero && smallerThanSize) {
    sliderIndex = sliderIndex + times;
    btnLeft.classList.remove('invisible');
    btnRight.classList.remove('invisible');
    if (sliderIndex === 0) {
      btnLeft.classList.add('invisible');
    } else if (sliderIndex === slidesSize) {
      btnRight.classList.add('invisible');
    }
    updatePagerButton(sliderIndex);
    slider.scrollBy({
      left: slider.offsetWidth * times,
      behavior: 'smooth'
    });
  }
}

const slideTo = (event) => {
  const index = event.target.id.split('-')[1];
  const times = index - sliderIndex;
  slide(times)
}

(slider.querySelectorAll(".slide").length > 1 ? slider.querySelectorAll(".slide") : []).forEach((slide, i) => {
  const pagerButton = document.createElement('button');
  if (i === 0) {
    pagerButton.className = 'active';
  }
  pagerButton.id = 'slide-'+i;
  pagerButton.onclick = slideTo;
  pager.appendChild(pagerButton);
});

btnLeft.addEventListener('click', (event) => {
  if (event.detail == 1) {
    // slideLeft();
    slide(-1)
  }
});

btnRight.addEventListener('click', (event) => {
  if (event.detail == 1) {
    // slideRight();
    slide(1)
  }
});
