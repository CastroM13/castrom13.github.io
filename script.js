
const contentContainer = document.getElementById("content");
let currentScriptElement = null;

function resetJavaScript() {
    if (currentScriptElement) {
        currentScriptElement.remove();
    }
}

function loadContent() {
    resetJavaScript();
    const hash = window.location.hash.slice(1) || 'home';
    const htmlPath = `pages/${hash}/index.html`;
    const cssPath = `pages/${hash}/styles.css`;
    const jsPath = `pages/${hash}/script.js`;


    fetch(htmlPath)
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to load content');
            }
            return response.text();
        })
        .then(htmlContent => {
            contentContainer.className = hash;
            contentContainer.innerHTML = htmlContent;

        
            const styleLink = document.createElement('link');
            styleLink.rel = 'stylesheet';
            styleLink.href = cssPath;
            document.head.appendChild(styleLink);

        
            const scriptElement = document.createElement('script');
            scriptElement.src = jsPath;
            document.body.appendChild(scriptElement);

        
            currentScriptElement = scriptElement;
        })
        .catch(error => {
            console.error(error);
            contentContainer.innerHTML = '<p>Error loading content.</p>';
        });
}

window.addEventListener('hashchange', loadContent);

loadContent();

// Shared Functions

stringToDomElement = (string) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(string, "text/html");
    return doc.body.firstChild;
}