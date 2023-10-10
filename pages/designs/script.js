const gallery = document.querySelector('#gallery')
fetch('designs.json')
  .then(result => result.json())
  .then(result => result.forEach((design) => {
    gallery.appendChild(stringToDomElement(`
    <div class="design-wrapper">
      <div class="design-slider">
          ${design.gallery.map(img => `<img class="design" src="${img}"/>`).join('')}
          <div class="title">${design.name}</div>
      </div>
    </div>
    `))
  }));