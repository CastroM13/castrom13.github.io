let projects = [];
let loading = false;

const requestResource = (resource) => {
    if (resource && resource.url) {
        return fetch((resource).url).then(e => e.json()).then(e => e.content)
    }
    return null
}

const requestAppJson = (resource) => {
    if (resource && resource.url) {
        return fetch((resource).url).then(e => e.json()).then(e => e.content)
    }
    return null
}

const main = () => {
    fetch("https://api.github.com/repos/CastroM13/castrom13.github.io/git/trees/main")
    .then(e => e.json())
    .then(e => {
        const promises = e.tree.filter(t => t.type == 'tree' && t.path !== 'assets').map(async m => {
            return fetch(m.url).then(e => e.json()).then(e => ({
                name: m.path.split('-').map(w => w.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase())).join(' '),
                path: m.path,
                url: 'https://github.com/CastroM13/castrom13.github.io/tree/main/' + m.path,
                app: requestAppJson(e.tree.find(d => d.path === 'app.json')),
                icon: requestResource(e.tree.find(d => d.path === 'icon.png')),
                thumbnail: requestResource(e.tree.find(d => d.path === 'thumbnail.png'))
            }))
        });
        Promise.all(promises).then(result => {
            projects = result;
            renderProjects(projects)
            console.log(projects)
        });
    });
};

window.onload=main();

const search = (param) => {

}

const renderProjects = (projects) => {
    document.querySelector('#render').innerHTML = null;
    projects.forEach(async project => document.querySelector('#render')?.appendChild(stringToDomElement(`
<div class="card" onclick="window.open('https://castrom13.github.io/${project.path}', '_blank')">
    <img src="data:image/png;base64, ${await project.thumbnail}" onerror="this.src='https://picsum.photos/1600/900'" alt="Thumbnail" class="thumbnail">
    <div class="card-body">
        <span>
            <img class="icon" width="32px" src='data:image/png;base64, ${await project.icon}' onerror="this.src='assets/project-fallback.svg';this.classList.add('fallback')"/>
            ${project.name}
            <img onclick="window.open('${project.url}', '_blank')" class="link" width="32px" src='assets/logos/logo-github.svg'/>
        </span>
        <!-- <p>Descrição curta do projeto que inclua funções e propósito.</p> -->
        <div class="badges">
            <a href="#">
                <img width="32px'" src="assets/logos/logo-github.svg" />
            </a>
        </div>
    </div>
</div>
`)))
    
}