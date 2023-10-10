let projects = [];
let language;
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

const debounce = (callback, delay) => {
    let timerId;
    return function () {
        clearTimeout(timerId);
        timerId = setTimeout(() => {
            callback.apply(this, arguments);
        }, delay);
    };
}

const inputElement = document.querySelector('#search');

const convertIfExists = (base64) => {
    if (base64) return JSON.parse(atob(base64))
    return;
}

const getProjects = () => {
    toggleLoading(true)
    fetch("https://api.github.com/repos/CastroM13/castrom13.github.io/git/trees/main")
        .then(e => e.json())
        .then(async e => {
            const rejectList = await getRejectList();
            const promises = e.tree
                .filter(t => t.type == 'tree' && t.path !== 'assets')
                .filter(t => !rejectList.includes(t.path))
                .map(async m => {
                    return fetch(m.url).then(e => e.json()).then(async e =>
                    ({
                        name: m.path.split('-').map(w => w.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase())).join(' '),
                        path: m.path,
                        url: 'https://github.com/CastroM13/castrom13.github.io/tree/main/' + m.path,
                        app: convertIfExists(await requestAppJson(e.tree.find(d => d.path === 'app.json'))),
                        icon: requestResource(e.tree.find(d => d.path === 'icon.png')),
                        thumbnail: requestResource(e.tree.find(d => d.path === 'thumbnail.png'))
                    })
                    );
                });
            Promise.all(promises).then(result => {
                projects = result;
                renderProjects(projects)
                const set = new Set(projects.map(p => p.app && p.app.languages).filter(e => !!e).flat(1));
                [...set].forEach(i => {
                    document.querySelector("#language").appendChild(stringToDomElement(`<option value="${i}">${i}</option>`))

                });
            });
        });
}

const handleInput = () => {
    renderProjects(projects
        .filter(t => t.app ? t.app.languages.includes(language) : false)
        .filter(t => inputElement.value ? t.path.toLowerCase().includes(inputElement.value.toLowerCase()) : true)
    );
}

const clearInput = () => {
    document.querySelector('#search').value = null;
    renderProjects(projects
        .filter(t => t.app ? t.app.languages.includes(language) : false)
        .filter(t => inputElement.value ? t.path.toLowerCase().includes(inputElement.value.toLowerCase()) : true)
    );
}

const changeLanguage = (event) => {
    language = event.target.value;
    if (language === 'All') {
        renderProjects(projects);
    } else {
        renderProjects(projects
            .filter(t => t.app ? t.app.languages.includes(language) : false)
            .filter(t => inputElement.value ? t.path.toLowerCase().includes(inputElement.value.toLowerCase()) : true)
        );
    }
}

inputElement.addEventListener('input', debounce(handleInput, 500));
document.querySelector("#language").addEventListener("change", changeLanguage);
document.querySelector("#clear-search").addEventListener("click", clearInput);


const main = () => {
    getProjects();
};

const toggleLoading = (bool) => {
    if (bool) {
        document.querySelector("#loading").classList.add('active')
    } else {
        document.querySelector("#loading").classList.remove('active')
    }
}

const getRejectList = () => fetch('pages/projects/reject.json')
    .then(e => e.json())
    .then(e => e)

window.onload = main();

const renderProjects = (projects) => {
    if (document.querySelector('#render')) {
        document.querySelector('#render').innerHTML = null;
        projects.forEach(async project => {
            document.querySelector('#render').appendChild(stringToDomElement(`
    <div class="card">
        <img src="data:image/png;base64, ${await project.thumbnail}" onerror="this.src='assets/thumbnail-fallback.png';this.classList.add('fallback')" class="thumbnail">
        <div class="card-body">
            <span onclick="window.open('https://castrom13.github.io/${project.path}', '_blank')">
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
    `))
    toggleLoading(false)
        })
    }
}