let projects = [];

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

const loadSelect = () => {

    var x, i, j, l, ll, selElmnt, a, b, c;
    x = document.getElementsByClassName("custom-select");
    l = x.length;

    for (i = 0; i < l; i++) {
        selElmnt = x[i].querySelector("#language");
        ll = selElmnt.length;
        a = document.createElement("DIV");
        a.setAttribute("class", "select-selected");
        a.innerHTML = selElmnt.options[selElmnt.selectedIndex].innerHTML;
        x[i].appendChild(a);
        b = document.createElement("DIV");
        b.setAttribute("class", "select-items select-hide");
        for (j = 1; j < ll; j++) {
            c = document.createElement("DIV");
            c.innerHTML = selElmnt.options[j].innerHTML;
            c.addEventListener("click", function (e) {
                var y, i, k, s, h, sl, yl;
                s = this.parentNode.parentNode.getElementsByTagName("select")[0];
                sl = s.length;
                h = this.parentNode.previousSibling;
                for (i = 0; i < sl; i++) {
                    if (s.options[i].innerHTML == this.innerHTML) {
                        s.selectedIndex = i;
                        h.innerHTML = this.innerHTML;
                        y = this.parentNode.getElementsByClassName("same-as-selected");
                        yl = y.length;
                        for (k = 0; k < yl; k++) {
                            y[k].removeAttribute("class");
                        }
                        this.setAttribute("class", "same-as-selected");
                        s.dispatchEvent(new Event("change"));
                        break;
                    }
                }
                h.click();
            });
            b.appendChild(c);
        }
        x[i].appendChild(b);
        a.addEventListener("click", function (e) {
            e.stopPropagation();
            closeAllSelect(this);
            this.nextSibling.classList.toggle("select-hide");
            this.classList.toggle("select-arrow-active");
        });
    }

    const closeAllSelect = (elmnt) => {
        var x, y, i, xl, yl, arrNo = [];
        x = document.getElementsByClassName("select-items");
        y = document.getElementsByClassName("select-selected");
        xl = x.length;
        yl = y.length;
        for (i = 0; i < yl; i++) {
            if (elmnt == y[i]) {
                arrNo.push(i)
            } else {
                y[i].classList.remove("select-arrow-active");
            }
        }
        for (i = 0; i < xl; i++) {
            if (arrNo.indexOf(i)) {
                x[i].classList.add("select-hide");
            }
        }
    }

    document.addEventListener("click", closeAllSelect);
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
                loadSelect();
            });
        });
}

const handleInput = () => {
    renderProjects(projects.filter(t => inputElement.value ? t.path.toLowerCase().includes(inputElement.value.toLowerCase()) : true))
}

const changeLanguage = (language) => {
    console.log(language)
    // renderProjects(projects.filter(t => inputElement.value ? t.path.toLowerCase().includes(inputElement.value.toLowerCase()) : true))
}

inputElement.addEventListener('input', debounce(handleInput, 500));


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
    loadCount = [projects.length, 0]
    document.querySelector('#render').innerHTML = null;
    projects.forEach(async project => {
        loadCount[1]++;
        document.querySelector('#render')?.appendChild(stringToDomElement(`
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
        if (loadCount[0] === loadCount[0]) {
            setInterval(() => toggleLoading(false), 1000);
        }
    })

}