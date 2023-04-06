fetch('https://raw.githubusercontent.com/CastroM13/CastroM13/main/README.md')
.then(e => e.text())
.then(e => document.querySelector('#md-1').innerHTML = markdownToHtml(e))

function markdownToHtml(markdown) {
    markdown = markdown.replace(/^---$/gm, '<hr>');
    markdown = markdown.replace(/^(#+)(.*)$/gm, function(match, p1, p2) {
      var level = p1.length;
      return '<h' + level + '>' + p2.trim() + '</h' + level + '>';
    });
    markdown = markdown.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    markdown = markdown.replace(/\*(.*?)\*/g, '<em>$1</em>');
    markdown = markdown.replace(/^>(.*)$/gm, '<blockquote>$1</blockquote>');
    markdown = markdown.replace(/^```(\w*)\n([\s\S]*?)\n```$/gm, function(match, p1, p2) {
      return '<pre><code class="' + p1 + '">' + p2.trim() + '</code></pre>';
    });
    markdown = markdown.replace(/^(\s*[-+*]\s+.*)$/gm, function(match, p1) {
      return '<ul><li>' + p1 + '</li></ul>';
    });
    markdown = markdown.replace(/^(\s*\d+\.\s+.*)$/gm, function(match, p1) {
      return '<ol><li>' + p1 + '</li></ol>';
    });
    markdown = markdown.replace(/\!\[([^\]]+)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
    markdown = markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    markdown = markdown.replace(/^\s*(\S.*\S)?\s*$/gm, '<p>$1</p>');

    return markdown;
  }
  