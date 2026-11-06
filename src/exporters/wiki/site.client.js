/* Search and the light or dark switch for the exported site. Runs from file:// with no server. */
(function () {
  'use strict';

  var root = document.documentElement;

  function remembered() {
    try {
      return localStorage.getItem('lorecraft-site-mode');
    } catch (e) {
      return null;
    }
  }

  function remember(mode) {
    try {
      localStorage.setItem('lorecraft-site-mode', mode);
    } catch (e) {
      /* Private windows and some browsers refuse storage on file://. */
    }
  }

  var savedMode = remembered();
  if (savedMode) root.setAttribute('data-mode', savedMode);

  document.addEventListener('DOMContentLoaded', function () {
    var toggle = document.getElementById('mode-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var dark = root.getAttribute('data-mode')
          ? root.getAttribute('data-mode') === 'dark'
          : window.matchMedia('(prefers-color-scheme: dark)').matches;
        var next = dark ? 'light' : 'dark';
        root.setAttribute('data-mode', next);
        remember(next);
      });
    }
    startSearch();
  });

  /** Lower case with accents removed, so "eowyn" finds "Éowyn". */
  function fold(text) {
    return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  }

  function snippet(text, position) {
    var start = Math.max(0, position - 60);
    var end = Math.min(text.length, position + 120);
    return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
  }

  /** Every word must appear. Matches in titles and aliases rank above matches in text. */
  function search(query, index) {
    var words = fold(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    var hits = [];
    index.forEach(function (entry) {
      var names = fold([entry.title].concat(entry.aliases).join(' '));
      var body = fold(entry.summary + ' ' + entry.text);
      var score = 0;
      for (var i = 0; i < words.length; i += 1) {
        if (names.indexOf(words[i]) >= 0) score += 10;
        else if (body.indexOf(words[i]) >= 0) score += 1;
        else return;
      }
      hits.push({ entry: entry, score: score, at: fold(entry.text).indexOf(words[0]) });
    });
    hits.sort(function (a, b) {
      return b.score - a.score || a.entry.title.localeCompare(b.entry.title);
    });
    return hits;
  }

  function startSearch() {
    var results = document.getElementById('search-results');
    if (!results) return;
    var input = document.getElementById('search-input');
    var heading = document.getElementById('search-heading');
    var index = window.LORECRAFT_SEARCH || [];
    var query = new URLSearchParams(window.location.search).get('q') || '';
    input.value = query;

    function show() {
      var value = input.value;
      results.textContent = '';
      var hits = search(value, index);
      heading.textContent = value.trim()
        ? hits.length + (hits.length === 1 ? ' page matches' : ' pages match')
        : 'Type to search every page.';
      hits.forEach(function (hit) {
        var item = document.createElement('li');
        var link = document.createElement('a');
        link.href = hit.entry.url;
        link.textContent = hit.entry.title;
        item.appendChild(link);
        var text = document.createElement('span');
        text.className = 'snippet';
        text.textContent = hit.at >= 0 ? snippet(hit.entry.text, hit.at) : hit.entry.summary;
        item.appendChild(text);
        results.appendChild(item);
      });
    }

    input.addEventListener('input', show);
    show();
  }
})();
