
const parseHTML = (htmlString) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');
    return doc;
}

const elementContainsText = (element, search) => {
    if (!element || !search) {
        return false;
    }

    const regex = new RegExp(search, 'i');

    if (element.textContent && regex.test(element.textContent)) {
        return true;
    }

    const childNodes = element.childNodes;
    for (let i = 0; i < childNodes.length; i++) {
        if (elementContainsText(childNodes[i], search)) {
            return true;
        }
    }

    return false;
}
const tableToJson = (table) => {
    const headers = [];
    const headerElements = table.getElementsByTagName('th');
    for (let i = 0; i < headerElements.length; i++) {
        headers.push(headerElements[i].textContent.trim().toLowerCase());
    }

    const rows = [];
    const rowElements = table.getElementsByTagName('tr');
    for (let i = 0; i < rowElements.length; i++) {
        const row = {};
        const cellElements = rowElements[i].getElementsByTagName('td');
        for (let j = 0; j < cellElements.length; j++) {
            row[headers[j]] = cellElements[j].textContent.split('\n')[0] || cellElements[j].querySelector('img')?.src;
        }
        rows.push(row);
    }

    return rows;
}

const removeDuplicates = (foodsParam) => {
    const newFoods = [];
    foodsParam.forEach(food => {
        if (newFoods.find(nf => {
            console.log()
            return JSON.stringify(nf) == JSON.stringify(food)

        })) {
            return;
        }
        newFoods.push(food)
    })
    return newFoods;
}


const getLovesLikes = async (villagers) => {
    return await Promise.all(villagers.map(villager => fetch('https://stardewcommunitywiki.com/' + villager.name)))
        .then(async e => e.map(i => i.text().then(resolvedDom => {
            const dom = parseHTML(resolvedDom);
            const villagerName = i.url.split('https://stardewcommunitywiki.com/')[1];
            let birthdayInfobox = Array.from(dom.querySelectorAll("td")).find(td => td.innerHTML.includes('Birthday')).nextSibling.nextSibling;
            return ({
                villager: { name: villagerName, img: Array.from(dom.querySelectorAll('img')).filter(i => i.src.includes(villagerName))[0].src },
                birthday: {
                    img: birthdayInfobox.querySelector('img').src,
                    date: birthdayInfobox.innerText.trim()
                },
                loved: tableToJson(Array.from(dom.querySelectorAll('.wikitable')).filter(i => elementContainsText(i, 'love'))[0]).slice(2).map(x => ({ ...x, url: `https://stardewcommunitywiki.com/${x.name?.replace(' ', '_')}` })),
                liked: tableToJson(Array.from(dom.querySelectorAll('.wikitable')).filter(i => elementContainsText(i, 'likes'))[0]).slice(2).map(x => ({ ...x, url: `https://stardewcommunitywiki.com/${x.name?.replace(' ', '_')}` }))
            })
        })))
}
const result = [];
fetch('https://stardewcommunitywiki.com/Villagers')
    .then(e => e.text())
    .then(e => {
        const dom = parseHTML(e);
        getLovesLikes(Array.from(dom.querySelectorAll(".villagergallery")).slice(0, 3).map(i => Array.from(i.querySelectorAll('.gallerybox')).map(c => ({ img: c.querySelector('img').src, name: c.querySelector('p').querySelector('a').innerText }))).flat(1)).then(async x => await x.map(i => i
            .then(l => result.push(l))))
    })