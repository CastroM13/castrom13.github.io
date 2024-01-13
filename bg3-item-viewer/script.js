let initialData = [];

fetch('data.json').then(e => e.json()).then(data => {
    initialData = data;
    loadData(initialData.slice(0, 100), null);
})

function debounce(func, delay) {
    let timeoutId;
    return function () {
        const context = this;
        const args = arguments;

        clearTimeout(timeoutId);
        timeoutId = setTimeout(function () {
            func.apply(context, args);
        }, delay);
    };
}

const debouncedLoadData = debounce((text) => {
    loadData(text ? initialData : initialData.slice(0, 100), text);
}, 300);

document.querySelector("#search").addEventListener('input', function(event) {
    debouncedLoadData(event.target.value);
});

const loadData = (data, text) => {
    document.querySelector("#list").innerHTML = '';
    return (data || initialData).filter(x => text ? x["DisplayName"]?.toLowerCase().includes(text.toLowerCase()) : true).forEach(d =>
        document.querySelector("#list").appendChild(element(`
        <div class="item">
            <img src="https://bg3.wiki/w/images/e/ef/Cape_of_the_Red_Prince_Faded.png" alt="">
            <span>${d["DisplayName"]}</span>
        </div>`)))
}
const element = (htmlString) => {
    const template = document.createElement('template');
    template.innerHTML = htmlString.trim();
    return template.content.firstChild;
}

// "UUID": "be7ef1cc-3be9-4e1c-8e0f-0fb7dc091352",
// "Icon": "Item_CONT_GEN_Burlap_Sack_B",
// "Name": "UNI_LOW_Flour_Sack",
// "DisplayName": "Flour Sack",
// "Description": "A simple bag, loosely tied.",
// "Tag": "OBJ_Sack"