/*
 * "Inquire with AI" button for disenyodigitals.com.
 *
 * Adds a floating button that opens the Disenyo AI inquiry assistant (built from
 * inquiry-app/ into inquire/) in a panel. The chat itself runs inside an iframe, so this
 * file holds no keys and sends no data: it only shows and hides the frame.
 *
 * Use: <script src="inquire-widget.js" defer></script> before </body>.
 * Any link to "#inquire", or any element with data-inquire, also opens the panel.
 */
(function () {
  'use strict';

  // The chat page, built from inquiry-app/ into inquire/ and served by this same site.
  // ?source=website lets the team see which leads came from the site.
  // A data-chat-url attribute on the script tag overrides it (for testing against a local copy).
  var script = document.currentScript;
  var CHAT_URL =
    (script && script.getAttribute('data-chat-url')) || '/inquire/?source=website';

  if (window.__disenyoInquire) return;
  window.__disenyoInquire = true;

  var css = [
    '.dq-fab{position:fixed;right:1.25rem;bottom:1.25rem;z-index:1000;display:inline-flex;align-items:center;gap:.55rem;',
    'padding:.85rem 1.25rem;border:0;border-radius:999px;background:#A0664E;color:#FDFBF8;',
    "font:500 .95rem/1 'DM Sans',system-ui,sans-serif;letter-spacing:.01em;cursor:pointer;",
    'box-shadow:0 10px 30px -8px rgba(74,44,32,.45);transition:background .2s,transform .2s}',
    '.dq-fab:hover{background:#8C5540;transform:translateY(-1px)}',
    '.dq-fab:focus-visible,.dq-close:focus-visible{outline:2px solid #FDFBF8;outline-offset:2px;box-shadow:0 0 0 4px #A0664E}',
    '.dq-fab svg{width:18px;height:18px;flex:none}',
    '.dq-fab[aria-expanded="true"]{display:none}',
    '.dq-panel{position:fixed;right:1.25rem;bottom:1.25rem;z-index:1001;width:400px;height:min(660px,calc(100vh - 2.5rem));',
    'display:flex;flex-direction:column;background:#F5EFE6;border-radius:18px;overflow:hidden;',
    'box-shadow:0 24px 60px -12px rgba(74,44,32,.45);opacity:0;transform:translateY(12px);',
    'transition:opacity .2s,transform .2s;visibility:hidden}',
    '.dq-panel.dq-open{opacity:1;transform:none;visibility:visible}',
    '.dq-bar{display:flex;align-items:center;justify-content:space-between;padding:.6rem .6rem .6rem 1rem;',
    "background:#A0664E;color:#FDFBF8;font:500 .9rem/1.2 'DM Sans',system-ui,sans-serif}",
    '.dq-close{display:grid;place-items:center;width:36px;height:36px;border:0;border-radius:50%;',
    'background:transparent;color:inherit;cursor:pointer;font-size:1.4rem;line-height:1}',
    '.dq-close:hover{background:rgba(253,251,248,.15)}',
    '.dq-frame{flex:1;width:100%;border:0;background:#F5EFE6}',
    '@media (max-width:600px){',
    '.dq-fab{right:1rem;bottom:1rem}',
    '.dq-panel{inset:0;width:auto;height:100%;border-radius:0}}',
    '@media (prefers-reduced-motion:reduce){.dq-fab,.dq-panel{transition:none}}',
  ].join('');

  function init() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'dq-fab';
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-controls', 'dq-panel');
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm4 7a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 8 11zm4 0a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 12 11zm4 0a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 16 11z"/></svg>' +
      '<span>Inquire with AI</span>';

    var panel = document.createElement('div');
    panel.id = 'dq-panel';
    panel.className = 'dq-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Disenyo AI inquiry assistant');
    panel.hidden = true;

    var bar = document.createElement('div');
    bar.className = 'dq-bar';
    var label = document.createElement('span');
    label.textContent = 'Inquire with Disenyo';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'dq-close';
    close.setAttribute('aria-label', 'Close the chat');
    close.textContent = '×';
    bar.append(label, close);
    panel.appendChild(bar);

    document.body.append(fab, panel);

    var frame = null;

    function open() {
      // Load the chat only on first open, so visitors who never use it don't load it.
      if (!frame) {
        frame = document.createElement('iframe');
        frame.className = 'dq-frame';
        frame.title = 'Chat with Disenyo’s AI assistant';
        frame.src = CHAT_URL;
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        panel.appendChild(frame);
      }
      panel.hidden = false;
      // Next frame, so the opening transition runs.
      requestAnimationFrame(function () {
        panel.classList.add('dq-open');
      });
      fab.setAttribute('aria-expanded', 'true');
      close.focus();
    }

    function hide() {
      panel.classList.remove('dq-open');
      fab.setAttribute('aria-expanded', 'false');
      setTimeout(function () {
        if (!panel.classList.contains('dq-open')) panel.hidden = true;
      }, 200);
      fab.focus();
    }

    fab.addEventListener('click', open);
    close.addEventListener('click', hide);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('dq-open')) hide();
    });
    // Escape pressed inside the chat frame: the chat page posts this message.
    window.addEventListener('message', function (e) {
      if (!frame || e.source !== frame.contentWindow) return;
      if (e.data && e.data.type === 'disenyo-inquire:close' && panel.classList.contains('dq-open')) hide();
    });

    // Page links can open the chat: <a href="#inquire"> or any element with data-inquire.
    document.addEventListener('click', function (e) {
      var target = e.target instanceof Element ? e.target.closest('a[href="#inquire"],[data-inquire]') : null;
      if (!target) return;
      e.preventDefault();
      open();
    });
    if (location.hash === '#inquire') open();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
