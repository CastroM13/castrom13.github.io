renderPost = (event) => {
  url = event.target.href;
  fetch(url)
    .then(e => e.text())
    .then(e => console.log(e))
}

fetch('https://api.github.com/repos/CastroM13/CastroM13/git/trees/ac51b3e76346df1371206226faa3020c0a740272')
  .then(e => e.json())
  .then(e => e.tree.forEach(post => {
    link = document.createElement('p')
    link.href = 'https://raw.githubusercontent.com/CastroM13/CastroM13/main/blog/' + encodeURI(post.path);
    link.onclick = renderPost;
    link.textContent = post.path.split('.md')[0];
    console.log(link)
    document.querySelector('#blog-wrapper').appendChild(link)
  }));

slider = document.querySelector('.slider');
btnLeft = document.querySelector('.left');
btnRight = document.querySelector('.right');
pager = document.querySelector('#pager');
sliderIndex = 0;

updatePagerButton = (sliderIndex) => {
  active = pager.querySelector('.active');
  active && active.classList.remove('active');
  pager.querySelector('#slide-' + sliderIndex).classList.add('active')
};

slide = (times = 0) => {
  slidesSize = (slider.querySelectorAll(".slide").length - 1);
  higherThanZero = (sliderIndex + times) >= 0;
  smallerThanSize = (sliderIndex + times) <= slidesSize;
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

slideTo = (event) => {
  index = event.target.id.split('-')[1];
  times = index - sliderIndex;
  slide(times)
}

(slider.querySelectorAll(".slide").length > 1 ? slider.querySelectorAll(".slide") : []).forEach((slide, i) => {
  pagerButton = document.createElement('button');
  if (i === 0) {
    pagerButton.className = 'active';
  }
  pagerButton.id = 'slide-' + i;
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
