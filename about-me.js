fetch('https://raw.githubusercontent.com/CastroM13/CastroM13/main/README.md')
.then(e => e.text())
.then(e => document.querySelector('#mkd').innerHTML = e)